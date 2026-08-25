import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { DomainEvent } from "../../shared/events.js";
import { AnalysisReport } from "../../domain/analysis.js";
import type { PositionWithValue, PortfolioSnapshot } from "../../domain/portfolio.js";
import type { Decision } from "../../domain/decision.js";
import { Order, type RealizedCost } from "../../domain/execution.js";
import { Run } from "../../domain/run.js";
import type {
  AnalysisRepository,
  DecisionRepository,
  EventRepository,
  OrderRepository,
  PortfolioRepository,
  RunRepository,
  SettingsRepository,
} from "../../application/ports.js";

function json(v: unknown): string {
  return JSON.stringify(v ?? {});
}

export { json };

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function tx(db: DatabaseSync, fn: () => void): void {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export class SqliteRunRepository implements RunRepository {
  private readonly upsert: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly latestStmt: StatementSync;
  private readonly sameHourStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.upsert = db.prepare(
      `INSERT INTO runs (id, started_at, finished_at, status, market_open, error, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET finished_at=excluded.finished_at, status=excluded.status,
         error=excluded.error, details_json=excluded.details_json`,
    );
    this.getStmt = db.prepare("SELECT * FROM runs WHERE id = ?");
    this.latestStmt = db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?");
    this.sameHourStmt = db.prepare(
      "SELECT * FROM runs WHERE substr(started_at, 1, 13) = ? ORDER BY started_at DESC LIMIT 1",
    );
  }

  async save(run: Run): Promise<void> {
    this.upsert.run(run.id, run.startedAt, run.finishedAt, run.status, run.marketOpen ? 1 : 0, run.error, json(run.details));
  }

  async get(id: string): Promise<Run | null> {
    const row = this.getStmt.get(id) as Record<string, unknown> | undefined;
    return row ? rowToRun(row) : null;
  }

  async latest(limit = 20): Promise<Run[]> {
    return (this.latestStmt.all(limit) as Record<string, unknown>[]).map(rowToRun);
  }

  async findSameHour(startedAt: Date): Promise<Run | null> {
    const hour = startedAt.toISOString().slice(0, 13);
    const row = this.sameHourStmt.get(hour) as Record<string, unknown> | undefined;
    return row ? rowToRun(row) : null;
  }
}

function rowToRun(row: Record<string, unknown>): Run {
  return new Run(
    String(row.id),
    String(row.started_at),
    String(row.status) as Run["status"],
    row.finished_at ? String(row.finished_at) : null,
    Boolean(row.market_open),
    row.error ? String(row.error) : null,
    parseJson<Record<string, unknown>>(String(row.details_json), {}),
  );
}

export class SqliteAnalysisRepository implements AnalysisRepository {
  private readonly insert: StatementSync;
  private readonly byRunStmt: StatementSync;
  private readonly byTickerStmt: StatementSync;

  constructor(private readonly db: DatabaseSync) {
    this.insert = db.prepare(
      `INSERT OR REPLACE INTO analysis_reports
       (id, run_id, ticker, analyst, conclusion, confidence, rationale, adjustment, adjustment_confidence, created_at, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.byRunStmt = db.prepare("SELECT * FROM analysis_reports WHERE run_id = ? ORDER BY ticker, analyst");
    this.byTickerStmt = db.prepare(
      "SELECT * FROM analysis_reports WHERE ticker = ? ORDER BY created_at DESC LIMIT ?",
    );
  }

  private run(report: AnalysisReport): void {
    this.insert.run(
      report.id,
      report.runId,
      report.ticker,
      report.analyst,
      report.conclusion,
      report.confidence,
      report.rationale,
      report.signals.targetWeightAdjustment,
      report.signals.confidence,
      report.createdAt,
      json(report.details),
    );
  }

  async save(report: AnalysisReport): Promise<void> {
    this.run(report);
  }

  async saveMany(reports: AnalysisReport[]): Promise<void> {
    tx(this.db, () => reports.forEach((r) => this.run(r)));
  }

  async byRun(runId: string): Promise<AnalysisReport[]> {
    return (this.byRunStmt.all(runId) as Record<string, unknown>[]).map(rowToReport);
  }

  async latestByTicker(ticker: string, limit = 10): Promise<AnalysisReport[]> {
    return (this.byTickerStmt.all(ticker, limit) as Record<string, unknown>[]).map(rowToReport);
  }
}

function rowToReport(row: Record<string, unknown>): AnalysisReport {
  return new AnalysisReport(
    String(row.id),
    String(row.run_id),
    String(row.ticker),
    String(row.analyst) as AnalysisReport["analyst"],
    String(row.conclusion) as AnalysisReport["conclusion"],
    Number(row.confidence),
    String(row.rationale),
    { targetWeightAdjustment: Number(row.adjustment), confidence: Number(row.adjustment_confidence) },
    String(row.created_at),
    parseJson<Record<string, unknown>>(String(row.details_json), {}),
  );
}

export class SqlitePortfolioRepository implements PortfolioRepository {
  private readonly insertSnap: StatementSync;
  private readonly insertPos: StatementSync;
  private readonly latestSnapStmt: StatementSync;
  private readonly positionsStmt: StatementSync;
  private readonly historyStmt: StatementSync;
  private readonly saveNavStmt: StatementSync;
  private readonly latestNavStmt: StatementSync;

  constructor(private readonly db: DatabaseSync) {
    this.insertSnap = db.prepare(
      `INSERT OR REPLACE INTO portfolio_snapshots
       (id, run_id, as_of, currency, cash, total_value, invested_value, day_change_pct, benchmark_change_pct, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertPos = db.prepare(
      `INSERT OR REPLACE INTO position_snapshots
       (id, snapshot_id, ticker, quantity, average_price, current_price, currency, fx_rate,
        market_value_local, market_value, weight, unrealized_pnl, unrealized_pnl_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.latestSnapStmt = db.prepare("SELECT * FROM portfolio_snapshots ORDER BY as_of DESC LIMIT 1");
    this.positionsStmt = db.prepare("SELECT * FROM position_snapshots WHERE snapshot_id = ? ORDER BY ticker");
    this.historyStmt = db.prepare("SELECT * FROM portfolio_snapshots ORDER BY as_of DESC LIMIT ?");
    this.saveNavStmt = db.prepare(
      "UPDATE portfolio_snapshots SET nav_units = ?, nav_per_unit = ? WHERE run_id = ?",
    );
    this.latestNavStmt = db.prepare(
      "SELECT nav_units, nav_per_unit, total_value FROM portfolio_snapshots WHERE nav_per_unit IS NOT NULL ORDER BY as_of DESC LIMIT 1",
    );
  }

  async save(snapshot: PortfolioSnapshot): Promise<void> {
    tx(this.db, () => {
      this.insertSnap.run(
        snapshot.id,
        snapshot.runId,
        snapshot.asOf,
        snapshot.currency,
        snapshot.cash,
        snapshot.totalValue,
        snapshot.investedValue,
        snapshot.dayChangePct,
        snapshot.benchmarkChangePct,
        json({}),
      );
      for (const p of snapshot.positions) {
        this.insertPos.run(
          `${snapshot.id}:${p.ticker}`,
          snapshot.id,
          p.ticker,
          p.quantity,
          p.averagePrice,
          p.currentPrice,
          p.currency,
          p.fxRate ?? 1,
          p.marketValueLocal,
          p.marketValue,
          p.weight,
          p.unrealizedPnl,
          p.unrealizedPnlPct,
        );
      }
    });
  }

  private hydrate(row: Record<string, unknown>): PortfolioSnapshot {
    const positions = (this.positionsStmt.all(String(row.id)) as Record<string, unknown>[]).map((p) => {
      const position: PositionWithValue = {
        ticker: String(p.ticker),
        quantity: Number(p.quantity),
        averagePrice: Number(p.average_price),
        currentPrice: Number(p.current_price),
        currency: String(p.currency),
        fxRate: Number(p.fx_rate),
        marketValueLocal: Number(p.market_value_local),
        marketValue: Number(p.market_value),
        weight: Number(p.weight),
        unrealizedPnl: Number(p.unrealized_pnl),
        unrealizedPnlPct: Number(p.unrealized_pnl_pct),
      };
      return position;
    });
    return {
      id: String(row.id),
      runId: String(row.run_id),
      asOf: String(row.as_of),
      currency: String(row.currency),
      cash: Number(row.cash),
      positions,
      totalValue: Number(row.total_value),
      investedValue: Number(row.invested_value),
      dayChangePct: row.day_change_pct === null || row.day_change_pct === undefined ? null : Number(row.day_change_pct),
      benchmarkChangePct:
        row.benchmark_change_pct === null || row.benchmark_change_pct === undefined ? null : Number(row.benchmark_change_pct),
    };
  }

  async latest(): Promise<PortfolioSnapshot | null> {
    const row = this.latestSnapStmt.get() as Record<string, unknown> | undefined;
    return row ? this.hydrate(row) : null;
  }

  async history(limit = 100): Promise<PortfolioSnapshot[]> {
    return (this.historyStmt.all(limit) as Record<string, unknown>[]).map((r) => this.hydrate(r));
  }

  async saveNav(runId: string, _asOf: string, units: number, navPerUnit: number, _totalValue: number): Promise<void> {
    this.saveNavStmt.run(units, navPerUnit, runId);
  }

  async latestNav(): Promise<{ units: number; navPerUnit: number; totalValue: number } | null> {
    const row = this.latestNavStmt.get() as Record<string, unknown> | undefined;
    if (!row || row.nav_units === null || row.nav_units === undefined) return null;
    return { units: Number(row.nav_units), navPerUnit: Number(row.nav_per_unit), totalValue: Number(row.total_value) };
  }
}

export class SqliteDecisionRepository implements DecisionRepository {
  private readonly insert: StatementSync;
  private readonly byRunStmt: StatementSync;
  private readonly latestStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.insert = db.prepare(
      `INSERT OR REPLACE INTO decisions
       (id, run_id, ticker, action, quantity, estimated_price, estimated_value, expected_benefit,
        cost_total, cost_json, approved, reason, rationale, confidence, decided_at, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.byRunStmt = db.prepare("SELECT * FROM decisions WHERE run_id = ? ORDER BY decided_at");
    this.latestStmt = db.prepare("SELECT * FROM decisions ORDER BY decided_at DESC LIMIT ?");
  }

  async save(decision: Decision): Promise<void> {
    this.insert.run(
      decision.id,
      decision.runId,
      decision.ticker,
      decision.action,
      decision.quantity,
      decision.proposal.estimatedPrice,
      decision.proposal.estimatedValue,
      decision.proposal.expectedBenefit,
      decision.proposal.costEstimate.total,
      json(decision.proposal.costEstimate),
      decision.approved ? 1 : 0,
      decision.reason,
      decision.proposal.rationale,
      decision.proposal.confidence,
      decision.decidedAt,
      json(decision.details),
    );
  }

  async byRun(runId: string): Promise<Decision[]> {
    return (this.byRunStmt.all(runId) as Record<string, unknown>[]).map(rowToDecision);
  }

  async latest(limit = 50): Promise<Decision[]> {
    return (this.latestStmt.all(limit) as Record<string, unknown>[]).map(rowToDecision);
  }
}

function rowToDecision(row: Record<string, unknown>): Decision {
  const costEstimate = parseJson<Decision["proposal"]["costEstimate"]>(String(row.cost_json), {
    currency: "?",
    spread: 0,
    fxFee: 0,
    stampDuty: 0,
    platformFee: 0,
    total: Number(row.cost_total),
  });
  return {
    id: String(row.id),
    runId: String(row.run_id),
    ticker: String(row.ticker),
    action: String(row.action) as Decision["action"],
    quantity: Number(row.quantity),
    approved: Boolean(row.approved),
    reason: String(row.reason) as Decision["reason"],
    proposal: {
      ticker: String(row.ticker),
      action: String(row.action) as Decision["proposal"]["action"],
      quantity: Number(row.quantity),
      estimatedPrice: Number(row.estimated_price),
      estimatedValue: Number(row.estimated_value),
      currency: "?",
      expectedBenefit: Number(row.expected_benefit),
      costEstimate,
      rationale: String(row.rationale),
      confidence: Number(row.confidence),
    },
    decidedAt: String(row.decided_at),
    details: parseJson<Record<string, unknown>>(String(row.details_json), {}),
  };
}

export class SqliteOrderRepository implements OrderRepository {
  private readonly insert: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly byRunStmt: StatementSync;
  private readonly latestStmt: StatementSync;
  private readonly recentStmt: StatementSync;
  private readonly openStmt: StatementSync;
  private readonly stalePendingStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.insert = db.prepare(
      `INSERT OR REPLACE INTO orders
       (id, run_id, decision_id, ticker, side, quantity, type, status, currency, broker_order_id,
        submitted_at, filled_quantity, filled_price_avg, filled_at, realized_cost_json, error, created_at, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getStmt = db.prepare("SELECT * FROM orders WHERE id = ?");
    this.byRunStmt = db.prepare("SELECT * FROM orders WHERE run_id = ? ORDER BY created_at");
    this.latestStmt = db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT ?");
    this.recentStmt = db.prepare(
      "SELECT * FROM orders WHERE ticker = ? AND created_at >= ? AND status IN ('FILLED','PARTIALLY_FILLED','SUBMITTED') ORDER BY created_at DESC",
    );
    this.openStmt = db.prepare(
      "SELECT * FROM orders WHERE status IN ('SUBMITTED','PARTIALLY_FILLED') ORDER BY created_at",
    );
    this.stalePendingStmt = db.prepare(
      "SELECT * FROM orders WHERE status = 'PENDING' AND created_at < ? ORDER BY created_at",
    );
  }

  async save(order: Order): Promise<void> {
    this.insert.run(
      order.id,
      order.runId,
      order.decisionId,
      order.ticker,
      order.side,
      order.quantity,
      order.type,
      order.status,
      order.currency,
      order.brokerOrderId,
      order.submittedAt,
      order.fill?.filledQuantity ?? null,
      order.fill?.filledPriceAvg ?? null,
      order.fill?.filledAt ?? null,
      order.fill ? json(order.fill.realizedCost) : null,
      order.error,
      order.createdAt,
      json(order.details),
    );
  }

  async get(id: string): Promise<Order | null> {
    const row = this.getStmt.get(id) as Record<string, unknown> | undefined;
    return row ? rowToOrder(row) : null;
  }

  async byRun(runId: string): Promise<Order[]> {
    return (this.byRunStmt.all(runId) as Record<string, unknown>[]).map(rowToOrder);
  }

  async latest(limit = 50): Promise<Order[]> {
    return (this.latestStmt.all(limit) as Record<string, unknown>[]).map(rowToOrder);
  }

  async recentByTicker(ticker: string, since: string): Promise<Order[]> {
    return (this.recentStmt.all(ticker, since) as Record<string, unknown>[]).map(rowToOrder);
  }

  async stalePending(beforeIso: string): Promise<Order[]> {
    return (this.stalePendingStmt.all(beforeIso) as Record<string, unknown>[]).map(rowToOrder);
  }

  async openOrders(): Promise<Order[]> {
    return (this.openStmt.all() as Record<string, unknown>[]).map(rowToOrder);
  }
}

function rowToOrder(row: Record<string, unknown>): Order {
  const fill = row.filled_at
    ? {
        filledQuantity: Number(row.filled_quantity),
        filledPriceAvg: Number(row.filled_price_avg),
        currency: String(row.currency),
        filledAt: String(row.filled_at),
        realizedCost: parseJson<RealizedCost>(String(row.realized_cost_json), {
          spread: 0,
          fxFee: 0,
          stampDuty: 0,
          platformFee: 0,
          total: 0,
        }),
      }
    : null;
  return new Order(
    String(row.id),
    String(row.run_id),
    row.decision_id ? String(row.decision_id) : null,
    String(row.ticker),
    String(row.side) as Order["side"],
    Number(row.quantity),
    String(row.type) as Order["type"],
    String(row.currency),
    String(row.status) as Order["status"],
    row.broker_order_id ? String(row.broker_order_id) : null,
    fill,
    row.submitted_at ? String(row.submitted_at) : null,
    row.error ? String(row.error) : null,
    String(row.created_at),
    parseJson<Record<string, unknown>>(String(row.details_json), {}),
  );
}

export class SqliteEventRepository implements EventRepository {
  private readonly insert: StatementSync;
  private readonly byRunStmt: StatementSync;
  private readonly recentStmt: StatementSync;

  constructor(private readonly db: DatabaseSync) {
    this.insert = db.prepare("INSERT OR REPLACE INTO events (id, run_id, type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)");
    this.byRunStmt = db.prepare("SELECT * FROM events WHERE run_id = ? ORDER BY occurred_at");
    this.recentStmt = db.prepare("SELECT * FROM events ORDER BY occurred_at DESC LIMIT ?");
  }

  async append(events: DomainEvent[]): Promise<void> {
    tx(this.db, () => {
      for (const e of events) this.insert.run(e.id, e.runId, e.type, json(e.payload), e.occurredAt);
    });
  }

  async byRun(runId: string): Promise<DomainEvent[]> {
    return (this.byRunStmt.all(runId) as Record<string, unknown>[]).map(rowToEvent);
  }

  async recent(limit = 100): Promise<DomainEvent[]> {
    return (this.recentStmt.all(limit) as Record<string, unknown>[]).map(rowToEvent);
  }
}

function rowToEvent(row: Record<string, unknown>): DomainEvent {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    type: String(row.type),
    payload: parseJson<Record<string, unknown>>(String(row.payload_json), {}),
    occurredAt: String(row.occurred_at),
  };
}

export class SqliteSettingsRepository implements SettingsRepository {
  private readonly getStmt: StatementSync;
  private readonly setStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.getStmt = db.prepare("SELECT value_json FROM settings WHERE key = ?");
    this.setStmt = db.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)");
  }

  async get(key: string): Promise<unknown | null> {
    const row = this.getStmt.get(key) as Record<string, unknown> | undefined;
    return row ? parseJson<unknown>(String(row.value_json), null) : null;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.setStmt.run(key, json(value));
  }
}
