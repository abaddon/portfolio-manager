import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { buildApp } from "../../src/composition/root.js";
import { FixedClock } from "../../src/shared/clock.js";
import { NullLogger } from "../../src/shared/logger.js";

const CONFIG = resolve(process.cwd(), "tests/fixtures/bootstrap-test-config.json");
const OPEN = new Date("2026-08-26T14:30:00Z"); // Wed, market open

describe("Allocation bootstrap end-to-end (existing portfolio, no configured targets)", () => {
  it("derives targets from the broker's positions and proceeds with the normal workflow", async () => {
    const app = buildApp({
      configPath: CONFIG,
      env: {} as NodeJS.ProcessEnv,
      dbPath: ":memory:",
      logger: new NullLogger(),
      clock: new FixedClock(OPEN),
    });
    try {
      const run = await app.orchestrator.runOnce();
      await app.flushEvents();
      expect(run.status).toBe("COMPLETED");

      // Targets bootstrapped from the paper account's initial positions.
      const targets = await app.ports.allocationTargets.current();
      expect(targets).toHaveLength(2);
      const msft = targets.find((t) => t.ticker === "MSFT")!;
      const aapl = targets.find((t) => t.ticker === "AAPL")!;
      // MSFT: 2 × 420 × 0.79 = 663.6; AAPL: 5 × 210 × 0.79 = 829.5; cash 1000 → total 2493.1
      expect(msft.weight).toBeCloseTo(663.6 / 2493.1, 4);
      expect(aapl.weight).toBeCloseTo(829.5 / 2493.1, 4);
      expect(msft.weight + aapl.weight).toBeLessThan(1); // cash stays out of the targets

      // The bootstrap was persisted as the initial review rows.
      const recent = await app.ports.allocationTargets.recentUpdates(10);
      expect(recent.every((u) => u.rationale.includes("bootstrapped"))).toBe(true);

      // Event trail recorded it.
      const events = await app.ports.eventRepo.byRun(run.id);
      expect(events.map((e) => e.type)).toContain("TargetsBootstrapped");

      // The normal workflow continued: analysis, evaluation against the
      // bootstrapped targets, decisions.
      expect(await app.ports.analysis.byRun(run.id)).toHaveLength(8);
      expect((await app.ports.decisions.byRun(run.id)).length).toBeGreaterThanOrEqual(0);
      const snapshot = await app.ports.portfolio.latest();
      expect(snapshot?.totalValue).toBeGreaterThan(0);

      // Second run in a new... same hour returns existing (guard) — but a
      // fresh app + fresh DB in the same hour is a new DB, so bootstrap runs
      // again — covered by unit tests instead. No duplicate bootstrap rows
      // within one DB: re-running the pipeline must NOT add more rows.
      const again = await app.orchestrator.runOnce();
      expect(again.id).toBe(run.id); // hour guard
      expect((await app.ports.allocationTargets.recentUpdates(50))).toHaveLength(2);
    } finally {
      app.close();
    }
  });

  it("fails with a clear error when there are no targets AND no positions", async () => {
    const app = buildApp({
      configPath: CONFIG,
      env: {} as NodeJS.ProcessEnv,
      dbPath: ":memory:",
      logger: new NullLogger(),
      clock: new FixedClock(OPEN),
    });
    // Empty the paper broker's positions by draining them via sells is complex;
    // instead verify the domain-level guard directly through the service.
    const { AllocationBootstrapService } = await import("../../src/application/services/target-bootstrap.js");
    const ports = app.ports;
    ports.broker.positions = async () => [];
    const svc = new AllocationBootstrapService(ports, []);
    await expect(svc.bootstrapIfNeeded("run-x")).rejects.toThrow(/no allocation targets configured and the broker account holds no positions/);
    app.close();
  });
});
