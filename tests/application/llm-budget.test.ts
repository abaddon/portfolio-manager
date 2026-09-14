import { describe, expect, it } from "vitest";
import { DEFAULT_LLM_BUDGET, LlmBudget, isLlmBudgetExceeded, type LlmUsageStore } from "../../src/application/services/llm-budget.js";
import { LlmBudgetExceededError, type LlmUsage } from "../../src/application/ports.js";
import { NullLogger } from "../../src/shared/logger.js";
import { FixedClock } from "../../src/shared/clock.js";
import { openDatabase } from "../../src/adapters/persistence/sqlite.js";
import { SqliteLlmUsageRepository } from "../../src/adapters/persistence/repositories.js";

class FakeStore implements LlmUsageStore {
  readonly saved: LlmUsage[] = [];
  constructor(private readonly priorSpend = 0) {}
  async save(usage: LlmUsage): Promise<void> {
    this.saved.push(usage);
  }
  async spendSince(): Promise<number> {
    return this.priorSpend;
  }
}

const logger = new NullLogger();

function usage(runId: string, usdCost: number): LlmUsage {
  return {
    runId,
    agentId: "macro-strategist",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    promptTokens: 1000,
    completionTokens: 200,
    cachedTokens: 0,
    usdCost,
    at: "2026-09-14T10:00:00.000Z",
  };
}

describe("LlmBudget", () => {
  it("totals calls, tokens and cost per run and persists each usage row", async () => {
    const store = new FakeStore();
    const budget = new LlmBudget(store, DEFAULT_LLM_BUDGET, new FixedClock(new Date("2026-09-14T10:00:00Z")), logger);
    budget.setActiveRun("run-1");

    await budget.record(usage("run-1", 0.002));
    await budget.record(usage("run-1", 0.003));

    expect(budget.callsInRun("run-1")).toBe(2);
    expect(budget.summary("run-1")).toMatchObject({ calls: 2, promptTokens: 2000, completionTokens: 400 });
    expect(budget.summary("run-1").usdCost).toBeCloseTo(0.005, 9);
    expect(store.saved).toHaveLength(2);
    expect(budget.summary("other-run")).toMatchObject({ calls: 0, usdCost: 0 });
  });

  it("stops the run at the per-run call cap and reports why", async () => {
    const budget = new LlmBudget(
      new FakeStore(),
      { ...DEFAULT_LLM_BUDGET, maxCallsPerRun: 2, maxSpendPerDayUsd: 0 },
      new FixedClock(new Date("2026-09-14T10:00:00Z")),
      logger,
    );
    budget.setActiveRun("run-1");
    await budget.spendUsd();

    await budget.record(usage("run-1", 0));
    expect(budget.exhausted("run-1")).toBe(false);
    await budget.record(usage("run-1", 0));

    expect(budget.exhausted("run-1")).toBe(true);
    expect(budget.exhaustedReason("run-1")).toContain("call cap reached");
    expect(() => budget.assertCanCall("run-1")).toThrow(LlmBudgetExceededError);
    // The cap is per run: another run starts with a fresh allowance.
    expect(budget.exhausted("run-2")).toBe(false);
  });

  it("stops on the day spend cap, loading prior spend from the store once", async () => {
    const budget = new LlmBudget(
      new FakeStore(1.99),
      { ...DEFAULT_LLM_BUDGET, maxCallsPerRun: 0, maxSpendPerDayUsd: 2 },
      new FixedClock(new Date("2026-09-14T10:00:00Z")),
      logger,
    );
    budget.setActiveRun("run-1");

    // 1.99 of a 2.00 cap is already inside the 2% reserve → refuse before spending.
    expect(await budget.spendUsd()).toBeCloseTo(1.99, 9);
    expect(budget.exhaustedReason("run-1")).toContain("spend cap reached");
    expect(() => budget.assertCanCall("run-1")).toThrow(LlmBudgetExceededError);
  });

  it("counts new spend against the cap as calls are recorded", async () => {
    const budget = new LlmBudget(
      new FakeStore(0.5),
      { ...DEFAULT_LLM_BUDGET, maxCallsPerRun: 0, maxSpendPerDayUsd: 1 },
      new FixedClock(new Date("2026-09-14T10:00:00Z")),
      logger,
    );
    budget.setActiveRun("run-1");
    await budget.spendUsd();
    expect(budget.exhausted("run-1")).toBe(false);

    await budget.record(usage("run-1", 0.49));
    expect(await budget.spendUsd()).toBeCloseTo(0.99, 9);
    expect(budget.exhausted("run-1")).toBe(true);
  });

  it("attributes a usage report without a run id to the active run", async () => {
    const store = new FakeStore();
    const budget = new LlmBudget(store, DEFAULT_LLM_BUDGET, new FixedClock(new Date("2026-09-14T10:00:00Z")), logger);
    budget.setActiveRun("run-7");
    await budget.record({ ...usage("", 0.001) });
    expect(budget.callsInRun("run-7")).toBe(1);
    expect(store.saved[0]!.runId).toBe("run-7");
  });

  it("recognises its own error type (used by the analysis/committee containment)", () => {
    expect(isLlmBudgetExceeded(new LlmBudgetExceededError("stop"))).toBe(true);
    expect(isLlmBudgetExceeded(new Error("other"))).toBe(false);
  });
});

describe("SqliteLlmUsageRepository", () => {
  it("persists usage rows and sums spend since a timestamp", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLlmUsageRepository(db);
    await repo.save({ ...usage("run-1", 0.25), at: "2026-09-14T10:00:00.000Z" });
    await repo.save({ ...usage("run-1", 0.5), at: "2026-09-14T11:00:00.000Z", agentId: "momentum-trader" });
    await repo.save({ ...usage("run-2", 0.75), at: "2026-09-15T10:00:00.000Z" });

    expect(await repo.spendSince("2026-09-14T09:00:00.000Z")).toBeCloseTo(1.5, 9);
    expect(await repo.spendSince("2026-09-14T10:30:00.000Z")).toBeCloseTo(1.25, 9);
    const rows = await repo.byRun("run-1");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ agentId: "macro-strategist", promptTokens: 1000, completionTokens: 200 });
    db.close();
  });
});
