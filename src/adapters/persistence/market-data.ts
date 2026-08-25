import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { MarketSnapshot, NewsItem, SentimentScore } from "../../domain/analysis.js";
import type { MarketDataRepository } from "../../application/ports.js";
import { json } from "./repositories.js";

/** SQLite adapter for the raw market inputs (quotes, news, sentiment). */
export class SqliteMarketDataRepository implements MarketDataRepository {
  private readonly insertSnapshot: StatementSync;
  private readonly insertNews: StatementSync;
  private readonly insertSentiment: StatementSync;
  private readonly snapshotsByTickerStmt: StatementSync;
  private readonly latestNewsStmt: StatementSync;
  private readonly latestSentimentStmt: StatementSync;

  constructor(private readonly db: DatabaseSync) {
    this.insertSnapshot = db.prepare(
      `INSERT OR REPLACE INTO market_snapshots
       (id, run_id, ticker, price, currency, prev_close, change_pct, volume, as_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertNews = db.prepare(
      `INSERT OR REPLACE INTO news_items
       (id, run_id, ticker, headline, source, url, published_at, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertSentiment = db.prepare(
      `INSERT OR REPLACE INTO sentiment_scores
       (id, run_id, ticker, score, label, source, details_json, as_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.snapshotsByTickerStmt = db.prepare(
      "SELECT * FROM market_snapshots WHERE ticker = ? ORDER BY as_of DESC LIMIT ?",
    );
    this.latestNewsStmt = db.prepare(
      "SELECT * FROM news_items ORDER BY published_at DESC LIMIT ?",
    );
    this.latestSentimentStmt = db.prepare(
      "SELECT * FROM sentiment_scores ORDER BY as_of DESC LIMIT ?",
    );
  }

  private tx(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async saveSnapshots(snapshots: { id: string; runId: string; snapshot: MarketSnapshot }[]): Promise<void> {
    if (snapshots.length === 0) return;
    this.tx(() => {
      for (const { id, runId, snapshot: s } of snapshots) {
        this.insertSnapshot.run(id, runId, s.ticker, s.price, s.currency, s.prevClose, s.changePct, s.volume, s.asOf);
      }
    });
  }

  async saveNews(items: { id: string; runId: string; item: NewsItem }[]): Promise<void> {
    if (items.length === 0) return;
    this.tx(() => {
      for (const { id, runId, item: n } of items) {
        this.insertNews.run(id, runId, n.ticker, n.headline, n.source, n.url, n.publishedAt, n.summary);
      }
    });
  }

  async saveSentiment(scores: { id: string; runId: string; score: SentimentScore; asOf: string }[]): Promise<void> {
    if (scores.length === 0) return;
    this.tx(() => {
      for (const { id, runId, score: s, asOf } of scores) {
        this.insertSentiment.run(id, runId, s.ticker, s.score, s.label, s.source, json(s.details), asOf);
      }
    });
  }

  async snapshotsByTicker(ticker: string, limit = 100): Promise<MarketSnapshot[]> {
    return (this.snapshotsByTickerStmt.all(ticker, limit) as Record<string, unknown>[]).map((r) => ({
      ticker: String(r.ticker),
      price: Number(r.price),
      currency: String(r.currency),
      prevClose: r.prev_close === null || r.prev_close === undefined ? null : Number(r.prev_close),
      changePct: r.change_pct === null || r.change_pct === undefined ? null : Number(r.change_pct),
      volume: r.volume === null || r.volume === undefined ? null : Number(r.volume),
      asOf: String(r.as_of),
    }));
  }

  async latestNews(limit = 20): Promise<{ runId: string; item: NewsItem }[]> {
    return (this.latestNewsStmt.all(limit) as Record<string, unknown>[]).map((r) => ({
      runId: String(r.run_id),
      item: {
        id: String(r.id),
        ticker: String(r.ticker),
        headline: String(r.headline),
        source: String(r.source),
        url: r.url ? String(r.url) : null,
        publishedAt: r.published_at ? String(r.published_at) : null,
        summary: r.summary ? String(r.summary) : null,
      },
    }));
  }

  async latestSentiment(limit = 20): Promise<{ runId: string; score: SentimentScore }[]> {
    return (this.latestSentimentStmt.all(limit) as Record<string, unknown>[]).map((r) => ({
      runId: String(r.run_id),
      score: {
        ticker: String(r.ticker),
        score: Number(r.score),
        label: String(r.label) as SentimentScore["label"],
        source: String(r.source),
        details: JSON.parse(String(r.details_json)) as Record<string, unknown>,
      },
    }));
  }
}
