import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  market_open INTEGER NOT NULL,
  error TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at);

CREATE TABLE IF NOT EXISTS analysis_reports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  analyst TEXT NOT NULL,
  conclusion TEXT NOT NULL,
  confidence REAL NOT NULL,
  rationale TEXT NOT NULL,
  adjustment REAL NOT NULL,
  adjustment_confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_analysis_run ON analysis_reports(run_id);
CREATE INDEX IF NOT EXISTS idx_analysis_ticker ON analysis_reports(ticker, created_at);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  as_of TEXT NOT NULL,
  currency TEXT NOT NULL,
  cash REAL NOT NULL,
  total_value REAL NOT NULL,
  invested_value REAL NOT NULL,
  day_change_pct REAL,
  nav_units REAL,
  nav_per_unit REAL,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_snapshots_asof ON portfolio_snapshots(as_of);

CREATE TABLE IF NOT EXISTS position_snapshots (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  quantity REAL NOT NULL,
  average_price REAL NOT NULL,
  current_price REAL NOT NULL,
  currency TEXT NOT NULL,
  fx_rate REAL NOT NULL DEFAULT 1,
  market_value_local REAL NOT NULL,
  market_value REAL NOT NULL,
  weight REAL NOT NULL,
  unrealized_pnl REAL NOT NULL,
  unrealized_pnl_pct REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_positions_snapshot ON position_snapshots(snapshot_id);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  action TEXT NOT NULL,
  quantity REAL NOT NULL,
  estimated_price REAL NOT NULL,
  estimated_value REAL NOT NULL,
  expected_benefit REAL NOT NULL,
  cost_total REAL NOT NULL,
  cost_json TEXT NOT NULL DEFAULT '{}',
  approved INTEGER NOT NULL,
  reason TEXT NOT NULL,
  rationale TEXT NOT NULL,
  confidence REAL NOT NULL,
  decided_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_decisions_run ON decisions(run_id);
CREATE INDEX IF NOT EXISTS idx_decisions_decided ON decisions(decided_at);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  decision_id TEXT,
  ticker TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity REAL NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  currency TEXT NOT NULL,
  broker_order_id TEXT,
  submitted_at TEXT,
  filled_quantity REAL,
  filled_price_avg REAL,
  filled_at TEXT,
  realized_cost_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_orders_run ON orders(run_id);
CREATE INDEX IF NOT EXISTS idx_orders_ticker ON orders(ticker, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(new Date().toISOString());
  return db;
}
