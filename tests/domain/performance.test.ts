import { describe, expect, it } from "vitest";
import {
  attributeDecision,
  buildPerformanceContext,
  buildScorecards,
  calibrateAnalysts,
  decisionWeightDelta,
  forwardReturn,
} from "../../src/domain/performance.js";

describe("forwardReturn (WP-P2.4)", () => {
  it("measures a close-to-close return over the horizon and clamps it to the series", () => {
    const closes = [100, 101, 102, 103, 104];
    expect(forwardReturn(closes, 1)).toBeCloseTo(104 / 103 - 1, 6);
    expect(forwardReturn(closes, 4)).toBeCloseTo(104 / 100 - 1, 6);
    expect(forwardReturn(closes, 99)).toBeCloseTo(104 / 100 - 1, 6); // clamped
    expect(forwardReturn([100], 1)).toBeNull();
    expect(forwardReturn([], 1)).toBeNull();
    expect(forwardReturn([0, 100], 1)).toBeNull(); // unusable base
  });
});

describe("attributeDecision (WP-P2.4)", () => {
  it("credits a correct call and debits a wrong one, signed by the direction", () => {
    const buyRight = attributeDecision({ decisionId: "d1", ticker: "MSFT", action: "BUY", approved: true, orderValue: 100, forwardReturnPct: 0.05 });
    expect(buyRight.contribution).toBeCloseTo(5, 2);
    const buyWrong = attributeDecision({ decisionId: "d2", ticker: "MSFT", action: "BUY", approved: true, orderValue: 100, forwardReturnPct: -0.03 });
    expect(buyWrong.contribution).toBeCloseTo(-3, 2);
    // A SELL that avoided a fall earns; a SELL before a rise loses.
    const sellRight = attributeDecision({ decisionId: "d3", ticker: "XOM", action: "SELL", approved: true, orderValue: 100, forwardReturnPct: -0.04 });
    expect(sellRight.contribution).toBeCloseTo(4, 2);
    const sellWrong = attributeDecision({ decisionId: "d4", ticker: "XOM", action: "SELL", approved: true, orderValue: 100, forwardReturnPct: 0.04 });
    expect(sellWrong.contribution).toBeCloseTo(-4, 2);
  });

  it("attributes nothing to a rejected or unmeasurable decision", () => {
    expect(attributeDecision({ decisionId: "d5", ticker: "MSFT", action: "BUY", approved: false, orderValue: 100, forwardReturnPct: 0.2 }).contribution).toBe(0);
    expect(attributeDecision({ decisionId: "d6", ticker: "MSFT", action: "BUY", approved: true, orderValue: 100, forwardReturnPct: null }).contribution).toBe(0);
    expect(attributeDecision({ decisionId: "d7", ticker: "MSFT", action: "HOLD", approved: true, orderValue: 0, forwardReturnPct: 0.2 }).contribution).toBe(0);
  });

  it("computes the weight a decision moved", () => {
    expect(decisionWeightDelta(200, 10_000)).toBeCloseTo(0.02, 4);
    expect(decisionWeightDelta(200, 0)).toBe(0);
  });
});

describe("buildScorecards (WP-P2.4)", () => {
  it("summarises acceptance, per-proposal contribution and profitability", () => {
    const cards = buildScorecards([
      { agentId: "a1", agentName: "Macro", proposals: 10, accepted: 4, contribution: 120, portfolioContribution: 120 },
      { agentId: "a2", agentName: "Momentum", proposals: 10, accepted: 1, contribution: -30, portfolioContribution: 0 },
      { agentId: "a3", agentName: "Value", proposals: 0, accepted: 0, contribution: 0, portfolioContribution: 0 },
    ]);
    const macro = cards.find((c) => c.agentId === "a1")!;
    expect(macro.acceptanceRate).toBeCloseTo(0.4, 4);
    expect(macro.contributionPerProposal).toBeCloseTo(12, 2);
    expect(macro.positive).toBe(true);
    expect(cards.find((c) => c.agentId === "a2")).toMatchObject({ positive: false });
    expect(cards.find((c) => c.agentId === "a3")).toMatchObject({ acceptanceRate: 0, contributionPerProposal: 0, positive: false });
  });
});

describe("calibrateAnalysts (WP-P2.4)", () => {
  it("measures hit rate, mean forward return and directional edge per analyst", () => {
    const calibration = calibrateAnalysts([
      { analyst: "market", conclusion: "bullish", confidence: 0.8, forwardReturnPct: 0.02 },
      { analyst: "market", conclusion: "bullish", confidence: 0.6, forwardReturnPct: -0.01 },
      { analyst: "market", conclusion: "bearish", confidence: 0.7, forwardReturnPct: -0.03 },
      { analyst: "market", conclusion: "neutral", confidence: 0.5, forwardReturnPct: 0.5 }, // excluded
      { analyst: "news", conclusion: "bullish", confidence: 0.5, forwardReturnPct: null }, // unscored → excluded
    ]);
    const market = calibration.find((c) => c.analyst === "market")!;
    expect(market.sample).toBe(3);
    expect(market.hits).toBe(2); // two bullish calls: one up, one down → one hit; bearish down → hit
    expect(market.hitRate).toBeCloseTo(2 / 3, 4);
    expect(market.meanForwardReturnPct).toBeCloseTo((0.02 - 0.01 - 0.03) / 3, 6);
    expect(market.directionalEdgePct).toBeCloseTo((0.02 - 0.01) / 2 - -0.03, 6);
    expect(calibration.find((c) => c.analyst === "news")).toBeUndefined();
  });

  it("returns no row for an analyst with nothing measurable", () => {
    expect(calibrateAnalysts([{ analyst: "market", conclusion: "bullish", confidence: 1, forwardReturnPct: null }])).toEqual([]);
  });
});

describe("buildPerformanceContext (WP-P2.4)", () => {
  it("summarises NAV, alpha vs the benchmark and the worst drawdown", () => {
    const context = buildPerformanceContext({
      navSeries: [
        { asOf: "2026-09-01", navPerUnit: 10 },
        { asOf: "2026-09-02", navPerUnit: 10.5 },
        { asOf: "2026-09-03", navPerUnit: 10.2 },
      ],
      benchmarkSeries: [100, 101, 102],
      scorecards: buildScorecards([
        { agentId: "a1", agentName: "Macro", proposals: 4, accepted: 2, contribution: 25, portfolioContribution: 25 },
      ]),
      windowContribution: 25,
    });
    expect(context.sessions).toBe(3);
    expect(context.navChangePct).toBeCloseTo(0.02, 4); // 10 → 10.2
    expect(context.benchmarkChangePct).toBeCloseTo(0.02, 4);
    expect(context.alphaPct).toBeCloseTo(0, 3);
    expect(context.worstDrawdownPct).toBeCloseTo(10.2 / 10.5 - 1, 6);
    expect(context.windowContribution).toBe(25);
    expect(context.scorecards[0]).toMatchObject({ agentName: "Macro", positive: true });
  });

  it("degrades to nulls rather than inventing numbers", () => {
    const context = buildPerformanceContext({ navSeries: [], benchmarkSeries: [], scorecards: [], windowContribution: 0 });
    expect(context).toMatchObject({ sessions: 0, navChangePct: null, benchmarkChangePct: null, alphaPct: null, worstDrawdownPct: null });
  });
});
