import { describe, expect, it } from "vitest";
import {
  castVote,
  coerceChoice,
  positiveFeedbackCounts,
  resolveVoteRound,
  type CommitteeFeedback,
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
