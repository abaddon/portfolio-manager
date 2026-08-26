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
import { DecisionService } from "../../src/application/services/decisions.js";

const COST: CostModel = { spreadBps: 2, fxFeePct: 0.0015, stampDutyPct: 0.005, platformFeePct: 0 };
const RISK: RiskLimits = {
  maxOrderValue: 500,
  maxHeatPct: 0.6,
  minExpectedBenefitPct: 0.0001,
  costBenefitMultiplier: 2,
  maxOrdersPerRun: 3,
  tickerCooldownDays: 1,
  minConfidence: 0.6,
};

function makePorts(): AppPorts {
  const db = openDatabase(":memory:");
  const clock = new FixedClock(new Date("2026-08-26T14:00:00Z"));
  const demo = new DemoMarketDataAdapter({ now: clock.now() });
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
      snapshotsByTicker: async () => [],
      latestNews: async () => [],
      latestSentiment: async () => [],
    },
    allocationTargets: {
      saveUpdates: async () => {},
      current: async () => [],
      recentUpdates: async () => [],
    },
  };
}

function reports(ticker: string, adjustment: number, confidence: number): AnalysisReport[] {
  return (["market", "sentiment", "news", "fundamentals"] as const).map(
    (k) =>
      new AnalysisReport(
        `an-${k}`,
        "run1",
        ticker,
        k,
        adjustment > 0 ? "bullish" : "bearish",
        confidence,
        "test rationale long enough",
        { targetWeightAdjustment: adjustment, confidence },
        "2026-08-26T14:01:00Z",
        {},
      ),
  );
}

function snapshot(cash = 100) {
  return buildPortfolioSnapshot({
    id: "snap1",
    runId: "run1",
    asOf: "2026-08-26T14:02:00Z",
    currency: "GBP",
    cash,
    positions: [], // nothing held: every target ticker drifts to BUY
    prevTotalValue: null,
  });
}

describe("DecisionService", () => {
  it("blocks a rebalance when analysts strongly disagree (direction veto)", async () => {
    const ports = makePorts();
    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK), { signalThreshold: 0.05 });
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snapshot(),
      drift: [{ ticker: "AAPL", targetWeight: 0.4, currentWeight: 0, drift: -0.4, insideBand: false, hint: "buy" }],
      reports: reports("AAPL", -0.15, 0.9), // analysts want OUT, drift wants IN
      heat: 0,
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe("HOLD");
    expect(decisions[0]!.approved).toBe(false);
    expect(decisions[0]!.reason).toBe("NO_CONVICTION");
    expect(decisions[0]!.proposal.rationale).toContain("opposes");
  });

  it("rejects a buy when cash is insufficient", async () => {
    const ports = makePorts();
    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK), { signalThreshold: 0.05 });
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snapshot(1), // almost no cash
      drift: [{ ticker: "AAPL", targetWeight: 0.9, currentWeight: 0, drift: -0.9, insideBand: false, hint: "buy" }],
      reports: reports("AAPL", 0.05, 0.8),
      heat: 0,
    });
    expect(decisions[0]!.approved).toBe(false);
    expect(decisions[0]!.reason).toBe("INSUFFICIENT_CASH");
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

    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK), { signalThreshold: 0.05 });
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snapshot(),
      drift: [{ ticker: "AAPL", targetWeight: 0.9, currentWeight: 0, drift: -0.9, insideBand: false, hint: "buy" }],
      reports: reports("AAPL", 0.05, 0.8),
      heat: 0,
    });
    expect(decisions[0]!.approved).toBe(false);
    expect(decisions[0]!.reason).toBe("COOLDOWN_ACTIVE");
  });

  it("rescales oversized proposals down to the risk cap (partial rebalance)", async () => {
    const ports = makePorts();
    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK), { signalThreshold: 0.05 });
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snapshot(50_000),
      drift: [{ ticker: "AAPL", targetWeight: 0.9, currentWeight: 0, drift: -0.9, insideBand: false, hint: "buy" }],
      reports: reports("AAPL", 0.05, 0.8),
      heat: 0,
    });
    // 0.9 × 50k = 45k would breach the 500 cap → quantity rescaled to the cap.
    const dec = decisions[0]!;
    expect(dec.proposal.estimatedValue).toBeLessThanOrEqual(500);
    expect(dec.proposal.quantity).toBeCloseTo(500 / (210 * 0.79), 2); // AAPL demo price 210 USD, fx 0.79
    expect(dec.approved).toBe(true); // economically viable at the capped size
  });

  it("produces economically viable decisions when benefit covers costs", async () => {
    const ports = makePorts();
    const svc = new DecisionService(ports, new DecisionEngine(COST, RISK), { signalThreshold: 0.05 });
    const decisions = await svc.decide({
      runId: "run1",
      snapshot: snapshot(1000),
      drift: [{ ticker: "AAPL", targetWeight: 0.05, currentWeight: 0, drift: -0.05, insideBand: false, hint: "buy" }],
      reports: reports("AAPL", 0.05, 0.8),
      heat: 0,
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.approved).toBe(true);
    expect(decisions[0]!.reason).toBe("ECONOMICALLY_VIABLE");
    expect(decisions[0]!.proposal.estimatedValue).toBeLessThanOrEqual(500);
    expect(decisions[0]!.proposal.costEstimate.fxFee).toBeGreaterThan(0);
  });
});
