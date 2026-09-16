import { z } from "zod";
import { newId } from "../../shared/id.js";
import { toIso } from "../../shared/clock.js";
import { clamp, roundTo, roundValue, WEIGHT_DP } from "../../shared/money.js";
import type { AnalysisReport } from "../../domain/analysis.js";
import type { Decision } from "../../domain/decision.js";
import type { InstrumentMetricsResult } from "./instrument-metrics.js";
import type { PerformanceContext } from "../../domain/performance.js";
import type {
  AllocationDrift,
  AllocationTarget,
  AllocationTargetUpdate,
  CashDrag,
  CashPolicy,
  PortfolioSnapshot,
} from "../../domain/portfolio.js";
import {
  applyDiversificationGuardrails,
  applyTargetTrustRegion,
  type AppliedTarget,
  castVote,
  coerceChoice,
  positiveFeedbackCounts,
  resolveVoteRound,
  type CommitteeAgentDef,
  type CommitteeAgentRole,
  type CommitteeFeedback,
  type CommitteeOrderIntent,
  type CommitteeProposal,
  type CommitteeSession,
  type CommitteeSessionDetail,
  type CommitteeVote,
} from "../../domain/committee.js";
import { computeSignalStrength, type DecisionEngine } from "../../domain/decision.js";
import { ANALYST_KINDS, type AnalystKind } from "../../domain/analysis.js";
import type { AppPorts, LlmPort } from "../ports.js";
import { isLlmBudgetExceeded } from "./llm-budget.js";
import { DecisionService } from "./decisions.js";

export interface CommitteeConfig {
  /** Cap on vote rounds; a surviving tie is settled deterministically. */
  maxVoteRounds: number;
  agents: CommitteeAgentDef[];
  /** Guardrail: no single name above this target weight. */
  maxTarget: number;
  /** Guardrail: total invested targets stay under 1 − minCashBuffer. */
  minCashBuffer: number;
  /** Weight of the winner's own confidence in the assumed edge (ADR 0012). */
  proposalConfidenceWeight: number;
  /** Diversification guardrails (WP-P2.2). */
  minPositions: number;
  sectorCaps: { defaultCap: number | null; bySector: Record<string, number> };
  /** Trust region: fraction of a proposed weight change a session may apply. */
  trustRegion: number;
  /** How much the winner's confidence damps that move (0 = not at all). */
  trustRegionConfidenceWeight: number;
  /** Turnover budget: notional a session may move, as a fraction of NAV. */
  maxTurnoverPctPerSession: number;
  /** Dead zone: |Δweight| below this is not worth an order. */
  minWeightChange: number;
  /**
   * Allocation dead-zone (`allocation.rebalanceBand`): a target within this
   * distance of the current weight needs no order to count as funded (ADR 0013).
   */
  rebalanceBand: number;
}

export interface CommitteeRunContext {
  snapshot: PortfolioSnapshot;
  drift: AllocationDrift[];
  heat: number;
  /** Cash policy + its measured cost (WP-P1.5); optional so tests can omit it. */
  cash?: { policy: CashPolicy; drag: CashDrag };
  /** Per-instrument risk metrics (WP-P1.1/WP-P2.1); optional so tests can omit them. */
  risk?: InstrumentMetricsResult;
  /** Days to the next earnings per ticker (WP-P2.3); absent = unknown. */
  daysToEarnings?: ReadonlyMap<string, number>;
  /** Upcoming macro releases (WP-P2.3); absent = unknown. */
  macroEvents?: { name: string; date: string; importance: string }[];
  /** Outcome feedback (WP-P2.4): how the recent sessions actually turned out. */
  performance?: PerformanceContext | null;
  reports: AnalysisReport[];
  /** Current effective allocation targets (the seeds/persisted-updates merge). */
  targets: AllocationTarget[];
  /**
   * Window spend on LLM inference in USD (ADR 0011), converted at the live FX
   * rate and passed to the gate: the decisions a session produces must cover
   * the inference that produced them (ADR 0012).
   */
  llmSpendUsd?: number;
}

export interface CommitteeOutcome {
  session: CommitteeSession;
  decisions: Decision[];
}

/* ---------------- LLM structured outputs ---------------- */

/**
 * LLM outputs: free-text fields carry only a minimum length — an over-long
 * (but otherwise valid) comment or rationale must never fail the session, so
 * lengths are truncated at persistence time (see the sanitizers below).
 */
const ProposalOutputSchema = z.object({
  title: z.string().min(3),
  rationale: z.string().min(20),
  confidence: z.number().min(0).max(1),
  targets: z.array(z.object({ ticker: z.string().min(1), weight: z.number().min(0).max(1) })).max(50),
  orders: z
    .array(
      z.object({
        ticker: z.string().min(1),
        side: z.enum(["BUY", "SELL"]),
        value: z.number().positive(),
        reason: z.string().min(5),
      }),
    )
    .max(20),
});

const FeedbackOutputSchema = z.object({
  verdict: z.enum(["positive", "negative"]),
  comment: z.string().min(5),
});

const VoteOutputSchema = z.object({
  choice: z.string().min(1),
});

type ProposalOutput = z.infer<typeof ProposalOutputSchema>;

/**
 * The Asset Allocation Committee — THE decision flow (ADR 0009). Every run
 * it manages the allocation and the orders:
 *
 *   1. every agent proposes an allocation (target weights + optional orders);
 *   2. every agent reviews every OTHER agent's proposal (positive/negative);
 *   3. every agent casts one vote for the other proposal it favours most;
 *      the most-voted proposal wins, ties trigger a run-off excluding the
 *      lowest-scoring proposal(s), capped at `maxVoteRounds` with a
 *      deterministic fallback;
 *   4. the winner's targets are persisted (per-name cap + cash floor) and
 *      its orders are priced and passed through the SAME economic gate every
 *      order has always met, then executed by the pipeline.
 *
 * All artifacts (session, proposals, feedback, votes, points) are persisted
 * and shown on the dashboard. A failing agent call fails the session (visible
 * on the dashboard) without crashing the run: no targets change and no
 * orders are placed that run.
 */
export class CommitteeService {
  /**
   * Per-phase prompt accounting for the current session (WP-P1.3): calls and
   * prompt characters per phase, recorded on
   * `committee_sessions.details.llmPhases` so the effect of the context diet
   * stays measurable on real runs, not only in tests.
   */
  private readonly phaseStats: Record<string, { calls: number; promptChars: number }> = {};

  constructor(
    private readonly ports: AppPorts,
    private readonly llms: ReadonlyMap<string, LlmPort>,
    private readonly cfg: CommitteeConfig,
    private readonly decisions: DecisionService,
    /** Used only to state, in the prompt, what the gate would accept (WP-P0.3). */
    private readonly engine: DecisionEngine,
  ) {}

  private trackPhase(phase: string, chars: number): void {
    const entry = this.phaseStats[phase] ?? { calls: 0, promptChars: 0 };
    entry.calls += 1;
    entry.promptChars += chars;
    this.phaseStats[phase] = entry;
  }

  agentDefs(): CommitteeAgentDef[] {
    return this.cfg.agents;
  }

  get maxVoteRounds(): number {
    return this.cfg.maxVoteRounds;
  }

  get maxTarget(): number {
    return this.cfg.maxTarget;
  }

  get minCashBuffer(): number {
    return this.cfg.minCashBuffer;
  }

  async latest(): Promise<CommitteeSessionDetail | null> {
    const session = await this.ports.committee.latestSession();
    if (!session) return null;
    return this.ports.committee.detail(session.id);
  }

  async runSession(runId: string, ctx: CommitteeRunContext): Promise<CommitteeOutcome> {
    const now = () => toIso(this.ports.clock.now());
    const session: CommitteeSession = {
      id: newId("cms"),
      runId,
      status: "PROPOSING",
      round: 0,
      winnerProposalId: null,
      error: null,
      createdAt: now(),
      completedAt: null,
      details: { agents: this.cfg.agents.map((a) => ({ id: a.id, name: a.name, model: a.model })) },
    };
    await this.ports.committee.saveSession(session);
    this.emit(runId, "CommitteeSessionStarted", {
      sessionId: session.id,
      agents: this.cfg.agents.map((a) => ({ id: a.id, name: a.name, model: a.model })),
    });

    try {
      // 1. Proposals — one per agent, in parallel.
      const notes: string[] = [];
      const proposals = await this.collectProposals(runId, session.id, ctx, notes);
      if (proposals.length < 2) throw new Error(`committee produced only ${proposals.length} proposal(s) — need at least 2 to vote`);
      await this.ports.committee.saveProposals(proposals);
      session.status = "FEEDBACK";
      session.details = { ...session.details, notes };
      await this.ports.committee.saveSession(session);
      this.emit(runId, "CommitteeProposalsReady", { sessionId: session.id, count: proposals.length });

      // 2. Feedback — every agent reviews every other agent's proposal.
      const feedback = await this.collectFeedback(runId, session.id, proposals, ctx);
      session.status = "VOTING";
      await this.ports.committee.saveSession(session);
      this.emit(runId, "CommitteeFeedbackCompleted", { sessionId: session.id, count: feedback.length });

      // 3. Voting — one vote per agent, run-off on ties.
      const winner = await this.runVoting(runId, session, proposals, feedback, ctx);

      // 4a. Shape the winner's targets (trust region + dead zone + turnover
      // budget, WP-P1.4) BEFORE the orders are priced: the gate must evaluate
      // what will actually be recorded, not the winner's raw request.
      const shaped = this.shapeWinnerTargets(winner, ctx);
      const llmCostPerRun = await this.llmCostInAccountCurrency(ctx);
      const decisions = await this.decisions.decide({
        runId,
        snapshot: ctx.snapshot,
        heat: ctx.heat,
        intents: winner.orders.map((o) => ({ ...o, confidence: winner.confidence })),
        reports: ctx.reports,
        llmCostPerRun,
        targetWeights: shaped.weightByTicker,
        meta: {
          source: "committee",
          sessionId: session.id,
          proposalId: winner.id,
          agentId: winner.agentId,
          agentName: winner.agentName,
          points: winner.points,
        },
      });

      // 4b. Persist the shaped targets, marked by whether this run funded them.
      const funding = await this.applyWinnerTargets(runId, winner, ctx, decisions, shaped);
      session.details = { ...session.details, funding, trustRegion: shaped.summary, llmPhases: this.phaseStats };

      session.status = "COMPLETED";
      session.winnerProposalId = winner.id;
      session.completedAt = now();
      await this.ports.committee.saveSession(session);
      this.emit(runId, "CommitteeSessionCompleted", {
        sessionId: session.id,
        winnerProposalId: winner.id,
        agentId: winner.agentId,
        points: winner.points,
        decisions: decisions.filter((d) => d.approved && d.action !== "HOLD").length,
        unfundedTargets: funding.unfunded,
      });
      return { session, decisions };
    } catch (err) {
      // A budget stop is a deliberate, non-alarming abort: the session is
      // marked FAILED with the reason, and the run reports it as a budget stop
      // rather than as an agent failure.
      if (isLlmBudgetExceeded(err)) {
        const message = `LLM budget stop: ${err.message}`;
        session.status = "FAILED";
        session.error = message;
        session.completedAt = now();
        await this.ports.committee.saveSession(session);
        this.emit(runId, "CommitteeSessionFailed", { sessionId: session.id, error: message, budgetStop: true });
        this.ports.logger.warn(`committee session ${session.id} stopped by the LLM budget: ${err.message}`);
        return { session, decisions: [] };
      }
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      session.status = "FAILED";
      session.error = message;
      session.completedAt = now();
      await this.ports.committee.saveSession(session);
      this.emit(runId, "CommitteeSessionFailed", { sessionId: session.id, error: message });
      this.ports.logger.warn(`committee session ${session.id} failed: ${message}`);
      return { session, decisions: [] };
    }
  }

  /* ---------------- phase 1: proposals ---------------- */

  private async collectProposals(
    runId: string,
    sessionId: string,
    ctx: CommitteeRunContext,
    notes: string[],
  ): Promise<CommitteeProposal[]> {
    const constraints = this.buildConstraints(ctx);
    const now = () => toIso(this.ports.clock.now());
    const proposals = await Promise.all(
      this.cfg.agents.map(async (agent) => {
        let out: ProposalOutput;
        try {
          out = await this.agentChat<ProposalOutput>(
            agent,
            {
              system: proposeSystemPrompt(agent, ctx, constraints),
              // Per-role evidence slice (WP-P2.5): same account, different inputs.
              user: this.buildContext(ctx, "propose", agent.role ?? "generalist"),
            },
            ProposalOutputSchema,
          );
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(`proposal agent ${agent.id} (${agent.model}) failed: ${detail}`);
        }
        return this.sanitizeProposal(agent, out, sessionId, ctx.targets, notes, now());
      }),
    );
    this.emit(runId, "CommitteeProposalGenerated", { sessionId, count: proposals.length });
    return proposals;
  }

  private sanitizeProposal(
    agent: CommitteeAgentDef,
    out: ProposalOutput,
    sessionId: string,
    targets: AllocationTarget[],
    notes: string[],
    createdAt: string,
  ): CommitteeProposal {
    const targetTickers = new Set(targets.map((t) => t.ticker));
    const weights = new Map<string, number>();
    for (const t of out.targets) {
      if (!targetTickers.has(t.ticker)) {
        notes.push(`${agent.id}: target for ${t.ticker} ignored (not in the allocation)`);
        continue;
      }
      weights.set(t.ticker, roundTo(clamp(t.weight, 0, 1), WEIGHT_DP));
    }
    const orders: CommitteeOrderIntent[] = [];
    for (const o of out.orders) {
      if (!targetTickers.has(o.ticker)) {
        notes.push(`${agent.id}: order for ${o.ticker} ignored (not in the allocation)`);
        continue;
      }
      orders.push({ ticker: o.ticker, side: o.side, value: roundTo(o.value, 2), reason: o.reason.slice(0, 600) });
    }
    return {
      id: newId("cmp"),
      sessionId,
      agentId: agent.id,
      agentName: agent.name,
      agentModel: agent.model,
      title: out.title.slice(0, 140),
      rationale: out.rationale.slice(0, 3000),
      confidence: roundTo(clamp(out.confidence, 0, 1), 4),
      targets: [...weights.entries()].map(([ticker, weight]) => ({ ticker, weight })),
      orders,
      points: 0,
      status: "active",
      excludedRound: null,
      createdAt,
    };
  }

  /* ---------------- phase 2: feedback ---------------- */

  private async collectFeedback(
    runId: string,
    sessionId: string,
    proposals: CommitteeProposal[],
    ctx: CommitteeRunContext,
  ): Promise<CommitteeFeedback[]> {
    const context = this.buildContext(ctx, "review");
    const now = () => toIso(this.ports.clock.now());
    const tasks: Promise<CommitteeFeedback>[] = [];
    for (const agent of this.cfg.agents) {
      for (const proposal of proposals) {
        if (proposal.agentId === agent.id) continue; // review only the OTHER agents' proposals
        tasks.push(
          (async () => {
            let out: { verdict: "positive" | "negative"; comment: string };
            try {
              out = await this.agentChat(
                agent,
                { system: feedbackSystemPrompt(agent, proposal), user: context },
                FeedbackOutputSchema,
                "review",
              );
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              throw new Error(`feedback agent ${agent.id} (${agent.model}) on proposal by ${proposal.agentId} failed: ${detail}`);
            }
            const item: CommitteeFeedback = {
              id: newId("cmf"),
              sessionId,
              proposalId: proposal.id,
              reviewerAgentId: agent.id,
              reviewerAgentName: agent.name,
              verdict: out.verdict,
              comment: out.comment.slice(0, 1200),
              createdAt: now(),
            };
            await this.ports.committee.saveFeedback([item]); // persist as collected — visible even if the session later fails
            return item;
          })(),
        );
      }
    }
    const feedback = await Promise.all(tasks);
    this.emit(runId, "CommitteeFeedbackGiven", { sessionId, count: feedback.length });
    return feedback;
  }

  /* ---------------- phase 3: voting ---------------- */

  private async runVoting(
    runId: string,
    session: CommitteeSession,
    proposals: CommitteeProposal[],
    feedback: CommitteeFeedback[],
    ctx: CommitteeRunContext,
  ): Promise<CommitteeProposal> {
    // Voting needs the ballot, not the research: the vote prompt already lists
    // every proposal and the feedback each received (WP-P1.3).
    const context = this.buildContext(ctx, "vote");
    const now = () => toIso(this.ports.clock.now());
    const positiveCounts = positiveFeedbackCounts(feedback);
    let active = proposals.filter((p) => p.status === "active");

    for (let round = 1; round <= this.cfg.maxVoteRounds; round++) {
      session.round = round;
      await this.ports.committee.saveSession(session);

      const votes = await this.collectVotes(session.id, round, active, feedback, context, now);
      await this.ports.committee.saveVotes(votes);
      for (const v of votes) {
        const proposal = proposals.find((p) => p.id === v.proposalId);
        if (proposal) proposal.points += v.points;
      }
      await this.ports.committee.saveProposals(active);
      this.emit(runId, "CommitteeVoteRoundCompleted", {
        sessionId: session.id,
        round,
        points: Object.fromEntries(active.map((p) => [p.id, p.points])),
      });

      const resolution = resolveVoteRound({
        activeProposals: active.map((p) => ({
          id: p.id,
          points: p.points,
          positiveFeedback: positiveCounts.get(p.id) ?? 0,
          createdAt: p.createdAt,
        })),
        round,
        maxRounds: this.cfg.maxVoteRounds,
      });

      if (resolution.kind === "winner") {
        return await this.markWinner(runId, session, proposals, resolution.winnerProposalId, resolution.fallback);
      }
      if (resolution.kind === "exclude") {
        for (const id of resolution.excludedProposalIds) {
          const proposal = proposals.find((p) => p.id === id)!;
          proposal.status = "excluded";
          proposal.excludedRound = round;
          this.emit(runId, "CommitteeProposalExcluded", {
            sessionId: session.id,
            proposalId: id,
            agentId: proposal.agentId,
            round,
            points: proposal.points,
            reason: "fewest points in a tied vote — excluded from the next vote",
          });
        }
        active = proposals.filter((p) => p.status === "active");
        await this.ports.committee.saveProposals(proposals);
        if (active.length === 1) return await this.markWinner(runId, session, proposals, active[0]!.id, false);
        continue;
      }
      // "revote": all remaining proposals tied for the top — vote again.
    }

    // Unreachable in practice (resolveVoteRound settles ties at the cap), kept
    // as a deterministic safety net.
    const fallback = [...active].sort(
      (a, b) => (positiveCounts.get(b.id) ?? 0) - (positiveCounts.get(a.id) ?? 0) || a.createdAt.localeCompare(b.createdAt),
    )[0]!;
    return await this.markWinner(runId, session, proposals, fallback.id, true);
  }

  private async collectVotes(
    sessionId: string,
    round: number,
    active: CommitteeProposal[],
    feedback: CommitteeFeedback[],
    context: string,
    now: () => string,
  ): Promise<CommitteeVote[]> {    const votes: CommitteeVote[] = [];
    for (const agent of this.cfg.agents) {
      const others = active.filter((p) => p.agentId !== agent.id);
      if (others.length === 0) continue; // only possible with 1 active proposal; the run-off settles it earlier
      let out: { choice: string };
      try {
        out = await this.agentChat(
          agent,
          { system: voteSystemPrompt(agent, others, feedback, round), user: context },
          VoteOutputSchema,
          "vote",
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`vote agent ${agent.id} (${agent.model}) round ${round} failed: ${detail}`);
      }
      const proposalIds = others.map((p) => p.id);
      const choice = coerceChoice(out.choice, proposalIds);
      votes.push({
        ...castVote({ sessionId, round, voterAgentId: agent.id, voterAgentName: agent.name, proposalId: choice, proposalIds, createdAt: now() }),
        id: newId("cmv"),
      });
    }
    return votes;
  }

  private async markWinner(
    runId: string,
    session: CommitteeSession,
    proposals: CommitteeProposal[],
    winnerProposalId: string,
    fallback: boolean,
  ): Promise<CommitteeProposal> {
    const winner = proposals.find((p) => p.id === winnerProposalId)!;
    for (const p of proposals) {
      p.status = p.id === winnerProposalId ? "accepted" : p.status === "excluded" ? "excluded" : "defeated";
    }
    await this.ports.committee.saveProposals(proposals);
    this.emit(runId, "CommitteeWinnerAccepted", {
      sessionId: session.id,
      proposalId: winner.id,
      agentId: winner.agentId,
      agentName: winner.agentName,
      title: winner.title,
      points: winner.points,
      fallback,
      targets: winner.targets,
      orders: winner.orders.length,
    });
    return winner;
  }

  /* ---------------- phase 4: applying the winner ---------------- */

  /**
   * Turns the winner's requested targets into the targets this session will
   * actually hold (WP-P1.4): per-name cap, trust region (a single 2/1 vote must
   * not re-shape the book), dead zone (changes too small to be worth an order),
   * then the cash-floor rescale — and finally the turnover budget, whose exact
   * notional cost depends on NAV.
   *
   * Pure bookkeeping: no I/O, so it can run before the orders are gated and the
   * gate can judge the weights that will really be written.
   */
  private shapeWinnerTargets(
    winner: CommitteeProposal,
    ctx: CommitteeRunContext,
  ): {
    weightByTicker: Map<string, number>;
    proposedWeights: Map<string, number>;
    applied: AppliedTarget[];
    summary: Record<string, unknown>;
  } {
    const currentWeights = new Map(ctx.targets.map((t) => [t.ticker, t.weight]));
    const requested = new Map(currentWeights);
    for (const t of winner.targets) {
      if (!requested.has(t.ticker)) continue; // sanitization already guarantees this
      requested.set(t.ticker, clamp(t.weight, 0, this.cfg.maxTarget));
    }

    const region = applyTargetTrustRegion(
      [...requested.entries()].map(([ticker, weight]) => ({
        ticker,
        weight,
        currentWeight: currentWeights.get(ticker) ?? 0,
      })),
      winner.confidence,
      {
        shrinkFactor: this.cfg.trustRegion,
        confidenceWeight: this.cfg.trustRegionConfidenceWeight,
        maxTurnoverPctPerSession: this.cfg.maxTurnoverPctPerSession,
        minWeightChange: this.cfg.minWeightChange,
      },
    );

    // Sector caps and the cash floor are applied to the post-region weights
    // (WP-P2.2). Names without a known sector keep `maxTarget` as their only cap.
    // Real sectors when the fundamentals feed provided them (WP-P2.2); unknown
    // sectors stay null so the cap is never applied to a guess.
    const sectors = new Map<string, string | null>(
      ctx.targets.map((t) => [t.ticker, ctx.risk?.sectors[t.ticker] ?? null]),
    );
    const diversified = applyDiversificationGuardrails(
      new Map(region.applied.map((a) => [a.ticker, a.appliedWeight])),
      sectors,
      { minPositions: this.cfg.minPositions, sectorCaps: this.cfg.sectorCaps },
      { minCashBuffer: this.cfg.minCashBuffer },
    );
    const applied = region.applied.map((a) => {
      const cappedWeight = diversified.weights.get(a.ticker) ?? a.appliedWeight;
      return {
        ...a,
        appliedWeight: cappedWeight,
        delta: roundTo(cappedWeight - a.currentWeight, WEIGHT_DP),
        scaled: a.scaled || cappedWeight !== a.appliedWeight,
      };
    });

    return {
      weightByTicker: new Map(applied.map((a) => [a.ticker, a.appliedWeight])),
      proposedWeights: new Map(region.applied.map((a) => [a.ticker, a.appliedWeight])),
      applied,
      summary: {
        diversification: {
          positionCount: diversified.positionCount,
          minPositions: this.cfg.minPositions,
          belowMinPositions: diversified.belowMinPositions,
          sectorExposure: diversified.sectorExposure,
          cappedSectors: diversified.cappedSectors,
          invested: diversified.invested,
        },
        shrinkFactor: this.cfg.trustRegion,
        confidenceWeight: this.cfg.trustRegionConfidenceWeight,
        confidence: winner.confidence,
        maxTurnoverPctPerSession: this.cfg.maxTurnoverPctPerSession,
        minWeightChange: this.cfg.minWeightChange,
        turnover: roundTo(applied.reduce((total, a) => total + Math.abs(a.delta), 0), WEIGHT_DP),
        turnoverBudgetHit: region.scaled,
        cashFloorScaled: diversified.invested < region.applied.reduce((total, a) => total + a.appliedWeight, 0),
        requested: [...requested.entries()].map(([ticker, weight]) => ({
          ticker,
          requested: weight,
          current: currentWeights.get(ticker) ?? 0,
          applied: applied.find((a) => a.ticker === ticker)?.appliedWeight ?? currentWeights.get(ticker) ?? 0,
          skipped: applied.find((a) => a.ticker === ticker)?.skipped ?? false,
        })),
      },
    };
  }

  /**
   * Persists the shaped targets and marks each one with its **funding status**
   * (ADR 0013):
   *
   *  - `ACTIVE`   — an order approved in this run moves the position toward the
   *                 target, or the weight is already in line with it (the
   *                 position needs no funding at that size);
   *  - `UNFUNDED` — the plan moved but nothing paid for it (order rejected,
   *                 scaled away, or none proposed). The target is still stored
   *                 (the plan must not silently vanish) and is reported back to
   *                 the next session as a residual, with the gate's reason.
   *
   * Returns the summary recorded on the session and on the run's events. Called
   * AFTER the orders are gated, so a target can never move ahead of the money.
   */
  private async applyWinnerTargets(
    runId: string,
    winner: CommitteeProposal,
    ctx: CommitteeRunContext,
    decisions: Decision[],
    shaped: { applied: AppliedTarget[]; proposedWeights: Map<string, number> },
  ): Promise<{ funded: string[]; unfunded: { ticker: string; weight: number; reason: string }[] }> {
    const current = ctx.targets;
    const band = this.cfg.rebalanceBand;
    const byTicker = new Map(ctx.drift.map((d) => [d.ticker, d]));
    const now = toIso(this.ports.clock.now());
    const updates: AllocationTargetUpdate[] = [];
    const funded: string[] = [];
    const unfunded: { ticker: string; weight: number; reason: string }[] = [];

    for (const target of shaped.applied) {
      const { ticker, appliedWeight: finalWeight, skipped, scaled } = target;
      const previous = current.find((t) => t.ticker === ticker)!;
      const before = previous.weight;
      const changed = Math.abs(finalWeight - before) >= 1e-4;
      const requested = shaped.proposedWeights.get(ticker) ?? finalWeight;

      const approved = decisions.filter((d) => d.ticker === ticker && d.approved && d.action !== "HOLD");
      const decision = decisions.find((d) => d.ticker === ticker);
      const currentWeight = byTicker.get(ticker)?.currentWeight ?? 0;
      // An order funds the target when it moves the position toward it. A target
      // already within the rebalance band needs no order to be "funded".
      const movingOrder = approved.find((d) => {
        if (d.action === "BUY") return currentWeight < finalWeight - band;
        return currentWeight > finalWeight + band;
      });
      const alreadyOnPlan = Math.abs(currentWeight - finalWeight) <= band;
      const status: "ACTIVE" | "UNFUNDED" = movingOrder || alreadyOnPlan ? "ACTIVE" : "UNFUNDED";
      const note = movingOrder
        ? `funded by ${movingOrder.action} ${movingOrder.id}`
        : alreadyOnPlan
          ? "already within the rebalance band"
          : decision
            ? `no funding order: ${decision.reason}`
            : "no funding order proposed";

      // A previous UNFUNDED target that this run funded (or that is still off
      // plan) must be re-stated so its status reflects reality even when the
      // weight itself did not change.
      const statusChanged = previous.status === "UNFUNDED" && status === "ACTIVE";
      if (!changed && !statusChanged) continue;

      const shaping = scaled
        ? ` [turnover budget: ${(requested - target.currentWeight).toFixed(4)} → ${(finalWeight - before).toFixed(4)}]`
        : skipped
          ? " [dead zone: change below minWeightChange]"
          : "";
      updates.push({
        id: newId("tg"),
        runId,
        ticker,
        weight: finalWeight,
        originalWeight: before,
        rationale: `committee ${winner.agentName} (${winner.points} pts): ${winner.title} — ${winner.rationale.slice(0, 280)}${shaping}`,
        conviction: winner.confidence,
        updatedAt: now,
        status,
        fundingNote: note,
      });
      if (status === "ACTIVE") funded.push(ticker);
      else unfunded.push({ ticker, weight: finalWeight, reason: note });
    }

    if (updates.length > 0) {
      await this.ports.allocationTargets.saveUpdates(updates);
      this.emit(runId, "CommitteeTargetsApplied", {
        runId,
        proposalId: winner.id,
        targets: updates.map((u) => ({ ticker: u.ticker, from: u.originalWeight, to: u.weight, status: u.status })),
      });
    }
    if (unfunded.length > 0) {
      this.emit(runId, "CommitteeTargetsUnfunded", {
        runId,
        proposalId: winner.id,
        targets: unfunded,
      });
      this.ports.logger.warn(
        `committee plan not funded for ${unfunded.map((u) => u.ticker).join(", ")} — carried to the next session as a residual`,
      );
    }
    return { funded, unfunded };
  }

  /* ---------------- prompts & context ---------------- */

  /**
   * What the economic gate will accept, stated to the agents before they spend
   * tokens proposing something else (WP-P0.3). Every number here is the same one
   * `DecisionService` will apply: the size window per ticker comes from the
   * engine's own `minViableOrder` / `maxViableOrder`, the budget from the cash
   * floor, the caps from the committee guardrails.
   */
  private buildConstraints(ctx: CommitteeRunContext): Record<string, unknown> {
    const nav = ctx.snapshot.totalValue;
    const investedCap = 1 - this.cfg.minCashBuffer;
    const investableCash = roundValue(Math.max(0, ctx.snapshot.cash - this.cfg.minCashBuffer * nav));
    const maxOrder = roundValue(this.engine.maxViableOrder(nav));
    const driftByTicker = new Map(ctx.drift.map((d) => [d.ticker, d]));

    const actionable: Record<string, unknown> = {};
    const notActionable: Record<string, string> = {};
    for (const target of ctx.targets) {
      const drift = driftByTicker.get(target.ticker);
      // Same signal the gate will compute, with the analysts' actual reports and
      // the median proposal confidence (0.65) standing in for the winner's own —
      // the feasibility answer must describe the gate the trade will really meet.
      const signal = computeSignalStrength({
        reports: ctx.reports,
        ticker: target.ticker,
        proposalConfidence: 0.65,
        proposalConfidenceWeight: DecisionService.EDGE_PROPOSAL_WEIGHT,
        fullStrengthAdjustment: DecisionService.FULL_STRENGTH_ADJUSTMENT,
      });
      const edgePct = this.engine.computeEdgePct(signal);
      const instrumentCurrency =
        ctx.snapshot.positions.find((p) => p.ticker === target.ticker)?.currency ?? "USD";
      const costRatio = this.engine.roundTripCostRatio({
        accountCurrency: ctx.snapshot.currency,
        instrumentCurrency,
        action: "BUY",
        ticker: target.ticker,
      });
      const minOrder = this.engine.minViableOrder({ edgePct, costRatio, portfolioTotalValue: nav });
      if (minOrder === null) {
        const requiredEdge = costRatio * Math.max(this.engine.costBenefitMultiple, this.engine.llmCostMultiple);
        notActionable[target.ticker] =
          `no order size can clear the gate: the assumed edge (${(edgePct * 100).toFixed(3)}% from the research so far, ` +
          `signal ${signal.toFixed(2)}) does not beat the round-trip cost of ${(costRatio * 100).toFixed(3)}% ` +
          `by the required margin (needs ≥ ${(requiredEdge * 100).toFixed(3)}%)`;
        continue;
      }
      actionable[target.ticker] = {
        currentWeight: drift?.currentWeight ?? 0,
        targetWeight: target.weight,
        driftPp: roundValue((drift?.drift ?? 0) * 100),
        hint: drift?.hint ?? "buy",
        ...(target.status === "UNFUNDED" ? { unfunded: true, why: target.unfundedReason ?? null } : {}),
        minOrderValue: minOrder,
      };
    }
    return {
      accountCurrency: ctx.snapshot.currency,
      nav,
      cash: ctx.snapshot.cash,
      investableCash,
      cashFloorPct: roundValue(this.cfg.minCashBuffer * 100, 2),
      maxOrderValue: maxOrder,
      maxTargetWeight: this.cfg.maxTarget,
      investedCapPct: roundValue(investedCap * 100, 2),
      // Every order is charged the position's ROUND-TRIP cost (entry + exit).
      note:
        "An order must be at least minOrderValue for its ticker; nothing above maxOrderValue is ever placed; " +
        "the total of all targets must stay at or under investedCapPct% (cash floor); " +
        "no single target above maxTargetWeight. Orders outside these bounds are rejected by the gate.",
      actionableTickers: actionable,
      ...(Object.keys(notActionable).length > 0 ? { notActionableTickers: notActionable } : {}),
    };
  }

  /**
   * The run's inference spend in the account currency. Contained: an FX failure
   * falls back to 1 (the same convention the portfolio evaluation uses), and a
   * failure is logged rather than aborting a session over an accounting detail.
   */
  private async llmCostInAccountCurrency(ctx: CommitteeRunContext): Promise<number> {
    const spendUsd = ctx.llmSpendUsd ?? 0;
    if (spendUsd <= 0) return 0;
    const accountCurrency = ctx.snapshot.currency;
    if (accountCurrency === "USD") return roundValue(spendUsd);
    try {
      const rate = await this.ports.fx.rate("USD", accountCurrency);
      return roundValue(spendUsd * rate);
    } catch (err) {
      this.ports.logger.warn("fx rate unavailable for LLM spend, assuming 1", { error: String(err) });
      return roundValue(spendUsd);
    }
  }

  private llmFor(agent: CommitteeAgentDef): LlmPort {
    const llm = this.llms.get(agent.id);
    if (!llm || !llm.available()) {
      throw new Error(`committee agent ${agent.id} (${agent.provider}/${agent.model}) has no LLM configured — add its API key`);
    }
    return llm;
  }

  /**
   * chatJson with the agent's optional per-agent temperature and a per-phase
   * thinking mode (WP-P1.3): proposals may reason (that is where thinking pays),
   * while feedback and votes are classification calls that must never pay for
   * reasoning tokens even when the configured models default to it.
   *
   * A seat whose endpoint makes reasoning mandatory (`requiresReasoning`) is
   * exempt: disabling it there is an HTTP 400, so the override is skipped and
   * the agent's own thinking setting stands.
   */
  private async agentChat<T>(
    agent: CommitteeAgentDef,
    opts: { system: string; user: string },
    schema: z.ZodType<T>,
    phase: "propose" | "review" | "vote" = "propose",
  ): Promise<T> {
    const full: { system: string; user: string; temperature?: number; thinking?: "enabled" | "disabled" } = {
      system: opts.system,
      user: opts.user,
    };
    if (agent.temperature !== undefined) full.temperature = agent.temperature;
    if (phase !== "propose" && !agent.requiresReasoning) full.thinking = "disabled";
    this.trackPhase(phase, opts.system.length + opts.user.length);
    return this.llmFor(agent).chatJson(full, schema);
  }

  /**
   * The context handed to the agents, sliced by phase (WP-P1.3). The same blob
   * used to be rebuilt and re-sent in full to every agent of every phase —
   * including ~20 analyst rationales for a vote that only needs a proposal id.
   *
   *  - `propose` — the full research, once per session (3 calls);
   *  - `review`  — account state + drift + a one-line summary per analyst per
   *                ticker: a reviewer judges an allocation, it does not need to
   *                re-read the research prose (6 calls);
   *  - `vote`    — nothing: the ballot and the feedback are already in the
   *                vote prompt (3–9 calls).
   */
  private buildContext(
    ctx: CommitteeRunContext,
    profile: "propose" | "review" | "vote" = "propose",
    role: CommitteeAgentRole = "generalist",
  ): string {
    if (profile === "vote") return JSON.stringify({ portfolio: this.portfolioSummary(ctx) }, null, 2);

    const account: Record<string, unknown> = {
      currency: ctx.snapshot.currency,
      cash: ctx.snapshot.cash,
      totalValue: ctx.snapshot.totalValue,
      heat: ctx.heat,
    };
    // The review slice does not need the position book: current targets,
    // per-ticker weights and drift already describe the portfolio state a
    // reviewer judges an allocation against.
    const positions =
      profile === "propose"
        ? ctx.snapshot.positions.map((p) => ({
            ticker: p.ticker,
            quantity: p.quantity,
            currentPrice: p.currentPrice,
            currency: p.currency,
            weight: p.weight,
            marketValue: p.marketValue,
          }))
        : undefined;
    const drift = ctx.drift.map((d) => ({ ticker: d.ticker, from: d.targetWeight, to: d.currentWeight, drift: d.drift, hint: d.hint }));
    const unfunded = ctx.targets
      .filter((t) => t.status === "UNFUNDED")
      .map((t) => ({ ticker: t.ticker, targetWeight: t.weight, why: t.unfundedReason ?? "no funding order" }));

    const byTicker = new Map<string, AnalysisReport[]>();
    for (const r of ctx.reports) {
      const list = byTicker.get(r.ticker) ?? [];
      list.push(r);
      byTicker.set(r.ticker, list);
    }
    const analystResearch =
      profile === "propose"
        ? [...byTicker.entries()].map(([ticker, reports]) => ({
            ticker,
            reports: reports.map((r) => ({
              analyst: r.analyst,
              conclusion: r.conclusion,
              confidence: r.confidence,
              rationale: r.rationale,
              targetWeightAdjustment: r.signals.targetWeightAdjustment,
              adjustmentConfidence: r.signals.confidence,
            })),
          }))
        : undefined;
    const analystSummary = [...byTicker.entries()].map(([ticker, reports]) => ({
      ticker,
      views: reports
        .map((r) => `${r.analyst}:${r.conclusion}(${r.confidence.toFixed(2)})Δ${r.signals.targetWeightAdjustment.toFixed(2)}`)
        .join(" "),
    }));

    // Role slicing (WP-P2.5): each agent still sees the account and the plan,
    // but only the evidence its specialisation is supposed to weigh.
    const wants = (key: "risk" | "macro" | "valuation" | "events" | "cash"): boolean => {
      if (profile !== "propose") return false;
      switch (role) {
        case "macro":
          return key === "macro" || key === "events" || key === "cash";
        case "momentum":
          return key === "risk" || key === "events";
        case "valuation":
          return key === "valuation" || key === "events" || key === "cash";
        case "risk-officer":
          return key === "risk" || key === "cash";
        default:
          return true;
      }
    };

    const data: Record<string, unknown> = {
      account,
      ...(ctx.cash && wants("cash")
        ? {
            cashPolicy: {
              note: "cash is a position with a target and a band; holding more than the target costs the benchmark's move (dailyDragPct)",
              targetWeight: ctx.cash.policy.targetWeight,
              band: ctx.cash.policy.band,
              currentWeight: ctx.cash.policy.currentWeight,
              drift: ctx.cash.policy.drift,
              hint: ctx.cash.policy.hint,
              uninvested: ctx.cash.drag.amount,
              dailyDragPct: ctx.cash.drag.dailyPct,
              annualisedDragPct: ctx.cash.drag.annualisedPct,
            },
          }
        : {}),
      ...(positions ? { positions } : {}),
      currentTargets: ctx.targets,
      drift,
      ...(unfunded.length > 0
        ? {
            unfundedTargets: {
              note: "targets the plan already sets but no order has funded yet — fund these before proposing new changes",
              targets: unfunded,
            },
          }
        : {}),
      // Each role gets the analysts it is supposed to weigh: the tape-side views
      // for the momentum seat, the fundamentals view for the valuation seat, all
      // of them for the generalists — and the risk seat none, because its job is
      // concentration and sizing, not another opinion on the research
      // (WP-P2.5).
      ...(analystResearch && profile === "propose" && role !== "risk-officer"
        ? {
            analystResearch: analystResearch
              .map((entry) => ({
                ...entry,
                reports:
                  role === "generalist"
                    ? entry.reports
                    : entry.reports.filter((r) => roleAnalysts(role).includes(r.analyst)),
              }))
              .filter((entry) => entry.reports.length > 0),
          }
        : {}),
      ...(profile === "review" ? { analystSummary } : {}),
      ...(profile === "propose" && ctx.performance && (role === "generalist" || role === "risk-officer")
        ? {
            trackRecord: {
              note: "how this portfolio and its committee agents have actually done recently — do not repeat a stance that has been losing money",
              ...ctx.performance,
            },
          }
        : {}),
      ...(wants("events") && (ctx.daysToEarnings?.size || ctx.macroEvents?.length)
        ? {
            scheduledEvents: {
              note: "known scheduled events: an earnings print or a major macro release inside a few days is event risk — prefer smaller changes or waiting",
              earnings: [...(ctx.daysToEarnings ?? new Map<string, number>())].map(([ticker, days]) => ({ ticker, daysToEarnings: days })),
              ...(ctx.macroEvents && ctx.macroEvents.length > 0 ? { macroReleases: ctx.macroEvents } : {}),
            },
          }
        : {}),
      ...(wants("risk") && ctx.risk
        ? {
            instrumentRisk: {
              note: "per-name risk from the last candles: vol/bar, beta vs the benchmark, trend vs the 20-bar average, momentum, worst recent drawdown, position in the recent range. Size positions on risk, not only on conviction.",
              benchmarkBars: ctx.risk.benchmarkBars,
              portfolio: ctx.risk.concentration,
              names: ctx.risk.metrics.map((m) => ({
                ticker: m.ticker,
                bars: m.bars,
                volPerBarPct: m.volatilityPerBarPct,
                volAnnualisedPct: m.volatilityAnnualisedPct,
                beta: m.beta,
                trendVsSma20Pct: m.trendVsSma20Pct,
                momentum20Pct: m.momentum20Pct,
                maxDrawdownPct: m.maxDrawdownPct,
                rangePosition: m.rangePosition,
                volumeRatio: m.volumeRatio,
              })),
            },
          }
        : {}),
    };
    return JSON.stringify(data, null, 2);
  }

  /** Account state only — the slice a vote needs. */
  private portfolioSummary(ctx: CommitteeRunContext): Record<string, unknown> {
    return {
      currency: ctx.snapshot.currency,
      cash: ctx.snapshot.cash,
      totalValue: ctx.snapshot.totalValue,
      heat: ctx.heat,
      ...(ctx.cash ? { cashPolicy: { ...ctx.cash.policy, uninvested: ctx.cash.drag.amount } } : {}),
      currentTargets: ctx.targets,
      drift: ctx.drift.map((d) => ({ ticker: d.ticker, drift: d.drift, hint: d.hint })),
    };
  }

  private emit(runId: string, type: string, payload: Record<string, unknown>): void {
    this.ports.events.publish({ id: newId("evt"), runId, type, payload, occurredAt: toIso(this.ports.clock.now()) });
  }
}

/* ---------------- prompt builders ---------------- */

function tickerList(ctx: CommitteeRunContext): string {
  return ctx.targets.map((t) => `${t.ticker} (current target ${(t.weight * 100).toFixed(1)}%)`).join(", ");
}

/** Which analyst roles each committee seat is meant to weigh (WP-P2.5). */
function roleAnalysts(role: CommitteeAgentRole): AnalystKind[] {
  switch (role) {
    case "momentum":
      return ["market", "sentiment", "news"];
    case "valuation":
      return ["fundamentals"];
    case "macro":
      return ["market", "news"];
    default:
      return [...ANALYST_KINDS];
  }
}

/** The objective each role argues from (WP-P2.5). */
function roleObjective(agent: CommitteeAgentDef): string[] {
  switch (agent.role) {
    case "macro":
      return [
        "Your seat on this committee is the MACRO view: rates, the yield curve, inflation, the market regime and scheduled macro releases.",
        "Argue from the regime: which asset mix wins if the macro backdrop persists, and what would change your mind. Ignore single-name technical noise.",
      ];
    case "momentum":
      return [
        "Your seat on this committee is MOMENTUM: price action, trend versus the moving average, recent momentum, range position and unusual volume.",
        "Argue from what the tape is doing. Say explicitly when the trend and the fundamentals disagree; do not re-derive valuation.",
      ];
    case "valuation":
      return [
        "Your seat on this committee is VALUATION: earnings, margins, balance sheet, growth and what you are paying for them.",
        "Argue from value discipline. Name the price at which you would change your mind rather than restating the current weight.",
      ];
    case "risk-officer":
      return [
        "Your seat on this committee is RISK: concentration, volatility, beta, drawdown and cash.",
        "Your job is to argue for LESS concentration and for the position sizes the evidence supports, even when every other seat is enthusiastic.",
        "State the largest risk in the current book and the specific change that reduces it.",
      ];
    default:
      return [
        "Given the portfolio state and the analyst research provided, propose YOUR target asset allocation and any orders needed to move the portfolio toward it.",
      ];
  }
}

function proposeSystemPrompt(agent: CommitteeAgentDef, ctx: CommitteeRunContext, constraints: Record<string, unknown>): string {
  return [
    `You are ${agent.name}, an AI asset manager on an investment committee for a personal stock portfolio.`,
    ...roleObjective(agent),
    "",
    "The economic gate this portfolio actually trades through (orders outside these bounds are refused):",
    "<<<CONSTRAINTS",
    JSON.stringify(constraints, null, 2),
    "CONSTRAINTS>>>",
    "",
    "Rules:",
    `- Allocatable tickers (target allocation only): ${tickerList(ctx)}.`,
    "- targets: an object per ticker whose weight you want to CHANGE, with weight in 0..1 (4 decimals). Tickers you omit keep their current target. The sum of ALL targets (current + your changes) must be ≤ 1 — leave cash for the remainder.",
    "- orders: optional, only for allocatable tickers; side BUY or SELL; value in account currency; explain why.",
    "- If the portfolio state lists unfundedTargets, the plan already calls for those weights and no order has paid for them yet: propose the orders that fund them before proposing new target changes.",
    "- If the portfolio state lists trackRecord, weigh it: an agent whose proposals have been losing money should say what it would change, and no one should repeat a losing stance unchanged.",
    "- If the portfolio state lists scheduledEvents, an earnings print or a major macro release is inside the window: treat it as event risk (smaller changes, or wait).",
    "- If the portfolio state lists cashPolicy, cash is a position with its own target and band: when the hint is invest-cash, say what the excess cash should buy; when it is raise-cash, say what to trim. The target weights plus the cash target should sum to 1.",
    "- Be decisive, give concrete numbers, and never invent data you were not given.",
    "",
    "You MUST respond with a single JSON object with exactly these fields:",
    '{"title": "<short title>", "rationale": "<2-6 sentences>", "confidence": <0..1>, "targets": [{"ticker": "MSFT", "weight": 0.2}], "orders": [{"ticker": "NVDA", "side": "BUY", "value": 100, "reason": "..."}]}',
    "Never output anything except the JSON object.",
  ].join("\n");
}

function feedbackSystemPrompt(agent: CommitteeAgentDef, proposal: CommitteeProposal): string {
  return [
    `You are ${agent.name}, an AI asset manager on an investment committee.`,
    `Another committee member, ${proposal.agentName} (${proposal.agentModel}), made this proposal:`,
    JSON.stringify(
      {
        id: proposal.id,
        title: proposal.title,
        rationale: proposal.rationale,
        confidence: proposal.confidence,
        targets: proposal.targets,
        orders: proposal.orders,
      },
      null,
      2,
    ),
    "",
    "Review it critically against the portfolio state: is the allocation sound, diversified, and reasonable given the research? Are the orders justified and proportionate?",
    "",
    'You MUST respond with a single JSON object: {"verdict": "positive"|"negative", "comment": "<your honest assessment>"}.',
    "Never output anything except the JSON object.",
  ].join("\n");
}

function voteSystemPrompt(
  agent: CommitteeAgentDef,
  others: CommitteeProposal[],
  feedback: CommitteeFeedback[],
  round: number,
): string {
  const proposalsText = others
    .map((p) => {
      const fb = feedback
        .filter((f) => f.proposalId === p.id)
        .map((f) => `${f.reviewerAgentName} (${f.verdict}): ${f.comment.slice(0, 240)}`)
        .join(" | ");
      return `- ${p.id} — "${p.title}" by ${p.agentName} (${p.agentModel}), confidence ${p.confidence}, points so far ${p.points}. Feedback: ${fb || "none"}`;
    })
    .join("\n");
  return [
    `You are ${agent.name}, an AI asset manager on an investment committee.`,
    `All proposals and the feedback each received (vote round ${round}):`,
    proposalsText,
    "",
    "You must now vote for exactly ONE proposal BY ANOTHER agent (do NOT vote for your own proposal).",
    'Respond with a single JSON object: {"choice": "<proposalId>"} naming the single other proposal id you vote for.',
    "Never output anything except the JSON object.",
  ].join("\n");
}
