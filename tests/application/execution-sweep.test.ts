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
      snapshotsByTicker: async () => [],
      latestNews: async () => [],
      latestSentiment: async () => [],
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
