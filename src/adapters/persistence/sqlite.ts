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
  benchmark_change_pct REAL,
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

CREATE TABLE IF NOT EXISTS market_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  price REAL NOT NULL,
  currency TEXT NOT NULL,
  prev_close REAL,
  change_pct REAL,
  volume REAL,
  as_of TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_run ON market_snapshots(run_id);
CREATE INDEX IF NOT EXISTS idx_market_ticker ON market_snapshots(ticker, as_of);

CREATE TABLE IF NOT EXISTS news_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  headline TEXT NOT NULL,
  source TEXT NOT NULL,
  url TEXT,
  published_at TEXT,
  summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_news_run ON news_items(run_id);
CREATE INDEX IF NOT EXISTS idx_news_ticker ON news_items(ticker, published_at);

CREATE TABLE IF NOT EXISTS sentiment_scores (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  score REAL NOT NULL,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  as_of TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sentiment_run ON sentiment_scores(run_id);
CREATE INDEX IF NOT EXISTS idx_sentiment_ticker ON sentiment_scores(ticker, as_of);

CREATE TABLE IF NOT EXISTS allocation_targets (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  weight REAL NOT NULL,
  original_weight REAL NOT NULL,
  rationale TEXT NOT NULL,
  conviction REAL NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_targets_ticker ON allocation_targets(ticker, updated_at);

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

  // Migration v2: benchmark column on portfolio_snapshots (pre-existing DBs).
  const hasBenchmarkColumn = db
    .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('portfolio_snapshots') WHERE name = 'benchmark_change_pct'")
    .get() as { n: number };
  if (hasBenchmarkColumn.n === 0) {
    db.exec("ALTER TABLE portfolio_snapshots ADD COLUMN benchmark_change_pct REAL");
  }

  // Migration v5: deduplicate news items — per-run persistence created one row
  // per article per run. DELETE FIRST (the unique index cannot be created
  // while duplicates exist), then enforce uniqueness at insert time.
  try {
    db.exec("DELETE FROM news_items WHERE id NOT IN (SELECT MIN(id) FROM news_items GROUP BY ticker, headline, source);");
  } catch {
    // tolerate anything; the dedupe is best-effort
  }
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_news_unique ON news_items(ticker, headline, source);");
  } catch {
    // already exists or dedupe failed — INSERT OR IGNORE still prevents dupes
  }

  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(new Date().toISOString());
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)").run(new Date().toISOString());
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, ?)").run(new Date().toISOString());
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, ?)").run(new Date().toISOString());
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (5, ?)").run(new Date().toISOString());
  return db;
}
