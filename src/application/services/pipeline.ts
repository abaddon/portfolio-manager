import { newId } from "../../shared/id.js";
import { toIso } from "../../shared/clock.js";
import { Run } from "../../domain/run.js";
import type { AppPorts } from "../ports.js";
import { MarketAnalysisService } from "./market-analysis.js";
import { PortfolioEvaluationService } from "./portfolio-evaluation.js";
import { DecisionService } from "./decisions.js";
import { ExecutionService } from "./execution.js";
import type { Analyst } from "../ports.js";

export interface PipelineDependencies {
  analysts: Analyst[];
  analysis: MarketAnalysisService;
  portfolio: PortfolioEvaluationService;
  decisions: DecisionService;
  execution: ExecutionService;
}

/**
 * Hourly pipeline: market analysis → portfolio/asset-allocation evaluation →
 * cost-aware decisions → trade execution, with every step and fact persisted.
 * One run per market hour (idempotency guard), SKIPPED runs recorded when the
 * market is closed so the dashboard can explain why nothing happened.
 */
export class PipelineOrchestrator {
  constructor(
    private readonly ports: AppPorts,
    private readonly deps: PipelineDependencies,
    private readonly universe: { tickers: string[]; benchmark: string },
  ) {}

  async runOnce(opts: { force?: boolean } = {}): Promise<Run> {
    const now = this.ports.clock.now();
    const startedAt = toIso(now);
    const marketOpen = this.ports.calendar.isOpen(now);

    const existing = await this.ports.runs.findSameHour(now);
    if (existing && existing.status !== "FAILED") {
      this.ports.logger.info(`run ${existing.id} already exists for this market hour — skipping duplicate`);
      return existing;
    }

    if (!marketOpen && !opts.force) {
      const run = Run.start(newId("run"), startedAt, false);
      run.skip(startedAt, "market closed at scheduled time");
      await this.ports.runs.save(run);
      this.emit(run.id, "PipelineSkipped", { reason: "market closed" }, startedAt);
      return run;
    }

    const run = Run.start(newId("run"), startedAt, marketOpen);
    await this.ports.runs.save(run);
    this.emit(run.id, "PipelineStarted", { marketOpen }, startedAt);

    try {
      // 1. Market analysis (4 analysts × universe, failures contained per source).
      const reports = await this.deps.analysis.analyze(run.id, this.universe.tickers, this.universe.benchmark);
      this.emit(run.id, "AnalysisCompleted", { reports: reports.length }, toIso(this.ports.clock.now()));

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

      // 3. Decisions with full cost evaluation.
      const decisions = await this.deps.decisions.decide({
        runId: run.id,
        snapshot: evaluation.snapshot,
        drift: evaluation.drift,
        reports,
        heat: evaluation.heat,
      });
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
  }

  private emit(runId: string, type: string, payload: Record<string, unknown>, occurredAt: string): void {
    this.ports.events.publish({ id: newId("evt"), runId, type, payload, occurredAt });
  }
}
