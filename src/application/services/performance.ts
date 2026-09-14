import { toIso } from "../../shared/clock.js";
import { roundValue } from "../../shared/money.js";
import {
  attributeDecision,
  buildPerformanceContext,
  buildScorecards,
  forwardReturn,
  type AgentOutcomeInput,
  type PerformanceContext,
} from "../../domain/performance.js";
import type { AppPorts } from "../ports.js";

export interface PerformanceConfig {
  /** Hours of forward return used to score a decision (default 24 h ≈ 4 sessions). */
  scoringHorizonHours: number;
  /** Completed runs whose outcomes go into the scorecards (default the last 20). */
  scorecardWindow: number;
}

/**
 * Outcome feedback (WP-P2.4): the loop that tells the system whether its
 * decisions made money.
 *
 *  - **score()** runs at the start of each run and attributes the decisions of
 *    previous runs that have no outcome yet, using the price series the market
 *    data adapter already serves (no new provider);
 *  - **context()** builds the compact performance block for the committee
 *    (NAV trend, alpha vs the benchmark, worst drawdown, window contribution,
 *    per-agent scorecards).
 *
 * Everything is contained: a missing price series leaves that decision unscored
 * for the next run, and a failure never fails the pipeline.
 */
export class PerformanceService {
  private readonly horizonHours: number;
  private readonly window: number;

  constructor(
    private readonly ports: AppPorts,
    cfg: PerformanceConfig = { scoringHorizonHours: 24, scorecardWindow: 20 },
  ) {
    this.horizonHours = cfg.scoringHorizonHours;
    this.window = cfg.scorecardWindow;
  }

  /** Attributes every approved decision that has no outcome yet. */
  async score(runId: string): Promise<{ scored: number; skipped: number }> {
    const repo = this.ports.outcomes;
    if (!repo) return { scored: 0, skipped: 0 };
    let pending: Awaited<ReturnType<typeof repo.unscored>>;
    try {
      pending = await repo.unscored(200);
    } catch (err) {
      this.ports.logger.warn("cannot read unscored decisions", { error: String(err) });
      return { scored: 0, skipped: 0 };
    }
    if (pending.length === 0) return { scored: 0, skipped: 0 };

    const scoredAt = toIso(this.ports.clock.now());
    const records = [];
    let skipped = 0;
    for (const decision of pending) {
      let returnPct: number | null = null;
      try {
        const candles = await this.ports.prices.candles(decision.ticker, { interval: "60", count: 48 });
        returnPct = forwardReturn(candles.map((c) => c.close), this.horizonHours);
      } catch (err) {
        this.ports.logger.debug(`cannot score ${decision.ticker}: ${String(err)}`);
      }
      if (returnPct === null) {
        // Not measurable yet (or no series): leave it for a later run.
        skipped++;
        continue;
      }
      const outcome = attributeDecision({
        decisionId: decision.id,
        ticker: decision.ticker,
        action: decision.action,
        approved: decision.approved,
        orderValue: decision.orderValue,
        forwardReturnPct: returnPct,
      });
      records.push({
        decisionId: outcome.decisionId,
        runId: decision.runId,
        ticker: outcome.ticker,
        action: outcome.action,
        approved: outcome.approved,
        orderValue: outcome.orderValue,
        forwardReturnPct: outcome.forwardReturnPct,
        contribution: outcome.contribution,
        scoredAt,
      });
    }
    if (records.length > 0) {
      try {
        await repo.save(records);
        this.emit(runId, "DecisionOutcomesScored", {
          scored: records.length,
          skipped,
          netContribution: roundValue(records.reduce((sum, r) => sum + r.contribution, 0)),
        });
      } catch (err) {
        this.ports.logger.warn("cannot persist decision outcomes", { error: String(err) });
      }
    }
    return { scored: records.length, skipped };
  }

  /** The performance block handed to the committee (null when nothing to say). */
  async context(): Promise<PerformanceContext | null> {
    const repo = this.ports.outcomes;
    try {
      const runs = await this.ports.runs.latest(this.window);
      const completed = runs.filter((r) => r.status === "COMPLETED");
      const outcomes = repo ? await repo.byRuns(completed.map((r) => r.id)) : [];
      const scorecards = buildScorecards(await this.buildScorecards(outcomes));
      // NAV comes from the unitized ledger's history and the benchmark from the
      // stored per-run day changes (rebuilt into an index), so no extra fetch.
      const snapshots = [...(await this.ports.portfolio.history(this.window))].sort((a, b) =>
        a.asOf.localeCompare(b.asOf),
      );
      const navPoints = snapshots
        .filter((s) => typeof s.navPerUnit === "number" && s.navPerUnit > 0)
        .map((s) => ({ asOf: s.asOf, navPerUnit: s.navPerUnit! }));
      // Starts at an index level of 100 and compounds each stored day change.
      const benchmarkSeries: number[] = [100];
      for (const snapshot of snapshots) {
        if (snapshot.benchmarkChangePct === null) continue;
        benchmarkSeries.push(benchmarkSeries.at(-1)! * (1 + snapshot.benchmarkChangePct / 100));
      }
      if (navPoints.length === 0 && scorecards.length === 0) return null;
      return buildPerformanceContext({
        navSeries: navPoints,
        benchmarkSeries,
        scorecards,
        windowContribution: outcomes.reduce((sum, o) => sum + o.contribution, 0),
      });
    } catch (err) {
      this.ports.logger.warn("cannot build the performance context", { error: String(err) });
      return null;
    }
  }

  /**
   * Per-agent attribution: the decisions taken from each agent's winning
   * proposals, plus how often the agent's proposals won at all.
   */
  private async buildScorecards(
    outcomes: Awaited<ReturnType<NonNullable<AppPorts["outcomes"]>["recent"]>>,
  ): Promise<AgentOutcomeInput[]> {
    const byDecision = new Map(outcomes.map((o) => [o.decisionId, o]));
    const runs = await this.ports.runs.latest(this.window);
    const completed = runs.filter((r) => r.status === "COMPLETED");
    const tally = new Map<string, AgentOutcomeInput>();

    for (const run of completed) {
      let session;
      try {
        const sessions = await this.ports.committee.byRun(run.id);
        session = sessions.at(-1);
      } catch {
        session = undefined;
      }
      if (!session) continue;
      let detail;
      try {
        detail = await this.ports.committee.detail(session.id);
      } catch {
        continue;
      }
      for (const proposal of detail.proposals) {
        const entry = tally.get(proposal.agentId) ?? {
          agentId: proposal.agentId,
          agentName: proposal.agentName,
          proposals: 0,
          accepted: 0,
          contribution: 0,
          portfolioContribution: 0,
        };
        entry.proposals += 1;
        if (proposal.status === "accepted") entry.accepted += 1;
        tally.set(proposal.agentId, entry);
      }
      // Attribution of this run's decisions goes to whoever proposed them.
      const decisions = await this.ports.decisions.byRun(run.id);
      for (const decision of decisions) {
        const agentId = typeof decision.details.agentId === "string" ? decision.details.agentId : null;
        if (!agentId) continue;
        const outcome = byDecision.get(decision.id);
        if (!outcome) continue;
        const entry = tally.get(agentId);
        if (!entry) continue;
        entry.contribution += outcome.contribution;
        if (proposalAcceptedFor(agentId, detail.proposals)) entry.portfolioContribution += outcome.contribution;
      }
    }
    return [...tally.values()];
  }

  private emit(runId: string, type: string, payload: Record<string, unknown>): void {
    this.ports.events.publish({ id: `evt_${type}_${runId}`, runId, type, payload, occurredAt: toIso(this.ports.clock.now()) });
  }
}

function proposalAcceptedFor(agentId: string, proposals: { agentId: string; status: string }[]): boolean {
  return proposals.some((p) => p.agentId === agentId && p.status === "accepted");
}
