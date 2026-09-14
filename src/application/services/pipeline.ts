import { newId } from "../../shared/id.js";
import { toIso } from "../../shared/clock.js";
import { Run, RunInProgressError } from "../../domain/run.js";
import { evaluateCadence } from "../../domain/cadence.js";
import type { Decision } from "../../domain/decision.js";
import type { AppPorts } from "../ports.js";
import { MarketAnalysisService } from "./market-analysis.js";
import { PortfolioEvaluationService } from "./portfolio-evaluation.js";
import { ExecutionService } from "./execution.js";
import { AllocationTargetsService } from "./allocation-targets.js";
import { AllocationBootstrapService } from "./target-bootstrap.js";
import { CommitteeService } from "./committee.js";
import type { InstrumentMetricsService } from "./instrument-metrics.js";

export interface PipelineDependencies {
  analysis: MarketAnalysisService;
  allocationBootstrap: AllocationBootstrapService;
  targets: AllocationTargetsService;
  portfolio: PortfolioEvaluationService;
  execution: ExecutionService;
  committee: CommitteeService;
  /** Per-instrument risk metrics (WP-P2.1); optional so tests can omit it. */
  metrics?: InstrumentMetricsService;
}

/** Cadence configuration (WP-P1.1): when the expensive path may run. */
export interface CadenceSettings {
  triggerMode: "always" | "material";
  navMovePct: number;
  driftPct: number;
  planningIntervalHours: number;
  newsLookbackHours: number;
  driftCooldownHours: number;
}

/**
 * Hourly pipeline: market analysis → portfolio/asset-allocation evaluation →
 * Asset Allocation Committee session (the ONE decision flow, ADR 0009) →
 * cost-gated execution, with every step and fact persisted. One run per
 * market hour (idempotency guard), SKIPPED runs recorded when the market is
 * closed so the dashboard can explain why nothing happened.
 */
export class PipelineOrchestrator {
  /** Id of the run currently executing (null when idle). Guards all triggers. */
  private inFlightRunId: string | null = null;

  constructor(
    private readonly ports: AppPorts,
    private readonly deps: PipelineDependencies,
    private readonly universe: { tickers: string[]; benchmark: string },
    private readonly cadence: CadenceSettings,
  ) {}

  /** News items gathered by the previous analysis run (for the new-news trigger). */
  private async headlinesSincePreviousRun(): Promise<string[]> {
    const previous = await this.ports.runs.latest(2);
    const lastRun = previous.find((r) => r.id !== this.inFlightRunId && r.status === "COMPLETED");
    if (!lastRun) return [];
    const reports = await this.ports.analysis.byRun(lastRun.id);
    if (reports.length === 0) return [];
    const since = new Date(this.ports.clock.now().getTime() - this.cadence.newsLookbackHours * 3_600_000).toISOString();
    const news = await this.ports.marketData.latestNews(200);
    return news
      .filter((n) => n.runId !== lastRun.id && (n.item.publishedAt ?? "") >= since)
      .map((n) => n.item.headline);
  }

  /** Hours since the last COMPLETED run (null when there is none on record). */
  private async hoursSinceLastCompletedRun(): Promise<number | null> {
    const runs = await this.ports.runs.latest(10);
    const last = runs.find((r) => r.status === "COMPLETED");
    if (!last) return null;
    const finished = last.finishedAt ?? last.startedAt;
    return (this.ports.clock.now().getTime() - new Date(finished).getTime()) / 3_600_000;
  }

  /** Hours since the last run that actually bought an opinion (null when none). */
  private async hoursSinceLastMaterialRun(): Promise<number | null> {
    const runs = await this.ports.runs.latest(20);
    const last = runs.find((r) => {
      if (r.status !== "COMPLETED") return false;
      const cadence = r.details.cadence as { material?: boolean } | undefined;
      // Runs that predate the cadence field were material by definition.
      return cadence?.material !== false;
    });
    if (!last) return null;
    const finished = last.finishedAt ?? last.startedAt;
    return (this.ports.clock.now().getTime() - new Date(finished).getTime()) / 3_600_000;
  }

  async runOnce(opts: { force?: boolean; skipHourGuard?: boolean } = {}): Promise<Run> {
    const now = this.ports.clock.now();
    const startedAt = toIso(now);
    const marketOpen = this.ports.calendar.isOpen(now);

    // Single-flight: at most one pipeline executes at a time, whichever
    // trigger started it (scheduler, startup or manual "Run now"). Manual
    // requests fail fast so the dashboard can tell the user (409); scheduled
    // triggers record a SKIPPED run instead of queueing.
    if (this.inFlightRunId !== null) {
      if (opts.skipHourGuard) throw new RunInProgressError(this.inFlightRunId);
      const run = Run.start(newId("run"), startedAt, marketOpen);
      run.skip(startedAt, `a run is already in progress (${this.inFlightRunId})`);
      await this.ports.runs.save(run);
      this.emit(run.id, "PipelineSkipped", { reason: "run in progress", existingRunId: this.inFlightRunId }, startedAt);
      this.ports.logger.info(`scheduled run skipped: ${this.inFlightRunId} still in progress`);
      return run;
    }
    this.inFlightRunId = "pending";
    try {

    // Crash recovery: reconcile orders left PENDING by an interrupted run
    // against the broker (never blind re-submission), then confirm late fills.
    // Runs BEFORE the duplicate-hour guard so even skipped runs close out fills.
    const staleBefore = toIso(new Date(now.getTime() - 15 * 60_000));
    if (this.ports.broker.kind === "trading212") {
      const reconciled = await this.deps.execution.reconcileStalePending(staleBefore);
      if (reconciled.adopted > 0 || reconciled.failed > 0) {
        this.ports.logger.info(
          `reconciled stale PENDING orders: adopted ${reconciled.adopted}, failed ${reconciled.failed}`,
        );
      }
      await this.deps.execution.sweepOpenOrders();
      await this.deps.execution.retryPrecisionFailures();
    }

    // One run per market hour (idempotency): protects against duplicate
    // analyses and duplicate orders. Manual requests opt out explicitly.
    if (!opts.skipHourGuard) {
      const existing = await this.ports.runs.findSameHour(now);
      if (existing && existing.status !== "FAILED") {
        this.ports.logger.info(`run ${existing.id} already exists for this market hour — skipping duplicate`);
        return existing;
      }
    } else {
      this.ports.logger.info("per-hour idempotency guard skipped (manual run)");
    }

    if (!marketOpen && !opts.force) {
      const run = Run.start(newId("run"), startedAt, false);
      run.skip(startedAt, "market closed at scheduled time");
      await this.ports.runs.save(run);
      this.emit(run.id, "PipelineSkipped", { reason: "market closed" }, startedAt);
      return run;
    }

    const run = Run.start(newId("run"), startedAt, marketOpen);
    this.inFlightRunId = run.id;
    await this.ports.runs.save(run);
    this.emit(run.id, "PipelineStarted", { marketOpen }, startedAt);

    // LLM budget stops are run-scoped and reported in the run summary.
    let stopReason: string | null = null;
    let committeeStop: string | null = null;

    try {
      // 0. Allocation bootstrap: with an existing portfolio and no configured
      // targets, the current holdings become the allocation (event emitted by
      // the bootstrap service itself).
      await this.deps.allocationBootstrap.bootstrapIfNeeded(run.id);

      // 1. Portfolio & asset-allocation evaluation FIRST: it costs nothing (one
      // broker read + quotes) and it is what the materiality test needs. The
      // expensive path is decided afterwards (WP-P1.1).
      const evaluation = await this.deps.portfolio.evaluate(run.id);
      this.emit(
        run.id,
        "PortfolioEvaluated",
        {
          totalValue: evaluation.snapshot.totalValue,
          cash: evaluation.snapshot.cash,
          cashPolicy: evaluation.cash.policy,
          cashDrag: evaluation.cash.drag,
          heat: evaluation.heat,
          drift: evaluation.drift.map((d) => ({ ticker: d.ticker, drift: d.drift, hint: d.hint })),
        },
        toIso(this.ports.clock.now()),
      );

      // 2. Materiality: should this run buy an opinion? Stats-only passes still
      // snapshot, evaluate and sweep — they just do not spend on inference.
      const targets = await this.deps.targets.currentTargets();
      const previous = await this.ports.portfolio.history(2);
      const previousValue = previous.find((s) => s.runId !== run.id)?.totalValue ?? null;
      const navMovePct =
        previousValue && previousValue > 0
          ? (evaluation.snapshot.totalValue - previousValue) / previousValue
          : null;
      const cadence = evaluateCadence(
        {
          drift: evaluation.drift,
          navMovePct,
          hoursSinceLastRun: await this.hoursSinceLastCompletedRun(),
          hoursSinceLastMaterialRun: await this.hoursSinceLastMaterialRun(),
          hasUnfundedTargets: targets.some((t) => t.status === "UNFUNDED"),
          newHeadlines: await this.headlinesSincePreviousRun(),
        },
        this.cadence,
        { force: opts.force === true || opts.skipHourGuard === true },
      );

      // LLM cost accounting is scoped to this run: every client reports usage
      // while it is active. A budget that is already exhausted stops the
      // expensive path here (the run still completes as a stats-only pass).
      const budget = this.ports.llmBudget;
      budget?.setActiveRun(run.id);
      // Prime the trailing-window spend before the first call, so a restarted
      // service cannot spend yesterday's budget again.
      await budget?.prime();
      stopReason = budget?.exhaustedReason(run.id) ?? null;
      if (stopReason) {
        this.ports.logger.warn(`LLM budget unavailable, skipping analysis and committee: ${stopReason}`);
      }
      const skipSpend = stopReason !== null || !cadence.material;
      if (!cadence.material && !stopReason) {
        this.ports.logger.info(`stats-only run: ${cadence.reason}`);
      }

      // 3. Market analysis (4 analysts × universe, failures contained per source).
      const reports = skipSpend
        ? []
        : await this.deps.analysis.analyze(run.id, this.universe.tickers, this.universe.benchmark);
      // Risk metrics come from the same candles the analysis used (+1 benchmark
      // series): they are read on the expensive path only, where the committee
      // can act on them.
      const risk = skipSpend || !this.deps.metrics ? null : await this.deps.metrics.collect(evaluation.snapshot);
      this.emit(
        run.id,
        "AnalysisCompleted",
        {
          reports: reports.length,
          trigger: cadence.triggers,
          reason: cadence.reason,
          skipped: stopReason ?? (cadence.material ? undefined : "nothing material"),
        },
        toIso(this.ports.clock.now()),
      );

      // 4. The Asset Allocation Committee is the ONE decision flow (ADR 0009):
      // the agents propose, review and vote; the winning proposal's targets
      // are persisted (guardrailed) and its orders are priced and passed
      // through the SAME economic gate every order has always met. A failed
      // session is contained: no target changes and no orders this run.
      committeeStop = budget?.exhaustedReason(run.id) ?? null;
      if (committeeStop && !stopReason) {
        this.ports.logger.warn(`LLM budget exhausted during analysis, skipping the committee session: ${committeeStop}`);
      }
      const runCommittee = !skipSpend && committeeStop === null;
      const outcome = runCommittee
        ? await this.deps.committee.runSession(run.id, {
            snapshot: evaluation.snapshot,
            drift: evaluation.drift,
            heat: evaluation.heat,
            cash: evaluation.cash,
            ...(risk ? { risk } : {}),
            reports,
            targets,
            ...(budget ? { llmSpendUsd: await budget.spendUsd() } : {}),
          })
        : null;
      const decisions: Decision[] = outcome ? outcome.decisions : [];
      const approved = decisions.filter((d) => d.approved && d.action !== "HOLD").length;
      this.emit(
        run.id,
        "DecisionsTaken",
        {
          total: decisions.length,
          approved,
          rejected: decisions.filter((d) => !d.approved).map((d) => ({
            ticker: d.ticker,
            reason: d.reason,
          })),
        },
        toIso(this.ports.clock.now()),
      );

      // 4. Execute approved trades.
      const exec = await this.deps.execution.execute(run.id, decisions);
      this.emit(
        run.id,
        "ExecutionCompleted",
        { orders: exec.orders.length, filled: exec.filled.length, rejected: exec.rejected.length, failed: exec.failed.length },
        toIso(this.ports.clock.now()),
      );

      if (risk) {
        this.emit(
          run.id,
          "RiskMetricsCollected",
          { names: risk.metrics.length, benchmarkBars: risk.benchmarkBars, portfolio: risk.concentration },
          toIso(this.ports.clock.now()),
        );
      }

      const llm = budget ? budget.summary(run.id) : null;
      // An analysis cut short by the budget is reported: a short analysis must
      // never look like a complete one.
      const analysisStop = this.deps.analysis.lastStopReason;
      if (llm && llm.calls > 0) {
        this.emit(
          run.id,
          "LlmUsageRecorded",
          { ...llm, daySpendUsd: await budget!.spendUsd() },
          toIso(this.ports.clock.now()),
        );
      }

      run.complete(toIso(this.ports.clock.now()), {
        reports: reports.length,
        decisions: decisions.length,
        approvedDecisions: approved,
        orders: exec.orders.length,
        filledOrders: exec.filled.length,
        totalValue: evaluation.snapshot.totalValue,
        decisionProcess: "committee",
        cadence: { material: cadence.material, triggers: cadence.triggers, reason: cadence.reason, mode: this.cadence.triggerMode },
        ...(llm ? { llm } : {}),
        ...(stopReason ?? committeeStop ?? analysisStop
          ? { llmBudgetStop: stopReason ?? committeeStop ?? analysisStop }
          : {}),
      });
      await this.ports.runs.save(run);
      this.emit(run.id, "PipelineCompleted", run.details, toIso(this.ports.clock.now()));
      return run;
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.ports.logger.error(`pipeline run ${run.id} failed`, { error: message });
      run.fail(toIso(this.ports.clock.now()), message);
      await this.ports.runs.save(run);
      this.emit(run.id, "PipelineFailed", { error: message }, toIso(this.ports.clock.now()));
      return run;
    }
    } finally {
      // Usage after this point belongs to no run (never misattribute it).
      this.ports.llmBudget?.setActiveRun(null);
      this.inFlightRunId = null;
    }
  }

  private emit(runId: string, type: string, payload: Record<string, unknown>, occurredAt: string): void {
    this.ports.events.publish({ id: newId("evt"), runId, type, payload, occurredAt });
  }
}
