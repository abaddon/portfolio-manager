import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/composition/root.js";
import { FixedClock } from "../../src/shared/clock.js";
import { NullLogger } from "../../src/shared/logger.js";
import { resolve } from "node:path";

const CONFIG = resolve(process.cwd(), "tests/fixtures/test-config.json");
const OPEN = new Date("2026-08-26T14:30:00Z"); // Wed, 10:30 ET — NYSE open
const SATURDAY = new Date("2026-08-29T15:00:00Z"); // market closed

function testApp(clock: FixedClock) {
  return buildApp({
    configPath: CONFIG,
    env: {} as NodeJS.ProcessEnv,
    dbPath: ":memory:",
    logger: new NullLogger(),
    clock,
  });
}

describe("Hourly pipeline end-to-end (paper mode, demo data)", () => {
  it("runs analysis → allocation evaluation → cost-gated decisions → execution, persisting everything", async () => {
    const app = testApp(new FixedClock(OPEN));
    try {
      const run = await app.orchestrator.runOnce();
      await app.flushEvents();

      expect(run.status).toBe("COMPLETED");
      expect(run.marketOpen).toBe(true);

      // 1. Market analysis: 4 analysts × 2 tickers, all persisted.
      const reports = await app.ports.analysis.byRun(run.id);
      expect(reports).toHaveLength(8);
      const kinds = new Set(reports.map((r) => r.analyst));
      expect(kinds).toEqual(new Set(["market", "sentiment", "news", "fundamentals"]));
      expect(reports.every((r) => r.rationale.length > 0)).toBe(true);

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

      // 3. Decisions: both tickers are under target → BUY proposals pass the cost gate.
      const decisions = await app.ports.decisions.byRun(run.id);
      expect(decisions).toHaveLength(2);
      for (const d of decisions) {
        expect(d.action).toBe("BUY");
        expect(d.approved).toBe(true);
        expect(d.reason).toBe("ECONOMICALLY_VIABLE");
        expect(d.proposal.costEstimate.total).toBeGreaterThan(0); // costs were evaluated
        expect(d.proposal.expectedBenefit).toBeGreaterThan(d.proposal.costEstimate.total); // economically correct
        expect(d.proposal.rationale).toContain("Allocation drift");
        expect(d.proposal.rationale).toContain("Estimated costs");
      }

      // 4. Execution: both orders filled by the paper broker, costs realized.
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

      // 5. Full event trail persisted.
      const events = await app.ports.eventRepo.byRun(run.id);
      const types = events.map((e) => e.type);
      for (const t of ["PipelineStarted", "AnalysisCompleted", "PortfolioEvaluated", "DecisionsTaken", "ExecutionCompleted", "PipelineCompleted"]) {
        expect(types).toContain(t);
      }
      expect(events.filter((e) => e.type === "OrderFilled")).toHaveLength(2);

      // 6. Idempotency: a second run in the same market hour is a no-op.
      const again = await app.orchestrator.runOnce();
      expect(again.id).toBe(run.id);
      expect(await app.ports.orders.byRun(run.id)).toHaveLength(2);
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
});
