import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/adapters/persistence/sqlite.js";
import { SqliteAnalysisRepository, SqliteDecisionRepository, SqliteEventRepository, SqliteOrderRepository, SqlitePortfolioRepository, SqliteRunRepository } from "../../src/adapters/persistence/repositories.js";
import { DemoFxAdapter, DemoMarketDataAdapter } from "../../src/adapters/marketdata/demo.js";
import { UnavailableLlmClient } from "../../src/adapters/llm/http-llm-client.js";
import { InMemoryEventBus } from "../../src/shared/events.js";
import { FixedClock } from "../../src/shared/clock.js";
import { NullLogger } from "../../src/shared/logger.js";
import { DecisionEngine, type CostModel, type RiskLimits } from "../../src/domain/decision.js";
import { Order } from "../../src/domain/execution.js";
import { buildPortfolioSnapshot } from "../../src/domain/portfolio.js";
import type { AppPorts } from "../../src/application/ports.js";
import { DecisionService, type OrderIntent } from "../../src/application/services/decisions.js";

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
});
