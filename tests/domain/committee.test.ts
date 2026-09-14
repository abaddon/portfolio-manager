import { describe, expect, it } from "vitest";
import {
  castVote,
  coerceChoice,
  positiveFeedbackCounts,
  resolveVoteRound,
  type CommitteeFeedback,
  applyTargetTrustRegion,
} from "../../src/domain/committee.js";

const VOTES = { sessionId: "s1", round: 1, voterAgentId: "a1", voterAgentName: "Agent 1", createdAt: "t" };

describe("castVote", () => {
  it("casts a single 1-point vote for an allowed proposal", () => {
    const vote = castVote({ ...VOTES, proposalId: "p2", proposalIds: ["p2", "p3"] });
    expect(vote).toMatchObject({ voterAgentId: "a1", proposalId: "p2", points: 1, round: 1 });
  });

  it("rejects a vote for a proposal outside the allowed set", () => {
    expect(() => castVote({ ...VOTES, proposalId: "pX", proposalIds: ["p2", "p3"] })).toThrow();
  });
});

describe("coerceChoice", () => {
  it("keeps a valid choice", () => {
    expect(coerceChoice("p3", ["p2", "p3"])).toBe("p3");
  });

  it("falls back to the first allowed id when the choice is invalid or missing", () => {
    expect(coerceChoice("bogus", ["p2", "p3"])).toBe("p2");
    expect(coerceChoice(undefined, ["p2", "p3"])).toBe("p2");
  });
});

describe("positiveFeedbackCounts", () => {
  it("counts positive feedback per proposal", () => {
    const feedback: CommitteeFeedback[] = [
      { id: "f1", sessionId: "s", proposalId: "p1", reviewerAgentId: "a2", reviewerAgentName: "A2", verdict: "positive", comment: "ok", createdAt: "t" },
      { id: "f2", sessionId: "s", proposalId: "p1", reviewerAgentId: "a3", reviewerAgentName: "A3", verdict: "negative", comment: "no", createdAt: "t" },
      { id: "f3", sessionId: "s", proposalId: "p2", reviewerAgentId: "a1", reviewerAgentName: "A1", verdict: "positive", comment: "ok", createdAt: "t" },
    ];
    const counts = positiveFeedbackCounts(feedback);
    expect(counts.get("p1")).toBe(1);
    expect(counts.get("p2")).toBe(1);
    expect(counts.get("p3")).toBeUndefined();
  });
});

const P = (id: string, points: number, positive = 0, createdAt = "2026-08-26T10:00:00Z") => ({
  id,
  points,
  positiveFeedback: positive,
  createdAt,
});

describe("resolveVoteRound", () => {
  it("a unique top scorer wins", () => {
    const res = resolveVoteRound({ activeProposals: [P("a", 9), P("b", 5), P("c", 4)], round: 1, maxRounds: 3 });
    expect(res).toEqual({ kind: "winner", winnerProposalId: "a", fallback: false });
  });

  it("a single active proposal wins without a vote", () => {
    const res = resolveVoteRound({ activeProposals: [P("a", 0)], round: 1, maxRounds: 3 });
    expect(res).toEqual({ kind: "winner", winnerProposalId: "a", fallback: false });
  });

  it("tie before the cap excludes the proposal(s) with the fewest points", () => {
    const res = resolveVoteRound({ activeProposals: [P("a", 9), P("b", 9), P("c", 3)], round: 1, maxRounds: 3 });
    expect(res).toEqual({ kind: "exclude", excludedProposalIds: ["c"] });
  });

  it("all-tied proposals before the cap trigger a plain re-vote", () => {
    const res = resolveVoteRound({ activeProposals: [P("a", 6), P("b", 6)], round: 1, maxRounds: 3 });
    expect(res).toEqual({ kind: "revote" });
  });

  it("a tie at the round cap falls back to most positive feedback", () => {
    const res = resolveVoteRound({ activeProposals: [P("a", 9, 1), P("b", 9, 2)], round: 3, maxRounds: 3 });
    expect(res).toEqual({ kind: "winner", winnerProposalId: "b", fallback: true });
  });

  it("a tie at the cap with equal feedback falls back to the earliest proposal", () => {
    const res = resolveVoteRound({
      activeProposals: [P("late", 9, 1, "2026-08-26T11:00:00Z"), P("early", 9, 1, "2026-08-26T09:00:00Z")],
      round: 3,
      maxRounds: 3,
    });
    expect(res).toEqual({ kind: "winner", winnerProposalId: "early", fallback: true });
  });
});

describe("applyTargetTrustRegion (WP-P1.4)", () => {
  const CFG = { shrinkFactor: 0.4, confidenceWeight: 0.5, maxTurnoverPctPerSession: 0.1, minWeightChange: 0.005 };

  it("moves only part of the way to the proposed weight", () => {
    const { applied } = applyTargetTrustRegion(
      [{ ticker: "MSFT", weight: 0.3, currentWeight: 0.1 }],
      0.8,
      CFG,
    );
    // damp(0.8) = 0.5 + 0.5 × 0.8 = 0.9; 0.4 × 0.9 × 0.2 = 0.072
    const msft = applied[0]!;
    expect(msft.appliedWeight).toBeCloseTo(0.172, 4);
    expect(msft.delta).toBeCloseTo(0.072, 4);
    expect(msft.skipped).toBe(false);
    expect(msft.scaled).toBe(false);
  });

  it("damps with confidence exactly as configured", () => {
    const proposal = [{ ticker: "MSFT", weight: 0.3, currentWeight: 0.1 }];
    const low = applyTargetTrustRegion(proposal, 0.2, CFG).applied[0]!;
    const high = applyTargetTrustRegion(proposal, 0.9, CFG).applied[0]!;
    expect(high.delta).toBeGreaterThan(low.delta);
    // confidenceWeight 0 ignores confidence entirely.
    const flat = { ...CFG, confidenceWeight: 0 };
    expect(applyTargetTrustRegion(proposal, 0.2, flat).applied[0]!.delta).toBeCloseTo(
      applyTargetTrustRegion(proposal, 0.9, flat).applied[0]!.delta,
      6,
    );
    // A zero-confidence winner moves nothing.
    expect(applyTargetTrustRegion(proposal, 0, { ...CFG, confidenceWeight: 1 }).applied[0]!.delta).toBe(0);
  });

  it("shrinkFactor 0 freezes the allocation and 1 applies the damped request", () => {
    const proposal = [{ ticker: "MSFT", weight: 0.3, currentWeight: 0.1 }];
    // Room to move the full 0.2 so the budget cannot mask the shrink factor.
    const roomy = { ...CFG, maxTurnoverPctPerSession: 1 };
    expect(applyTargetTrustRegion(proposal, 1, { ...roomy, shrinkFactor: 0 }).applied[0]!.appliedWeight).toBe(0.1);
    // k=1, cw=0 → the requested weight, verbatim.
    expect(
      applyTargetTrustRegion(proposal, 1, { ...roomy, shrinkFactor: 1, confidenceWeight: 0 }).applied[0]!.appliedWeight,
    ).toBeCloseTo(0.3, 4);
  });

  it("ignores changes inside the dead zone", () => {
    const { applied, turnover } = applyTargetTrustRegion(
      [{ ticker: "MSFT", weight: 0.101, currentWeight: 0.1 }],
      1,
      { ...CFG, confidenceWeight: 0, trustRegionFactor: 1 } as typeof CFG,
    );
    expect(applied[0]!.skipped).toBe(true);
    expect(applied[0]!.delta).toBe(0);
    expect(applied[0]!.appliedWeight).toBe(0.1);
    expect(turnover).toBe(0);
  });

  it("scales every move down when the session's turnover budget is exceeded", () => {
    const proposals = [
      { ticker: "A", weight: 0.5, currentWeight: 0.2 },
      { ticker: "B", weight: 0.5, currentWeight: 0.2 },
      { ticker: "C", weight: 0.5, currentWeight: 0.2 },
    ];
    const { applied, turnover, scaled } = applyTargetTrustRegion(proposals, 1, {
      ...CFG,
      confidenceWeight: 0,
      maxTurnoverPctPerSession: 0.3,
    });
    expect(scaled).toBe(true);
    expect(turnover).toBeCloseTo(0.3, 4); // the budget, exactly
    for (const a of applied) {
      expect(a.delta).toBeCloseTo(0.1, 4); // 0.3 of the 0.9 wanted, spread evenly
      expect(a.scaled).toBe(true);
    }
  });

  it("leaves moves untouched when they fit the budget", () => {
    const { applied, scaled, turnover } = applyTargetTrustRegion(
      [{ ticker: "A", weight: 0.25, currentWeight: 0.2 }],
      1,
      { ...CFG, confidenceWeight: 0, maxTurnoverPctPerSession: 0.1 },
    );
    expect(scaled).toBe(false);
    expect(applied[0]!.scaled).toBe(false);
    // k=0.4 × a 0.05 request = 0.02, inside the 0.1 budget.
    expect(turnover).toBeCloseTo(0.02, 4);
    expect(applied[0]!.appliedWeight).toBeCloseTo(0.22, 4);
  });

  it("combined dampers: a 5-point one-hour swing becomes a fraction of a point", () => {
    // The observed live behaviour: the winner asks to move AMZN 0.15 → 0.12 and
    // back the next hour, on a 2/1 vote with confidence 0.68.
    const { applied, turnover } = applyTargetTrustRegion([{ ticker: "AMZN", weight: 0.12, currentWeight: 0.15 }], 0.68, CFG);
    // Δ = −0.03, damped by damp(0.68) = 0.5 + 0.5 × 0.68 = 0.84 and by k = 0.4.
    expect(applied[0]!.delta).toBeCloseTo(-0.0101, 4);
    expect(Math.abs(applied[0]!.delta)).toBeLessThan(0.03); // a fraction of the requested 3 points
    expect(turnover).toBeLessThanOrEqual(CFG.maxTurnoverPctPerSession);
  });
});
