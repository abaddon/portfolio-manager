import { newId } from "../../shared/id.js";
import { toIso } from "../../shared/clock.js";
import { Run, RunInProgressError } from "../../domain/run.js";
import type { Decision } from "../../domain/decision.js";
import type { AppPorts } from "../ports.js";
import { MarketAnalysisService } from "./market-analysis.js";
import { PortfolioEvaluationService } from "./portfolio-evaluation.js";
import { DecisionService } from "./decisions.js";
import { ExecutionService } from "./execution.js";
import { AllocationReviewService } from "./allocation-review.js";
import { AllocationBootstrapService } from "./target-bootstrap.js";
import { CommitteeService } from "./committee.js";
import type { Analyst } from "../ports.js";

export interface PipelineDependencies {
  analysts: Analyst[];
  analysis: MarketAnalysisService;
  allocationBootstrap: AllocationBootstrapService;
  allocationReview: AllocationReviewService;
  portfolio: PortfolioEvaluationService;
  decisions: DecisionService;
  execution: ExecutionService;
  committee: CommitteeService;
}

/**
 * Hourly pipeline: market analysis → portfolio/asset-allocation evaluation →
 * cost-aware decisions → trade execution, with every step and fact persisted.
 * One run per market hour (idempotency guard), SKIPPED runs recorded when the
 * market is closed so the dashboard can explain why nothing happened.
 */
export class PipelineOrchestrator {
  /** Id of the run currently executing (null when idle). Guards all triggers. */
  private inFlightRunId: string | null = null;

  constructor(
    private readonly ports: AppPorts,
    private readonly deps: PipelineDependencies,
    private readonly universe: { tickers: string[]; benchmark: string },
  ) {}

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

    try {
      // 0. Allocation bootstrap: with an existing portfolio and no configured
      // targets, the current holdings become the allocation (event emitted by
      // the bootstrap service itself).
      await this.deps.allocationBootstrap.bootstrapIfNeeded(run.id);

      // 1. Market analysis (4 analysts × universe, failures contained per source).
      const reports = await this.deps.analysis.analyze(run.id, this.universe.tickers, this.universe.benchmark);
      this.emit(run.id, "AnalysisCompleted", { reports: reports.length }, toIso(this.ports.clock.now()));

      // 1b. Decision flow: the Asset Allocation Committee is the ALTERNATIVE
      // flow. When enabled it replaces the allocation review and the
      // analyst-signal decisions; when disabled the classic flow runs
      // unchanged.
      const committeeEnabled = await this.deps.committee.isEnabled();
      if (committeeEnabled) {
        this.ports.logger.info("asset allocation committee enabled — allocation review and analyst decisions bypassed this run");
      } else {
        const review = await this.deps.allocationReview.review(run.id, reports);
        if (review.updates.length > 0) {
          this.emit(
            run.id,
            "TargetsReviewed",
            { changes: review.updates.map((u) => ({ ticker: u.ticker, from: u.originalWeight, to: u.weight, conviction: u.conviction })) },
            toIso(this.ports.clock.now()),
          );
        }
      }

      // 2. Portfolio & asset-allocation evaluation.
      const evaluation = await this.deps.portfolio.evaluate(run.id);
      this.emit(
        run.id,
        "PortfolioEvaluated",
        {
          totalValue: evaluation.snapshot.totalValue,
          cash: evaluation.snapshot.cash,
          heat: evaluation.heat,
          drift: evaluation.drift.map((d) => ({ ticker: d.ticker, drift: d.drift, hint: d.hint })),
        },
        toIso(this.ports.clock.now()),
      );

      // 3. Decisions with full cost evaluation — committee or classic path.
      let decisions: Decision[];
      if (committeeEnabled) {
        // The committee replaces the decisions step: the winning proposal's
        // orders are priced and passed through the SAME economic gate, and
        // the winning allocation is persisted by the committee service.
        const targets = await this.deps.allocationReview.currentTargets();
        const outcome = await this.deps.committee.runSession(run.id, {
          snapshot: evaluation.snapshot,
          drift: evaluation.drift,
          heat: evaluation.heat,
          reports,
          targets,
        });
        decisions = outcome.decisions;
      } else {
        decisions = await this.deps.decisions.decide({
          runId: run.id,
          snapshot: evaluation.snapshot,
          drift: evaluation.drift,
          reports,
          heat: evaluation.heat,
        });
      }
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

      run.complete(toIso(this.ports.clock.now()), {
        reports: reports.length,
        decisions: decisions.length,
        approvedDecisions: approved,
        orders: exec.orders.length,
        filledOrders: exec.filled.length,
        totalValue: evaluation.snapshot.totalValue,
        decisionProcess: committeeEnabled ? "committee" : "classic",
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
      this.inFlightRunId = null;
    }
  }

  private emit(runId: string, type: string, payload: Record<string, unknown>, occurredAt: string): void {
    this.ports.events.publish({ id: newId("evt"), runId, type, payload, occurredAt });
  }
}
