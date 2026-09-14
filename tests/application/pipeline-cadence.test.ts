import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ZodType } from "zod";
import { buildApp } from "../../src/composition/root.js";
import { FixedClock } from "../../src/shared/clock.js";
import { NullLogger } from "../../src/shared/logger.js";
import type { LlmChatOptions, LlmPort } from "../../src/application/ports.js";
import { firstAgentWins, type ScriptedProposal } from "../helpers/scripted-committee.js";

const BASE = resolve(process.cwd(), "tests/fixtures/test-config.json");
const OPEN = new Date("2026-08-26T14:30:00Z"); // Wed 10:30 ET — market open

/**
 * A config with the materiality test at its least sensitive: nothing but the
 * planning slot can fire, so the *second* run of the same day must be stats-only.
 */
function materialConfig(): string {
  const cfg = JSON.parse(readFileSync(BASE, "utf8")) as Record<string, any>;
  cfg.schedule = {
    ...cfg.schedule,
    runOnStartup: false,
    triggerMode: "material",
    materiality: { navMovePct: 0.5, driftPct: 0.9, planningIntervalHours: 1000, newsLookbackHours: 0.001, driftCooldownHours: 6 },
  };
  const dir = mkdtempSync(join(tmpdir(), "cadence-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return path;
}

class CountingLlm implements LlmPort {
  calls = 0;
  constructor(private readonly inner: LlmPort) {}
  available(): boolean {
    return true;
  }
  async chat(opts: LlmChatOptions): Promise<string> {
    this.calls++;
    return this.inner.chat(opts);
  }
  async chatJson<T>(opts: LlmChatOptions, schema: ZodType<T>): Promise<T> {
    this.calls++;
    return this.inner.chatJson(opts, schema);
  }
}

function committeeLlms(): ReadonlyMap<string, LlmPort> {
  const winner: ScriptedProposal = {
    title: "Hold the allocation",
    rationale: "Nothing in the research justifies changing the allocation this hour; keep the plan as it is.",
    confidence: 0.6,
    targets: [],
    orders: [],
  };
  const hold = (title: string): ScriptedProposal => ({
    title,
    rationale: "No action needed this run; hold the current allocation and wait for new evidence.",
    confidence: 0.5,
    targets: [],
    orders: [],
  });
  return firstAgentWins(winner, [hold("Steady"), hold("Wait")]);
}

describe("event-driven cadence in the pipeline (WP-P1.1)", () => {
  it("runs the full path when a trigger fires and a stats-only pass when none does", async () => {
    const clock = new FixedClock(OPEN);
    const counters = new Map<string, CountingLlm>();
    for (const [id, inner] of committeeLlms()) counters.set(id, new CountingLlm(inner));
    const app = buildApp({
      configPath: materialConfig(),
      env: {} as NodeJS.ProcessEnv,
      dbPath: ":memory:",
      logger: new NullLogger(),
      clock,
      committeeLlms: counters,
    });
    try {
      // Run 1: no previous session on record → planning slot → the full path.
      const first = await app.orchestrator.runOnce();
      await app.flushEvents();
      expect(first.status).toBe("COMPLETED");
      const firstCadence = first.details.cadence as { material: boolean; triggers: string[] };
      expect(firstCadence.material).toBe(true);
      expect(firstCadence.triggers).toContain("planning-slot");
      expect(await app.ports.committee.latestSession()).not.toBeNull();
      const afterFirst = [...counters.values()].reduce((s, c) => s + c.calls, 0);
      expect(afterFirst).toBeGreaterThan(0);

      // Run 2, one hour later, same portfolio, no fresh news, no drift, planning
      // slot far away: nothing material → no LLM call at all.
      clock.advance(3_600_000);
      const second = await app.orchestrator.runOnce();
      await app.flushEvents();
      expect(second.status).toBe("COMPLETED");
      const secondCadence = second.details.cadence as { material: boolean; triggers: string[]; reason: string };
      expect(secondCadence.material).toBe(false);
      expect(secondCadence.triggers).toEqual([]);
      expect(secondCadence.reason).toContain("no LLM spend");
      expect([...counters.values()].reduce((s, c) => s + c.calls, 0)).toBe(afterFirst);

      // The cheap pass still did its job: snapshot persisted, portfolio evaluated,
      // reports not produced, no decisions, run complete.
      expect(second.details.reports).toBe(0);
      expect(second.details.decisions).toBe(0);
      const snapshots = await app.ports.portfolio.history(5);
      expect(snapshots.map((s) => s.runId)).toContain(second.id);
      const events = await app.ports.eventRepo.byRun(second.id);
      expect(events.find((e) => e.type === "PortfolioEvaluated")).toBeDefined();
      expect((events.find((e) => e.type === "AnalysisCompleted")?.payload as { skipped?: string }).skipped).toBe(
        "nothing material",
      );

      // Run 3: a forced/manual run bypasses the test (the dashboard button must
      // always be able to ask for a fresh cycle).
      clock.advance(3_600_000);
      const third = await app.orchestrator.runOnce({ skipHourGuard: true });
      await app.flushEvents();
      const thirdCadence = third.details.cadence as { material: boolean; triggers: string[] };
      expect(thirdCadence.material).toBe(true);
      expect(thirdCadence.triggers).toContain("manual");
      expect([...counters.values()].reduce((s, c) => s + c.calls, 0)).toBeGreaterThan(afterFirst);
    } finally {
      app.close();
    }
  });

  it("spends when a previous session left an unfunded target", async () => {
    const clock = new FixedClock(OPEN);
    const counters = new Map<string, CountingLlm>();
    const unfunded: ScriptedProposal = {
      title: "Raise MSFT without funding it",
      rationale: "MSFT deserves a larger weight, but this run proposes no order to move the position at all.",
      confidence: 0.8,
      targets: [{ ticker: "MSFT", weight: 0.25 }],
      orders: [],
    };
    const hold = (title: string): ScriptedProposal => ({
      title,
      rationale: "No action needed this run; hold the current allocation and wait for new evidence.",
      confidence: 0.5,
      targets: [],
      orders: [],
    });
    for (const [id, inner] of firstAgentWins(unfunded, [hold("Steady"), hold("Wait")])) {
      counters.set(id, new CountingLlm(inner));
    }
    const app = buildApp({
      configPath: materialConfig(),
      env: {} as NodeJS.ProcessEnv,
      dbPath: ":memory:",
      logger: new NullLogger(),
      clock,
      committeeLlms: counters,
    });
    try {
      const first = await app.orchestrator.runOnce();
      await app.flushEvents();
      expect((await app.ports.allocationTargets.current()).find((t) => t.ticker === "MSFT")?.status).toBe("UNFUNDED");

      clock.advance(3_600_000);
      const second = await app.orchestrator.runOnce();
      await app.flushEvents();
      const cadence = second.details.cadence as { material: boolean; triggers: string[] };
      expect(cadence.material).toBe(true);
      expect(cadence.triggers).toContain("unfunded-target");
      expect(first.details.decisions).toBe(0);
    } finally {
      app.close();
    }
  });

  it("measures a simulated trading day: calls per market hour with and without the materiality gate", async () => {
    const clock = new FixedClock(OPEN);
    const counters = new Map<string, CountingLlm>();
    // The committee scripts a winner that raises MSFT and funds it, so a material
    // run does real work rather than a no-op.
    const winner: ScriptedProposal = {
      title: "Fund the MSFT target",
      rationale: "MSFT is underweight versus its target and the research supports adding to it now.",
      confidence: 0.8,
      targets: [{ ticker: "MSFT", weight: 0.25 }],
      orders: [{ ticker: "MSFT", side: "BUY", value: 150, reason: "fund the higher MSFT target" }],
    };
    const hold = (title: string): ScriptedProposal => ({
      title,
      rationale: "No action needed this run; hold the current allocation and wait for new evidence.",
      confidence: 0.5,
      targets: [],
      orders: [],
    });
    for (const [id, inner] of firstAgentWins(winner, [hold("Steady"), hold("Wait")])) {
      counters.set(id, new CountingLlm(inner));
    }
    const app = buildApp({
      configPath: materialConfig(),
      env: {} as NodeJS.ProcessEnv,
      dbPath: ":memory:",
      logger: new NullLogger(),
      clock,
      committeeLlms: counters,
    });
    try {
      const hours = 7; // a full US session, hourly
      let calls = 0;
      let materialRuns = 0;
      for (let hour = 0; hour < hours; hour++) {
        if (hour > 0) clock.advance(3_600_000);
        const run = await app.orchestrator.runOnce();
        await app.flushEvents();
        const cadence = run.details.cadence as { material: boolean } | undefined;
        if (cadence?.material) materialRuns++;
        calls = [...counters.values()].reduce((sum, c) => sum + c.calls, 0);
      }
      // Analyst calls run on the shared (keyless, offline) path in this fixture,
      // so they are counted analytically: one call per universe ticker (WP-P1.2),
      // and zero on a stats-only hour (WP-P1.1).
      const analystCallsPerMaterialRun = 2; // the fixture universe (MSFT, AAPL)
      const callsPerMaterialRun = calls / Math.max(materialRuns, 1) + analystCallsPerMaterialRun;
      const perHourWithGate = (calls + materialRuns * analystCallsPerMaterialRun) / hours;
      const perHourWithoutGate = callsPerMaterialRun; // every hour ran the full path
      console.log(
        `[P1 exit] ${hours} market hours: ${materialRuns} material run(s), ${callsPerMaterialRun.toFixed(0)} calls per full run → ` +
          `${perHourWithGate.toFixed(1)} calls/hour with the materiality gate vs ` +
          `${perHourWithoutGate.toFixed(1)} calls/hour if every hour ran the full path ` +
          `(${(100 - (perHourWithGate / perHourWithoutGate) * 100).toFixed(0)}% fewer)`,
      );
      expect(materialRuns).toBe(1); // only the first hour (no previous session) fired
      expect(perHourWithGate).toBeLessThan(perHourWithoutGate);
    } finally {
      app.close();
    }
  });
});
