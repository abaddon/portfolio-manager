import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/adapters/persistence/sqlite.js";
import { SqliteEventRepository, SqliteOrderRepository } from "../../src/adapters/persistence/repositories.js";
import { InMemoryEventBus, type DomainEvent } from "../../src/shared/events.js";
import { FixedClock } from "../../src/shared/clock.js";
import { NullLogger } from "../../src/shared/logger.js";
import { DecisionEngine, type CostModel, type RiskLimits } from "../../src/domain/decision.js";
import { Order } from "../../src/domain/execution.js";
import { ExecutionService } from "../../src/application/services/execution.js";
import type { AppPorts } from "../../src/application/ports.js";

const COST: CostModel = { spreadBps: 2, fxFeePct: 0.0015, stampDutyPct: 0.005, platformFeePct: 0 };
const RISK: RiskLimits = {
  maxOrderValue: 2000,
  maxHeatPct: 0.6,
  minExpectedBenefitPct: 0.0001,
  costBenefitMultiplier: 2,
  maxOrdersPerRun: 3,
  tickerCooldownDays: 0,
  minConfidence: 0.6,
};

interface FakeBrokerStatus {
  status: string;
  filledQuantity: number;
  filledPriceAvg: number | null;
}

function makePorts(brokerStatuses: Record<string, FakeBrokerStatus>) {
  const db = openDatabase(":memory:");
  const bus = new InMemoryEventBus();
  const events: DomainEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const ports: AppPorts = {
    clock: new FixedClock(new Date("2026-08-26T14:10:00Z")),
    logger: new NullLogger(),
    events: bus,
    calendar: { isOpen: () => true },
    llm: { available: () => false, chat: async () => "", chatJson: async <T,>(): Promise<T> => ({}) as T },
    prices: { quote: async () => ({ ticker: "X", price: 1, currency: "USD", prevClose: null, changePct: null, volume: null, asOf: "x" }), candles: async () => [] },
    news: { latestNews: async () => [] },
    fundamentals: { fundamentals: async () => { throw new Error("n/a"); } },
    sentiment: { sentiment: async () => ({ ticker: "X", score: 0, label: "neutral", source: "x", details: {} }) },
    macro: null,
    fx: { rate: async () => 1 },
    broker: {
      kind: "trading212",
      account: async () => ({ currency: "GBP", cash: 100, totalValue: 1000, investedValue: 900 }),
      positions: async () => [],
      submitOrder: async () => ({ brokerOrderId: "n/a", status: "SUBMITTED" }),
      orderStatus: async (id: string) => {
        const s = brokerStatuses[id];
        if (!s) throw new Error(`unexpected status poll for ${id}`);
        return s;
      },
      listOpenOrders: async () => [],
    },
    runs: { save: async () => {}, get: async () => null, latest: async () => [], findSameHour: async () => null },
    analysis: { save: async () => {}, saveMany: async () => {}, byRun: async () => [], latestByTicker: async () => [] },
    portfolio: {
      save: async () => {},
      latest: async () => null,
      history: async () => [],
      saveNav: async () => {},
      latestNav: async () => null,
    },
    decisions: { save: async () => {}, byRun: async () => [], latest: async () => [] },
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
  return { ports, events };
}

function submittedOrder(brokerOrderId: string) {
  const order = Order.create({
    id: `ord-${brokerOrderId}`,
    runId: "run0",
    decisionId: "dec0",
    ticker: "MSFT",
    side: "BUY",
    quantity: 4.83,
    type: "MARKET",
    currency: "USD",
    createdAt: "2026-08-26T13:00:00Z",
  });
  order.markSubmitted(brokerOrderId, "2026-08-26T13:00:01Z");
  order.details = { pricing: { accountCurrency: "GBP", estimatedPrice: 420, estimatedAccountValue: 1603 } };
  return order;
}

describe("ExecutionService.sweepOpenOrders", () => {
  it("confirms late fills for SUBMITTED orders with realized costs", async () => {
    const { ports, events } = makePorts({
      "b-1": { status: "FILLED", filledQuantity: 4.83, filledPriceAvg: 420 },
    });
    const order = submittedOrder("b-1");
    await ports.orders.save(order);

    const svc = new ExecutionService(ports, new DecisionEngine(COST, RISK), 3, 0);
    const result = await svc.sweepOpenOrders();
    expect(result).toEqual({ checked: 1, filled: 1, rejected: 0 });

    const updated = await ports.orders.get(order.id);
    expect(updated?.status).toBe("FILLED");
    expect(updated?.fill?.filledPriceAvg).toBe(420);
    expect(updated?.fill?.realizedCost.fxFee).toBeCloseTo(1603 * 0.0015, 2); // USD→GBP conversion
    expect(events.map((e) => e.type)).toContain("OrderFilled");
  });

  it("marks broker-side rejections", async () => {
    const { ports } = makePorts({ "b-2": { status: "REJECTED", filledQuantity: 0, filledPriceAvg: null } });
    const order = submittedOrder("b-2");
    await ports.orders.save(order);

    const svc = new ExecutionService(ports, new DecisionEngine(COST, RISK), 3, 0);
    const result = await svc.sweepOpenOrders();
    expect(result.rejected).toBe(1);
    expect((await ports.orders.get(order.id))?.status).toBe("REJECTED");
  });

  it("leaves still-open orders SUBMITTED for the next sweep", async () => {
    const { ports } = makePorts({ "b-3": { status: "NEW", filledQuantity: 0, filledPriceAvg: null } });
    const order = submittedOrder("b-3");
    await ports.orders.save(order);

    const svc = new ExecutionService(ports, new DecisionEngine(COST, RISK), 3, 0);
    const result = await svc.sweepOpenOrders();
    expect(result).toEqual({ checked: 1, filled: 0, rejected: 0 });
    expect((await ports.orders.get(order.id))?.status).toBe("SUBMITTED");
  });
});

describe("ExecutionService.reconcileStalePending", () => {
  it("adopts the broker id when a matching order exists (submission actually reached the broker)", async () => {
    const { ports } = makePorts({});
    (ports.broker.listOpenOrders as () => Promise<unknown[]>) = async () => [
      { brokerOrderId: "b-real", ticker: "MSFT", side: "BUY", quantity: 4.83, status: "NEW", createdAt: "2026-08-26T13:00:02Z" },
    ];
    const order = Order.create({
      id: "ord-pend",
      runId: "run0",
      decisionId: "dec0",
      ticker: "MSFT",
      side: "BUY",
      quantity: 4.83,
      type: "MARKET",
      currency: "USD",
      createdAt: "2026-08-26T13:00:00Z",
    });
    await ports.orders.save(order);

    const svc = new ExecutionService(ports, new DecisionEngine(COST, RISK), 3, 0);
    const result = await svc.reconcileStalePending("2026-08-26T13:30:00Z");
    expect(result).toEqual({ adopted: 1, failed: 0 });
    const updated = await ports.orders.get("ord-pend");
    expect(updated?.status).toBe("SUBMITTED");
    expect(updated?.brokerOrderId).toBe("b-real");
  });

  it("fails orders that never reached the broker (no match, no blind resubmit)", async () => {
    const { ports } = makePorts({});
    const order = Order.create({
      id: "ord-pend2",
      runId: "run0",
      decisionId: "dec0",
      ticker: "MSFT",
      side: "BUY",
      quantity: 1,
      type: "MARKET",
      currency: "USD",
      createdAt: "2026-08-26T13:00:00Z",
    });
    await ports.orders.save(order);

    const svc = new ExecutionService(ports, new DecisionEngine(COST, RISK), 3, 0);
    const result = await svc.reconcileStalePending("2026-08-26T13:30:00Z");
    expect(result).toEqual({ adopted: 0, failed: 1 });
    const updated = await ports.orders.get("ord-pend2");
    expect(updated?.status).toBe("FAILED");
    expect(updated?.error).toContain("no matching order");
  });
});


describe("ExecutionService.retryPrecisionFailures", () => {
  it("re-submits orders that failed on quantity precision (adapter corrects the precision)", async () => {
    const { ports } = makePorts({});
    let calls = 0;
    ports.broker.submitOrder = async (req) => {
      calls++;
      return { brokerOrderId: `retry-${calls}`, status: "SUBMITTED", submittedQuantity: req.side === "SELL" ? -0.9 : 0.9 };
    };
    const order = Order.create({
      id: "ord-prec",
      runId: "run0",
      decisionId: "dec0",
      ticker: "NU",
      side: "SELL",
      quantity: 0.8986,
      type: "MARKET",
      currency: "USD",
      createdAt: "2026-08-26T19:00:00Z",
    });
    order.markFailed('AdapterError: trading212 HTTP 400: {"type":"/api-errors/quantity-precision-mismatch","detail":"invalid quantity precision 3"}');
    await ports.orders.save(order);

    const svc = new ExecutionService(ports, new DecisionEngine(COST, RISK), 3, 0);
    const result = await svc.retryPrecisionFailures();
    expect(result).toEqual({ retried: 1, failed: 0 });
    const updated = await ports.orders.get("ord-prec");
    expect(updated?.status).toBe("SUBMITTED");
    expect(updated?.quantity).toBeCloseTo(0.9, 6); // aligned with the accepted quantity
    expect(updated?.brokerOrderId).toBe("retry-1");
  });

  it("leaves unrelated failures untouched and keeps new failures as FAILED", async () => {
    const { ports } = makePorts({});
    const unrelated = Order.create({
      id: "ord-other",
      runId: "run0",
      decisionId: "dec0",
      ticker: "MSFT",
      side: "BUY",
      quantity: 1,
      type: "MARKET",
      currency: "USD",
      createdAt: "2026-08-26T19:00:00Z",
    });
    unrelated.markFailed("insufficient cash");
    await ports.orders.save(unrelated);

    const precision = Order.create({
      id: "ord-prec2",
      runId: "run0",
      decisionId: "dec0",
      ticker: "NU",
      side: "SELL",
      quantity: 0.8986,
      type: "MARKET",
      currency: "USD",
      createdAt: "2026-08-26T19:00:00Z",
    });
    precision.markFailed('HTTP 400 quantity-precision-mismatch');
    await ports.orders.save(precision);
    ports.broker.submitOrder = async () => { throw new Error("broker still rejects"); };

    const svc = new ExecutionService(ports, new DecisionEngine(COST, RISK), 3, 0);
    const result = await svc.retryPrecisionFailures();
    expect(result.retried).toBe(0);
    expect(result.failed).toBe(1);
    expect((await ports.orders.get("ord-other"))?.status).toBe("FAILED"); // untouched
    expect((await ports.orders.get("ord-prec2"))?.status).toBe("FAILED"); // still failed, new reason
  });
});

describe("ExecutionService partial fills", () => {
  it("leaves a PARTIALLY_FILLED order open for the next sweep (no fill recorded yet)", async () => {
    const { ports, events } = makePorts({
      "b-p1": { status: "PARTIALLY_FILLED", filledQuantity: 2, filledPriceAvg: 420 },
    });
    const order = submittedOrder("b-p1");
    await ports.orders.save(order);

    const svc = new ExecutionService(ports, new DecisionEngine(COST, RISK), 3, 0);
    const result = await svc.sweepOpenOrders();
    expect(result).toEqual({ checked: 1, filled: 0, rejected: 0 });

    const updated = await ports.orders.get(order.id);
    expect(updated?.status).toBe("SUBMITTED");
    expect(updated?.fill).toBeNull();
    expect(events.map((e) => e.type)).not.toContain("OrderFilled");
  });

  it("records the broker's filled quantity when a terminal fill is smaller than requested", async () => {
    const { ports } = makePorts({
      "b-p2": { status: "FILLED", filledQuantity: 3, filledPriceAvg: 420 },
    });
    const order = submittedOrder("b-p2"); // requested 4.83
    await ports.orders.save(order);

    const svc = new ExecutionService(ports, new DecisionEngine(COST, RISK), 3, 0);
    const result = await svc.sweepOpenOrders();
    expect(result).toEqual({ checked: 1, filled: 1, rejected: 0 });

    const updated = await ports.orders.get(order.id);
    expect(updated?.status).toBe("FILLED");
    expect(updated?.quantity).toBe(3);
    expect(updated?.fill?.filledQuantity).toBe(3);
    // realized costs on the filled part only: 1603 × (3 / 4.83) × 0.15% FX
    expect(updated?.fill?.realizedCost.fxFee).toBeCloseTo(1603 * (3 / 4.83) * 0.0015, 2);
    expect(updated?.details.partialFill).toEqual({ requestedQuantity: 4.83, filledQuantity: 3, brokerStatus: "FILLED" });
  });

  it("keeps the filled part when the remainder of a partially filled order is cancelled", async () => {
    const { ports, events } = makePorts({
      "b-p3": { status: "CANCELLED", filledQuantity: 1.5, filledPriceAvg: 418 },
    });
    const order = submittedOrder("b-p3");
    await ports.orders.save(order);

    const svc = new ExecutionService(ports, new DecisionEngine(COST, RISK), 3, 0);
    const result = await svc.sweepOpenOrders();
    expect(result).toEqual({ checked: 1, filled: 1, rejected: 0 });

    const updated = await ports.orders.get(order.id);
    expect(updated?.status).toBe("FILLED");
    expect(updated?.quantity).toBe(1.5);
    expect(updated?.fill?.filledPriceAvg).toBe(418);
    expect(updated?.details.partialFill).toEqual({ requestedQuantity: 4.83, filledQuantity: 1.5, brokerStatus: "CANCELLED" });
    expect(events.map((e) => e.type)).toContain("OrderFilled");
  });
});
