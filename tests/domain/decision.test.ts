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
  maxHeatPct: 0.12,
  minExpectedBenefitPct: 0.006,
  costBenefitMultiplier: 2,
  maxOrdersPerRun: 3,
  tickerCooldownDays: 2,
  minConfidence: 0.6,
};

function proposal(over: Partial<TradeProposal> = {}): TradeProposal {
  return {
    ticker: "AAPL",
    action: "BUY",
    quantity: 1,
    estimatedPrice: 200,
    estimatedValue: 200,
    currency: "USD",
    expectedBenefit: 5,
    costEstimate: { currency: "GBP", spread: 0.04, fxFee: 0.3, stampDuty: 0, platformFee: 0, total: 0.34 },
    rationale: "",
    confidence: 0.7,
    ...over,
  };
}

const ctx = { portfolioHeat: 0.05, portfolioTotalValue: 10_000, cash: 2_000, cooledTickers: new Set<string>() };

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

  it("charges the configured spread on every trade", () => {
    const e = engine.estimateCosts({ orderValue: 1000, accountCurrency: "GBP", instrumentCurrency: "USD", action: "SELL", ticker: "AAPL" });
    expect(e.spread).toBeCloseTo(0.2, 2); // 2bps
    expect(e.total).toBeCloseTo(0.2 + 1.5, 2);
  });
});

describe("DecisionEngine.evaluate (economic-correctness gate)", () => {
  const engine = new DecisionEngine(costModel, risk);

  it("approves a viable trade", () => {
    expect(engine.evaluate(proposal(), ctx)).toEqual({ approved: true, reason: "ECONOMICALLY_VIABLE" });
  });

  it("rejects when costs exceed benefit (COST_EXCEEDS_BENEFIT)", () => {
    const p = proposal({
      expectedBenefit: 2, // ≥ 1.2 minimum, but < 2 × 1.5 costs
      costEstimate: { currency: "GBP", spread: 0.2, fxFee: 1.3, stampDuty: 0, platformFee: 0, total: 1.5 },
    });
    expect(engine.evaluate(p, ctx)).toEqual({ approved: false, reason: "COST_EXCEEDS_BENEFIT" });
  });

  it("rejects when the opportunity is too small vs minimum benefit", () => {
    const p = proposal({ expectedBenefit: 0.1, costEstimate: { currency: "GBP", spread: 0, fxFee: 0, stampDuty: 0, platformFee: 0, total: 0 } });
    expect(engine.evaluate(p, ctx)).toEqual({ approved: false, reason: "OPPORTUNITY_TOO_SMALL" });
  });

  it("rejects oversized orders (RISK_LIMIT_EXCEEDED)", () => {
    const p = proposal({ estimatedValue: 501 });
    expect(engine.evaluate(p, ctx)).toEqual({ approved: false, reason: "RISK_LIMIT_EXCEEDED" });
  });

  it("rejects low-conviction proposals (NO_CONVICTION)", () => {
    expect(engine.evaluate(proposal({ confidence: 0.3 }), ctx)).toEqual({ approved: false, reason: "NO_CONVICTION" });
  });

  it("rejects buys exceeding available cash (INSUFFICIENT_CASH)", () => {
    expect(engine.evaluate(proposal({ estimatedValue: 200 }), { ...ctx, cash: 100 })).toEqual({
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

  it("always approves HOLD", () => {
    expect(engine.evaluate(proposal({ action: "HOLD", quantity: 0 }), ctx)).toEqual({
      approved: true,
      reason: "ECONOMICALLY_VIABLE",
    });
  });
});
