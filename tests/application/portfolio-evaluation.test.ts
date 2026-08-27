import { describe, expect, it } from "vitest";
import { InMemoryEventBus, type DomainEvent } from "../../src/shared/events.js";
import { FixedClock } from "../../src/shared/clock.js";
import { buildPortfolioSnapshot } from "../../src/domain/portfolio.js";
import type { AppPorts, CashFlow } from "../../src/application/ports.js";
import { PortfolioEvaluationService } from "../../src/application/services/portfolio-evaluation.js";

interface Fixture {
  cash: number;
  cashFlows?: (sinceIso: string) => Promise<CashFlow[]>;
  prevNav?: { units: number; navPerUnit: number; totalValue: number } | null;
}

function makePorts(fx: Fixture) {
  const bus = new InMemoryEventBus();
  const events: DomainEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const savedNav: { units: number; navPerUnit: number }[] = [];
  const prevSnapshot = buildPortfolioSnapshot({
    id: "snap0",
    runId: "run0",
    asOf: "2026-08-26T13:00:00Z",
    currency: "GBP",
    cash: 10_000,
    positions: [],
    prevTotalValue: null,
  });
  const warnings: string[] = [];
  const ports: AppPorts = {
    clock: new FixedClock(new Date("2026-08-26T14:00:00Z")),
    logger: { debug: () => {}, info: () => {}, error: () => {}, warn: (msg: string) => { warnings.push(msg); } },
    events: bus,
    calendar: { isOpen: () => true },
    llm: { available: () => false, chat: async () => "", chatJson: async <T,>(): Promise<T> => ({}) as T },
    prices: { quote: async () => { throw new Error("no quotes"); }, candles: async () => [] },
    news: { latestNews: async () => [] },
    fundamentals: { fundamentals: async () => { throw new Error("n/a"); } },
    sentiment: { sentiment: async () => ({ ticker: "X", score: 0, label: "neutral", source: "x", details: {} }) },
    macro: null,
    fx: { rate: async () => 0.8 },
    broker: {
      kind: "trading212",
      account: async () => ({ currency: "GBP", cash: fx.cash, totalValue: fx.cash, investedValue: 0 }),
      positions: async () => [],
      submitOrder: async () => ({ brokerOrderId: "x", status: "SUBMITTED" }),
      orderStatus: async () => ({ status: "NEW", filledQuantity: 0, filledPriceAvg: null }),
      ...(fx.cashFlows ? { cashFlows: fx.cashFlows } : {}),
    },
    runs: { save: async () => {}, get: async () => null, latest: async () => [], findSameHour: async () => null },
    analysis: { save: async () => {}, saveMany: async () => {}, byRun: async () => [], latestByTicker: async () => [] },
    portfolio: {
      save: async () => {},
      latest: async () => prevSnapshot,
      history: async () => [],
      saveNav: async (_runId, _asOf, units, navPerUnit) => { savedNav.push({ units, navPerUnit }); },
      latestNav: async () => (fx.prevNav === undefined ? { units: 1000, navPerUnit: 10, totalValue: 10_000 } : fx.prevNav),
    },
    decisions: { save: async () => {}, byRun: async () => [], latest: async () => [] },
    orders: { save: async () => {}, get: async () => null, byRun: async () => [], latest: async () => [], recentByTicker: async () => [], openOrders: async () => [], stalePending: async () => [] },
    eventRepo: { append: async () => {}, byRun: async () => [], recent: async () => [] },
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
    allocationTargets: { saveUpdates: async () => {}, current: async () => [], recentUpdates: async () => [] },
  };
  return { ports, events, savedNav, warnings };
}

const svc = (ports: AppPorts) => new PortfolioEvaluationService(ports, [], 0.04, 0.1, null);

describe("PortfolioEvaluationService NAV cash-flow adjustment", () => {
  it("a deposit since the previous snapshot adds units at the previous NAV instead of inflating performance", async () => {
    const deposit: CashFlow = { amount: 1000, currency: "GBP", occurredAt: "2026-08-26T13:30:00Z", type: "DEPOSIT", reference: "d1" };
    const seen: string[] = [];
    const { ports, events, savedNav } = makePorts({
      cash: 11_000, // 10 000 + the deposit, no market move
      cashFlows: async (since) => { seen.push(since); return [deposit]; },
    });
    const result = await svc(ports).evaluate("run1");
    expect(seen).toEqual(["2026-08-26T13:00:00Z"]); // asked from the previous snapshot onwards
    expect(result.nav.units).toBeCloseTo(1100, 4);
    expect(result.nav.navPerUnit).toBeCloseTo(10, 4); // unchanged: the deposit is not performance
    expect(savedNav).toEqual([{ units: 1100, navPerUnit: 10 }]);
    const evt = events.find((e) => e.type === "NavCashFlowsApplied");
    expect(evt?.payload).toMatchObject({ netAmount: 1000, count: 1 });
  });

  it("converts flows in another currency into the account currency", async () => {
    const { ports } = makePorts({
      cash: 10_800, // 10 000 + 1000 USD × 0.8
      cashFlows: async () => [{ amount: 1000, currency: "USD", occurredAt: "2026-08-26T13:30:00Z", type: "DEPOSIT", reference: "d2" }],
    });
    const result = await svc(ports).evaluate("run1");
    expect(result.nav.units).toBeCloseTo(1080, 4);
    expect(result.nav.navPerUnit).toBeCloseTo(10, 4);
  });

  it("contains a failing transactions feed: warns and leaves units unchanged", async () => {
    const { ports, warnings } = makePorts({
      cash: 11_000,
      cashFlows: async () => { throw new Error("HTTP 500"); },
    });
    const result = await svc(ports).evaluate("run1");
    expect(result.nav.units).toBe(1000);
    expect(result.nav.navPerUnit).toBeCloseTo(11, 4); // without flow data the change counts as performance
    expect(warnings.some((w) => w.includes("cash flows"))).toBe(true);
  });

  it("brokers without a transactions feed (paper) keep the fixed-units behaviour", async () => {
    const { ports } = makePorts({ cash: 11_000 });
    const result = await svc(ports).evaluate("run1");
    expect(result.nav).toEqual({ units: 1000, navPerUnit: 11 });
  });

  it("starts a fresh ledger at 1000 units on the first snapshot", async () => {
    const { ports } = makePorts({ cash: 5_000, prevNav: null, cashFlows: async () => [] });
    const result = await svc(ports).evaluate("run1");
    expect(result.nav).toEqual({ units: 1000, navPerUnit: 5 });
  });
});
