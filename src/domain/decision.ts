import { DomainError } from "../shared/errors.js";
import { EDGE_DP, roundTo, roundValue } from "../shared/money.js";

export type TradeAction = "BUY" | "SELL" | "HOLD";

/**
 * Tolerance for the edge-vs-cost comparison. Both sides come from rounded
 * money amounts, so a signal whose edge sits exactly on the required multiple
 * must clear rather than flip on binary representation (0.0069 vs 0.0068).
 */
const COST_EPSILON = 1e-9;

export interface CostEstimate {
  currency: string;
  /** Estimated spread cost (half-spread × order value). */
  spread: number;
  /** FX conversion fee when instrument currency differs from account currency. */
  fxFee: number;
  /** Stamp duty for UK-listed buys. */
  stampDuty: number;
  platformFee: number;
  total: number;
  /**
   * Cost as a fraction of the order value, for the position's whole life
   * (entry **and** exit): `2 × spread + 2 × fxFee + stampDuty + 2 × platformFee`.
   * This is what a rebalance actually destroys — the gate compares the assumed
   * edge against this, not against the one-way cost.
   */
  costRatio: number;
}

export interface TradeProposal {
  ticker: string;
  action: TradeAction;
  /** Quantity to trade; for HOLD proposals always 0. */
  quantity: number;
  estimatedPrice: number;
  estimatedValue: number;
  currency: string;
  /** Estimated benefit of executing, in account currency. */
  expectedBenefit: number;
  costEstimate: CostEstimate;
  /** Assumed edge of the trade as a fraction of order value (see `computeEdgePct`). */
  edgePct?: number;
  /** Why this proposal was formed: analysis summary + drift numbers. */
  rationale: string;
  confidence: number; // 0..1
}

export type DecisionReason =
  | "ECONOMICALLY_VIABLE"
  | "OPPORTUNITY_TOO_SMALL"
  | "COST_EXCEEDS_BENEFIT"
  | "RISK_LIMIT_EXCEEDED"
  | "NO_CONVICTION"
  | "INSUFFICIENT_CASH"
  | "MARKET_CLOSED"
  | "INSTRUMENT_UNAVAILABLE"
  | "INSTRUMENT_UNECONOMIC"
  | "COOLDOWN_ACTIVE";

export interface Decision {
  id: string;
  runId: string;
  ticker: string;
  action: TradeAction;
  quantity: number;
  approved: boolean;
  reason: DecisionReason;
  proposal: TradeProposal;
  decidedAt: string;
  details: Record<string, unknown>;
}

export interface RiskLimits {
  /** Hard cap on a single order's value, in account currency. */
  maxOrderValue: number;
  /** Cap on order value as a fraction of NAV (0 = disabled). */
  maxOrderValuePct: number;
  /** Orders below this value never repay their fixed costs (0 = disabled). */
  minOrderValue: number;
  maxHeatPct: number; // portfolio heat cap (fraction of NAV, 0..1)
  /** Assumed edge at full signal strength, as a fraction of order value. */
  baseEdgePct: number;
  /** Hard ceiling on the assumed edge (0 = disabled), fraction of order value. */
  maxEdgePct: number;
  /** Net benefit (after round-trip costs) must reach this fraction of order value. */
  minNetBenefitPct: number;
  /** Session net benefit must cover the run's LLM cost × this (0 = disabled). */
  llmCostBenefitMultiplier: number;
  /** Assumed edge must exceed the round-trip cost ratio × this. */
  costBenefitMultiplier: number;
  maxOrdersPerRun: number;
  tickerCooldownDays: number;
  /** Minimum winner confidence required to trade, 0..1. */
  minConfidence: number;
}

export interface CostModel {
  spreadBps: number;
  fxFeePct: number;
  stampDutyPct: number;
  platformFeePct: number;
}

export interface DecisionContext {
  /** Portfolio heat: fraction of NAV at risk before this trade, 0..1. */
  portfolioHeat: number;
  /** Total portfolio value in account currency. */
  portfolioTotalValue: number;
  /** Available cash in account currency. */
  availableCash: number;
  /** Tickers traded within the cooldown window. */
  cooledTickers: ReadonlySet<string>;
}

/**
 * Run-scoped economics the gate needs beyond the portfolio state (ADR 0011/0012).
 * The caller computes `coverageAmount` (this trade's net benefit plus the net
 * benefit already approved in the run) so this check stays a pure function of
 * its inputs — the gate never has to read mutable run state.
 */
export interface RunEconomics {
  /** Estimated LLM cost of producing this run's decisions, in account currency. */
  llmCostPerRun: number;
  /** Net benefit the run has booked if this trade is approved, in account currency. */
  coverageAmount: number;
}

/**
 * Decision domain service: turns a proposal into an economically evaluated
 * decision. Pure and fully unit-testable.
 *
 * The gate is size-aware and edge-honest: the assumed edge comes from the
 * research (`computeEdgePct`), the cost side is the position's **round trip**
 * (entry + exit), and an order must clear a net-benefit floor after costs and
 * contribute to covering the run's inference cost. See ADR 0012 and
 * docs/DECISION_PROCESS.md §6.
 */
export class DecisionEngine {
  constructor(
    private readonly costModel: CostModel,
    private readonly riskLimits: RiskLimits,
  ) {}

  get maxOrderValue(): number {
    return this.riskLimits.maxOrderValue;
  }

  get tickerCooldownDays(): number {
    return this.riskLimits.tickerCooldownDays;
  }

  /**
   * Costs of a position's whole life. Spread, platform fee and FX conversion
   * are paid on the way in **and** on the way out; UK stamp duty is charged on
   * the buy leg only. `costRatio` is the fraction of the order value they add
   * up to — the gate's cost input.
   */
  estimateCosts(params: {
    orderValue: number;
    accountCurrency: string;
    instrumentCurrency: string;
    action: Exclude<TradeAction, "HOLD">;
    ticker: string;
  }): CostEstimate {
    const { orderValue } = params;
    // Ratios (exact, size-independent) …
    const ratio = this.costRatios(params);
    // … and the money amounts, rounded for display and persistence. The ratio is
    // deliberately NOT derived from the rounded amounts: at a £25 order, 2 dp
    // rounding turns a 2 bp spread into 0 and the gate would then compare the
    // edge against a cost that no longer exists.
    const total = roundValue(ratio.total * orderValue);
    return {
      currency: params.accountCurrency,
      spread: roundValue(ratio.spread * orderValue),
      fxFee: roundValue(ratio.fxFee * orderValue),
      stampDuty: roundValue(ratio.stampDuty * orderValue),
      platformFee: roundValue(ratio.platformFee * orderValue),
      total,
      costRatio: ratio.total,
    };
  }

  /** Per-instrument cost ratios (fractions of the order value) — the gate's inputs. */
  private costRatios(params: {
    accountCurrency: string;
    instrumentCurrency: string;
    action: Exclude<TradeAction, "HOLD">;
    ticker: string;
  }): { spread: number; fxFee: number; stampDuty: number; platformFee: number; total: number } {
    const spread = this.costModel.spreadBps / 10_000;
    const fxFee = params.accountCurrency !== params.instrumentCurrency ? this.costModel.fxFeePct : 0;
    const ukListed = params.ticker.toUpperCase().endsWith(".L");
    const stampDuty = params.action === "BUY" && ukListed ? this.costModel.stampDutyPct : 0;
    const platformFee = this.costModel.platformFeePct;
    // Round trip: every proportional cost is paid twice except stamp duty.
    return { spread, fxFee, stampDuty, platformFee, total: 2 * spread + 2 * fxFee + stampDuty + 2 * platformFee };
  }

  /**
   * The per-instrument cost ratio the gate compares the assumed edge against.
   * Size-independent: every modelled cost is proportional to the order value
   * (stamp duty included, since it applies to the buy leg only).
   */
  roundTripCostRatio(params: {
    accountCurrency: string;
    instrumentCurrency: string;
    action: Exclude<TradeAction, "HOLD">;
    ticker: string;
  }): number {
    return this.costRatios(params).total;
  }

  /**
   * Assumed edge as a fraction of order value, from the research signal: full
   * signal strength assumes `baseEdgePct`, scaled linearly and capped at
   * `maxEdgePct`. Signal strength blends the analysts' recommended weight
   * changes (weighted by their own confidence) with the winning proposal's
   * confidence — see `DecisionService` for how it is computed.
   */
  computeEdgePct(signalStrength: number): number {
    const strength = Math.min(Math.max(signalStrength, 0), 1);
    const raw = strength * this.riskLimits.baseEdgePct;
    const cap = this.riskLimits.maxEdgePct > 0 ? this.riskLimits.maxEdgePct : Number.POSITIVE_INFINITY;
    return roundTo(Math.min(raw, cap), EDGE_DP);
  }

  /** Expected benefit of an order at the assumed edge, in account currency. */
  expectedBenefit(orderValue: number, edgePct: number): number {
    return roundValue(orderValue * edgePct);
  }

  /** Upper bound for a single order: the configured cap and the NAV fraction. */
  maxViableOrder(portfolioTotalValue: number): number {
    const byNav =
      this.riskLimits.maxOrderValuePct > 0 && portfolioTotalValue > 0
        ? this.riskLimits.maxOrderValuePct * portfolioTotalValue
        : Number.POSITIVE_INFINITY;
    return Math.min(this.riskLimits.maxOrderValue, byNav);
  }

  /**
   * The economic-correctness gate, applied to every trade, in this order:
   *  1. HOLD is always approved;
   *  2. quantity > 0 (OPPORTUNITY_TOO_SMALL);
   *  3. confidence ≥ minConfidence (NO_CONVICTION);
   *  4. order value within [minOrderValue, maxViableOrder] (INSTRUMENT_UNECONOMIC /
   *     RISK_LIMIT_EXCEEDED) — the smallest size that pays for its own costs;
   *  5. net benefit (benefit − round-trip costs) ≥ minNetBenefitPct × order value
   *     (OPPORTUNITY_TOO_SMALL);
   *  6. the assumed edge must beat the round trip: `edge ≥ costRatio × costBenefitMultiplier`
   *     (COST_EXCEEDS_BENEFIT) — the ratio test, so a structurally marginal
   *     instrument is refused at any size;
   *  7. no churn: ticker outside its cooldown window (COOLDOWN_ACTIVE);
   *  8. BUY only: cash available (INSUFFICIENT_CASH) and post-trade heat under the
   *     cap (RISK_LIMIT_EXCEEDED). SELLs have no cash/heat check;
   *  9. the run's LLM cost must be covered by the session's net benefit
   *     (COST_EXCEEDS_BENEFIT) — inference is a cost of trading too.
   * See docs/DECISION_PROCESS.md §6.4.
   */
  evaluate(proposal: TradeProposal, ctx: DecisionContext, economics?: RunEconomics): { approved: boolean; reason: DecisionReason } {
    if (proposal.action === "HOLD") return { approved: true, reason: "ECONOMICALLY_VIABLE" };
    if (proposal.quantity <= 0) return { approved: false, reason: "OPPORTUNITY_TOO_SMALL" };
    if (proposal.confidence < this.riskLimits.minConfidence) return { approved: false, reason: "NO_CONVICTION" };

    const maxViable = this.maxViableOrder(ctx.portfolioTotalValue);
    if (proposal.estimatedValue > maxViable) return { approved: false, reason: "RISK_LIMIT_EXCEEDED" };
    if (this.riskLimits.minOrderValue > 0 && proposal.estimatedValue < this.riskLimits.minOrderValue) {
      return { approved: false, reason: "INSTRUMENT_UNECONOMIC" };
    }

    // Is this trade worth doing at all? Two size-aware tests, in the order the
    // operator reads them: does the money left on the table justify the trade
    // (net floor), and does the assumed edge beat the round trip by the required
    // margin (ratio test)? Both are needed — the first protects small orders
    // whose fixed costs eat the benefit, the second refuses structurally
    // marginal instruments at any size.
    const netBenefit = roundValue(proposal.expectedBenefit - proposal.costEstimate.total);
    if (netBenefit < this.riskLimits.minNetBenefitPct * proposal.estimatedValue) {
      return { approved: false, reason: "OPPORTUNITY_TOO_SMALL" };
    }
    const edgePct = proposal.edgePct ?? 0;
    const costRatio = proposal.costEstimate.costRatio;
    if (edgePct < costRatio * this.riskLimits.costBenefitMultiplier - COST_EPSILON) {
      return { approved: false, reason: "COST_EXCEEDS_BENEFIT" };
    }

    if (ctx.cooledTickers.has(proposal.ticker)) return { approved: false, reason: "COOLDOWN_ACTIVE" };

    if (proposal.action === "BUY") {
      if (proposal.estimatedValue > ctx.availableCash) return { approved: false, reason: "INSUFFICIENT_CASH" };
      const valueFraction = ctx.portfolioTotalValue > 0 ? proposal.estimatedValue / ctx.portfolioTotalValue : 1;
      if (ctx.portfolioHeat + valueFraction > this.riskLimits.maxHeatPct) {
        return { approved: false, reason: "RISK_LIMIT_EXCEEDED" };
      }
    }

    if (economics && this.riskLimits.llmCostBenefitMultiplier > 0) {
      if (economics.coverageAmount < economics.llmCostPerRun * this.riskLimits.llmCostBenefitMultiplier) {
        return { approved: false, reason: "COST_EXCEEDS_BENEFIT" };
      }
    }
    return { approved: true, reason: "ECONOMICALLY_VIABLE" };
  }

  requireEconomicViability(decision: Decision): void {
    if (!decision.approved) {
      throw new DomainError(`decision ${decision.id} for ${decision.ticker} was not approved (${decision.reason})`);
    }
  }
}
