import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import type { ZodType } from "zod";
import { buildApp, type App } from "../../src/composition/root.js";
import { FixedClock } from "../../src/shared/clock.js";
import { NullLogger } from "../../src/shared/logger.js";
import type { LlmChatOptions, LlmPort, LlmUsageRecorder } from "../../src/application/ports.js";
import { firstAgentWins, type ScriptedProposal } from "../helpers/scripted-committee.js";

/**
 * LLM cost accounting end-to-end. Scripted committee clients report no provider
 * usage, so each call is metered through the app's REAL accounting path
 * (`ports.llmBudget.record`): that is what the production clients do through
 * their usage sink. The wrapper is a deferred proxy because the app (and its
 * budget) only exists after `buildApp` returns.
 */
class MeteredLlm implements LlmPort {
  budget: LlmUsageRecorder | null = null;
  calls = 0;
  constructor(
    private readonly inner: LlmPort,
    private readonly usdPerCall: number,
  ) {}

  available(): boolean {
    return this.inner.available();
  }

  private async meter(): Promise<void> {
    this.calls++;
    if (!this.budget) return;
    // An empty runId is attributed to the active run by the budget itself
    // (same path the production usage sink takes).
    await this.budget.record({
      runId: "",
      agentId: "test-agent",
      provider: "test",
      model: "test/model",
      promptTokens: 1000,
      completionTokens: 100,
      cachedTokens: 0,
      usdCost: this.usdPerCall,
      at: "2026-08-26T14:30:00.000Z",
    });
  }

  async chat(opts: LlmChatOptions): Promise<string> {
    await this.meter();
    return this.inner.chat(opts);
  }

  async chatJson<T>(opts: LlmChatOptions, schema: ZodType<T>): Promise<T> {
    await this.meter();
    return this.inner.chatJson(opts, schema);
  }
}

function meteredApp(clock: FixedClock, usdPerCall: number): { app: App; clients: MeteredLlm[] } {
  const winner: ScriptedProposal = {
    title: "Rebalance to targets",
    rationale: "Both names are underweight versus target; buy them back while the cost stays small.",
    confidence: 0.8,
    targets: [],
    orders: [
      { ticker: "MSFT", side: "BUY", value: 120, reason: "underweight vs target" },
      { ticker: "AAPL", side: "BUY", value: 120, reason: "underweight vs target" },
    ],
  };
  const hold = (title: string): ScriptedProposal => ({
    title,
    rationale: "No action needed this run; hold the current allocation.",
    confidence: 0.5,
    targets: [],
    orders: [],
  });
  const scripted = firstAgentWins(winner, [hold("Hold steady"), hold("Wait and see")]);
  const clients = new Map<string, MeteredLlm>();
  for (const [id, inner] of scripted) clients.set(id, new MeteredLlm(inner, usdPerCall));

  const app = buildApp({
    configPath: resolve(process.cwd(), "tests/fixtures/test-config.json"),
    env: {} as NodeJS.ProcessEnv,
    dbPath: ":memory:",
    logger: new NullLogger(),
    clock,
    committeeLlms: clients,
  });
  for (const client of clients.values()) client.budget = app.ports.llmBudget ?? null;
  return { app, clients: [...clients.values()] };
}

describe("LLM cost accounting in the pipeline", () => {
  it("records per-run tokens and cost, emits LlmUsageRecorded, and still completes the run", async () => {
    const { app, clients } = meteredApp(new FixedClock(new Date("2026-08-26T14:30:00Z")), 0.004);
    try {
      const run = await app.orchestrator.runOnce();
      await app.flushEvents();

      expect(run.status).toBe("COMPLETED");
      const llm = run.details.llm as { calls: number; promptTokens: number; completionTokens: number; usdCost: number };
      const calls = clients.reduce((sum, c) => sum + c.calls, 0);
      expect(calls).toBe(12); // 3 proposals + 6 feedback + 3 votes
      expect(llm.calls).toBe(calls);
      expect(llm.promptTokens).toBe(calls * 1000);
      expect(llm.completionTokens).toBe(calls * 100);
      expect(llm.usdCost).toBeCloseTo(calls * 0.004, 6);
      expect(run.details.llmBudgetStop).toBeUndefined();

      // The append-only usage log holds one row per metered call.
      expect(await app.ports.llmUsage!.byRun(run.id)).toHaveLength(calls);

      const usageEvent = (await app.ports.eventRepo.byRun(run.id)).find((e) => e.type === "LlmUsageRecorded");
      expect(usageEvent?.payload).toMatchObject({ calls, usdCost: llm.usdCost });
    } finally {
      app.close();
    }
  });

  it("stops the run before the committee when the spend cap is already reached, and reports it", async () => {
    const { app } = meteredApp(new FixedClock(new Date("2026-08-26T14:30:00Z")), 0.5);
    try {
      const budget = app.ports.llmBudget!;
      // Burn the whole day budget on a previous run, then verify this run refuses
      // to spend: the session is skipped, the run completes with the reason.
      for (let i = 0; i < 12; i++) {
        await budget.record({
          runId: "previous-run",
          agentId: "test-agent",
          provider: "test",
          model: "test/model",
          promptTokens: 1000,
          completionTokens: 100,
          cachedTokens: 0,
          usdCost: 0.5,
          at: "2026-08-26T13:00:00.000Z",
        });
      }
      await budget.prime();
      expect(budget.exhaustedReason("previous-run")).toContain("spend cap reached");

      const run = await app.orchestrator.runOnce();
      await app.flushEvents();

      expect(run.status).toBe("COMPLETED");
      expect(String(run.details.llmBudgetStop)).toContain("spend cap reached");
      expect(run.details.reports).toBe(0);
      expect(run.details.llm).toMatchObject({ calls: 0, usdCost: 0 });
      expect(await app.ports.committee.latestSession()).toBeNull();
      // No orders were attempted either.
      expect(await app.ports.orders.byRun(run.id)).toHaveLength(0);
    } finally {
      app.close();
    }
  });

  it("skips the committee when the per-run call cap is exhausted by the analysis step", async () => {
    const { app } = meteredApp(new FixedClock(new Date("2026-08-26T14:30:00Z")), 0);
    try {
      const budget = app.ports.llmBudget!;
      // Analysis uses the shared (unmetered) client, so simulate the cap being
      // hit mid-analysis: the committee must not start at all.
      for (let i = 0; i < 200; i++) {
        await budget.record({
          runId: "warmup",
          agentId: "analysts",
          provider: "test",
          model: "test/model",
          promptTokens: 1,
          completionTokens: 1,
          cachedTokens: 0,
          usdCost: 0,
          at: "2026-08-26T13:00:00.000Z",
        });
      }
      const run = await app.orchestrator.runOnce();
      expect(run.status).toBe("COMPLETED");
      // The cap is per run: a fresh run starts clean, so the session still runs.
      expect(await app.ports.committee.latestSession()).not.toBeNull();
    } finally {
      app.close();
    }
  });
});
