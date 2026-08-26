import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/adapters/persistence/sqlite.js";
import { SqliteAllocationTargetRepository } from "../../src/adapters/persistence/allocation-targets.js";
import { SqliteAnalysisRepository, SqliteEventRepository } from "../../src/adapters/persistence/repositories.js";
import { InMemoryEventBus } from "../../src/shared/events.js";
import { FixedClock } from "../../src/shared/clock.js";
import { NullLogger } from "../../src/shared/logger.js";
import { AnalysisReport } from "../../src/domain/analysis.js";
import type { AllocationTarget } from "../../src/domain/portfolio.js";
import { AllocationReviewService, type AllocationReviewConfig } from "../../src/application/services/allocation-review.js";
import type { AppPorts } from "../../src/application/ports.js";

const SEEDS: AllocationTarget[] = [
  { ticker: "MSFT", weight: 0.2 },
  { ticker: "NVDA", weight: 0.05 },
];

const CFG: AllocationReviewConfig = {
  enabled: true,
  maxDeltaPerRun: 0.02,
  minConviction: 0.4,
  maxTarget: 0.25,
  minCashBuffer: 0.05,
};

function reports(ticker: string, adjustment: number, conviction: number): AnalysisReport[] {
  return (["market", "sentiment", "news", "fundamentals"] as const).map((k) =>
    new AnalysisReport(
      `an-${ticker}-${k}`,
      "run1",
      ticker,
      k,
      adjustment > 0 ? "bullish" : "bearish",
      conviction,
      `test rationale for ${k} — enough text`,
      { targetWeightAdjustment: adjustment, confidence: conviction },
      "2026-08-26T14:01:00Z",
      {},
    ),
  );
}

function makePorts(): AppPorts {
  const db = openDatabase(":memory:");
  const empty = async () => undefined;
  return {
    clock: new FixedClock(new Date("2026-08-26T14:00:00Z")),
    logger: new NullLogger(),
    events: new InMemoryEventBus(),
    calendar: { isOpen: () => true },
    llm: { available: () => false, chat: async () => "", chatJson: async <T,>(): Promise<T> => ({}) as T },
    prices: { quote: async () => ({ ticker: "X", price: 1, currency: "USD", prevClose: null, changePct: null, volume: null, asOf: "x" }), candles: async () => [] },
    news: { latestNews: async () => [] },
    fundamentals: { fundamentals: async () => { throw new Error("n/a"); } },
    sentiment: { sentiment: async () => ({ ticker: "X", score: 0, label: "neutral", source: "x", details: {} }) },
    fx: { rate: async () => 1 },
    broker: { kind: "paper", account: async () => ({ currency: "GBP", cash: 0, totalValue: 0, investedValue: 0 }), positions: async () => [], submitOrder: async () => ({ brokerOrderId: "x", status: "SUBMITTED" }), orderStatus: async () => ({ status: "NEW", filledQuantity: 0, filledPriceAvg: null }) },
    runs: { save: async () => {}, get: async () => null, latest: async () => [], findSameHour: async () => null },
    analysis: new SqliteAnalysisRepository(db),
    portfolio: { save: async () => {}, latest: async () => null, history: async () => [], saveNav: async () => {}, latestNav: async () => null },
    decisions: { save: async () => {}, byRun: async () => [], latest: async () => [] },
    orders: { save: async () => {}, get: async () => null, byRun: async () => [], latest: async () => [], recentByTicker: async () => [], openOrders: async () => [], stalePending: async () => [] },
    eventRepo: new SqliteEventRepository(db),
    marketData: { saveSnapshots: empty, saveNews: empty, saveSentiment: empty, snapshotsByTicker: async () => [], latestNews: async () => [], latestSentiment: async () => [] },
    allocationTargets: new SqliteAllocationTargetRepository(db),
  };
}

describe("AllocationReviewService", () => {
  it("raises targets when analysts are bullish with conviction (bounded per run)", async () => {
    const ports = makePorts();
    const svc = new AllocationReviewService(ports, SEEDS, CFG);
    const result = await svc.review("run1", [...reports("MSFT", 0.15, 0.7), ...reports("NVDA", 0.1, 0.6)]);
    expect(result.updates.map((u) => u.ticker).sort()).toEqual(["MSFT", "NVDA"]);
    const msft = result.updates.find((u) => u.ticker === "MSFT")!;
    expect(msft.weight).toBeCloseTo(0.22, 4); // +0.02 cap (0.15 signal clamped)
    expect(msft.weight - 0.2).toBeLessThanOrEqual(0.02 + 1e-9);
    expect(msft.rationale).toContain("market");
    expect(msft.originalWeight).toBeCloseTo(0.2, 4);

    // Persisted: current targets now reflect the review.
    const current = await svc.currentTargets();
    expect(current.find((t) => t.ticker === "MSFT")?.weight).toBeCloseTo(0.22, 4);
  });

  it("ignores low-conviction signals", async () => {
    const ports = makePorts();
    const svc = new AllocationReviewService(ports, SEEDS, CFG);
    const result = await svc.review("run1", reports("MSFT", 0.15, 0.3)); // below 0.4
    expect(result.updates).toHaveLength(0);
  });

  it("never exceeds the per-name cap", async () => {
    const ports = makePorts();
    const svc = new AllocationReviewService(ports, [{ ticker: "MSFT", weight: 0.24 }], CFG);
    const result = await svc.review("run1", reports("MSFT", 0.15, 0.8));
    expect(result.updates[0]!.weight).toBeCloseTo(0.25, 4); // capped at maxTarget
  });

  it("scales changes down to preserve the cash floor", async () => {
    const ports = makePorts();
    // Four names already at the cash floor (0.95 total), each under the per-name cap.
    const seeds: AllocationTarget[] = [
      { ticker: "A", weight: 0.24 },
      { ticker: "B", weight: 0.24 },
      { ticker: "C", weight: 0.24 },
      { ticker: "D", weight: 0.23 },
    ];
    const svc = new AllocationReviewService(ports, seeds, CFG);
    const reportsAll = ["A", "B", "C", "D"].flatMap((t) => reports(t, 0.15, 0.8));
    const result = await svc.review("run1", reportsAll);
    const total = result.targets.reduce((s, t) => s + t.weight, 0);
    expect(total).toBeLessThanOrEqual(0.95 + 1e-9); // 1 - minCashBuffer
    expect(total).toBeGreaterThan(0.9);
    // Every name moved up (bounded), scaled proportionally to the floor.
    expect(result.updates).toHaveLength(4);
  });

  it("scales unchanged tickers too when the cash floor is breached", async () => {
    const ports = makePorts();
    const seeds: AllocationTarget[] = [
      { ticker: "A", weight: 0.24 },
      { ticker: "B", weight: 0.24 },
      { ticker: "C", weight: 0.24 },
      { ticker: "D", weight: 0.23 },
    ];
    const svc = new AllocationReviewService(ports, seeds, CFG);
    // Only A has a bullish proposal; B/C/D stay put but must scale down anyway.
    const result = await svc.review("run1", reports("A", 0.15, 0.8));
    const total = result.targets.reduce((sum, t) => sum + t.weight, 0);
    expect(total).toBeLessThanOrEqual(0.95 + 1e-9);
    const b = result.targets.find((t) => t.ticker === "B")!;
    expect(b.weight).toBeLessThan(0.24); // scaled down without a proposal
    const dUpdate = result.updates.find((u) => u.ticker === "B");
    expect(dUpdate?.rationale).toContain("cash-floor");
  });

  it("does nothing when adaptation is disabled", async () => {
    const ports = makePorts();
    const svc = new AllocationReviewService(ports, SEEDS, { ...CFG, enabled: false });
    const result = await svc.review("run1", reports("MSFT", 0.15, 0.8));
    expect(result.updates).toHaveLength(0);
    expect(result.targets).toEqual(SEEDS);
  });

  it("drops a target toward zero on strong bearish conviction", async () => {
    const ports = makePorts();
    const svc = new AllocationReviewService(ports, SEEDS, CFG);
    const result = await svc.review("run1", reports("NVDA", -0.15, 0.8));
    const nvda = result.updates.find((u) => u.ticker === "NVDA")!;
    expect(nvda.weight).toBeCloseTo(0.03, 4); // 0.05 - 0.02
  });
});

describe("SqliteAllocationTargetRepository", () => {
  it("returns the latest target per ticker", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteAllocationTargetRepository(db);
    await repo.saveUpdates([
      { id: "tg1", runId: "run1", ticker: "MSFT", weight: 0.21, originalWeight: 0.2, rationale: "r1", conviction: 0.6, updatedAt: "2026-08-26T14:01:00Z" },
      { id: "tg2", runId: "run2", ticker: "MSFT", weight: 0.23, originalWeight: 0.2, rationale: "r2", conviction: 0.7, updatedAt: "2026-08-26T15:01:00Z" },
      { id: "tg3", runId: "run2", ticker: "NVDA", weight: 0.06, originalWeight: 0.05, rationale: "r3", conviction: 0.8, updatedAt: "2026-08-26T15:01:00Z" },
    ]);
    const current = await repo.current();
    expect(current).toHaveLength(2);
    expect(current.find((t) => t.ticker === "MSFT")?.weight).toBeCloseTo(0.23, 4);
    expect((await repo.recentUpdates(10))).toHaveLength(3);
    db.close();
  });
});
