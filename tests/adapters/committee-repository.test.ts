import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/adapters/persistence/sqlite.js";
import { SqliteCommitteeRepository } from "../../src/adapters/persistence/committee.js";
import type {
  CommitteeProposal,
  CommitteeSession,
} from "../../src/domain/committee.js";

function session(overrides: Partial<CommitteeSession> = {}): CommitteeSession {
  return {
    id: "s1",
    runId: "run1",
    status: "COMPLETED",
    round: 2,
    winnerProposalId: "p2",
    error: null,
    createdAt: "2026-08-26T14:10:00Z",
    completedAt: "2026-08-26T14:12:00Z",
    details: { agents: ["a1", "a2"] },
    ...overrides,
  };
}

function proposal(overrides: Partial<CommitteeProposal> = {}): CommitteeProposal {
  return {
    id: "p1",
    sessionId: "s1",
    agentId: "a1",
    agentName: "Macro",
    agentModel: "openrouter/m1",
    title: "Defensive",
    rationale: "Defensive allocation.",
    confidence: 0.8,
    targets: [{ ticker: "MSFT", weight: 0.3 }],
    orders: [{ ticker: "AAPL", side: "BUY", value: 250, reason: "add" }],
    points: 3,
    status: "active",
    excludedRound: null,
    createdAt: "2026-08-26T14:10:01Z",
    ...overrides,
  };
}

describe("SqliteCommitteeRepository", () => {
  it("round-trips sessions, proposals, feedback and votes", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteCommitteeRepository(db);

    await repo.saveSession(session());
    await repo.saveProposals([
      proposal({ id: "p1", agentId: "a1" }),
      proposal({ id: "p2", agentId: "a2", agentName: "Momentum", status: "accepted", points: 6 }),
      proposal({ id: "p3", agentId: "a3", status: "excluded", excludedRound: 1, points: 2 }),
    ]);
    await repo.saveFeedback([
      { id: "f1", sessionId: "s1", proposalId: "p2", reviewerAgentId: "a1", reviewerAgentName: "Macro", verdict: "positive", comment: "good", createdAt: "t" },
      { id: "f2", sessionId: "s1", proposalId: "p1", reviewerAgentId: "a2", reviewerAgentName: "Momentum", verdict: "negative", comment: "meh", createdAt: "t" },
    ]);
    await repo.saveVotes([
      { id: "v1", sessionId: "s1", round: 1, voterAgentId: "a1", voterAgentName: "Macro", proposalId: "p2", points: 3, createdAt: "t" },
      { id: "v2", sessionId: "s1", round: 1, voterAgentId: "a1", voterAgentName: "Macro", proposalId: "p3", points: 2, createdAt: "t" },
    ]);

    const latest = await repo.latestSession();
    expect(latest?.id).toBe("s1");
    expect(latest?.winnerProposalId).toBe("p2");

    const detail = await repo.detail("s1");
    expect(detail.proposals).toHaveLength(3);
    expect(detail.proposals.find((p) => p.id === "p2")?.status).toBe("accepted");
    expect(detail.proposals.find((p) => p.id === "p3")?.excludedRound).toBe(1);
    expect(detail.proposals.find((p) => p.id === "p1")?.targets).toEqual([{ ticker: "MSFT", weight: 0.3 }]);
    expect(detail.feedback).toHaveLength(2);
    expect(detail.votes).toHaveLength(2);

    expect(await repo.byRun("run1")).toHaveLength(1);
    expect(await repo.byRun("run2")).toHaveLength(0);
  });

  it("updates points and status on re-save (run-off lifecycle)", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteCommitteeRepository(db);
    await repo.saveSession(session());
    const p = proposal({ id: "p1", status: "active", points: 3 });
    await repo.saveProposals([p]);
    p.points = 7;
    p.status = "excluded";
    p.excludedRound = 1;
    await repo.saveProposals([p]);
    const detail = await repo.detail("s1");
    expect(detail.proposals[0]?.points).toBe(7);
    expect(detail.proposals[0]?.status).toBe("excluded");
    expect(detail.proposals[0]?.excludedRound).toBe(1);
  });
});
