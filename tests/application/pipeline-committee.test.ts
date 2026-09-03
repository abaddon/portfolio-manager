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
import type { AllocationTarget } from "../../src/domain/portfolio.js";
import type { CommitteeSession } from "../../src/domain/committee.js";

const TARGETS: AllocationTarget[] = [{ ticker: "MSFT", weight: 0.4 }];

function makeHarness(opts: { failSession?: boolean } = {}) {
  const db = openDatabase(":memory:");
  const clock = new FixedClock(new Date("2026-08-26T14:30:00Z")); // Wed 10:30 ET — market open
  const calls = { session: 0, execute: 0 };
  let sessionCtx: { targets: AllocationTarget[] } | null = null;
  let executed: Decision[] = [];

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

  const gatedDecision = {
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
      estimatedPrice: 420,
      estimatedValue: 100,
      currency: "USD",
      expectedBenefit: 1,
      costEstimate: { currency: "GBP", spread: 0.02, fxFee: 0.15, stampDuty: 0, platformFee: 0, total: 0.17 },
      rationale: "Macro Strategist (committee): test",
      confidence: 0.8,
    },
    decidedAt: "t",
    details: { source: "committee" },
  } as unknown as Decision;

  const deps = {
    analysis: { analyze: async () => [] },
    allocationBootstrap: { bootstrapIfNeeded: async () => {} },
    targets: { currentTargets: async () => TARGETS },
    portfolio: {
      evaluate: async () => ({
        snapshot: { id: "snap", runId: "run1", asOf: "t", currency: "GBP", cash: 100, totalValue: 1000, investedValue: 900, dayChangePct: null, benchmarkChangePct: null, positions: [] },
        heat: 0,
        drift: [],
        nav: { units: 1000, navPerUnit: 1 },
      }),
    },
    execution: {
      execute: async (_runId: string, decisions: Decision[]) => {
        calls.execute++;
        executed = decisions;
        return { orders: [], filled: [], rejected: [], failed: [] };
      },
      reconcileStalePending: async () => ({ adopted: 0, failed: 0 }),
      sweepOpenOrders: async () => {},
      retryPrecisionFailures: async () => {},
    },
    committee: {
      runSession: async (_runId: string, ctx: { targets: AllocationTarget[] }) => {
        calls.session++;
        sessionCtx = ctx;
        return { session, decisions: opts.failSession ? [] : [gatedDecision] };
      },
    },
  } as unknown as PipelineDependencies;

  const orchestrator = new PipelineOrchestrator(ports, deps, { tickers: ["MSFT"], benchmark: "SPY" });
  return {
    ports,
    orchestrator,
    calls,
    getSessionCtx: () => sessionCtx,
    getExecuted: () => executed,
  };
}

describe("PipelineOrchestrator — unified committee flow (ADR 0009)", () => {
  it("always decides through a committee session and executes its gated decisions", async () => {
    const { ports, orchestrator, calls, getSessionCtx, getExecuted } = makeHarness();
    const run = await orchestrator.runOnce({ force: true, skipHourGuard: true });

    expect(run.status).toBe("COMPLETED");
    expect(calls.session).toBe(1); // the ONLY decision path
    expect(calls.execute).toBe(1);
    expect(run.details.decisionProcess).toBe("committee");

    // The committee received the current allocation targets as its input.
    expect(getSessionCtx()?.targets).toEqual(TARGETS);
    // The session's gated decisions are exactly what execution received.
    expect(getExecuted()).toHaveLength(1);
    expect(getExecuted()[0]!.ticker).toBe("MSFT");

    const persisted = (await ports.runs.get(run.id))!;
    expect(persisted.details.decisionProcess).toBe("committee");
    expect(persisted.details.approvedDecisions).toBe(1);
  });

  it("contains a failed committee session: the run completes with no decisions or orders", async () => {
    const { orchestrator, calls, getExecuted } = makeHarness({ failSession: true });
    const run = await orchestrator.runOnce({ force: true, skipHourGuard: true });

    expect(run.status).toBe("COMPLETED");
    expect(calls.session).toBe(1);
    expect(run.details.decisions).toBe(0);
    expect(run.details.approvedDecisions).toBe(0);
    expect(getExecuted()).toHaveLength(0);
  });
});
