import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/adapters/persistence/sqlite.js";
import { SqliteMarketDataRepository } from "../../src/adapters/persistence/market-data.js";
import {
  SqliteAnalysisRepository,
  SqliteDecisionRepository,
  SqliteEventRepository,
  SqliteOrderRepository,
  SqlitePortfolioRepository,
  SqliteRunRepository,
} from "../../src/adapters/persistence/repositories.js";
import { Run } from "../../src/domain/run.js";
import { AnalysisReport } from "../../src/domain/analysis.js";
import { Order } from "../../src/domain/execution.js";
import { buildPortfolioSnapshot } from "../../src/domain/portfolio.js";

describe("SQLite repositories (contract tests)", () => {
  it("persists runs and finds the run of the same hour", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteRunRepository(db);
    const run = Run.start("r1", "2026-08-26T14:00:00Z", true);
    run.complete("2026-08-26T14:05:00Z", { reports: 8 });
    await repo.save(run);

    expect(await repo.get("r1")).toMatchObject({ id: "r1", status: "COMPLETED" });
    expect(await repo.findSameHour(new Date("2026-08-26T14:59:00Z"))).toMatchObject({ id: "r1" });
    expect(await repo.findSameHour(new Date("2026-08-26T15:00:00Z"))).toBeNull();
    db.close();
  });

  it("round-trips analysis reports", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteAnalysisRepository(db);
    const r = new AnalysisReport(
      "an1",
      "run1",
      "MSFT",
      "market",
      "bullish",
      0.8,
      "strong uptrend",
      { targetWeightAdjustment: 0.03, confidence: 0.7 },
      "2026-08-26T14:01:00Z",
      { engine: "offline" },
    );
    await repo.save(r);
    const byRun = await repo.byRun("run1");
    expect(byRun).toHaveLength(1);
    expect(byRun[0]).toMatchObject({ id: "an1", ticker: "MSFT", analyst: "market", conclusion: "bullish" });
    expect(byRun[0]!.signals.targetWeightAdjustment).toBeCloseTo(0.03, 6);
    const byTicker = await repo.latestByTicker("MSFT");
    expect(byTicker).toHaveLength(1);
    db.close();
  });

  it("round-trips portfolio snapshots with positions and NAV", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqlitePortfolioRepository(db);
    const snap = buildPortfolioSnapshot({
      id: "snap1",
      runId: "run1",
      asOf: "2026-08-26T14:02:00Z",
      currency: "GBP",
      cash: 1000,
      positions: [{ ticker: "MSFT", quantity: 2, averagePrice: 400, currentPrice: 420, currency: "USD", fxRate: 0.79 }],
      prevTotalValue: null,
      benchmarkChangePct: 0.35,
    });
    await repo.save(snap);
    await repo.saveNav("run1", "2026-08-26T14:02:00Z", 1000, 1.6636, snap.totalValue);

    const latest = await repo.latest();
    expect(latest?.totalValue).toBeCloseTo(snap.totalValue, 2);
    expect(latest?.positions).toHaveLength(1);
    expect(latest?.positions[0]?.marketValue).toBeCloseTo(663.6, 2);
    expect(latest?.benchmarkChangePct).toBeCloseTo(0.35, 2);
    expect((await repo.latestNav())?.navPerUnit).toBeCloseTo(1.6636, 4);
    expect(await repo.history(10)).toHaveLength(1);
    db.close();
  });

  it("round-trips decisions with cost estimates", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteDecisionRepository(db);
    const decision = {
      id: "dec1",
      runId: "run1",
      ticker: "AAPL",
      action: "BUY" as const,
      quantity: 5,
      approved: true,
      reason: "ECONOMICALLY_VIABLE" as const,
      proposal: {
        ticker: "AAPL",
        action: "BUY" as const,
        quantity: 5,
        estimatedPrice: 200,
        estimatedValue: 1000,
        currency: "USD",
        expectedBenefit: 8,
        costEstimate: { currency: "GBP", spread: 0.2, fxFee: 1.5, stampDuty: 0, platformFee: 0, total: 1.7 },
        rationale: "drift repair",
        confidence: 0.7,
      },
      decidedAt: "2026-08-26T14:03:00Z",
      details: { drift: -0.3 },
    };
    await repo.save(decision);
    const byRun = await repo.byRun("run1");
    expect(byRun).toHaveLength(1);
    expect(byRun[0]?.reason).toBe("ECONOMICALLY_VIABLE");
    expect(byRun[0]?.proposal.costEstimate.total).toBeCloseTo(1.7, 2);
    expect((await repo.latest(5))[0]?.ticker).toBe("AAPL");
    db.close();
  });

  it("round-trips the order lifecycle and serves cooldown queries", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteOrderRepository(db);
    const order = Order.create({
      id: "ord1",
      runId: "run1",
      decisionId: "dec1",
      ticker: "AAPL",
      side: "BUY",
      quantity: 5,
      type: "MARKET",
      currency: "USD",
      createdAt: "2026-08-26T14:04:00Z",
    });
    await repo.save(order);
    order.markSubmitted("b-9", "2026-08-26T14:04:01Z");
    order.markFilled({
      filledQuantity: 5,
      filledPriceAvg: 201,
      currency: "USD",
      filledAt: "2026-08-26T14:04:02Z",
      realizedCost: { spread: 0.2, fxFee: 1.51, stampDuty: 0, platformFee: 0, total: 1.71 },
    });
    await repo.save(order);

    const loaded = await repo.get("ord1");
    expect(loaded?.status).toBe("FILLED");
    expect(loaded?.fill?.filledPriceAvg).toBe(201);
    expect(loaded?.fill?.realizedCost.total).toBeCloseTo(1.71, 2);
    expect(await repo.byRun("run1")).toHaveLength(1);
    expect(await repo.recentByTicker("AAPL", "2026-08-26T14:00:00Z")).toHaveLength(1);
    expect(await repo.recentByTicker("AAPL", "2026-08-27T00:00:00Z")).toHaveLength(0);
    expect(await repo.recentByTicker("MSFT", "2026-08-26T00:00:00Z")).toHaveLength(0);
    db.close();
  });

  it("lists stale PENDING orders for crash reconciliation", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteOrderRepository(db);
    const stale = Order.create({
      id: "ord-stale",
      runId: "run0",
      decisionId: "dec0",
      ticker: "AAPL",
      side: "BUY",
      quantity: 1,
      type: "MARKET",
      currency: "USD",
      createdAt: "2026-08-26T12:00:00Z",
    });
    const fresh = Order.create({
      id: "ord-fresh",
      runId: "run1",
      decisionId: "dec1",
      ticker: "MSFT",
      side: "BUY",
      quantity: 1,
      type: "MARKET",
      currency: "USD",
      createdAt: "2026-08-26T14:30:00Z",
    });
    await repo.save(stale);
    await repo.save(fresh);

    const staleList = await repo.stalePending("2026-08-26T14:00:00Z");
    expect(staleList.map((o) => o.id)).toEqual(["ord-stale"]);
    db.close();
  });

  it("deduplicates news at save time and in the display view", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteMarketDataRepository(db);
    const article = (id: string, runId: string, ticker: string) => ({
      id,
      runId,
      item: { id, ticker, headline: "Same syndicated headline", source: "ChartMill", url: null, publishedAt: "2026-08-26T12:00:00Z", summary: null },
    });
    // Same article seen by two runs for the same ticker → stored once (first seen).
    await repo.saveNews([article("n1", "run1", "MSFT")]);
    await repo.saveNews([article("n2", "run2", "MSFT")]);
    // Same article syndicated for other tickers → stored per ticker, but the
    // display view dedupes across tickers.
    await repo.saveNews([article("n3", "run1", "AAPL"), article("n4", "run1", "NVDA")]);

    const count = (db.prepare("SELECT COUNT(*) AS c FROM news_items").get() as { c: number }).c;
    expect(count).toBe(3); // MSFT stored once (INSERT OR IGNORE), AAPL + NVDA rows kept
    const latest = await repo.latestNews(10);
    expect(latest).toHaveLength(1); // display dedupes the syndicated headline
    expect(latest[0]?.item.ticker).toBe("MSFT"); // first-seen row wins
    db.close();
  });

  it("persists events in insertion order", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteEventRepository(db);
    await repo.append([
      { id: "e1", runId: "run1", type: "PipelineStarted", payload: {}, occurredAt: "2026-08-26T14:00:00Z" },
      { id: "e2", runId: "run1", type: "PipelineCompleted", payload: { x: 1 }, occurredAt: "2026-08-26T14:05:00Z" },
    ]);
    const byRun = await repo.byRun("run1");
    expect(byRun.map((e) => e.type)).toEqual(["PipelineStarted", "PipelineCompleted"]);
    expect((await repo.recent(1))[0]?.type).toBe("PipelineCompleted");
    db.close();
  });

  it("round-trips market snapshots, news and sentiment per run", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteMarketDataRepository(db);
    await repo.saveSnapshots([
      {
        id: "ms1",
        runId: "run1",
        snapshot: { ticker: "MSFT", price: 420, currency: "USD", prevClose: 415, changePct: 1.2, volume: 1e6, asOf: "2026-08-26T14:00:00Z" },
      },
    ]);
    await repo.saveNews([
      { id: "n1", runId: "run1", item: { id: "n1", ticker: "MSFT", headline: "MSFT beats", source: "demo", url: null, publishedAt: "2026-08-26T12:00:00Z", summary: null } },
    ]);
    await repo.saveSentiment([
      { id: "s1", runId: "run1", score: { ticker: "MSFT", score: 0.4, label: "positive", source: "demo", details: {} }, asOf: "2026-08-26T14:00:00Z" },
    ]);

    const snapshots = await repo.snapshotsByTicker("MSFT");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.price).toBe(420);
    expect(snapshots[0]?.changePct).toBeCloseTo(1.2, 6);
    const news = await repo.latestNews();
    expect(news).toHaveLength(1);
    expect(news[0]?.item.headline).toBe("MSFT beats");
    expect(news[0]?.runId).toBe("run1");
    const sentiment = await repo.latestSentiment();
    expect(sentiment[0]?.score).toMatchObject({ ticker: "MSFT", score: 0.4, label: "positive" });
    db.close();
  });
});
