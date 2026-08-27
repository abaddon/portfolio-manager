import { DomainError } from "../shared/errors.js";
import { roundValue } from "../shared/money.js";

export type TradeAction = "BUY" | "SELL" | "HOLD";

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
  maxOrderValue: number;
  maxHeatPct: number; // portfolio heat cap (fraction of NAV, 0..1)
  minExpectedBenefitPct: number; // minimum expected benefit as fraction of order value
  costBenefitMultiplier: number; // expected benefit must exceed costs × this
  maxOrdersPerRun: number;
  tickerCooldownDays: number;
  /** Minimum aggregated analyst conviction required to trade, 0..1. */
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
  cash: number;
  /** Tickers traded within the cooldown window. */
  cooledTickers: ReadonlySet<string>;
}

/**
 * Decision domain service: turns a proposal into an economically evaluated
 * decision. Pure and fully unit-testable.
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

  estimateCosts(params: {
    orderValue: number;
    accountCurrency: string;
    instrumentCurrency: string;
    action: Exclude<TradeAction, "HOLD">;
    ticker: string;
  }): CostEstimate {
    const { orderValue, accountCurrency, instrumentCurrency, action } = params;
    const spread = roundValue((this.costModel.spreadBps / 10_000) * orderValue);
    const fxApplies = accountCurrency !== instrumentCurrency;
    const fxFee = fxApplies ? roundValue(this.costModel.fxFeePct * orderValue) : 0;
    const ukListed = params.ticker.toUpperCase().endsWith(".L");
    const stampDuty = action === "BUY" && ukListed ? roundValue(this.costModel.stampDutyPct * orderValue) : 0;
    const platformFee = roundValue(this.costModel.platformFeePct * orderValue);
    return {
      currency: accountCurrency,
      spread,
      fxFee,
      stampDuty,
      platformFee,
      total: roundValue(spread + fxFee + stampDuty + platformFee),
    };
  }

  /**
   * The economic-correctness gate, applied to every trade, in this order:
   *  1. HOLD is always approved;
   *  2. quantity > 0 (OPPORTUNITY_TOO_SMALL);
   *  3. aggregated confidence ≥ minConfidence (NO_CONVICTION);
   *  4. order value ≤ maxOrderValue (RISK_LIMIT_EXCEEDED);
   *  5. no churn: ticker outside its cooldown window (COOLDOWN_ACTIVE);
   *  6. expected benefit ≥ minExpectedBenefitPct × order value (OPPORTUNITY_TOO_SMALL);
   *  7. expected benefit ≥ costs × costBenefitMultiplier (COST_EXCEEDS_BENEFIT);
   *  8. BUY only: cash available (INSUFFICIENT_CASH) and post-trade heat under
   *     the cap (RISK_LIMIT_EXCEEDED). See docs/DECISION_PROCESS.md §6.4.
   */
  evaluate(proposal: TradeProposal, ctx: DecisionContext): { approved: boolean; reason: DecisionReason } {
    if (proposal.action === "HOLD") return { approved: true, reason: "ECONOMICALLY_VIABLE" };
    if (proposal.quantity <= 0) return { approved: false, reason: "OPPORTUNITY_TOO_SMALL" };
    if (proposal.confidence < this.riskLimits.minConfidence) return { approved: false, reason: "NO_CONVICTION" };
    if (proposal.estimatedValue > this.riskLimits.maxOrderValue) {
      return { approved: false, reason: "RISK_LIMIT_EXCEEDED" };
    }
    if (ctx.cooledTickers.has(proposal.ticker)) return { approved: false, reason: "COOLDOWN_ACTIVE" };

    const minBenefit = this.riskLimits.minExpectedBenefitPct * proposal.estimatedValue;
    if (proposal.expectedBenefit < minBenefit) {
      return { approved: false, reason: "OPPORTUNITY_TOO_SMALL" };
    }
    const costFloor = proposal.costEstimate.total * this.riskLimits.costBenefitMultiplier;
    if (proposal.expectedBenefit < costFloor) {
      return { approved: false, reason: "COST_EXCEEDS_BENEFIT" };
    }
    if (proposal.action === "BUY") {
      if (proposal.estimatedValue > ctx.cash) return { approved: false, reason: "INSUFFICIENT_CASH" };
      const valueFraction = ctx.portfolioTotalValue > 0 ? proposal.estimatedValue / ctx.portfolioTotalValue : 1;
      if (ctx.portfolioHeat + valueFraction > this.riskLimits.maxHeatPct) {
        return { approved: false, reason: "RISK_LIMIT_EXCEEDED" };
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
