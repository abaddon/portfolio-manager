import { describe, expect, it } from "vitest";
import { PipelineOrchestrator, type PipelineDependencies } from "../../src/application/services/pipeline.js";
import { RunInProgressError } from "../../src/domain/run.js";
import { openDatabase } from "../../src/adapters/persistence/sqlite.js";
import {
  SqliteAnalysisRepository,
  SqliteDecisionRepository,
  SqliteEventRepository,
  SqliteOrderRepository,
  SqlitePortfolioRepository,
  SqliteRunRepository,
} from "../../src/adapters/persistence/repositories.js";
import { FixedClock } from "../../src/shared/clock.js";
import { NullLogger } from "../../src/shared/logger.js";
import { InMemoryEventBus } from "../../src/shared/events.js";
import type { AppPorts } from "../../src/application/ports.js";

/** A promise whose resolution is controlled by the test. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

function makeHarness(opts: { failPortfolio?: boolean } = {}) {
  const db = openDatabase(":memory:");
  const clock = new FixedClock(new Date("2026-08-26T14:30:00Z")); // Wed 10:30 ET — market open
  const analysisGate = gate();
  const analysisCalls: string[] = [];

  const ports = {
    clock,
    logger: new NullLogger(),
    events: new InMemoryEventBus(),
    calendar: { isOpen: () => true },
    llm: { available: () => false, chat: async () => "", chatJson: async <T,>(): Promise<T> => ({}) as T },
    prices: { quote: async () => ({ ticker: "X", price: 1, currency: "USD", prevClose: null, changePct: null, volume: null, asOf: "x" }), candles: async () => [] },
    news: { latestNews: async () => [] },
    fundamentals: { fundamentals: async () => { throw new Error("n/a"); } },
    sentiment: { sentiment: async () => ({ ticker: "X", score: 0, label: "neutral", source: "x", details: {} }) },
    macro: null,
    fx: { rate: async () => 1 },
    broker: { kind: "paper", account: async () => ({ currency: "GBP", cash: 0, totalValue: 0, investedValue: 0 }), positions: async () => [], submitOrder: async () => ({ brokerOrderId: "x", status: "SUBMITTED" }), orderStatus: async () => ({ status: "NEW", filledQuantity: 0, filledPriceAvg: null }) },
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
    allocationTargets: { saveUpdates: async () => {}, current: async () => [], recentUpdates: async () => [] },
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
  } as AppPorts;

  const deps = {
    analysts: [],
    analysis: {
      analyze: async (runId: string) => {
        analysisCalls.push(runId);
        await analysisGate.promise; // holds the run in flight until released
        return [];
      },
    },
    allocationBootstrap: { bootstrapIfNeeded: async () => {} },
    allocationReview: { review: async () => ({ updates: [] }) },
    portfolio: {
      evaluate: async () => {
        if (opts.failPortfolio) throw new Error("evaluation exploded");
        return {
          snapshot: { totalValue: 1000, cash: 100, currency: "GBP", investedValue: 900, dayChangePct: null, benchmarkChangePct: null, positions: [] },
          heat: 0,
          drift: [],
        };
      },
    },
    decisions: { decide: async () => [] },
    committee: { isEnabled: async () => false },
    execution: {
      execute: async () => ({ orders: [], filled: [], rejected: [], failed: [] }),
      reconcileStalePending: async () => ({ adopted: 0, failed: 0 }),
      sweepOpenOrders: async () => {},
      retryPrecisionFailures: async () => {},
    },
  } as unknown as PipelineDependencies;

  const orchestrator = new PipelineOrchestrator(ports, deps, { tickers: ["MSFT"], benchmark: "SPY" });
  return { ports, orchestrator, analysisGate, analysisCalls };
}

describe("PipelineOrchestrator — single-flight execution", () => {
  it("rejects a manual run while another run is executing, and recovers afterwards", async () => {
    const { ports, orchestrator, analysisGate, analysisCalls } = makeHarness();

    const first = orchestrator.runOnce();
    // Let the first run reach the analysis step (blocked on the gate).
    await new Promise((r) => setTimeout(r, 0));
    expect(analysisCalls).toHaveLength(1);
    // The RUNNING row is already persisted — this is what the dashboard shows.
    const inFlightId = (await ports.runs.latest(1))[0]!.id;

    // Manual trigger while in flight → fails fast, carrying the running id.
    await expect(orchestrator.runOnce({ skipHourGuard: true })).rejects.toBeInstanceOf(RunInProgressError);
    const err = await orchestrator.runOnce({ skipHourGuard: true }).catch((e: unknown) => e);
    expect((err as RunInProgressError).runId).toBe(inFlightId);

    analysisGate.release();
    expect((await first).status).toBe("COMPLETED");
    expect(analysisCalls).toHaveLength(1); // nothing ever ran concurrently

    // After completion the guard is clear and a manual run goes through again.
    const second = await orchestrator.runOnce({ skipHourGuard: true });
    expect(second.status).toBe("COMPLETED");
    expect(analysisCalls).toHaveLength(2);
  });

  it("records a SKIPPED run (never queues) when a scheduled trigger fires during an in-flight run", async () => {
    const { ports, orchestrator, analysisGate } = makeHarness();

    const first = orchestrator.runOnce();
    await new Promise((r) => setTimeout(r, 0));
    const inFlightId = (await ports.runs.latest(1))[0]!.id;

    const scheduled = await orchestrator.runOnce(); // scheduler-style: no skipHourGuard
    expect(scheduled.status).toBe("SKIPPED");
    expect(scheduled.error).toContain("already in progress");
    expect(scheduled.error).toContain(inFlightId);
    expect(scheduled.id).not.toBe(inFlightId);

    // The skipped run is persisted so the dashboard can explain why nothing happened.
    expect((await ports.runs.get(scheduled.id))?.status).toBe("SKIPPED");

    analysisGate.release();
    expect((await first).status).toBe("COMPLETED");
  });

  it("clears the guard after a FAILED run (no stuck in-flight state)", async () => {
    const { orchestrator, analysisGate } = makeHarness({ failPortfolio: true });

    const first = orchestrator.runOnce();
    await new Promise((r) => setTimeout(r, 0));

    analysisGate.release();
    const firstRun = await first;
    expect(firstRun.status).toBe("FAILED");

    // The guard must be clear after the failure — a new run starts normally.
    const retry = await orchestrator.runOnce({ skipHourGuard: true });
    expect(retry.status).toBe("FAILED"); // still failing, but the run started
    expect(retry.id).not.toBe(firstRun.id);
  });
});
