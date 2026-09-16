import { DomainError } from "../shared/errors.js";
import { roundTo, WEIGHT_DP } from "../shared/money.js";

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

/**
 * What an agent is FOR (WP-P2.5). Without a role every agent sees the same
 * context and answers the same question, so the proposals are near-identical
 * perturbations of the current targets and the vote picks a tone rather than an
 * argument. A role decides which slice of the evidence that agent receives and
 * which objective its prompt states.
 */
export type CommitteeAgentRole = "macro" | "momentum" | "valuation" | "risk-officer" | "generalist";

export interface CommitteeAgentDef {
  id: string;
  name: string;
  provider: string;
  model: string;
  temperature?: number;
  /** Specialisation; absent means `generalist` (today's behaviour). */
  role?: CommitteeAgentRole;
  /**
   * True when the agent's endpoint makes reasoning mandatory (OpenRouter
   * gemini-3.8-flash / glm-5.3-flash), so the cheap phases must not ask for
   * `thinking: disabled` — the provider rejects that with HTTP 400.
   */
  requiresReasoning?: boolean;
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

/* ---------------- applying a winner's targets: trust region ---------------- */

export interface TrustRegionConfig {
  /**
   * How much of a proposed weight change is applied: `w + k × damp(conf) × (w' − w)`
   * (0 = ignore the proposal, 1 = apply the full damped move).
   */
  shrinkFactor: number;
  /**
   * How much the winner's own confidence damps the move (0..1):
   * `damp(conf) = (1 − w) + w × conf`. 0 = ignore confidence entirely,
   * 1 = scale the whole move by it.
   */
  confidenceWeight: number;
  /**
   * Notional moved per session, as a fraction of NAV. Deltas are scaled down
   * proportionally when their sum exceeds it (same idiom as the cash-floor
   * rescale).
   */
  maxTurnoverPctPerSession: number;
  /** |Δweight| below this is noise and is not applied at all. */
  minWeightChange: number;
}

export interface ProposedTarget {
  ticker: string;
  /** The winner's requested weight. */
  weight: number;
  /** The weight in force before the session. */
  currentWeight: number;
}

export interface AppliedTarget extends ProposedTarget {
  /** Weight after the trust region, the dead zone and the turnover budget. */
  appliedWeight: number;
  /** appliedWeight − currentWeight, rounded. */
  delta: number;
  /** True when the dead zone dropped this change. */
  skipped: boolean;
  /** True when the turnover budget scaled this change down. */
  scaled: boolean;
}

/**
 * Turns a winner's requested targets into applied targets (WP-P1.4).
 *
 * The committee applies the winner's numbers **verbatim** today, so a 2/1 vote
 * hands 100 % of the decision to one agent: the live account shows 5-point
 * weight swings within an hour and XOM 0.05 → 0.1551 in a week. Three dampers,
 * all pure and testable:
 *
 *  1. **trust region**  — move only `shrinkFactor × confidence` of the way to the
 *     proposed weight, so a single session cannot re-shape the book;
 *  2. **dead zone**     — a change below `minWeightChange` is not worth an order;
 *  3. **turnover budget** — the session may move at most
 *     `maxTurnoverPctPerSession × NAV` of notional; when the sum of the moves
 *     exceeds it, every move is scaled by the same factor (never silently
 *     dropping one name).
 */
export function applyTargetTrustRegion(
  proposals: ProposedTarget[],
  confidence: number,
  cfg: TrustRegionConfig,
): { applied: AppliedTarget[]; turnover: number; scaled: boolean } {
  const k = Math.min(Math.max(cfg.shrinkFactor, 0), 1);
  const cw = Math.min(Math.max(cfg.confidenceWeight, 0), 1);
  const conf = Math.min(Math.max(confidence, 0), 1);
  const damp = (1 - cw) + cw * conf;

  const shaped = proposals.map((p) => {
    const requested = p.weight - p.currentWeight;
    const shrunk = requested * k * damp;
    const skipped = Math.abs(shrunk) < cfg.minWeightChange;
    return { ...p, delta: skipped ? 0 : shrunk, skipped, scaled: false };
  });

  const total = shaped.reduce((sum, s) => sum + Math.abs(s.delta), 0);
  const budget = Math.max(cfg.maxTurnoverPctPerSession, 0);
  const factor = budget > 0 && total > budget ? budget / total : 1;
  const applied = shaped.map((s) => {
    const delta = s.delta * factor;
    return {
      ticker: s.ticker,
      weight: s.weight,
      currentWeight: s.currentWeight,
      appliedWeight: roundTo(s.currentWeight + delta, WEIGHT_DP),
      delta: roundTo(delta, WEIGHT_DP),
      skipped: s.skipped,
      scaled: factor < 1 && !s.skipped,
    };
  });
  return {
    applied,
    turnover: roundTo(applied.reduce((sum, a) => sum + Math.abs(a.delta), 0), WEIGHT_DP),
    scaled: factor < 1,
  };
}

/* ---------------- diversification guardrails (WP-P2.2) ---------------- */

export interface SectorCaps {
  /** Default cap applied to every sector without an explicit entry (null = uncapped). */
  defaultCap: number | null;
  /** Per-sector overrides, matched case-insensitively. */
  bySector: Record<string, number>;
}

export interface DiversificationConfig {
  /** Minimum number of funded positions the allocation should hold (0 = off). */
  minPositions: number;
  /** Sector exposure caps. */
  sectorCaps: SectorCaps;
}

export interface DiversificationResult {
  /** Weights after the sector caps and the cash-floor rescale. */
  weights: Map<string, number>;
  /** Exposure per sector after the cap (fraction of NAV). */
  sectorExposure: Record<string, number>;
  /** Sectors that had to be scaled back, with the cap that bit. */
  cappedSectors: { sector: string; exposure: number; cap: number }[];
  /** Names above `minPositions` threshold of weight (a genuinely held position). */
  positionCount: number;
  /** True when the allocation carries fewer positions than `minPositions`. */
  belowMinPositions: boolean;
  /** Invested fraction after the cap. */
  invested: number;
}

/** Weight above which a name counts as a position rather than a rounding artefact. */
const POSITION_FLOOR = 0.01;

/**
 * Caps sector exposure and reports the resulting diversification (WP-P2.2).
 *
 * The old guardrails were per-name only (`maxTarget` 0.25) plus a cash floor, so
 * five correlated names could hold 95 % of NAV while looking "diversified": the
 * live book was 5 large caps with unlimited sector overlap. This makes sector
 * concentration a first-class constraint:
 *
 *   1. names without a known sector are left alone (the cap cannot be applied
 *      honestly, so the caller's `maxTarget` remains their only limit);
 *   2. each sector above its cap is scaled back proportionally, the excess
 *      staying in cash rather than being pushed into another sector;
 *   3. the result is renormalised only if a cash floor is supplied, exactly like
 *      the existing cash-floor guardrail.
 *
 * Pure: it never reads fundamentals itself, callers pass the sector map.
 */
export function applyDiversificationGuardrails(
  weights: Map<string, number>,
  sectors: ReadonlyMap<string, string | null>,
  cfg: DiversificationConfig,
  opts: { minCashBuffer?: number } = {},
): DiversificationResult {
  const capped = new Map(weights);
  const sectorExposure: Record<string, number> = {};
  const cappedSectors: { sector: string; exposure: number; cap: number }[] = [];

  const sectorOf = (ticker: string): string | null => {
    const raw = sectors.get(ticker);
    return raw && raw.trim().length > 0 ? raw.trim() : null;
  };
  const capFor = (sector: string): number | null => {
    const override = Object.entries(cfg.sectorCaps.bySector).find(([name]) => name.toLowerCase() === sector.toLowerCase());
    if (override) return override[1];
    return cfg.sectorCaps.defaultCap;
  };

  // 1. accumulate exposure per sector
  const totals = new Map<string, number>();
  for (const [ticker, weight] of capped) {
    const sector = sectorOf(ticker);
    if (!sector) continue;
    totals.set(sector, roundTo((totals.get(sector) ?? 0) + weight, WEIGHT_DP));
  }

  // 2. scale back the sectors over their cap (proportionally within the sector)
  for (const [sector, exposure] of totals) {
    const cap = capFor(sector);
    if (cap === null || exposure <= cap || exposure <= 0) continue;
    const factor = cap / exposure;
    for (const [ticker, weight] of capped) {
      if (sectorOf(ticker) !== sector) continue;
      capped.set(ticker, roundTo(weight * factor, WEIGHT_DP));
    }
    cappedSectors.push({ sector, exposure: roundTo(exposure, WEIGHT_DP), cap });
  }

  // 3. optional cash-floor rescale (the existing guardrail's idiom)
  const invested = roundTo([...capped.values()].reduce((sum, w) => sum + w, 0), WEIGHT_DP);
  const cap = opts.minCashBuffer === undefined ? 1 : 1 - opts.minCashBuffer;
  if (invested > cap && invested > 0) {
    const factor = cap / invested;
    for (const [ticker, weight] of capped) capped.set(ticker, roundTo(weight * factor, WEIGHT_DP));
  }

  for (const [ticker, weight] of capped) {
    const sector = sectorOf(ticker);
    if (!sector) continue;
    sectorExposure[sector] = roundTo((sectorExposure[sector] ?? 0) + weight, WEIGHT_DP);
  }
  const positionCount = [...capped.values()].filter((w) => w >= POSITION_FLOOR).length;

  return {
    weights: capped,
    sectorExposure,
    cappedSectors,
    positionCount,
    belowMinPositions: cfg.minPositions > 0 && positionCount < cfg.minPositions,
    invested: roundTo([...capped.values()].reduce((sum, w) => sum + w, 0), WEIGHT_DP),
  };
}
