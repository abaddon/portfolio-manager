import { describe, expect, it } from "vitest";
import { PipelineOrchestrator, type PipelineDependencies } from "../../src/application/services/pipeline.js";
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
import type { Decision } from "../../src/domain/decision.js";
import type { CommitteeSession } from "../../src/domain/committee.js";

function makeHarness(opts: { committeeEnabled: boolean }) {
  const db = openDatabase(":memory:");
  const clock = new FixedClock(new Date("2026-08-26T14:30:00Z")); // Wed 10:30 ET — market open
  const calls = { review: 0, decide: 0, runSession: 0 };

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

  const session: CommitteeSession = {
    id: "s1",
    runId: "run1",
    status: "COMPLETED",
    round: 1,
    winnerProposalId: "p1",
    error: null,
    createdAt: "t",
    completedAt: "t",
    details: {},
  };

  const deps = {
    analysts: [],
    analysis: { analyze: async () => [] },
    allocationBootstrap: { bootstrapIfNeeded: async () => {} },
    allocationReview: {
      review: async () => {
        calls.review++;
        return { updates: [], targets: [] };
      },
      currentTargets: async () => [],
    },
    portfolio: {
      evaluate: async () => ({
        snapshot: { id: "snap", runId: "run1", asOf: "t", currency: "GBP", cash: 100, totalValue: 1000, investedValue: 900, dayChangePct: null, benchmarkChangePct: null, positions: [] },
        heat: 0,
        drift: [],
        nav: { units: 1000, navPerUnit: 1 },
      }),
    },
    decisions: {
      decide: async () => {
        calls.decide++;
        return [] as Decision[];
      },
    },
    execution: {
      execute: async () => ({ orders: [], filled: [], rejected: [], failed: [] }),
      reconcileStalePending: async () => ({ adopted: 0, failed: 0 }),
      sweepOpenOrders: async () => {},
      retryPrecisionFailures: async () => {},
    },
    committee: {
      isEnabled: async () => opts.committeeEnabled,
      runSession: async () => {
        calls.runSession++;
        return { session, decisions: [] as Decision[] };
      },
    },
  } as unknown as PipelineDependencies;

  const orchestrator = new PipelineOrchestrator(ports, deps, { tickers: ["MSFT"], benchmark: "SPY" });
  return { ports, orchestrator, calls };
}

describe("PipelineOrchestrator — decision flow selection", () => {
  it("runs the committee flow when enabled and bypasses review + analyst decisions", async () => {
    const { ports, orchestrator, calls } = makeHarness({ committeeEnabled: true });
    const run = await orchestrator.runOnce({ force: true, skipHourGuard: true });

    expect(run.status).toBe("COMPLETED");
    expect(calls.runSession).toBe(1);
    expect(calls.review).toBe(0);
    expect(calls.decide).toBe(0);
    expect(run.details.decisionProcess).toBe("committee");

    const persisted = (await ports.runs.get(run.id))!;
    expect(persisted.details.decisionProcess).toBe("committee");
  });

  it("runs the classic flow when the committee is disabled", async () => {
    const { ports, orchestrator, calls } = makeHarness({ committeeEnabled: false });
    const run = await orchestrator.runOnce({ force: true, skipHourGuard: true });

    expect(run.status).toBe("COMPLETED");
    expect(calls.runSession).toBe(0);
    expect(calls.review).toBe(1);
    expect(calls.decide).toBe(1);
    expect(run.details.decisionProcess).toBe("classic");

    const persisted = (await ports.runs.get(run.id))!;
    expect(persisted.details.decisionProcess).toBe("classic");
  });
});
