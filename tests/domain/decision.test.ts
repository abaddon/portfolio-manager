import { describe, expect, it } from "vitest";
import { DecisionEngine, type CostModel, type RiskLimits, type TradeProposal } from "../../src/domain/decision.js";

const costModel: CostModel = {
  spreadBps: 2,
  fxFeePct: 0.0015, // Trading212 Invest FX fee
  stampDutyPct: 0.005, // UK stamp duty
  platformFeePct: 0,
};

const risk: RiskLimits = {
  maxOrderValue: 500,
  maxOrderValuePct: 0,
  minOrderValue: 25,
  maxHeatPct: 0.12,
  baseEdgePct: 0.01,
  maxEdgePct: 0.02,
  minNetBenefitPct: 0.0005,
  llmCostBenefitMultiplier: 1,
  costBenefitMultiplier: 2,
  maxOrdersPerRun: 3,
  tickerCooldownDays: 2,
  minConfidence: 0.6,
};

/** An 8% edge clears the 0.34% round trip by a wide margin; the tests below vary one input at a time. */
function proposal(over: Partial<TradeProposal> = {}): TradeProposal {
  return {
    ticker: "AAPL",
    action: "BUY",
    quantity: 1,
    estimatedPrice: 200,
    estimatedValue: 200,
    currency: "USD",
    expectedBenefit: 16,
    edgePct: 0.08,
    costEstimate: { currency: "GBP", spread: 0.04, fxFee: 0.3, stampDuty: 0, platformFee: 0, total: 0.68, costRatio: 0.0034 },
    rationale: "",
    confidence: 0.7,
    ...over,
  };
}

const ctx = {
  portfolioHeat: 0.05,
  portfolioTotalValue: 10_000,
  availableCash: 2_000,
  cooledTickers: new Set<string>(),
};

describe("DecisionEngine.estimateCosts", () => {
  const engine = new DecisionEngine(costModel, risk);

  it("applies the 0.15% FX fee only when instrument currency differs from account", () => {
    const gbp = engine.estimateCosts({ orderValue: 1000, accountCurrency: "GBP", instrumentCurrency: "USD", action: "BUY", ticker: "AAPL" });
    expect(gbp.fxFee).toBeCloseTo(1.5, 2);
    const usd = engine.estimateCosts({ orderValue: 1000, accountCurrency: "USD", instrumentCurrency: "USD", action: "BUY", ticker: "AAPL" });
    expect(usd.fxFee).toBe(0);
  });

  it("applies 0.5% stamp duty on UK-listed buys only", () => {
    const uk = engine.estimateCosts({ orderValue: 1000, accountCurrency: "GBP", instrumentCurrency: "GBP", action: "BUY", ticker: "VUSA.L" });
    expect(uk.stampDuty).toBeCloseTo(5, 2);
    const ukSell = engine.estimateCosts({ orderValue: 1000, accountCurrency: "GBP", instrumentCurrency: "GBP", action: "SELL", ticker: "VUSA.L" });
    expect(ukSell.stampDuty).toBe(0);
    const us = engine.estimateCosts({ orderValue: 1000, accountCurrency: "GBP", instrumentCurrency: "USD", action: "BUY", ticker: "AAPL" });
    expect(us.stampDuty).toBe(0);
  });

  it("charges both legs: the total is the round trip, not a single fill", () => {
    const e = engine.estimateCosts({ orderValue: 1000, accountCurrency: "GBP", instrumentCurrency: "USD", action: "SELL", ticker: "AAPL" });
    expect(e.spread).toBeCloseTo(0.2, 2); // 2bps on this leg
    expect(e.fxFee).toBeCloseTo(1.5, 2); // on this leg
    expect(e.total).toBeCloseTo(2 * 0.2 + 2 * 1.5, 2); // spread + FX on entry AND exit
    expect(e.costRatio).toBeCloseTo(0.0034, 6);
  });

  it("adds stamp duty once (buy leg only) to the round trip", () => {
    const buy = engine.estimateCosts({ orderValue: 1000, accountCurrency: "GBP", instrumentCurrency: "GBP", action: "BUY", ticker: "VUSA.L" });
    const sell = engine.estimateCosts({ orderValue: 1000, accountCurrency: "GBP", instrumentCurrency: "GBP", action: "SELL", ticker: "VUSA.L" });
    expect(buy.total - sell.total).toBeCloseTo(5, 2); // 0.5% of 1000, charged once
  });

  it("exposes the same ratio through roundTripCostRatio (size-independent)", () => {
    expect(
      engine.roundTripCostRatio({ accountCurrency: "GBP", instrumentCurrency: "USD", action: "BUY", ticker: "AAPL" }),
    ).toBeCloseTo(0.0034, 6);
  });
});

describe("DecisionEngine edge model", () => {
  const engine = new DecisionEngine(costModel, risk);

  it("scales the assumed edge with the signal strength, capped at maxEdgePct", () => {
    expect(engine.computeEdgePct(0)).toBe(0);
    expect(engine.computeEdgePct(0.5)).toBeCloseTo(0.005, 6); // 0.5 × baseEdgePct 1%
    expect(engine.computeEdgePct(1)).toBeCloseTo(0.01, 6);
    expect(engine.computeEdgePct(1.5)).toBeCloseTo(0.01, 6); // clamped to full strength
    expect(engine.computeEdgePct(-1)).toBe(0);
  });

  it("honours maxEdgePct as a hard ceiling", () => {
    const capped = new DecisionEngine(costModel, { ...risk, baseEdgePct: 0.5, maxEdgePct: 0.02 });
    expect(capped.computeEdgePct(1)).toBeCloseTo(0.02, 6);
  });

  it("computes the benefit from the edge and bounds the order size", () => {
    expect(engine.expectedBenefit(1000, 0.012)).toBeCloseTo(12, 2);
    expect(engine.maxViableOrder(10_000)).toBe(500); // configured maxOrderValue
    const byNav = new DecisionEngine(costModel, { ...risk, maxOrderValue: 5000, maxOrderValuePct: 0.1 });
    expect(byNav.maxViableOrder(10_000)).toBe(1000); // 10% of NAV wins over the wider cap
  });
});

describe("DecisionEngine.evaluate (economic-correctness gate)", () => {
  const engine = new DecisionEngine(costModel, risk);

  it("approves a viable trade", () => {
    expect(engine.evaluate(proposal(), ctx)).toEqual({ approved: true, reason: "ECONOMICALLY_VIABLE" });
  });

  it("rejects an edge that does not beat the round trip by the required multiple (COST_EXCEEDS_BENEFIT)", () => {
    // costRatio 0.34% × multiplier 2 = 0.68% required; a 0.5% edge is short.
    const p = proposal({ edgePct: 0.005, expectedBenefit: 1 });
    expect(engine.evaluate(p, ctx)).toEqual({ approved: false, reason: "COST_EXCEEDS_BENEFIT" });
  });

  it("rejects an order too small to repay its costs (INSTRUMENT_UNECONOMIC)", () => {
    const p = proposal({ estimatedValue: 20, expectedBenefit: 1.6 });
    expect(engine.evaluate(p, ctx)).toEqual({ approved: false, reason: "INSTRUMENT_UNECONOMIC" });
  });

  it("rejects when the net benefit misses the floor (OPPORTUNITY_TOO_SMALL)", () => {
    // Benefit barely above zero: edge passes the cost test, net benefit does not.
    const p = proposal({ edgePct: 0.007, expectedBenefit: 0.6, estimatedValue: 200 });
    expect(engine.evaluate(p, ctx)).toEqual({ approved: false, reason: "OPPORTUNITY_TOO_SMALL" });
  });

  it("rejects oversized orders (RISK_LIMIT_EXCEEDED)", () => {
    const p = proposal({ estimatedValue: 501 });
    expect(engine.evaluate(p, ctx)).toEqual({ approved: false, reason: "RISK_LIMIT_EXCEEDED" });
  });

  it("rejects an order above the NAV fraction even when under maxOrderValue", () => {
    const byNav = new DecisionEngine(costModel, { ...risk, maxOrderValue: 5000, maxOrderValuePct: 0.01 });
    const p = proposal({ estimatedValue: 200 }); // 2% of 10 000 NAV > 1%
    expect(byNav.evaluate(p, ctx)).toEqual({ approved: false, reason: "RISK_LIMIT_EXCEEDED" });
  });

  it("rejects low-conviction proposals (NO_CONVICTION)", () => {
    expect(engine.evaluate(proposal({ confidence: 0.3 }), ctx)).toEqual({ approved: false, reason: "NO_CONVICTION" });
  });

  it("rejects buys exceeding available cash (INSUFFICIENT_CASH)", () => {
    expect(engine.evaluate(proposal({ estimatedValue: 200 }), { ...ctx, availableCash: 100 })).toEqual({
      approved: false,
      reason: "INSUFFICIENT_CASH",
    });
  });

  it("rejects buys that would breach the portfolio heat cap", () => {
    expect(
      engine.evaluate(proposal({ estimatedValue: 400 }), { ...ctx, portfolioHeat: 0.1 }),
    ).toEqual({ approved: false, reason: "RISK_LIMIT_EXCEEDED" }); // 0.1 + 0.04 > 0.12
  });

  it("rejects tickers inside the anti-churn cooldown", () => {
    expect(engine.evaluate(proposal(), { ...ctx, cooledTickers: new Set(["AAPL"]) })).toEqual({
      approved: false,
      reason: "COOLDOWN_ACTIVE",
    });
  });

  it("requires the run's coverage to reach the LLM cost", () => {
    // This trade nets £15.32 (200 × 8% edge − £0.68 round trip).
    const p = proposal();
    expect(engine.evaluate(p, ctx, { llmCostPerRun: 1, coverageAmount: 15.32 })).toEqual({
      approved: true,
      reason: "ECONOMICALLY_VIABLE",
    });
    // The same trade cannot pay for £20 of inference on its own …
    expect(engine.evaluate(p, ctx, { llmCostPerRun: 20, coverageAmount: 15.32 })).toEqual({
      approved: false,
      reason: "COST_EXCEEDS_BENEFIT",
    });
    // … but it can once earlier approvals in the run are counted in.
    expect(engine.evaluate(p, ctx, { llmCostPerRun: 20, coverageAmount: 15.32 + 6 })).toEqual({
      approved: true,
      reason: "ECONOMICALLY_VIABLE",
    });
  });

  it("ignores the LLM-coverage check when the multiplier is 0", () => {
    const noCoverage = new DecisionEngine(costModel, { ...risk, llmCostBenefitMultiplier: 0 });
    expect(noCoverage.evaluate(proposal(), ctx, { llmCostPerRun: 1000, coverageAmount: 0 })).toEqual({
      approved: true,
      reason: "ECONOMICALLY_VIABLE",
    });
  });

  it("always approves HOLD", () => {
    expect(engine.evaluate(proposal({ action: "HOLD", quantity: 0 }), ctx)).toEqual({
      approved: true,
      reason: "ECONOMICALLY_VIABLE",
    });
  });
});
