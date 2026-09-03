import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/composition/root.js";
import { FixedClock } from "../../src/shared/clock.js";
import { NullLogger } from "../../src/shared/logger.js";
import { resolve } from "node:path";
import { firstAgentWins, type ScriptedProposal } from "../helpers/scripted-committee.js";

const CONFIG = resolve(process.cwd(), "tests/fixtures/test-config.json");
const OPEN = new Date("2026-08-26T14:30:00Z"); // Wed, 10:30 ET — NYSE open
const SATURDAY = new Date("2026-08-29T15:00:00Z"); // market closed

/**
 * The committee is the ONE decision flow: the scripted winner proposes buying
 * both underweight names back toward target; the other agents propose
 * nothing. With the default vote script the first agent (a1) wins round 1.
 */
function committeeLlms() {
  const winner: ScriptedProposal = {
    title: "Rebalance to targets",
    rationale: "Both names are underweight versus target; buy them back toward the allocation while costs stay small.",
    confidence: 0.8,
    targets: [],
    orders: [
      { ticker: "MSFT", side: "BUY", value: 120, reason: "underweight vs target" },
      { ticker: "AAPL", side: "BUY", value: 120, reason: "underweight vs target" },
    ],
  };
  const noOrders = (title: string): ScriptedProposal => ({
    title,
    rationale: "No action needed this run; hold the current allocation.",
    confidence: 0.5,
    targets: [],
    orders: [],
  });
  return firstAgentWins(winner, [noOrders("Hold steady"), noOrders("Wait and see")]);
}

function testApp(clock: FixedClock) {
  return buildApp({
    configPath: CONFIG,
    env: {} as NodeJS.ProcessEnv,
    dbPath: ":memory:",
    logger: new NullLogger(),
    clock,
    committeeLlms: committeeLlms(),
  });
}

describe("Hourly pipeline end-to-end (paper mode, demo data, committee flow)", () => {
  it("runs analysis → evaluation → committee session → cost-gated decisions → execution, persisting everything", async () => {
    const app = testApp(new FixedClock(OPEN));
    try {
      const run = await app.orchestrator.runOnce();
      await app.flushEvents();

      expect(run.status).toBe("COMPLETED");
      expect(run.marketOpen).toBe(true);
      expect(run.details.decisionProcess).toBe("committee");

      // 1. Market analysis: 4 analysts × 2 tickers, all persisted.
      const reports = await app.ports.analysis.byRun(run.id);
      expect(reports).toHaveLength(8);
      const kinds = new Set(reports.map((r) => r.analyst));
      expect(kinds).toEqual(new Set(["market", "sentiment", "news", "fundamentals"]));
      expect(reports.every((r) => r.rationale.length > 0)).toBe(true);

      // 1b. Raw market inputs persisted: quotes (universe + benchmark), news, sentiment.
      expect(await app.ports.marketData.snapshotsByTicker("MSFT")).toHaveLength(1);
      expect(await app.ports.marketData.snapshotsByTicker("AAPL")).toHaveLength(1);
      expect(await app.ports.marketData.snapshotsByTicker("SPY")).toHaveLength(1); // benchmark too
      expect(await app.ports.marketData.latestNews(100)).not.toHaveLength(0);
      expect(await app.ports.marketData.latestSentiment(100)).toHaveLength(2);

      // 2. Portfolio snapshot persisted with FX-converted values + benchmark.
      const snapshot = await app.ports.portfolio.latest();
      expect(snapshot?.runId).toBe(run.id);
      expect(snapshot?.currency).toBe("GBP");
      expect(snapshot?.totalValue).toBeGreaterThan(0);
      expect(snapshot?.benchmarkChangePct).not.toBeNull(); // SPY quote captured
      const msft = snapshot!.positions.find((p) => p.ticker === "MSFT");
      expect(msft?.marketValueLocal).toBeCloseTo(2 * 420, 2); // USD value
      expect(msft?.marketValue).toBeCloseTo(2 * 420 * 0.79, 2); // GBP value
      const nav = await app.ports.portfolio.latestNav();
      expect(nav?.units).toBe(1000);
      expect(nav?.navPerUnit).toBeCloseTo(snapshot!.totalValue / 1000, 4);

      // 3. Committee session persisted: a1's proposal won the vote.
      const sessions = await app.ports.committee.byRun(run.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.status).toBe("COMPLETED");
      const detail = await app.ports.committee.detail(sessions[0]!.id);
      expect(detail.proposals).toHaveLength(3);
      const winner = detail.proposals.find((p) => p.status === "accepted")!;
      expect(winner.agentId).toBe("a1");
      expect(winner.points).toBe(2); // a2 + a3 voted for it

      // 4. Decisions: the winner's order intents passed the SAME economic gate.
      const decisions = await app.ports.decisions.byRun(run.id);
      expect(decisions).toHaveLength(2);
      for (const d of decisions) {
        expect(d.action).toBe("BUY");
        expect(d.approved).toBe(true);
        expect(d.reason).toBe("ECONOMICALLY_VIABLE");
        expect(d.details.source).toBe("committee");
        expect(d.details.agentId).toBe("a1");
        expect(d.proposal.costEstimate.total).toBeGreaterThan(0); // costs were evaluated
        expect(d.proposal.expectedBenefit).toBeGreaterThan(d.proposal.costEstimate.total); // economically correct
        expect(d.proposal.rationale).toContain("(committee)");
      }

      // 5. Execution: both orders filled by the paper broker, costs realized.
      const orders = await app.ports.orders.byRun(run.id);
      expect(orders).toHaveLength(2);
      for (const o of orders) {
        expect(o.status).toBe("FILLED");
        expect(o.fill?.filledQuantity).toBe(o.quantity);
        expect(o.fill?.realizedCost.fxFee).toBeGreaterThan(0); // USD→GBP conversion cost applied
      }
      const accountAfter = await app.ports.broker.account();
      expect(accountAfter.cash).toBeLessThan(5000); // buys consumed cash
      const positionsAfter = await app.ports.broker.positions();
      expect(positionsAfter.find((p) => p.ticker === "AAPL")?.quantity).toBeGreaterThan(0);

      // 6. Full event trail persisted — pipeline AND committee events.
      const events = await app.ports.eventRepo.byRun(run.id);
      const types = events.map((e) => e.type);
      for (const t of [
        "PipelineStarted",
        "AnalysisCompleted",
        "PortfolioEvaluated",
        "CommitteeSessionStarted",
        "CommitteeWinnerAccepted",
        "CommitteeSessionCompleted",
        "DecisionsTaken",
        "ExecutionCompleted",
        "PipelineCompleted",
      ]) {
        expect(types).toContain(t);
      }
      expect(events.filter((e) => e.type === "OrderFilled")).toHaveLength(2);

      // 7. Idempotency: a second run in the same market hour is a no-op.
      const again = await app.orchestrator.runOnce();
      expect(again.id).toBe(run.id);
      expect(await app.ports.orders.byRun(run.id)).toHaveLength(2);
    } finally {
      app.close();
    }
  });

  it("bypasses the per-hour guard for manual runs (skipHourGuard)", async () => {
    const app = testApp(new FixedClock(OPEN));
    try {
      const first = await app.orchestrator.runOnce();
      expect(first.status).toBe("COMPLETED");
      // Same market hour, but a manual request must always run fresh.
      const second = await app.orchestrator.runOnce({ force: true, skipHourGuard: true });
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe("COMPLETED");
      const runs = await app.ports.runs.latest(10);
      expect(runs.filter((r) => r.id === first.id || r.id === second.id)).toHaveLength(2);
    } finally {
      app.close();
    }
  });

  it("records a SKIPPED run with a reason when the market is closed", async () => {
    const app = testApp(new FixedClock(SATURDAY));
    try {
      const run = await app.orchestrator.runOnce();
      await app.flushEvents();
      expect(run.status).toBe("SKIPPED");
      expect(run.marketOpen).toBe(false);
      expect(run.error).toContain("market closed");
      const events = await app.ports.eventRepo.byRun(run.id);
      expect(events.map((e) => e.type)).toContain("PipelineSkipped");
      // No analysis or orders were produced.
      expect(await app.ports.analysis.byRun(run.id)).toHaveLength(0);
      expect(await app.ports.orders.byRun(run.id)).toHaveLength(0);
    } finally {
      app.close();
    }
  });

  it("runs when forced even outside market hours", async () => {
    const app = testApp(new FixedClock(SATURDAY));
    try {
      const run = await app.orchestrator.runOnce({ force: true });
      expect(run.status).toBe("COMPLETED");
      expect(run.marketOpen).toBe(false);
    } finally {
      app.close();
    }
  });

  it("completes the run with no decisions when the committee's LLMs are unavailable (containment)", async () => {
    const app = buildApp({
      configPath: CONFIG,
      env: {} as NodeJS.ProcessEnv,
      dbPath: ":memory:",
      logger: new NullLogger(),
      clock: new FixedClock(OPEN),
      // no committeeLlms + no API keys in env → UnavailableLlmClient agents
    });
    try {
      const run = await app.orchestrator.runOnce();
      await app.flushEvents();
      expect(run.status).toBe("COMPLETED"); // session failure never kills the run
      expect(run.details.decisions).toBe(0);
      expect(await app.ports.orders.byRun(run.id)).toHaveLength(0);
      const sessions = await app.ports.committee.byRun(run.id);
      expect(sessions[0]!.status).toBe("FAILED");
      expect(sessions[0]!.error).toContain("no LLM configured");
    } finally {
      app.close();
    }
  });
});
