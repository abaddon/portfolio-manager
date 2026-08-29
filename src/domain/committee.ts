import { DomainError } from "../shared/errors.js";

/**
 * Asset Allocation Committee domain: types + pure voting logic.
 *
 * Flow per session: every agent proposes an allocation (target weights +
 * optional orders) → every agent reviews every OTHER agent's proposal
 * (positive/negative feedback) → every agent casts ONE vote for the other
 * agent's proposal it thinks is best (1 point per vote) → the proposal with
 * the most votes wins and is applied to the portfolio.
 *
 * Tie-break (the user's rule): when two or more proposals tie for the most
 * votes, the proposal(s) with the fewest votes are excluded from the next
 * vote round and the agents vote again. When all remaining proposals are
 * tied (nothing to exclude) the round is simply re-voted. The rounds are
 * capped at `maxVoteRounds`; a tie that survives the cap is settled by a
 * deterministic fallback: most positive feedback, then earliest proposal.
 */

export type CommitteeSessionStatus = "PROPOSING" | "FEEDBACK" | "VOTING" | "COMPLETED" | "FAILED";
export type CommitteeProposalStatus = "active" | "excluded" | "accepted" | "defeated";
export type CommitteeFeedbackVerdict = "positive" | "negative";

export interface CommitteeAgentDef {
  id: string;
  name: string;
  provider: string;
  model: string;
  temperature?: number;
}

export interface CommitteeProposalTarget {
  ticker: string;
  weight: number; // 0..1
}

/** An order the proposing agent wants placed (value in account currency). */
export interface CommitteeOrderIntent {
  ticker: string;
  side: "BUY" | "SELL";
  value: number;
  reason: string;
}

export interface CommitteeProposal {
  id: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  agentModel: string;
  title: string;
  rationale: string;
  /** The agent's own confidence in its proposal, 0..1 (also the trade-gate confidence). */
  confidence: number;
  targets: CommitteeProposalTarget[];
  orders: CommitteeOrderIntent[];
  /** Cumulative vote points across rounds (one vote = one point). */
  points: number;
  status: CommitteeProposalStatus;
  /** Vote round in which the proposal was excluded (null when never excluded). */
  excludedRound: number | null;
  createdAt: string;
}

export interface CommitteeFeedback {
  id: string;
  sessionId: string;
  proposalId: string;
  reviewerAgentId: string;
  reviewerAgentName: string;
  verdict: CommitteeFeedbackVerdict;
  comment: string;
  createdAt: string;
}

export interface CommitteeVote {
  id: string;
  sessionId: string;
  round: number;
  voterAgentId: string;
  voterAgentName: string;
  proposalId: string;
  /** Always 1 — each agent casts exactly one vote per round. */
  points: number;
  createdAt: string;
}

export interface CommitteeSession {
  id: string;
  runId: string;
  status: CommitteeSessionStatus;
  /** Latest vote round held (0 = none yet). */
  round: number;
  winnerProposalId: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  details: Record<string, unknown>;
}

export interface CommitteeSessionDetail {
  session: CommitteeSession;
  proposals: CommitteeProposal[];
  feedback: CommitteeFeedback[];
  votes: CommitteeVote[];
}

/**
 * Casts one agent's single vote for one of the allowed proposals: exactly
 * one vote per agent per round, worth 1 point.
 */
export function castVote(params: {
  sessionId: string;
  round: number;
  voterAgentId: string;
  voterAgentName: string;
  proposalId: string;
  proposalIds: string[];
  createdAt: string;
}): Omit<CommitteeVote, "id"> {
  const { sessionId, round, voterAgentId, voterAgentName, proposalId, proposalIds, createdAt } = params;
  if (!proposalIds.includes(proposalId)) {
    throw new DomainError(`vote by ${voterAgentId} must be for one of ${proposalIds.join(",")}`);
  }
  return { sessionId, round, voterAgentId, voterAgentName, proposalId, points: 1, createdAt };
}

/** Coerces a possibly imperfect LLM choice into a valid proposal id (first allowed id on failure). */
export function coerceChoice(choice: string | undefined, proposalIds: string[]): string {
  return choice !== undefined && proposalIds.includes(choice) ? choice : proposalIds[0]!;
}

/** Per-proposal positive-feedback counts (tie-break input for the run-off cap). */
export function positiveFeedbackCounts(feedback: CommitteeFeedback[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of feedback) {
    if (f.verdict !== "positive") continue;
    out.set(f.proposalId, (out.get(f.proposalId) ?? 0) + 1);
  }
  return out;
}

export type VoteResolution =
  | { kind: "winner"; winnerProposalId: string; fallback: boolean }
  | { kind: "exclude"; excludedProposalIds: string[] }
  | { kind: "revote" };

export interface ActiveProposalState {
  id: string;
  points: number;
  positiveFeedback: number;
  createdAt: string;
}

/**
 * Resolves one vote round. Rules (see module doc):
 *  - a unique top-scoring proposal wins;
 *  - a tie for the top at the round cap is settled by the deterministic
 *    fallback (most positive feedback, then earliest created);
 *  - a tie before the cap excludes the lowest-scoring proposal(s) when some
 *    proposal scores strictly below the top; otherwise (all tied) it is a
 *    plain re-vote.
 */
export function resolveVoteRound(params: {
  activeProposals: ActiveProposalState[];
  round: number;
  maxRounds: number;
}): VoteResolution {
  const { activeProposals, round, maxRounds } = params;
  if (activeProposals.length === 0) throw new DomainError("cannot resolve a vote round with no active proposals");
  if (activeProposals.length === 1) return { kind: "winner", winnerProposalId: activeProposals[0]!.id, fallback: false };

  const top = Math.max(...activeProposals.map((p) => p.points));
  const tops = activeProposals.filter((p) => p.points === top);
  if (tops.length === 1) return { kind: "winner", winnerProposalId: tops[0]!.id, fallback: false };

  if (round >= maxRounds) {
    // Deterministic fallback for a tie that survives the round cap.
    const best = [...tops].sort(
      (a, b) => b.positiveFeedback - a.positiveFeedback || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )[0]!;
    return { kind: "winner", winnerProposalId: best.id, fallback: true };
  }

  const min = Math.min(...activeProposals.map((p) => p.points));
  if (min < top) {
    return { kind: "exclude", excludedProposalIds: activeProposals.filter((p) => p.points === min).map((p) => p.id) };
  }
  return { kind: "revote" };
}
