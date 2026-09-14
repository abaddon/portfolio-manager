import { newId } from "../../shared/id.js";
import { toIso } from "../../shared/clock.js";
import { clamp, EDGE_DP, roundTo, roundValue } from "../../shared/money.js";
import { DecisionEngine, type CostEstimate, type Decision, type DecisionReason, type TradeAction, type TradeProposal } from "../../domain/decision.js";
import type { AnalysisReport } from "../../domain/analysis.js";
import type { PortfolioSnapshot, PositionWithValue } from "../../domain/portfolio.js";
import type { AppPorts } from "../ports.js";

export interface DecisionServiceConfig {
  /** How much the winning proposal's own confidence weighs in the assumed edge (0..1). */
  proposalConfidenceWeight?: number;
  /** Anti-churn: skip tickers traded within this many days. */
  tickerCooldownDays?: number;
}

/** A trade the Asset Allocation Committee wants gated and executed. */
export interface OrderIntent {
  ticker: string;
  side: "BUY" | "SELL";
  /** Target order value in account currency. */
  value: number;
  reason: string;
  /** Confidence driving the economic gate, 0..1. */
  confidence: number;
}

/**
 * Signal strength behind a ticker's assumed edge, 0..1 (ADR 0012). Two
 * evidence sources are blended:
 *  - the analysts' recommended target-weight changes for that ticker, weighted
 *    by each analyst's own confidence in the change (`adjustmentConfidence`);
 *  - the winning proposal's confidence.
 * With no analyst coverage the proposal's confidence carries the signal alone,
 * so a name the research never looked at trades on much thinner evidence.
 */
export function computeSignalStrength(params: {
  reports: AnalysisReport[];
  ticker: string;
  proposalConfidence: number;
  proposalConfidenceWeight: number;
  /** A |Δweight| at or above this counts as a full-strength analyst signal. */
  fullStrengthAdjustment: number;
}): number {
  const { reports, ticker, proposalConfidence, proposalConfidenceWeight, fullStrengthAdjustment } = params;
  let weighted = 0;
  let weightSum = 0;
  for (const r of reports) {
    if (r.ticker !== ticker) continue;
    const adjustment = Math.min(Math.abs(r.signals.targetWeightAdjustment) / fullStrengthAdjustment, 1);
    const confidence = clamp(r.signals.confidence, 0, 1);
    weighted += adjustment * confidence;
    weightSum += confidence;
  }
  const analystStrength = weightSum > 0 ? clamp(weighted / weightSum, 0, 1) : 0;
  const w = clamp(proposalConfidenceWeight, 0, 1);
  return clamp((1 - w) * analystStrength + w * clamp(proposalConfidence, 0, 1), 0, 1);
}

/**
 * The decision step of the unified committee flow (ADR 0009): prices the
 * winning committee proposal's order intents and passes every one through the
 * economic gate (DecisionEngine.evaluate). There is no drift or
 * analyst-signal logic — the committee already decided what to trade — but
 * every intent meets the exact same gates every order has always met.
 */
export class DecisionService {
  private readonly proposalConfidenceWeight: number;
  private readonly cooldownMs: number;
  /** Normalising constant for an analyst's recommended Δ: 15% of NAV is a full-strength signal. */
  private static readonly FULL_STRENGTH_ADJUSTMENT = 0.15;

  constructor(
    private readonly ports: AppPorts,
    private readonly engine: DecisionEngine,
    cfg: DecisionServiceConfig = {},
  ) {
    this.proposalConfidenceWeight = clamp(cfg.proposalConfidenceWeight ?? 0.5, 0, 1);
    this.cooldownMs = (cfg.tickerCooldownDays ?? engine.tickerCooldownDays) * 86_400_000;
  }

  async decide(params: {
    runId: string;
    snapshot: PortfolioSnapshot;
    heat: number;
    intents: OrderIntent[];
    /** Analyst research behind this run's decision (drives the assumed edge). */
    reports?: AnalysisReport[];
    /** LLM cost of this run's inference, in account currency (ADR 0011). */
    llmCostPerRun?: number;
    meta?: Record<string, unknown>;
  }): Promise<Decision[]> {
    const { runId, snapshot, heat, intents } = params;
    const now = toIso(this.ports.clock.now());
    const reports = params.reports ?? [];
    const cooledTickers = await this.cooledTickersFor(intents.map((i) => i.ticker));

    // Running gate state: every intent is evaluated against the portfolio AS IT
    // WILL BE once the intents approved before it have executed. Evaluating all
    // of them against the pre-run cash/heat let a run of BUYs collectively
    // breach `maxHeatPct` and the available cash, because each one only saw the
    // untouched starting point.
    let availableCash = snapshot.cash;
    let runningHeat = heat;
    const llmCostPerRun = params.llmCostPerRun ?? 0;
    // Net benefit approved so far: the run's inference cost must be covered by
    // the decisions it produced (ADR 0011/0012).
    let sessionNetBenefit = 0;
    const maxOrderValue = this.engine.maxViableOrder(snapshot.totalValue);

    const decisions: Decision[] = [];
    for (const intent of intents) {
      const action = intent.side;
      const pricing = await this.resolveOrderable({
        runId,
        ticker: intent.ticker,
        action,
        snapshot,
        now,
        details: { source: "committee-order", reason: intent.reason },
      });
      if (pricing.kind === "rejected") {
        decisions.push(pricing.decision);
        continue;
      }
      const { price, fxRate, currency, position } = pricing;

      let quantity = roundValue(intent.value / (price * fxRate), 4);
      if (action === "SELL" && position) {
        quantity = Math.min(quantity, roundValue(position.quantity, 4));
      }
      if (quantity <= 0) {
        decisions.push(this.reject(runId, intent.ticker, "OPPORTUNITY_TOO_SMALL", now, {
          source: "committee-order",
          reason: "computed trade quantity is zero",
        }));
        continue;
      }
      // Rounding can nudge the value just over the cap — rescale instead of rejecting.
      if (quantity * price * fxRate > maxOrderValue && price > 0 && fxRate > 0) {
        quantity = roundValue(maxOrderValue / (price * fxRate), 4);
      }
      const orderValue = roundValue(Math.min(quantity * price * fxRate, maxOrderValue));

      const confidence = clamp(intent.confidence, 0, 1);
      const signalStrength = computeSignalStrength({
        reports,
        ticker: intent.ticker,
        proposalConfidence: confidence,
        proposalConfidenceWeight: this.proposalConfidenceWeight,
        fullStrengthAdjustment: DecisionService.FULL_STRENGTH_ADJUSTMENT,
      });
      const edgePct = this.engine.computeEdgePct(signalStrength);
      const expectedBenefit = this.engine.expectedBenefit(orderValue, edgePct);
      const costs = this.engine.estimateCosts({
        orderValue,
        accountCurrency: snapshot.currency,
        instrumentCurrency: currency,
        action,
        ticker: intent.ticker,
      });

      const source = String(params.meta?.agentName ?? "committee");
      const proposal: TradeProposal = {
        ticker: intent.ticker,
        action,
        quantity,
        estimatedPrice: price,
        estimatedValue: orderValue,
        currency,
        expectedBenefit,
        costEstimate: costs,
        edgePct,
        rationale: `${source} (committee): ${intent.reason}`,
        confidence,
      };
      const verdict = this.engine.evaluate(
        proposal,
        {
          portfolioHeat: runningHeat,
          portfolioTotalValue: snapshot.totalValue,
          availableCash,
          cooledTickers,
        },
        {
          llmCostPerRun,
          // What the run's net benefit would be if this order is approved.
          coverageAmount: roundValue(sessionNetBenefit + expectedBenefit - costs.total),
        },
      );
      // The heat the gate actually compared against `maxHeatPct`: the dashboard
      // renders `details.heat` as that check, so it must be the gate's input.
      const heatAtGate = runningHeat;

      if (verdict.approved && action === "BUY") {
        availableCash = roundValue(availableCash - orderValue);
        runningHeat = roundValue(runningHeat + orderValue / snapshot.totalValue);
      } else if (verdict.approved) {
        // A SELL releases cash and risk capital. Both are estimates — the gate
        // sizes the NEXT intent, it never relaxes an already-approved one.
        availableCash = roundValue(availableCash + orderValue);
        runningHeat = roundValue(Math.max(0, runningHeat - (position ? position.weight : 0)));
      }
      if (verdict.approved) {
        sessionNetBenefit = roundValue(sessionNetBenefit + expectedBenefit - costs.total);
      }

      decisions.push({
        id: newId("dec"),
        runId,
        ticker: intent.ticker,
        action: verdict.approved ? proposal.action : "HOLD",
        quantity: verdict.approved ? proposal.quantity : 0,
        approved: verdict.approved,
        reason: verdict.reason,
        proposal,
        decidedAt: now,
        details: {
          ...(params.meta ?? {}),
          orderValue,
          heat: heatAtGate,
          heatAfter: runningHeat,
          // Fractions, not money: 2 dp would round a 34 bp cost ratio to zero.
          signalStrength: roundTo(signalStrength, EDGE_DP),
          edgePct,
          costRatioPct: roundTo(costs.costRatio, EDGE_DP),
          netBenefit: roundValue(expectedBenefit - costs.total),
          sessionNetBenefit,
          llmCostPerRun,
        },
      });
    }

    for (const dec of decisions) await this.ports.decisions.save(dec);
    return decisions;
  }

  /**
   * Resolves price, FX rate and currency for a candidate trade: an existing
   * position prices itself, a SELL without a position is rejected, and a BUY
   * of a new ticker is priced live.
   */
  private async resolveOrderable(params: {
    runId: string;
    ticker: string;
    action: Exclude<TradeAction, "HOLD">;
    snapshot: PortfolioSnapshot;
    now: string;
    details: Record<string, unknown>;
  }): Promise<
    | { kind: "ok"; price: number; fxRate: number; currency: string; position: PositionWithValue | undefined }
    | { kind: "rejected"; decision: Decision }
  > {
    const { runId, ticker, action, snapshot, now } = params;
    const position = snapshot.positions.find((p) => p.ticker === ticker);
    if (position) {
      return { kind: "ok", price: position.currentPrice, fxRate: position.fxRate ?? 1, currency: position.currency, position };
    }
    if (action === "SELL") {
      return {
        kind: "rejected",
        decision: this.reject(runId, ticker, "INSTRUMENT_UNAVAILABLE", now, {
          ...params.details,
          reason: "cannot sell: ticker not held",
        }),
      };
    }
    try {
      const q = await this.ports.prices.quote(ticker);
      const currency = q.currency;
      const fxRate = currency === snapshot.currency ? 1 : await this.ports.fx.rate(currency, snapshot.currency);
      return { kind: "ok", price: q.price, fxRate, currency, position: undefined };
    } catch (err) {
      return {
        kind: "rejected",
        decision: this.reject(runId, ticker, "INSTRUMENT_UNAVAILABLE", now, {
          ...params.details,
          reason: `cannot price ${ticker}: ${String(err)}`,
        }),
      };
    }
  }

  private async cooledTickersFor(tickers: string[]): Promise<Set<string>> {
    if (this.cooldownMs <= 0) return new Set();
    const since = toIso(new Date(this.ports.clock.now().getTime() - this.cooldownMs));
    const out = new Set<string>();
    for (const ticker of tickers) {
      const recent = await this.ports.orders.recentByTicker(ticker, since);
      if (recent.length > 0) out.add(ticker);
    }
    return out;
  }

  private reject(
    runId: string,
    ticker: string,
    reason: DecisionReason,
    now: string,
    details: Record<string, unknown>,
  ): Decision {
    const emptyCosts: CostEstimate = { currency: "?", spread: 0, fxFee: 0, stampDuty: 0, platformFee: 0, total: 0, costRatio: 0 };
    return {
      id: newId("dec"),
      runId,
      ticker,
      action: "HOLD",
      quantity: 0,
      approved: false,
      reason,
      proposal: {
        ticker,
        action: "HOLD",
        quantity: 0,
        estimatedPrice: 0,
        estimatedValue: 0,
        currency: "?",
        expectedBenefit: 0,
        costEstimate: emptyCosts,
        rationale: String(details.reason ?? reason),
        confidence: 0,
      },
      decidedAt: now,
      details,
    };
  }
}
