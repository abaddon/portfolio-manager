import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { AllocationTarget, AllocationTargetUpdate } from "../../domain/portfolio.js";
import type { AllocationTargetRepository } from "../../application/ports.js";

/** SQLite adapter for the evolving allocation targets (allocation review). */
export class SqliteAllocationTargetRepository implements AllocationTargetRepository {
  private readonly insert: StatementSync;
  private readonly currentStmt: StatementSync;
  private readonly recentStmt: StatementSync;

  constructor(private readonly db: DatabaseSync) {
    this.insert = db.prepare(
      `INSERT OR REPLACE INTO allocation_targets
       (id, run_id, ticker, weight, original_weight, rationale, conviction, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.currentStmt = db.prepare(
      `SELECT * FROM allocation_targets a
       WHERE updated_at = (SELECT MAX(updated_at) FROM allocation_targets b WHERE b.ticker = a.ticker)`,
    );
    this.recentStmt = db.prepare(
      "SELECT * FROM allocation_targets ORDER BY updated_at DESC, id DESC LIMIT ?",
    );
  }

  async saveUpdates(updates: AllocationTargetUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    this.db.exec("BEGIN");
    try {
      for (const u of updates) {
        this.insert.run(u.id, u.runId, u.ticker, u.weight, u.originalWeight, u.rationale, u.conviction, u.updatedAt);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async current(): Promise<AllocationTarget[]> {
    return (this.currentStmt.all() as Record<string, unknown>[]).map((r) => ({
      ticker: String(r.ticker),
      weight: Number(r.weight),
    }));
  }

  async recentUpdates(limit = 20): Promise<AllocationTargetUpdate[]> {
    return (this.recentStmt.all(limit) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      runId: String(r.run_id),
      ticker: String(r.ticker),
      weight: Number(r.weight),
      originalWeight: Number(r.original_weight),
      rationale: String(r.rationale),
      conviction: Number(r.conviction),
      updatedAt: String(r.updated_at),
    }));
  }
}
