import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/adapters/persistence/sqlite.js";
import { SqliteCommitteeRepository } from "../../src/adapters/persistence/committee.js";
import {
  SqliteDecisionRepository,
  SqliteEventRepository,
  SqliteOutcomeRepository,
  SqlitePortfolioRepository,
  SqliteRunRepository,
} from "../../src/adapters/persistence/repositories.js";
import { PerformanceService } from "../../src/application/services/performance.js";
import { Run } from "../../src/domain/run.js";
import { FixedClock } from "../../src/shared/clock.js";
import { InMemoryEventBus } from "../../src/shared/events.js";
import type { AppPorts } from "../../src/application/ports.js";
import type { Decision } from "../../src/domain/decision.js";
import type { Candle } from "../../src/domain/analysis.js";

function candles(ticker: string, closes: number[]): Candle[] {
  return closes.map((close, i) => ({ ticker, timestamp: String(i), open: close, high: close, low: close, close, volume: 1 }));
}

function harness(opts: { closes?: number[]; failCandles?: boolean } = {}) {
  const db = openDatabase(":memory:");
  const clock = new FixedClock(new Date("2026-09-14T14:00:00Z"));
  const published: string[] = [];
  const bus = new InMemoryEventBus();
  bus.subscribe((e) => published.push(e.type));
  const warnings: string[] = [];
  const prices = {
    quote: async () => {
      throw new Error("unused");
    },
    candles: async (ticker: string) => {
      if (opts.failCandles) throw new Error("no series");
      return candles(ticker, opts.closes ?? [100, 101, 102, 103, 104, 105]);
    },
  };
  const ports = {
    clock,
    logger: { debug: () => {}, info: () => {}, warn: (m: string) => warnings.push(m), error: () => {} },
    events: bus,
    prices,
    runs: new SqliteRunRepository(db),
    decisions: new SqliteDecisionRepository(db),
    orders: {},
    portfolio: new SqlitePortfolioRepository(db),
    committee: new SqliteCommitteeRepository(db),
    outcomes: new SqliteOutcomeRepository(db),
    eventRepo: new SqliteEventRepository(db),
  } as unknown as AppPorts;
  return { ports, db, published, warnings };
}

function decision(over: Partial<Decision> = {}): Decision {
  return {
    id: "dec1",
    runId: "run1",
    ticker: "MSFT",
    action: "BUY",
    quantity: 1,
    approved: true,
    reason: "ECONOMICALLY_VIABLE",
    proposal: {
      ticker: "MSFT",
      action: "BUY",
      quantity: 1,
      estimatedPrice: 100,
      estimatedValue: 200,
      currency: "GBP",
      expectedBenefit: 2,
      costEstimate: { currency: "GBP", spread: 0.04, fxFee: 0.3, stampDuty: 0, platformFee: 0, total: 0.34, costRatio: 0.0017 },
      rationale: "test",
      confidence: 0.8,
    },
    decidedAt: "2026-09-14T13:00:00Z",
    details: { agentId: "a1" },
    ...over,
  };
}

describe("PerformanceService (WP-P2.4)", () => {
  it("attributes an approved decision once the forward return is measurable", async () => {
    const { ports, db, published } = harness({ closes: [100, 101, 102, 103, 104, 105] });
    const run = Run.start("run1", "2026-09-14T13:00:00Z", true);
    run.complete("2026-09-14T13:05:00Z", {});
    await ports.runs.save(run);
    await ports.decisions.save(decision());

    const svc = new PerformanceService(ports, { scoringHorizonHours: 5, scorecardWindow: 20 });
    const result = await svc.score("run2");
    // 5 bars back: 100 → 105, so a £200 BUY contributed £10.
    expect(result).toEqual({ scored: 1, skipped: 0 });
    const outcomes = await ports.outcomes!.recent(10);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ decisionId: "dec1", ticker: "MSFT", approved: true, forwardReturnPct: 0.05 });
    expect(outcomes[0]!.contribution).toBeCloseTo(10, 2);
    expect(published).toContain("DecisionOutcomesScored");

    // Scoring is idempotent: the decision is no longer unscored.
    expect(await svc.score("run3")).toEqual({ scored: 0, skipped: 0 });
    db.close();
  });

  it("leaves a decision unscored when the series is unavailable, and never throws", async () => {
    const { ports, db, warnings } = harness({ failCandles: true });
    const run = Run.start("run1", "2026-09-14T13:00:00Z", true);
    run.complete("2026-09-14T13:05:00Z", {});
    await ports.runs.save(run);
    await ports.decisions.save(decision());

    const svc = new PerformanceService(ports);
    expect(await svc.score("run2")).toEqual({ scored: 0, skipped: 1 });
    expect(await ports.outcomes!.recent(10)).toEqual([]);
    expect(await ports.outcomes!.unscored(10)).toHaveLength(1); // still queued for later
    expect(warnings.length).toBe(0); // debug, not warn — a missing series is normal
    db.close();
  });

  it("only queues approved, non-HOLD decisions from completed runs", async () => {
    const { ports, db } = harness();
    const completed = Run.start("run1", "2026-09-14T13:00:00Z", true);
    completed.complete("2026-09-14T13:05:00Z", {});
    const failed = Run.start("run9", "2026-09-14T12:00:00Z", true);
    failed.fail("2026-09-14T12:05:00Z", "boom");
    await ports.runs.save(completed);
    await ports.runs.save(failed);
    await ports.decisions.save(decision({ id: "d-approved" }));
    await ports.decisions.save(decision({ id: "d-rejected", approved: false, action: "HOLD" }));
    await ports.decisions.save(decision({ id: "d-failed-run", runId: "run9" }));

    expect((await ports.outcomes!.unscored(10)).map((d) => d.id)).toEqual(["d-approved"]);
    db.close();
  });

  it("builds the committee's performance block from NAV history and scorecards", async () => {
    const { ports, db } = harness({ closes: [100, 101, 102, 103, 104, 105] });
    const run = Run.start("run1", "2026-09-14T13:00:00Z", true);
    run.complete("2026-09-14T13:05:00Z", {});
    await ports.runs.save(run);
    await ports.decisions.save(decision());
    // Two snapshots with a NAV and a benchmark move, as the pipeline writes them.
    await ports.portfolio.save({
      id: "s1",
      runId: "run1",
      asOf: "2026-09-14T13:00:00Z",
      currency: "GBP",
      cash: 100,
      positions: [],
      totalValue: 1000,
      investedValue: 900,
      dayChangePct: 0.5,
      benchmarkChangePct: 0.4,
      navUnits: 1000,
      navPerUnit: 1,
    });
    await ports.portfolio.save({
      id: "s2",
      runId: "run1",
      asOf: "2026-09-14T14:00:00Z",
      currency: "GBP",
      cash: 100,
      positions: [],
      totalValue: 1020,
      investedValue: 920,
      dayChangePct: 0.6,
      benchmarkChangePct: -0.2,
      navUnits: 1000,
      navPerUnit: 1.02,
    });
    const svc = new PerformanceService(ports, { scoringHorizonHours: 5, scorecardWindow: 20 });
    await svc.score("run2");

    const context = await svc.context();
    expect(context).not.toBeNull();
    expect(context!.sessions).toBe(2);
    expect(context!.navChangePct).toBeCloseTo(0.02, 4);
    // The benchmark series is rebuilt by compounding the stored day changes.
    expect(context!.benchmarkChangePct).toBeCloseTo(1.004 * 0.998 - 1, 4);
    expect(context!.alphaPct).not.toBeNull();
    expect(context!.worstDrawdownPct).toBe(0);
    db.close();
  });
});
