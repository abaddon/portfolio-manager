import { roundTo, roundValue, WEIGHT_DP } from "../shared/money.js";

/**
 * Outcome feedback (WP-P2.4). Nothing in the system used to ask "did that
 * decision make money?": the review found no per-decision attribution, no
 * per-agent scorecard and no analyst calibration, so the committee could neither
 * learn nor be held to account. These are the pure pieces — measurement only,
 * no I/O.
 */

export interface ForwardReturn {
  /** Horizon in hours the return was measured over. */
  horizonHours: number;
  /** Close-to-close return of the instrument over the horizon (fraction). */
  returnPct: number | null;
}

/** Close-to-close return over roughly `horizonHours` bars of an hourly series. */
export function forwardReturn(closes: number[], horizonHours: number): number | null {
  if (closes.length < 2) return null;
  const horizon = Math.max(1, Math.min(Math.round(horizonHours), closes.length - 1));
  const then = closes[closes.length - 1 - horizon]!;
  const now = closes.at(-1)!;
  if (then <= 0) return null;
  return roundTo(now / then - 1, 6);
}

export interface DecisionOutcomeInput {
  decisionId: string;
  ticker: string;
  action: "BUY" | "SELL" | "HOLD";
  approved: boolean;
  /** Signed order value in account currency (0 for HOLD/rejected). */
  orderValue: number;
  /** Instrument return since the decision, when it can be measured. */
  forwardReturnPct: number | null;
}

export interface DecisionOutcome {
  decisionId: string;
  ticker: string;
  action: "BUY" | "SELL" | "HOLD";
  approved: boolean;
  orderValue: number;
  forwardReturnPct: number | null;
  /**
   * Contribution of the decision to the portfolio, in account currency:
   * `0` for a rejected/HOLD decision (nothing was risked), `orderValue ×
   * forwardReturn` for an approved one, signed by the direction taken — so a BUY
   * into a fall and a SELL before a rise are both negative.
   */
  contribution: number;
}

export function attributeDecision(input: DecisionOutcomeInput): DecisionOutcome {
  const { decisionId, ticker, action, approved, orderValue, forwardReturnPct } = input;
  const risked = approved && action !== "HOLD" && forwardReturnPct !== null;
  const direction = action === "SELL" ? -1 : 1;
  return {
    decisionId,
    ticker,
    action,
    approved,
    orderValue: roundValue(orderValue),
    forwardReturnPct,
    contribution: risked ? roundValue(orderValue * forwardReturnPct! * direction) : 0,
  };
}

export interface AgentOutcomeInput {
  agentId: string;
  agentName: string;
  /** Proposals the agent made in the sessions being scored. */
  proposals: number;
  accepted: number;
  /** Sum of the attribution of the decisions taken from this agent's proposals. */
  contribution: number;
  /** Attribution of the decisions of the sessions this agent WON. */
  portfolioContribution: number;
}

export interface AgentScorecard extends AgentOutcomeInput {
  /** Share of this agent's proposals that won the vote. */
  acceptanceRate: number;
  /** Mean contribution per proposal, account currency. */
  contributionPerProposal: number;
  /** True when the agent's proposals have earned money on balance. */
  positive: boolean;
}

/** Evidence-weighted scorecard per agent: what their proposals actually did. */
export function buildScorecards(inputs: readonly AgentOutcomeInput[]): AgentScorecard[] {
  return inputs.map((input) => {
    const acceptanceRate = input.proposals > 0 ? roundTo(input.accepted / input.proposals, 4) : 0;
    const contributionPerProposal = input.proposals > 0 ? roundValue(input.contribution / input.proposals) : 0;
    return {
      ...input,
      contribution: roundValue(input.contribution),
      portfolioContribution: roundValue(input.portfolioContribution),
      acceptanceRate,
      contributionPerProposal,
      positive: input.contribution > 0,
    };
  });
}

export interface AnalystCalibrationInput {
  analyst: string;
  conclusion: "bullish" | "bearish" | "neutral";
  confidence: number;
  forwardReturnPct: number | null;
}

export interface AnalystCalibration {
  analyst: string;
  /** Scored calls: those with a measurable forward return. */
  sample: number;
  /** Bullish calls that rose + bearish calls that fell, over the sample. */
  hits: number;
  /** hits / sample (null without a sample). */
  hitRate: number | null;
  /** Mean forward return of the calls (null without a sample). */
  meanForwardReturnPct: number | null;
  /**
   * Mean forward return a bullish call produced minus a bearish one: a positive
   * number means the analyst's direction has been informative.
   */
  directionalEdgePct: number | null;
}

/** Did the analyst's calls line up with what happened? (per role, per window) */
export function calibrateAnalysts(inputs: readonly AnalystCalibrationInput[]): AnalystCalibration[] {
  const byAnalyst = new Map<string, AnalystCalibrationInput[]>();
  for (const item of inputs) {
    if (item.forwardReturnPct === null || item.conclusion === "neutral") continue;
    const list = byAnalyst.get(item.analyst) ?? [];
    list.push(item);
    byAnalyst.set(item.analyst, list);
  }
  return [...byAnalyst.entries()].map(([analyst, items]) => {
    const sample = items.length;
    const hits = items.filter((i) => (i.conclusion === "bullish" ? i.forwardReturnPct! > 0 : i.forwardReturnPct! < 0)).length;
    const mean = items.reduce((sum, i) => sum + i.forwardReturnPct!, 0) / sample;
    const bullish = items.filter((i) => i.conclusion === "bullish");
    const bearish = items.filter((i) => i.conclusion === "bearish");
    const meanOf = (list: AnalystCalibrationInput[]): number | null =>
      list.length === 0 ? null : list.reduce((sum, i) => sum + i.forwardReturnPct!, 0) / list.length;
    const bullishMean = meanOf(bullish);
    const bearishMean = meanOf(bearish);
    return {
      analyst,
      sample,
      hits,
      hitRate: roundTo(hits / sample, 4),
      meanForwardReturnPct: roundTo(mean, 6),
      directionalEdgePct:
        bullishMean === null || bearishMean === null ? null : roundTo(bullishMean - bearishMean, 6),
    };
  });
}

export interface PerformanceContextInput {
  /** NAV per unit over the recent snapshots, oldest first. */
  navSeries: { asOf: string; navPerUnit: number }[];
  /** Benchmark index levels over the same window, oldest first (may be shorter). */
  benchmarkSeries: number[];
  /** Attribution per agent over the scoring window. */
  scorecards: readonly AgentScorecard[];
  /** Attribution of the whole window (sum of decision contributions). */
  windowContribution: number;
}

export interface PerformanceContext {
  sessions: number;
  /** NAV change over the window, as a fraction. */
  navChangePct: number | null;
  /** Benchmark change over the same window, as a fraction. */
  benchmarkChangePct: number | null;
  /** navChange − benchmarkChange, in percentage points. */
  alphaPct: number | null;
  worstDrawdownPct: number | null;
  windowContribution: number;
  scorecards: { agentId: string; agentName: string; acceptanceRate: number; contribution: number; positive: boolean }[];
}

/** The compact "how have we been doing?" block handed to the committee. */
export function buildPerformanceContext(input: PerformanceContextInput): PerformanceContext {
  const navs = input.navSeries.map((s) => s.navPerUnit).filter((n) => n > 0);
  const navChangePct =
    navs.length >= 2 && navs[0]! > 0 ? roundTo(navs.at(-1)! / navs[0]! - 1, 6) : null;
  const bench = input.benchmarkSeries.filter((b) => b > 0);
  const benchmarkChangePct =
    bench.length >= 2 && bench[0]! > 0 ? roundTo(bench.at(-1)! / bench[0]! - 1, 6) : null;

  let peak = navs.length > 0 ? navs[0]! : 0;
  let worst = 0;
  for (const nav of navs) {
    if (nav > peak) peak = nav;
    if (peak > 0) {
      const dd = nav / peak - 1;
      if (dd < worst) worst = dd;
    }
  }

  return {
    sessions: navs.length,
    navChangePct,
    benchmarkChangePct,
    alphaPct:
      navChangePct === null || benchmarkChangePct === null
        ? null
        : roundTo((navChangePct - benchmarkChangePct) * 100, 4),
    worstDrawdownPct: navs.length >= 2 ? roundTo(worst, 6) : null,
    windowContribution: roundValue(input.windowContribution),
    scorecards: input.scorecards.map((s) => ({
      agentId: s.agentId,
      agentName: s.agentName,
      acceptanceRate: s.acceptanceRate,
      contribution: s.contribution,
      positive: s.positive,
    })),
  };
}

/** Portfolio weights attributed to one decision, for the stored row. */
export function decisionWeightDelta(orderValue: number, nav: number): number {
  return nav > 0 ? roundTo(orderValue / nav, WEIGHT_DP) : 0;
}
