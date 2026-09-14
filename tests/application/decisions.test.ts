import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/adapters/persistence/sqlite.js";
import { SqliteAnalysisRepository, SqliteDecisionRepository, SqliteEventRepository, SqliteOrderRepository, SqlitePortfolioRepository, SqliteRunRepository } from "../../src/adapters/persistence/repositories.js";
import { DemoFxAdapter, DemoMarketDataAdapter } from "../../src/adapters/marketdata/demo.js";
import { UnavailableLlmClient } from "../../src/adapters/llm/http-llm-client.js";
import { InMemoryEventBus } from "../../src/shared/events.js";
import { FixedClock } from "../../src/shared/clock.js";
import { NullLogger } from "../../src/shared/logger.js";
import { DecisionEngine, type CostModel, type RiskLimits } from "../../src/domain/decision.js";
import { AnalysisReport } from "../../src/domain/analysis.js";
import { Order } from "../../src/domain/execution.js";
import { buildPortfolioSnapshot } from "../../src/domain/portfolio.js";
import type { AppPorts } from "../../src/application/ports.js";
import { DecisionService, type OrderIntent } from "../../src/application/services/decisions.js";

const COST: CostModel = { spreadBps: 2, fxFeePct: 0.0015, stampDutyPct: 0.005, platformFeePct: 0 };
const RISK: RiskLimits = {
  maxOrderValue: 500,
  maxHeatPct: 0.6,
  maxOrderValuePct: 0,
  minOrderValue: 10,
  baseEdgePct: 0.02,
  maxEdgePct: 0.02,
  minNetBenefitPct: 0.0005,
  llmCostBenefitMultiplier: 1,
  costBenefitMultiplier: 2,
  maxOrdersPerRun: 3,
  tickerCooldownDays: 1,
  minConfidence: 0.6,
};

function makePorts(): AppPorts {
  const db = openDatabase(":memory:");
  const clock = new FixedClock(new Date("2026-08-26T14:00:00Z"));
  const demo = new DemoMarketDataAdapter({ now: () => clock.now() });
  return {
    clock,
    logger: new NullLogger(),
    events: new InMemoryEventBus(),
    calendar: { isOpen: () => true },
    llm: new UnavailableLlmClient(),
    prices: demo,
    news: demo,
    fundamentals: demo,
    sentiment: demo,
    macro: null,
    fx: new DemoFxAdapter(),
    broker: {
      kind: "paper",
      account: async () => ({ currency: "GBP", cash: 100, totalValue: 10_000, investedValue: 9_900 }),
      positions: async () => [],
      submitOrder: async () => ({ brokerOrderId: "x", status: "FILLED" }),
      orderStatus: async () => ({ status: "FILLED", filledQuantity: 1, filledPriceAvg: 100 }),
    },
    runs: new SqliteRunRepository(db),
    analysis: new SqliteAnalysisRepository(db),
    portfolio: new SqlitePortfolioRepository(db),
    decisions: new SqliteDecisionRepository(db),
    orders: new SqliteOrderRepository(db),
    eventRepo: new SqliteEventRepository(db),
    marketData: {
      saveSnapshots: async () => {},
      saveNews: async () => {},
      saveSentiment: async () => {},
      saveMacro: async () => {},
      snapshotsByTicker: async () => [],
      latestNews: async () => [],
      latestSentiment: async () => [],
      latestMacro: async () => [],
    },
    allocationTargets: {
      saveUpdates: async () => {},
      current: async () => [],
      recentUpdates: async () => [],
    },
    settings: { get: async () => null, set: async () => {} },
    committee: {
      saveSession: async () => {},
      saveProposals: async () => {},
      saveFeedback: async () => {},
      saveVotes: async () => {},
      latestSession: async () => null,
      detail: async () => ({
        session: { id: "x", runId: "r", status: "COMPLETED", round: 0, winnerProposalId: null, error: null, createdAt: "t", completedAt: "t", details: {} },
        proposals: [],
        feedback: [],
        votes: [],
      }),
      byRun: async () => [],
    },
  };
}

function snapshot(cash = 1000, positions: Parameters<typeof buildPortfolioSnapshot>[0]["positions"] = []) {
  return buildPortfolioSnapshot({
    id: "snap1",
    runId: "run1",
    asOf: "2026-08-26T14:02:00Z",
    currency: "GBP",
    cash,
    positions,
    prevTotalValue: null,
  });
}

function intent(ticker: string, side: "BUY" | "SELL", value: number, confidence = 0.8): OrderIntent {
  return { ticker, side, value, reason: "committee winner test order", confidence };
}

describe("DecisionService (committee orders through the economic gate)", () => {
  it("approves a buy whose expected benefit covers the costs", async () => {
    const ports = makePorts();
    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK));
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snapshot(1000),
      heat: 0,
      intents: [intent("AAPL", "BUY", 100)],
      meta: { source: "committee", agentName: "Macro Strategist" },
    });
    expect(decisions).toHaveLength(1);
    const dec = decisions[0]!;
    expect(dec.approved).toBe(true);
    expect(dec.reason).toBe("ECONOMICALLY_VIABLE");
    expect(dec.action).toBe("BUY");
    // priced live: demo AAPL 210 USD × 0.79 fx
    expect(dec.proposal.estimatedPrice).toBe(210);
    expect(dec.proposal.costEstimate.fxFee).toBeGreaterThan(0); // USD→GBP conversion
    expect(dec.proposal.expectedBenefit).toBeGreaterThan(dec.proposal.costEstimate.total * RISK.costBenefitMultiplier);
    expect(dec.proposal.rationale).toContain("Macro Strategist (committee)");
    expect(dec.details.source).toBe("committee");
    // persisted for the dashboard + audit trail
    expect(await ports.decisions.byRun("run1")).toHaveLength(1);
  });

  it("rescales oversized orders down to the risk cap (partial fill of the intent)", async () => {
    const ports = makePorts();
    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK));
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snapshot(50_000),
      heat: 0,
      intents: [intent("AAPL", "BUY", 45_000)],
    });
    const dec = decisions[0]!;
    expect(dec.proposal.estimatedValue).toBeLessThanOrEqual(500);
    expect(dec.proposal.quantity).toBeCloseTo(500 / (210 * 0.79), 2);
    expect(dec.approved).toBe(true); // economically viable at the capped size
  });

  it("rejects a sell of a ticker the account does not hold", async () => {
    const ports = makePorts();
    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK));
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snapshot(),
      heat: 0,
      intents: [intent("AAPL", "SELL", 100)],
    });
    expect(decisions[0]!.approved).toBe(false);
    expect(decisions[0]!.reason).toBe("INSTRUMENT_UNAVAILABLE");
    expect(decisions[0]!.proposal.rationale).toContain("not held");
  });

  it("caps a sell at the held quantity", async () => {
    const ports = makePorts();
    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK));
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snapshot(100, [{ ticker: "AAPL", quantity: 0.5, averagePrice: 100, currentPrice: 100, currency: "GBP" }]),
      heat: 0,
      intents: [intent("AAPL", "SELL", 1000)], // asks for far more than held
    });
    const dec = decisions[0]!;
    expect(dec.approved).toBe(true);
    expect(dec.action).toBe("SELL");
    expect(dec.quantity).toBe(0.5);
  });

  it("rejects a buy when cash is insufficient", async () => {
    const ports = makePorts();
    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK));
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snapshot(1), // almost no cash
      heat: 0,
      intents: [intent("AAPL", "BUY", 400)],
    });
    expect(decisions[0]!.approved).toBe(false);
    expect(decisions[0]!.reason).toBe("INSUFFICIENT_CASH");
  });

  it("rejects low-confidence intents (gate uses the winner's confidence)", async () => {
    const ports = makePorts();
    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK));
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snapshot(1000),
      heat: 0,
      intents: [intent("AAPL", "BUY", 100, 0.4)], // below minConfidence 0.6
    });
    expect(decisions[0]!.approved).toBe(false);
    expect(decisions[0]!.reason).toBe("NO_CONVICTION");
  });

  it("applies the anti-churn cooldown to recently traded tickers", async () => {
    const ports = makePorts();
    const order = Order.create({
      id: "ord1",
      runId: "run0",
      decisionId: null,
      ticker: "AAPL",
      side: "BUY",
      quantity: 1,
      type: "MARKET",
      currency: "USD",
      createdAt: "2026-08-26T13:30:00Z", // 30 min ago, within 1-day cooldown
    });
    order.markSubmitted("b1", "2026-08-26T13:30:01Z");
    order.markFilled({ filledQuantity: 1, filledPriceAvg: 200, currency: "USD", filledAt: "2026-08-26T13:30:02Z", realizedCost: { spread: 0, fxFee: 0, stampDuty: 0, platformFee: 0, total: 0 } });
    await ports.orders.save(order);

    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK));
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snapshot(1000),
      heat: 0,
      intents: [intent("AAPL", "BUY", 100)],
    });
    expect(decisions[0]!.approved).toBe(false);
    expect(decisions[0]!.reason).toBe("COOLDOWN_ACTIVE");
  });

  it("rejects intents too small to produce a tradable quantity", async () => {
    const ports = makePorts();
    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK));
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snapshot(1000),
      heat: 0,
      intents: [intent("AAPL", "BUY", 0.001)], // rounds to 0 shares
    });
    expect(decisions[0]!.approved).toBe(false);
    expect(decisions[0]!.reason).toBe("OPPORTUNITY_TOO_SMALL");
  });

  // Gate state accumulates across the run: every intent is evaluated against the
  // portfolio as it will be once the earlier intents have executed. Evaluating
  // each intent against the untouched pre-run snapshot let a run of orders
  // collectively breach maxHeatPct and the available cash.
  it("applies the heat cap cumulatively across the run's intents", async () => {
    const ports = makePorts();
    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK));
    // £10k NAV with 60% invested → heat 0.54; maxHeatPct 0.6 leaves 0.06 of room.
    const snap = snapshot(4000, [{ ticker: "MSFT", quantity: 12, averagePrice: 500, currentPrice: 500, currency: "GBP" }]);
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snap,
      heat: 0.54,
      intents: [intent("AAPL", "BUY", 800), intent("AAPL", "BUY", 800)],
    });
    // Each order is capped at maxOrderValue (500) → +0.05 heat, so the first fits.
    expect(decisions[0]!.approved).toBe(true);
    expect(decisions[0]!.proposal.estimatedValue).toBeCloseTo(500, 2);
    // The second would reach 0.64 — it must not see the pre-run 0.54.
    expect(decisions[1]!.approved).toBe(false);
    expect(decisions[1]!.reason).toBe("RISK_LIMIT_EXCEEDED");
  });

  it("applies the cash limit cumulatively across the run's intents", async () => {
    const ports = makePorts();
    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK));
    // £5.5k NAV (£5k held, £500 cash) — the cash check, not heat, is the binding one.
    const snap = snapshot(500, [{ ticker: "MSFT", quantity: 10, averagePrice: 500, currentPrice: 500, currency: "GBP" }]);
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snap,
      heat: 0,
      intents: [intent("AAPL", "BUY", 400), intent("AAPL", "BUY", 400)],
    });
    expect(decisions[0]!.approved).toBe(true);
    expect(decisions[0]!.proposal.estimatedValue).toBeCloseTo(400, 2);
    // 400 of the 500 cash is committed — only 100 is left for the next intent.
    expect(decisions[1]!.approved).toBe(false);
    expect(decisions[1]!.reason).toBe("INSUFFICIENT_CASH");
  });

  it("releases cash for a later BUY when an earlier SELL funds it", async () => {
    const ports = makePorts();
    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK));
    const snap = snapshot(500, [{ ticker: "MSFT", quantity: 10, averagePrice: 500, currentPrice: 500, currency: "GBP" }]);
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snap,
      heat: 0,
      intents: [intent("MSFT", "SELL", 400), intent("AAPL", "BUY", 800)],
    });
    expect(decisions[0]!.approved).toBe(true);
    expect(decisions[0]!.action).toBe("SELL");
    // 400 of proceeds + 500 cash = 900 available; the rescaled 500 BUY fits.
    expect(decisions[1]!.approved).toBe(true);
    expect(decisions[1]!.action).toBe("BUY");
  });

  /* ---- assumed edge comes from the research (ADR 0012) ---- */

  it("scales the assumed edge with analyst coverage: confidence alone is not enough", async () => {
    const ports = makePorts();
    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK));
    // No analyst report for MSFT → edge = proposal confidence only (0.8 × base 2% / w 0.5 → 0.8%)
    // against a 0.68% required edge: it clears, but only just, and the run says so.
    const withoutResearch = await svc.decide({
      runId: "run1",
      snapshot: snapshot(1000),
      heat: 0,
      intents: [intent("MSFT", "BUY", 100, 0.8)],
      reports: [],
    });
    const bare = withoutResearch[0]!;
    expect(bare.details.signalStrength).toBeCloseTo(0.4, 4);
    expect(bare.details.edgePct).toBeCloseTo(0.008, 6);

    // The same order, with analysts recommending a 15% weight increase at high confidence:
    const reports = ([
      ["market", 0.15, 0.9],
      ["news", 0.15, 0.9],
    ] as const).map(([analyst, adjustment, confidence]) =>
      new AnalysisReport(
        `an-${analyst}`,
        "run1",
        "MSFT",
        analyst,
        "bullish",
        0.8,
        "strong evidence for a larger weight",
        { targetWeightAdjustment: adjustment, confidence },
        "2026-08-26T14:00:00Z",
      ),
    );
    const withResearch = await svc.decide({
      runId: "run2",
      snapshot: snapshot(1000),
      heat: 0,
      intents: [intent("MSFT", "BUY", 100, 0.8)],
      reports,
    });
    const backed = withResearch[0]!;
    expect(backed.details.signalStrength).toBeGreaterThan(bare.details.signalStrength as number);
    expect(backed.details.edgePct).toBeGreaterThan(bare.details.edgePct as number);
    expect(backed.approved).toBe(true);
    // Both decisions record the inputs the gate used, for the dashboard.
    expect(backed.details.costRatioPct).toBeGreaterThan(0);
    expect(backed.details.netBenefit).toBeGreaterThan(0);
  });

  it("never approves a trade whose edge cannot beat the round trip, whatever the size", async () => {
    const ports = makePorts();
    // 0.2% assumed edge at full signal against a 0.34% round trip: structurally
    // marginal. The net-benefit floor catches it at every size (a trade that
    // earns less than it costs can never clear a positive net floor).
    const tight = new DecisionEngine(COST, { ...RISK, baseEdgePct: 0.002, maxEdgePct: 0.002 });
    const svc = new DecisionService(ports, tight);
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snapshot(10_000),
      heat: 0,
      intents: [intent("MSFT", "BUY", 100, 1), intent("MSFT", "BUY", 400, 1)],
    });
    expect(decisions.map((d) => d.reason)).toEqual(["OPPORTUNITY_TOO_SMALL", "OPPORTUNITY_TOO_SMALL"]);
    expect(decisions.every((d) => !d.approved)).toBe(true);
    expect(decisions.every((d) => (d.details.netBenefit as number) < 0)).toBe(true);
  });

  it("rejects on the ratio test alone when the net floor cannot fire (structural marginality)", async () => {
    const ports = makePorts();
    // minNetBenefitPct is pushed negative so the floor can never reject: the
    // only thing left to refuse a 0.2%-edge trade against a 0.34% round trip is
    // the ratio test. This is the check that stops "trade a little, often".
    const ratioOnly = new DecisionEngine(COST, {
      ...RISK,
      baseEdgePct: 0.002,
      maxEdgePct: 0.002,
      minNetBenefitPct: -1,
      minOrderValue: 0,
    });
    const svc = new DecisionService(ports, ratioOnly);
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snapshot(10_000),
      heat: 0,
      intents: [intent("MSFT", "BUY", 400, 1)],
    });
    expect(decisions[0]!.reason).toBe("COST_EXCEEDS_BENEFIT");
  });

  it("requires the run's decisions to cover the run's inference cost", async () => {
    const ports = makePorts();
    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK));
    const cheap = await svc.decide({
      runId: "run-cheap",
      snapshot: snapshot(1000),
      heat: 0,
      intents: [intent("MSFT", "BUY", 100, 0.9)],
      llmCostPerRun: 0.01,
    });
    expect(cheap[0]!.approved).toBe(true);
    expect(cheap[0]!.details.llmCostPerRun).toBe(0.01);

    const expensive = await svc.decide({
      runId: "run-expensive",
      snapshot: snapshot(1000),
      heat: 0,
      intents: [intent("MSFT", "BUY", 100, 0.9)],
      llmCostPerRun: 50, // the session's net benefit can never cover this
    });
    expect(expensive[0]!.approved).toBe(false);
    expect(expensive[0]!.reason).toBe("COST_EXCEEDS_BENEFIT");
  });

  it("counts earlier approvals towards the run's inference-cost coverage", async () => {
    const ports = makePorts();
    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK));
    // £300 order: 0.9% edge = £2.70 benefit, £1.02 round trip → £1.68 net.
    // A £1.50 inference bill: the first order covers it on its own, and the
    // second is gated with the first one's net benefit already banked — the
    // session, not the individual order, has to pay for the analysis. (A run
    // whose decisions cannot cover the inference that produced them stops at
    // the gate, which is exactly the "no trade is worth the tokens" case.)
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snapshot(10_000),
      heat: 0,
      intents: [intent("MSFT", "BUY", 300, 0.9), intent("MSFT", "BUY", 300, 0.9)],
      llmCostPerRun: 1.5,
    });
    expect(decisions.map((d) => d.approved)).toEqual([true, true]);
    expect(decisions.map((d) => d.details.sessionNetBenefit)).toEqual([1.68, 3.36]);
    expect(decisions[1]!.details.llmCostPerRun).toBe(1.5);
  });

  it("refuses every order when the run's inference cost cannot be covered", async () => {
    const ports = makePorts();
    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK));
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snapshot(10_000),
      heat: 0,
      intents: [intent("MSFT", "BUY", 100, 0.9), intent("MSFT", "BUY", 100, 0.9)],
      llmCostPerRun: 100,
    });
    expect(decisions.every((d) => !d.approved)).toBe(true);
    expect(decisions.map((d) => d.reason)).toEqual(["COST_EXCEEDS_BENEFIT", "COST_EXCEEDS_BENEFIT"]);
    // Nothing accumulates from a rejected order: the coverage never grows.
    expect(decisions.map((d) => d.details.sessionNetBenefit)).toEqual([0, 0]);
  });

  it("bounds the order size by the NAV fraction when configured", async () => {
    const ports = makePorts();
    const byNav = new DecisionEngine(COST, { ...RISK, maxOrderValuePct: 0.02 });
    const svc = new DecisionService(ports, byNav);
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snapshot(10_000, [{ ticker: "MSFT", quantity: 20, averagePrice: 500, currentPrice: 500, currency: "GBP" }]),
      heat: 0,
      intents: [intent("AAPL", "BUY", 5000)],
    });
    // 2% of the £20k portfolio = £400, well under maxOrderValue 500.
    expect(decisions[0]!.proposal.estimatedValue).toBeLessThanOrEqual(400);
    expect(decisions[0]!.approved).toBe(true);
  });
});
