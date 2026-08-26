import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/adapters/persistence/sqlite.js";
import { SqliteDecisionRepository, SqliteOrderRepository } from "../../src/adapters/persistence/repositories.js";
import { InMemoryEventBus } from "../../src/shared/events.js";
import { FixedClock } from "../../src/shared/clock.js";
import { NullLogger } from "../../src/shared/logger.js";
import { DecisionEngine, type CostModel, type RiskLimits } from "../../src/domain/decision.js";
import { ExecutionService } from "../../src/application/services/execution.js";
import type { AppPorts } from "../../src/application/ports.js";
import type { Decision } from "../../src/domain/decision.js";

const COST: CostModel = { spreadBps: 2, fxFeePct: 0.0015, stampDutyPct: 0.005, platformFeePct: 0 };
const RISK: RiskLimits = {
  maxOrderValue: 2000,
  maxHeatPct: 0.6,
  minExpectedBenefitPct: 0.0001,
  costBenefitMultiplier: 1,
  maxOrdersPerRun: 3,
  tickerCooldownDays: 0,
  minConfidence: 0.1,
};

const DECISION: Decision = {
  id: "dec1",
  runId: "run1",
  ticker: "MSFT",
  action: "BUY",
  quantity: 0.5,
  approved: true,
  reason: "ECONOMICALLY_VIABLE",
  proposal: {
    ticker: "MSFT",
    action: "BUY",
    quantity: 0.5,
    estimatedPrice: 490,
    estimatedValue: 100,
    currency: "USD",
    expectedBenefit: 1,
    costEstimate: { currency: "GBP", spread: 0.02, fxFee: 0.15, stampDuty: 0, platformFee: 0, total: 0.17 },
    rationale: "test",
    confidence: 0.6,
  },
  decidedAt: "2026-08-26T14:00:00Z",
  details: {},
};

function makePorts(broker: { submitStatus: string; remoteStatus: string }) {
  const db = openDatabase(":memory:");
  const ports: AppPorts = {
    clock: new FixedClock(new Date("2026-08-26T14:00:00Z")),
    logger: new NullLogger(),
    events: new InMemoryEventBus(),
    calendar: { isOpen: () => true },
    llm: { available: () => false, chat: async () => "", chatJson: async <T,>(): Promise<T> => ({}) as T },
    prices: { quote: async () => ({ ticker: "X", price: 1, currency: "USD", prevClose: null, changePct: null, volume: null, asOf: "x" }), candles: async () => [] },
    news: { latestNews: async () => [] },
    fundamentals: { fundamentals: async () => { throw new Error("n/a"); } },
    sentiment: { sentiment: async () => ({ ticker: "X", score: 0, label: "neutral", source: "x", details: {} }) },
    fx: { rate: async () => 0.79 },
    broker: {
      kind: "trading212",
      account: async () => ({ currency: "GBP", cash: 1000, totalValue: 1000, investedValue: 0 }),
      positions: async () => [],
      submitOrder: async () => ({ brokerOrderId: "b-1", status: broker.submitStatus as "SUBMITTED" }),
      orderStatus: async () => ({ status: broker.remoteStatus, filledQuantity: 0, filledPriceAvg: null }),
    },
    runs: { save: async () => {}, get: async () => null, latest: async () => [], findSameHour: async () => null },
    analysis: { save: async () => {}, saveMany: async () => {}, byRun: async () => [], latestByTicker: async () => [] },
    portfolio: { save: async () => {}, latest: async () => null, history: async () => [], saveNav: async () => {}, latestNav: async () => null },
    decisions: new SqliteDecisionRepository(db),
    orders: new SqliteOrderRepository(db),
    eventRepo: { append: async () => {}, byRun: async () => [], recent: async () => [] },
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
  return ports;
}

describe("ExecutionService: broker order still open after submit (regression)", () => {
  it("leaves the order SUBMITTED instead of failing when the broker status stays NEW", async () => {
    const ports = makePorts({ submitStatus: "SUBMITTED", remoteStatus: "NEW" });
    const svc = new ExecutionService(ports, new DecisionEngine(COST, RISK), 3, 0);
    const result = await svc.execute("run1", [DECISION]);

    expect(result.failed).toHaveLength(0);
    expect(result.orders).toHaveLength(1);
    const order = result.orders[0]!;
    expect(order.status).toBe("SUBMITTED");
    expect(order.brokerOrderId).toBe("b-1");
    expect(order.error).toBeNull();

    // A later sweep can still confirm the fill.
    const persisted = await ports.orders.get(order.id);
    expect(persisted?.status).toBe("SUBMITTED");
  });

  it("confirms an immediate fill without polling", async () => {
    const ports = makePorts({ submitStatus: "FILLED", remoteStatus: "FILLED" });
    const svc = new ExecutionService(ports, new DecisionEngine(COST, RISK), 3, 0);
    const result = await svc.execute("run1", [DECISION]);
    expect(result.filled).toHaveLength(1);
    expect(result.orders[0]!.status).toBe("FILLED");
  });
});
