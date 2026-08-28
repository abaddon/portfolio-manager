import { newId } from "../../shared/id.js";
import { toIso } from "../../shared/clock.js";
import { clamp, roundValue } from "../../shared/money.js";
import type { AnalysisReport } from "../../domain/analysis.js";
import { DecisionEngine, type CostEstimate, type Decision, type DecisionReason, type TradeAction, type TradeProposal } from "../../domain/decision.js";
import type { AllocationDrift, PortfolioSnapshot, PositionWithValue } from "../../domain/portfolio.js";
import type { AppPorts } from "../ports.js";

export interface DecisionServiceConfig {
  /** Analyst weights used to aggregate the four reports into one signal. */
  analystWeights?: Record<string, number>;
  /** |signal| below this is ignored when the ticker is inside its rebalance band. */
  signalThreshold?: number;
  /** Smallest order value worth trading (account currency). */
  minTradeValue?: number;
  /** Assumed return the trade unlocks, as % of order value. */
  expectedReturnPerTradePct?: number;
  /** Anti-churn: skip tickers traded within this many days. */
  tickerCooldownDays?: number;
}

const DEFAULT_WEIGHTS: Record<string, number> = {
  market: 0.25,
  sentiment: 0.2,
  news: 0.15,
  fundamentals: 0.4,
};

export { DEFAULT_WEIGHTS };

/** A trade the committee (or another alternative source) wants gated and executed. */
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
 * Aggregates the four analyst reports per ticker, combines them with the
 * allocation drift, sizes the trade, and passes every proposal through the
 * economic gate (DecisionEngine). Persists the final decisions.
 */
export class DecisionService {
  private readonly weights: Record<string, number>;
  private readonly signalThreshold: number;
  private readonly minTradeValue: number;
  private readonly expectedReturn: number;
  private readonly cooldownMs: number;

  constructor(
    private readonly ports: AppPorts,
    private readonly engine: DecisionEngine,
    cfg: DecisionServiceConfig = {},
  ) {
    this.weights = { ...DEFAULT_WEIGHTS, ...cfg.analystWeights };
    this.signalThreshold = cfg.signalThreshold ?? 0.05;
    this.minTradeValue = cfg.minTradeValue ?? 10;
    this.expectedReturn = (cfg.expectedReturnPerTradePct ?? 0.5) / 100;
    this.cooldownMs = (cfg.tickerCooldownDays ?? engine.tickerCooldownDays) * 86_400_000;
  }

  async decide(params: {
    runId: string;
    snapshot: PortfolioSnapshot;
    drift: AllocationDrift[];
    reports: AnalysisReport[];
    heat: number;
  }): Promise<Decision[]> {
    const { snapshot, drift, reports, heat } = params;
    const now = toIso(this.ports.clock.now());

    const byTicker = new Map<string, AnalysisReport[]>();
    for (const r of reports) {
      const list = byTicker.get(r.ticker) ?? [];
      list.push(r);
      byTicker.set(r.ticker, list);
    }

    const cooledTickers = await this.cooledTickersFor(drift.map((d) => d.ticker));

    const decisions: Decision[] = [];
    for (const d of drift) {
      const tickerReports = byTicker.get(d.ticker) ?? [];
      const signal = this.aggregate(tickerReports, this.weights);

      const actionable = !d.insideBand || Math.abs(signal) >= this.signalThreshold;
      if (!actionable) continue; // nothing to decide; silence keeps the decision trail readable

      // The drift hint sets the direction; inside the band (hint "hold") the
      // ticker is actionable only because of a strong signal, so the signal's
      // sign decides: bullish adds, bearish trims.
      const action: Exclude<TradeAction, "HOLD"> =
        d.hint === "buy" ? "BUY" : d.hint === "sell" ? "SELL" : signal > 0 ? "BUY" : "SELL";

      const pricing = await this.resolveOrderable({
        runId: params.runId,
        ticker: d.ticker,
        action,
        snapshot,
        now,
        details: { drift: d.drift, signal },
      });
      if (pricing.kind === "rejected") {
        decisions.push(pricing.decision);
        continue;
      }
      const { price, fxRate, currency, position } = pricing;

      // Direction veto: strong analyst disagreement blocks the rebalance move.
      // (signal × direction) < -threshold means the signal points against the trade.
      const direction = action === "BUY" ? 1 : -1;
      if (direction * signal < -this.signalThreshold) {
        decisions.push(this.reject(params.runId, d.ticker, "NO_CONVICTION", now, {
          drift: d.drift,
          signal,
          reason: `analyst signal ${signal.toFixed(3)} opposes the ${action.toLowerCase()} rebalance`,
        }));
        continue;
      }

      // Size: fix the drift, then let the signal adjust within bounds.
      const baseValue = Math.abs(d.drift) * snapshot.totalValue;
      const signalBoost = (action === "BUY" ? signal : -signal) * snapshot.totalValue * 0.5;
      const proposedValue = clamp(
        roundValue(baseValue + signalBoost),
        this.minTradeValue,
        this.engine.maxOrderValue,
      );
      let quantity = roundValue(proposedValue / (price * fxRate), 4);
      if (action === "SELL" && position) {
        quantity = Math.min(quantity, roundValue(position.quantity, 4));
      }
      if (quantity <= 0) {
        decisions.push(this.reject(params.runId, d.ticker, "OPPORTUNITY_TOO_SMALL", now, {
          drift: d.drift,
          signal,
          reason: "computed trade quantity is zero",
        }));
        continue;
      }
      // Rounding can nudge the value just over the cap — rescale instead of rejecting.
      if (quantity * price * fxRate > this.engine.maxOrderValue && price > 0 && fxRate > 0) {
        quantity = roundValue(this.engine.maxOrderValue / (price * fxRate), 4);
      }
      const orderValue = roundValue(Math.min(quantity * price * fxRate, this.engine.maxOrderValue));

      const confidence = this.aggregateConfidence(tickerReports, this.weights);
      const expectedBenefit = roundValue(orderValue * this.expectedReturn * (0.5 + 0.5 * confidence));
      const costs = this.engine.estimateCosts({
        orderValue,
        accountCurrency: snapshot.currency,
        instrumentCurrency: currency,
        action,
        ticker: d.ticker,
      });

      const proposal: TradeProposal = {
        ticker: d.ticker,
        action,
        quantity,
        estimatedPrice: price,
        estimatedValue: orderValue,
        currency,
        expectedBenefit,
        costEstimate: costs,
        rationale: this.rationale(d, signal, tickerReports, costs),
        confidence,
      };
      const verdict = this.engine.evaluate(proposal, {
        portfolioHeat: heat,
        portfolioTotalValue: snapshot.totalValue,
        cash: snapshot.cash,
        cooledTickers,
      });

      decisions.push({
        id: newId("dec"),
        runId: params.runId,
        ticker: d.ticker,
        action: verdict.approved ? proposal.action : "HOLD",
        quantity: verdict.approved ? proposal.quantity : 0,
        approved: verdict.approved,
        reason: verdict.reason,
        proposal,
        decidedAt: now,
        details: { drift: d.drift, signal, heat },
      });
    }

    for (const dec of decisions) await this.ports.decisions.save(dec);
    return decisions;
  }

  /**
   * Gates and persists explicit order intents (e.g. the winning asset
   * allocation committee proposal). Unlike `decide`, there is no drift or
   * analyst-signal logic — the intent already says what to trade — but every
   * intent passes the exact same economic gate (DecisionEngine.evaluate).
   */
  async decideFromOrders(params: {
    runId: string;
    snapshot: PortfolioSnapshot;
    heat: number;
    intents: OrderIntent[];
    meta?: Record<string, unknown>;
  }): Promise<Decision[]> {
    const { runId, snapshot, heat, intents } = params;
    const now = toIso(this.ports.clock.now());
    const cooledTickers = await this.cooledTickersFor(intents.map((i) => i.ticker));

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
      if (quantity * price * fxRate > this.engine.maxOrderValue && price > 0 && fxRate > 0) {
        quantity = roundValue(this.engine.maxOrderValue / (price * fxRate), 4);
      }
      const orderValue = roundValue(Math.min(quantity * price * fxRate, this.engine.maxOrderValue));

      const confidence = clamp(intent.confidence, 0, 1);
      const expectedBenefit = roundValue(orderValue * this.expectedReturn * (0.5 + 0.5 * confidence));
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
        rationale: `${source} (committee): ${intent.reason}`,
        confidence,
      };
      const verdict = this.engine.evaluate(proposal, {
        portfolioHeat: heat,
        portfolioTotalValue: snapshot.totalValue,
        cash: snapshot.cash,
        cooledTickers,
      });

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
        details: { ...(params.meta ?? {}), orderValue, heat },
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

  private aggregate(reports: AnalysisReport[], weights: Record<string, number>): number {
    let totalWeight = 0;
    let weighted = 0;
    for (const r of reports) {
      const w = weights[r.analyst] ?? 0.25;
      totalWeight += w;
      weighted += r.signals.targetWeightAdjustment * w;
    }
    return totalWeight > 0 ? roundValue(weighted / totalWeight, 4) : 0;
  }

  private aggregateConfidence(reports: AnalysisReport[], weights: Record<string, number>): number {
    let totalWeight = 0;
    let weighted = 0;
    for (const r of reports) {
      const w = weights[r.analyst] ?? 0.25;
      totalWeight += w;
      weighted += r.signals.confidence * w;
    }
    return totalWeight > 0 ? roundValue(weighted / totalWeight, 4) : 0;
  }

  private rationale(
    d: AllocationDrift,
    signal: number,
    reports: AnalysisReport[],
    costs: CostEstimate,
  ): string {
    const summaries = reports
      .map((r) => `${r.analyst}: ${r.conclusion} (conf ${r.confidence.toFixed(2)})`)
      .join("; ");
    return [
      `Allocation drift ${(d.drift * 100).toFixed(2)}% (target ${(d.targetWeight * 100).toFixed(1)}%, current ${(d.currentWeight * 100).toFixed(1)}%).`,
      `Aggregated analyst signal ${signal >= 0 ? "+" : ""}${signal.toFixed(3)}.`,
      summaries ? `Analysts — ${summaries}.` : "",
      `Estimated costs: total ${costs.total.toFixed(2)} (fx ${costs.fxFee.toFixed(2)}, spread ${costs.spread.toFixed(2)}, stamp duty ${costs.stampDuty.toFixed(2)}).`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  private reject(
    runId: string,
    ticker: string,
    reason: DecisionReason,
    now: string,
    details: Record<string, unknown>,
  ): Decision {
    const emptyCosts: CostEstimate = { currency: "?", spread: 0, fxFee: 0, stampDuty: 0, platformFee: 0, total: 0 };
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
