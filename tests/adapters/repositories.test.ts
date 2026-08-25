import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/adapters/persistence/sqlite.js";
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

  it("recovers stale PENDING orders as FAILED without resubmission", async () => {
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

    const changed = await repo.failStalePending("2026-08-26T14:00:00Z", "interrupted before submission");
    expect(changed).toBe(1);
    expect((await repo.get("ord-stale"))?.status).toBe("FAILED");
    expect((await repo.get("ord-stale"))?.error).toContain("interrupted");
    expect((await repo.get("ord-fresh"))?.status).toBe("PENDING");
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
});
