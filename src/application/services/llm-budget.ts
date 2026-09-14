import { LlmBudgetExceededError, type LlmUsage, type LlmUsageRecorder } from "../ports.js";
import type { Logger } from "../../shared/logger.js";

export interface LlmBudgetConfig {
  /** Hard cap on LLM calls in one pipeline run (0 = unlimited). */
  maxCallsPerRun: number;
  /** Hard cap on USD spend over the trailing window (0 = unlimited). */
  maxSpendPerDayUsd: number;
  /** Length of the spend window in hours (default 24). */
  spendWindowHours: number;
  /** Stop before a call when the current spend is within this fraction of the cap. */
  reserveFraction: number;
}

export const DEFAULT_LLM_BUDGET: LlmBudgetConfig = {
  maxCallsPerRun: 200,
  maxSpendPerDayUsd: 5,
  spendWindowHours: 24,
  reserveFraction: 0.02,
};

interface RunTotals {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  usdCost: number;
}

export interface LlmUsageStore {
  save(usage: LlmUsage): Promise<void>;
  /** Total USD spend strictly after `sinceIso`. */
  spendSince(sinceIso: string): Promise<number>;
}

/**
 * LLM cost accounting + budget guards. Owns the active run id so the (per-agent,
 * long-lived) LLM clients can report usage without knowing which run is
 * executing: every recorded call is attributed to the run that is active at the
 * time. Exhaustion is expressed as a thrown `LlmBudgetExceededError` from
 * `assertCanCall`, which the pipeline/analysis layers translate into a contained
 * skip — a budget stop never crashes a run.
 */
export class LlmBudget implements LlmUsageRecorder {
  private readonly perRun = new Map<string, RunTotals>();
  private activeRunId: string | null = null;
  private daySpendUsd: number | null = null;
  /** Guard so concurrent recorders cannot double-count the store total. */
  private pendingWrites: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: LlmUsageStore | null,
    private readonly cfg: LlmBudgetConfig,
    private readonly clock: { now(): Date },
    private readonly logger: Logger,
  ) {}

  /** Binds subsequent usage reports to a run (called by the pipeline). */
  setActiveRun(runId: string | null): void {
    this.activeRunId = runId;
  }

  get currentRunId(): string | null {
    return this.activeRunId;
  }

  /** Records one call. Without an active run the usage is still logged, not stored. */
  async record(usage: LlmUsage): Promise<void> {
    const runId = usage.runId || this.activeRunId || "unattributed";
    const totals = this.perRun.get(runId) ?? { calls: 0, promptTokens: 0, completionTokens: 0, usdCost: 0 };
    totals.calls += 1;
    totals.promptTokens += usage.promptTokens;
    totals.completionTokens += usage.completionTokens;
    totals.usdCost = Math.round((totals.usdCost + usage.usdCost) * 1_000_000) / 1_000_000;
    this.perRun.set(runId, totals);
    if (this.daySpendUsd !== null) this.daySpendUsd = Math.round((this.daySpendUsd + usage.usdCost) * 1_000_000) / 1_000_000;
    this.logger.debug(
      `llm usage ${usage.agentId} (${usage.provider}/${usage.model}): ${usage.promptTokens}+${usage.completionTokens} tok, $${usage.usdCost.toFixed(5)}`,
    );
    if (!this.store) return;
    const write = { ...usage, runId };
    this.pendingWrites = this.pendingWrites
      .then(() => this.store!.save(write))
      .catch((err) => this.logger.warn("failed to persist LLM usage", { error: String(err) }));
    await this.pendingWrites;
  }

  /**
   * Spend over the trailing window. The first call loads it from the store (so
   * a restarted service keeps counting the same day's budget); later calls add
   * the spend recorded in this process.
   */
  async spendUsd(): Promise<number> {
    if (this.daySpendUsd !== null) return this.daySpendUsd;
    if (!this.store) {
      this.daySpendUsd = 0;
      return 0;
    }
    const since = new Date(this.clock.now().getTime() - this.cfg.spendWindowHours * 3_600_000).toISOString();
    try {
      this.daySpendUsd = await this.store.spendSince(since);
    } catch (err) {
      this.logger.warn("cannot read LLM spend history — budget starts at 0 for this process", { error: String(err) });
      this.daySpendUsd = 0;
    }
    return this.daySpendUsd;
  }

  /**
   * Loads the trailing-window spend from the store if it has not been read yet.
   * Called by the pipeline before it starts spending: `exhaustedReason` is
   * synchronous (it runs inside prompt loops) and must not report a stale 0
   * after a restart.
   */
  async prime(): Promise<void> {
    await this.spendUsd();
  }

  callsInRun(runId: string): number {
    return this.perRun.get(runId)?.calls ?? 0;
  }

  summary(runId: string): RunTotals {
    const totals = this.perRun.get(runId);
    return totals ? { ...totals } : { calls: 0, promptTokens: 0, completionTokens: 0, usdCost: 0 };
  }

  exhaustedReason(runId: string): string | null {
    if (this.cfg.maxCallsPerRun > 0 && this.callsInRun(runId) >= this.cfg.maxCallsPerRun) {
      return `LLM call cap reached for this run (${this.cfg.maxCallsPerRun} calls)`;
    }
    if (this.cfg.maxSpendPerDayUsd > 0 && this.daySpendUsd !== null) {
      const ceiling = this.cfg.maxSpendPerDayUsd * (1 - this.cfg.reserveFraction);
      if (this.daySpendUsd >= ceiling) {
        return `LLM spend cap reached ($${this.daySpendUsd.toFixed(4)} of $${this.cfg.maxSpendPerDayUsd.toFixed(2)} over ${this.cfg.spendWindowHours}h)`;
      }
    }
    return null;
  }

  exhausted(runId: string): boolean {
    return this.exhaustedReason(runId) !== null;
  }

  /** Throws when no further call may be made — called by the pipeline and the session loop. */
  assertCanCall(runId: string): void {
    const reason = this.exhaustedReason(runId);
    if (reason) throw new LlmBudgetExceededError(reason);
  }
}

/** True when the error is the budget guard firing (as opposed to a provider failure). */
export function isLlmBudgetExceeded(err: unknown): err is LlmBudgetExceededError {
  return err instanceof LlmBudgetExceededError || (err instanceof Error && err.name === "LlmBudgetExceededError");
}
