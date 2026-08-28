import { z } from "zod";
import { newId } from "../../shared/id.js";
import { toIso } from "../../shared/clock.js";
import { clamp, roundTo, WEIGHT_DP } from "../../shared/money.js";
import type { AnalysisReport } from "../../domain/analysis.js";
import type { Decision } from "../../domain/decision.js";
import type { AllocationDrift, AllocationTarget, AllocationTargetUpdate, PortfolioSnapshot } from "../../domain/portfolio.js";
import {
  coerceRanking,
  positiveFeedbackCounts,
  rankVotes,
  resolveVoteRound,
  type CommitteeAgentDef,
  type CommitteeFeedback,
  type CommitteeOrderIntent,
  type CommitteeProposal,
  type CommitteeSession,
  type CommitteeSessionDetail,
  type CommitteeVote,
} from "../../domain/committee.js";
import type { AppPorts, LlmPort } from "../ports.js";
import { DecisionService } from "./decisions.js";

const ENABLED_SETTING = "committee.enabled";

export interface CommitteeConfig {
  /** Default enabled state (the dashboard toggle overrides it in settings). */
  enabled: boolean;
  /** Cap on vote rounds; a surviving tie is settled deterministically. */
  maxVoteRounds: number;
  agents: CommitteeAgentDef[];
  /** Guardrail shared with the allocation review: no single name above this. */
  maxTarget: number;
  /** Guardrail: total invested targets stay under 1 − minCashBuffer. */
  minCashBuffer: number;
}

export interface CommitteeRunContext {
  snapshot: PortfolioSnapshot;
  drift: AllocationDrift[];
  heat: number;
  reports: AnalysisReport[];
  /** Current effective allocation targets (the seeds/review merge). */
  targets: AllocationTarget[];
}

export interface CommitteeOutcome {
  session: CommitteeSession;
  decisions: Decision[];
}

/* ---------------- LLM structured outputs ---------------- */

const ProposalOutputSchema = z.object({
  title: z.string().min(3).max(140),
  rationale: z.string().min(20).max(3000),
  confidence: z.number().min(0).max(1),
  targets: z.array(z.object({ ticker: z.string().min(1), weight: z.number().min(0).max(1) })).max(50),
  orders: z
    .array(
      z.object({
        ticker: z.string().min(1),
        side: z.enum(["BUY", "SELL"]),
        value: z.number().positive(),
        reason: z.string().min(5).max(600),
      }),
    )
    .max(20),
});

const FeedbackOutputSchema = z.object({
  verdict: z.enum(["positive", "negative"]),
  comment: z.string().min(5).max(1200),
});

const VoteOutputSchema = z.object({
  ranking: z.array(z.string().min(1)).min(1).max(20),
});

type ProposalOutput = z.infer<typeof ProposalOutputSchema>;

/**
 * The Asset Allocation Committee — the alternative decision flow. When
 * enabled (config or dashboard toggle) it replaces the allocation review and
 * the analyst-signal decisions for a run:
 *
 *   1. every agent proposes an allocation (target weights + optional orders);
 *   2. every agent reviews every OTHER agent's proposal (positive/negative);
 *   3. every agent votes by ranking the other proposals; the top-scoring
 *      proposal wins, ties trigger a run-off excluding the lowest-scoring
 *      proposal(s), capped at `maxVoteRounds` with a deterministic fallback;
 *   4. the winner's targets are persisted (with the review guardrails) and
 *      its orders are priced and passed through the SAME economic gate as
 *      the classic flow, then executed by the pipeline.
 *
 * All artifacts (session, proposals, feedback, votes, points) are persisted
 * and shown on the dashboard. A failing agent call fails the session (visible
 * on the dashboard) without crashing the run: no targets change and no
 * orders are placed that run.
 */
export class CommitteeService {
  constructor(
    private readonly ports: AppPorts,
    private readonly llms: ReadonlyMap<string, LlmPort>,
    private readonly cfg: CommitteeConfig,
    private readonly decisions: DecisionService,
  ) {}

  async isEnabled(): Promise<boolean> {
    const override = await this.ports.settings.get(ENABLED_SETTING);
    return typeof override === "boolean" ? override : this.cfg.enabled;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.ports.settings.set(ENABLED_SETTING, enabled);
  }

  agentDefs(): CommitteeAgentDef[] {
    return this.cfg.agents;
  }

  get maxVoteRounds(): number {
    return this.cfg.maxVoteRounds;
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

      // 3. Voting — ranked ballots, run-off on ties.
      const winner = await this.runVoting(runId, session, proposals, feedback, ctx);

      // 4. Apply the winner: allocation targets (guardrailed) + gated orders.
      await this.applyWinnerTargets(runId, winner, ctx.targets);
      const decisions = await this.decisions.decideFromOrders({
        runId,
        snapshot: ctx.snapshot,
        heat: ctx.heat,
        intents: winner.orders.map((o) => ({ ...o, confidence: winner.confidence })),
        meta: {
          source: "committee",
          sessionId: session.id,
          proposalId: winner.id,
          agentId: winner.agentId,
          agentName: winner.agentName,
          points: winner.points,
        },
      });

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
      });
      return { session, decisions };
    } catch (err) {
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
    const context = this.buildContext(ctx);
    const now = () => toIso(this.ports.clock.now());
    const proposals = await Promise.all(
      this.cfg.agents.map(async (agent) => {
        const out = await this.agentChat<ProposalOutput>(
          agent,
          { system: proposeSystemPrompt(agent, ctx), user: context },
          ProposalOutputSchema,
        );
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
      orders.push({ ticker: o.ticker, side: o.side, value: roundTo(o.value, 2), reason: o.reason });
    }
    return {
      id: newId("cmp"),
      sessionId,
      agentId: agent.id,
      agentName: agent.name,
      agentModel: agent.model,
      title: out.title,
      rationale: out.rationale,
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
    const context = this.buildContext(ctx);
    const now = () => toIso(this.ports.clock.now());
    const tasks: Promise<CommitteeFeedback>[] = [];
    for (const agent of this.cfg.agents) {
      for (const proposal of proposals) {
        if (proposal.agentId === agent.id) continue; // review only the OTHER agents' proposals
        tasks.push(
          (async () => {
            const out = await this.agentChat(
              agent,
              { system: feedbackSystemPrompt(agent, proposal), user: context },
              FeedbackOutputSchema,
            );
            const item: CommitteeFeedback = {
              id: newId("cmf"),
              sessionId,
              proposalId: proposal.id,
              reviewerAgentId: agent.id,
              reviewerAgentName: agent.name,
              verdict: out.verdict,
              comment: out.comment,
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
    const context = this.buildContext(ctx);
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
      const out = await this.agentChat(
        agent,
        { system: voteSystemPrompt(agent, others, feedback, round), user: context },
        VoteOutputSchema,
      );
      const ranking = coerceRanking(out.ranking, others.map((p) => p.id));
      const roundVotes = rankVotes({
        sessionId,
        round,
        voterAgentId: agent.id,
        voterAgentName: agent.name,
        ranking,
        proposalIds: others.map((p) => p.id),
        createdAt: now(),
      }).map((v) => ({ ...v, id: newId("cmv") }));
      votes.push(...roundVotes);
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

  /** Persists the winner's targets with the same guardrails as the review. */
  private async applyWinnerTargets(runId: string, winner: CommitteeProposal, current: AllocationTarget[]): Promise<void> {
    const proposed = new Map(current.map((t) => [t.ticker, t.weight]));
    for (const t of winner.targets) {
      if (!proposed.has(t.ticker)) continue; // sanitization already guarantees this
      proposed.set(t.ticker, clamp(t.weight, 0, this.cfg.maxTarget));
    }
    const cap = 1 - this.cfg.minCashBuffer;
    const sum = [...proposed.values()].reduce((a, b) => a + b, 0);
    const scale = sum > cap ? cap / sum : 1;

    const now = toIso(this.ports.clock.now());
    const updates: AllocationTargetUpdate[] = [];
    for (const [ticker, weight] of proposed) {
      const finalWeight = roundTo(weight * scale, WEIGHT_DP);
      const before = current.find((t) => t.ticker === ticker)!.weight;
      if (Math.abs(finalWeight - before) < 1e-4) continue;
      updates.push({
        id: newId("tg"),
        runId,
        ticker,
        weight: finalWeight,
        originalWeight: before,
        rationale: `committee ${winner.agentName} (${winner.points} pts): ${winner.title} — ${winner.rationale.slice(0, 280)}`,
        conviction: winner.confidence,
        updatedAt: now,
      });
    }
    if (updates.length > 0) {
      await this.ports.allocationTargets.saveUpdates(updates);
      this.emit(runId, "CommitteeTargetsApplied", {
        runId,
        proposalId: winner.id,
        targets: updates.map((u) => ({ ticker: u.ticker, from: u.originalWeight, to: u.weight })),
      });
    }
  }

  /* ---------------- prompts & context ---------------- */

  private llmFor(agent: CommitteeAgentDef): LlmPort {
    const llm = this.llms.get(agent.id);
    if (!llm || !llm.available()) {
      throw new Error(`committee agent ${agent.id} (${agent.provider}/${agent.model}) has no LLM configured — add its API key`);
    }
    return llm;
  }

  /** chatJson with the agent's optional per-agent temperature. */
  private async agentChat<T>(
    agent: CommitteeAgentDef,
    opts: { system: string; user: string },
    schema: z.ZodType<T>,
  ): Promise<T> {
    const full: { system: string; user: string; temperature?: number } = { system: opts.system, user: opts.user };
    if (agent.temperature !== undefined) full.temperature = agent.temperature;
    return this.llmFor(agent).chatJson(full, schema);
  }

  private buildContext(ctx: CommitteeRunContext): string {
    const byTicker = new Map<string, AnalysisReport[]>();
    for (const r of ctx.reports) {
      const list = byTicker.get(r.ticker) ?? [];
      list.push(r);
      byTicker.set(r.ticker, list);
    }
    const data = {
      account: {
        currency: ctx.snapshot.currency,
        cash: ctx.snapshot.cash,
        totalValue: ctx.snapshot.totalValue,
        heat: ctx.heat,
      },
      positions: ctx.snapshot.positions.map((p) => ({
        ticker: p.ticker,
        quantity: p.quantity,
        currentPrice: p.currentPrice,
        currency: p.currency,
        weight: p.weight,
        marketValue: p.marketValue,
      })),
      currentTargets: ctx.targets,
      drift: ctx.drift.map((d) => ({ ticker: d.ticker, drift: d.drift, hint: d.hint })),
      analystResearch: [...byTicker.entries()].map(([ticker, reports]) => ({
        ticker,
        reports: reports.map((r) => ({
          analyst: r.analyst,
          conclusion: r.conclusion,
          confidence: r.confidence,
          rationale: r.rationale,
        })),
      })),
    };
    return JSON.stringify(data, null, 2);
  }

  private emit(runId: string, type: string, payload: Record<string, unknown>): void {
    this.ports.events.publish({ id: newId("evt"), runId, type, payload, occurredAt: toIso(this.ports.clock.now()) });
  }
}

/* ---------------- prompt builders ---------------- */

function tickerList(ctx: CommitteeRunContext): string {
  return ctx.targets.map((t) => `${t.ticker} (current target ${(t.weight * 100).toFixed(1)}%)`).join(", ");
}

function proposeSystemPrompt(agent: CommitteeAgentDef, ctx: CommitteeRunContext): string {
  return [
    `You are ${agent.name}, an AI asset manager on an investment committee for a personal stock portfolio.`,
    "Given the portfolio state and the analyst research provided, propose YOUR target asset allocation and any orders needed to move the portfolio toward it.",
    "",
    "Rules:",
    `- Allocatable tickers (target allocation only): ${tickerList(ctx)}.`,
    "- targets: an object per ticker whose weight you want to CHANGE, with weight in 0..1 (4 decimals). Tickers you omit keep their current target. The sum of ALL targets (current + your changes) must be ≤ 1 — leave cash for the remainder.",
    "- orders: optional, only for allocatable tickers; side BUY or SELL; value in account currency; explain why.",
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
    "You must now vote by ranking the proposals BY THE OTHER agents from best to worst (do NOT rank your own proposal).",
    'Respond with a single JSON object: {"ranking": ["<proposalId>", "<proposalId>", ...]} listing every other proposal id, best first.',
    "Never output anything except the JSON object.",
  ].join("\n");
}
