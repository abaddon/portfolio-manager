import { describe, expect, it } from "vitest";
import {
  coerceRanking,
  positiveFeedbackCounts,
  rankVotes,
  resolveVoteRound,
  type CommitteeFeedback,
} from "../../src/domain/committee.js";

const VOTES = { sessionId: "s1", round: 1, voterAgentId: "a1", voterAgentName: "Agent 1", createdAt: "t" };

describe("rankVotes", () => {
  it("assigns descending points: top pick gets k, last gets 1", () => {
    const votes = rankVotes({ ...VOTES, ranking: ["p2", "p3", "p4"], proposalIds: ["p2", "p3", "p4"] });
    expect(votes.map((v) => [v.proposalId, v.points])).toEqual([
      ["p2", 3],
      ["p3", 2],
      ["p4", 1],
    ]);
  });

  it("rejects a ranking that is not a permutation", () => {
    expect(() => rankVotes({ ...VOTES, ranking: ["p2", "p2"], proposalIds: ["p2", "p3"] })).toThrow();
    expect(() => rankVotes({ ...VOTES, ranking: ["p2", "pX"], proposalIds: ["p2", "p3"] })).toThrow();
  });
});

describe("coerceRanking", () => {
  it("keeps the given order, drops unknown/duplicate ids, appends missing ones", () => {
    expect(coerceRanking(["pX", "p2", "p2"], ["p2", "p3"])).toEqual(["p2", "p3"]);
    expect(coerceRanking(["p3"], ["p2", "p3"])).toEqual(["p3", "p2"]);
    expect(coerceRanking([], ["p2"])).toEqual(["p2"]);
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
