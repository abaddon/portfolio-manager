import { newId } from "../../shared/id.js";
import { toIso } from "../../shared/clock.js";
import { clamp, roundValue } from "../../shared/money.js";
import { DecisionEngine, type CostEstimate, type Decision, type DecisionReason, type TradeAction, type TradeProposal } from "../../domain/decision.js";
import type { PortfolioSnapshot, PositionWithValue } from "../../domain/portfolio.js";
import type { AppPorts } from "../ports.js";

export interface DecisionServiceConfig {
  /** Assumed return the trade unlocks, as % of order value. */
  expectedReturnPerTradePct?: number;
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
 * The decision step of the unified committee flow (ADR 0009): prices the
 * winning committee proposal's order intents and passes every one through the
 * economic gate (DecisionEngine.evaluate). There is no drift or
 * analyst-signal logic — the committee already decided what to trade — but
 * every intent meets the exact same gates every order has always met.
 */
export class DecisionService {
  private readonly expectedReturn: number;
  private readonly cooldownMs: number;

  constructor(
    private readonly ports: AppPorts,
    private readonly engine: DecisionEngine,
    cfg: DecisionServiceConfig = {},
  ) {
    this.expectedReturn = (cfg.expectedReturnPerTradePct ?? 0.5) / 100;
    this.cooldownMs = (cfg.tickerCooldownDays ?? engine.tickerCooldownDays) * 86_400_000;
  }

  async decide(params: {
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
