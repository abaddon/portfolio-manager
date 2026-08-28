import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { CommitteeRepository } from "../../application/ports.js";
import type {
  CommitteeFeedback,
  CommitteeProposal,
  CommitteeProposalStatus,
  CommitteeSession,
  CommitteeSessionDetail,
  CommitteeVote,
} from "../../domain/committee.js";
import { json } from "./repositories.js";

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** SQLite adapter for the Asset Allocation Committee audit trail. */
export class SqliteCommitteeRepository implements CommitteeRepository {
  private readonly sessionUpsert: StatementSync;
  private readonly proposalUpsert: StatementSync;
  private readonly feedbackInsert: StatementSync;
  private readonly voteInsert: StatementSync;
  private readonly latestSessionStmt: StatementSync;
  private readonly sessionStmt: StatementSync;
  private readonly byRunStmt: StatementSync;
  private readonly proposalsStmt: StatementSync;
  private readonly feedbackStmt: StatementSync;
  private readonly votesStmt: StatementSync;

  constructor(private readonly db: DatabaseSync) {
    this.sessionUpsert = db.prepare(
      `INSERT INTO committee_sessions
       (id, run_id, status, round, winner_proposal_id, error, created_at, completed_at, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, round=excluded.round,
         winner_proposal_id=excluded.winner_proposal_id, error=excluded.error,
         completed_at=excluded.completed_at, details_json=excluded.details_json`,
    );
    this.proposalUpsert = db.prepare(
      `INSERT INTO committee_proposals
       (id, session_id, agent_id, agent_name, agent_model, title, rationale, confidence,
        targets_json, orders_json, points, status, excluded_round, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET points=excluded.points, status=excluded.status,
         excluded_round=excluded.excluded_round`,
    );
    this.feedbackInsert = db.prepare(
      `INSERT OR REPLACE INTO committee_feedback
       (id, session_id, proposal_id, reviewer_agent_id, reviewer_agent_name, verdict, comment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.voteInsert = db.prepare(
      `INSERT OR REPLACE INTO committee_votes
       (id, session_id, vote_round, voter_agent_id, voter_agent_name, proposal_id, points, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.latestSessionStmt = db.prepare("SELECT * FROM committee_sessions ORDER BY created_at DESC LIMIT 1");
    this.sessionStmt = db.prepare("SELECT * FROM committee_sessions WHERE id = ?");
    this.byRunStmt = db.prepare("SELECT * FROM committee_sessions WHERE run_id = ? ORDER BY created_at DESC");
    this.proposalsStmt = db.prepare("SELECT * FROM committee_proposals WHERE session_id = ? ORDER BY created_at");
    this.feedbackStmt = db.prepare("SELECT * FROM committee_feedback WHERE session_id = ? ORDER BY created_at");
    this.votesStmt = db.prepare("SELECT * FROM committee_votes WHERE session_id = ? ORDER BY vote_round, created_at");
  }

  async saveSession(session: CommitteeSession): Promise<void> {
    this.sessionUpsert.run(
      session.id,
      session.runId,
      session.status,
      session.round,
      session.winnerProposalId,
      session.error,
      session.createdAt,
      session.completedAt,
      json(session.details),
    );
  }

  async saveProposals(proposals: CommitteeProposal[]): Promise<void> {
    if (proposals.length === 0) return;
    this.db.exec("BEGIN");
    try {
      for (const p of proposals) this.upsertProposal(p);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private upsertProposal(p: CommitteeProposal): void {
    this.proposalUpsert.run(
      p.id,
      p.sessionId,
      p.agentId,
      p.agentName,
      p.agentModel,
      p.title,
      p.rationale,
      p.confidence,
      json(p.targets),
      json(p.orders),
      p.points,
      p.status,
      p.excludedRound,
      p.createdAt,
    );
  }

  async saveFeedback(items: CommitteeFeedback[]): Promise<void> {
    if (items.length === 0) return;
    this.db.exec("BEGIN");
    try {
      for (const f of items) {
        this.feedbackInsert.run(
          f.id,
          f.sessionId,
          f.proposalId,
          f.reviewerAgentId,
          f.reviewerAgentName,
          f.verdict,
          f.comment,
          f.createdAt,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async saveVotes(votes: CommitteeVote[]): Promise<void> {
    if (votes.length === 0) return;
    this.db.exec("BEGIN");
    try {
      for (const v of votes) {
        this.voteInsert.run(
          v.id,
          v.sessionId,
          v.round,
          v.voterAgentId,
          v.voterAgentName,
          v.proposalId,
          v.points,
          v.createdAt,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async latestSession(): Promise<CommitteeSession | null> {
    const row = this.latestSessionStmt.get() as Record<string, unknown> | undefined;
    return row ? rowToSession(row) : null;
  }

  async detail(sessionId: string): Promise<CommitteeSessionDetail> {
    const sessionRow = this.sessionStmt.get(sessionId) as Record<string, unknown> | undefined;
    if (!sessionRow) throw new Error(`committee session ${sessionId} not found`);
    return {
      session: rowToSession(sessionRow),
      proposals: (this.proposalsStmt.all(sessionId) as Record<string, unknown>[]).map(rowToProposal),
      feedback: (this.feedbackStmt.all(sessionId) as Record<string, unknown>[]).map(rowToFeedback),
      votes: (this.votesStmt.all(sessionId) as Record<string, unknown>[]).map(rowToVote),
    };
  }

  async byRun(runId: string): Promise<CommitteeSession[]> {
    return (this.byRunStmt.all(runId) as Record<string, unknown>[]).map(rowToSession);
  }
}

function rowToSession(row: Record<string, unknown>): CommitteeSession {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    status: String(row.status) as CommitteeSession["status"],
    round: Number(row.round),
    winnerProposalId: row.winner_proposal_id ? String(row.winner_proposal_id) : null,
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    details: parseJson<Record<string, unknown>>(String(row.details_json), {}),
  };
}

function rowToProposal(row: Record<string, unknown>): CommitteeProposal {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    agentId: String(row.agent_id),
    agentName: String(row.agent_name),
    agentModel: String(row.agent_model),
    title: String(row.title),
    rationale: String(row.rationale),
    confidence: Number(row.confidence),
    targets: parseJson<CommitteeProposal["targets"]>(String(row.targets_json), []),
    orders: parseJson<CommitteeProposal["orders"]>(String(row.orders_json), []),
    points: Number(row.points),
    status: String(row.status) as CommitteeProposalStatus,
    excludedRound: row.excluded_round === null || row.excluded_round === undefined ? null : Number(row.excluded_round),
    createdAt: String(row.created_at),
  };
}

function rowToFeedback(row: Record<string, unknown>): CommitteeFeedback {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    proposalId: String(row.proposal_id),
    reviewerAgentId: String(row.reviewer_agent_id),
    reviewerAgentName: String(row.reviewer_agent_name),
    verdict: String(row.verdict) as CommitteeFeedback["verdict"],
    comment: String(row.comment),
    createdAt: String(row.created_at),
  };
}

function rowToVote(row: Record<string, unknown>): CommitteeVote {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    round: Number(row.vote_round),
    voterAgentId: String(row.voter_agent_id),
    voterAgentName: String(row.voter_agent_name),
    proposalId: String(row.proposal_id),
    points: Number(row.points),
    createdAt: String(row.created_at),
  };
}
