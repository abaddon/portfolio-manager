import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { buildWebServer } from "../../src/adapters/web/server.js";
import { loadConfig } from "../../src/config.js";
import { NullLogger } from "../../src/shared/logger.js";
import type { AppPorts } from "../../src/application/ports.js";
import { Run } from "../../src/domain/run.js";

const CONFIG = loadConfig({ configPath: resolve(process.cwd(), "tests/fixtures/test-config.json") }).config;

function makePorts(): AppPorts {
  return {
    clock: { now: () => new Date() },
    logger: new NullLogger(),
    events: { publish: () => {} },
    calendar: { isOpen: () => true },
    llm: { available: () => false, chat: async () => "", chatJson: async <T,>(): Promise<T> => ({}) as T },
    prices: { quote: async () => ({ ticker: "X", price: 1, currency: "USD", prevClose: null, changePct: null, volume: null, asOf: "x" }), candles: async () => [] },
    news: { latestNews: async () => [] },
    fundamentals: { fundamentals: async () => { throw new Error("n/a"); } },
    sentiment: { sentiment: async () => ({ ticker: "X", score: 0, label: "neutral", source: "x", details: {} }) },
    fx: { rate: async () => 1 },
    broker: { kind: "paper", account: async () => ({ currency: "GBP", cash: 0, totalValue: 0, investedValue: 0 }), positions: async () => [], submitOrder: async () => ({ brokerOrderId: "x", status: "SUBMITTED" }), orderStatus: async () => ({ status: "NEW", filledQuantity: 0, filledPriceAvg: null }) },
    runs: { save: async () => {}, get: async () => null, latest: async () => [], findSameHour: async () => null },
    analysis: { save: async () => {}, saveMany: async () => {}, byRun: async () => [], latestByTicker: async () => [] },
    portfolio: { save: async () => {}, latest: async () => null, history: async () => [], saveNav: async () => {}, latestNav: async () => null },
    decisions: { save: async () => {}, byRun: async () => [], latest: async () => [] },
    orders: { save: async () => {}, get: async () => null, byRun: async () => [], latest: async () => [], recentByTicker: async () => [], openOrders: async () => [], stalePending: async () => [] },
    eventRepo: { append: async () => {}, byRun: async () => [], recent: async () => [] },
    marketData: {
      saveSnapshots: async () => {},
      saveNews: async () => {},
      saveSentiment: async () => {},
      snapshotsByTicker: async () => [],
      latestNews: async () => [],
      latestSentiment: async () => [],
    },
  };
}

function makeRun(status: Run["status"] = "COMPLETED"): Run {
  const run = new Run("run1", "2026-08-26T14:00:00Z", status, status === "RUNNING" ? null : "2026-08-26T14:02:00Z", true, null, {});
  return run;
}

describe("Web server — manual run trigger", () => {
  it("POST /api/run executes the pipeline through the trigger", async () => {
    const trigger = { runOnce: vi.fn(async () => makeRun()) };
    const web = buildWebServer(makePorts(), CONFIG, new NullLogger(), "paper", trigger);
    const res = await web.instance.inject({ method: "POST", url: "/api/run", payload: { force: true } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runId).toBe("run1");
    expect(body.status).toBe("COMPLETED");
    expect(trigger.runOnce).toHaveBeenCalledWith({ force: true, skipHourGuard: true });
    await web.stop();
  });

  it("defaults to force=false when the body omits it", async () => {
    const trigger = { runOnce: vi.fn(async () => makeRun()) };
    const web = buildWebServer(makePorts(), CONFIG, new NullLogger(), "paper", trigger);
    const res = await web.instance.inject({ method: "POST", url: "/api/run", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(trigger.runOnce).toHaveBeenCalledWith({ force: false, skipHourGuard: true });
    await web.stop();
  });

  it("rejects concurrent triggers with 409 while a run is in flight", async () => {
    let release!: (v: Run) => void;
    const trigger = { runOnce: vi.fn(() => new Promise<Run>((r) => (release = r))) };
    const web = buildWebServer(makePorts(), CONFIG, new NullLogger(), "paper", trigger);

    const first = web.instance.inject({ method: "POST", url: "/api/run", payload: { force: true } });
    // Give the in-flight reservation a tick, then fire a second request.
    await new Promise((r) => setTimeout(r, 20));
    const second = await web.instance.inject({ method: "POST", url: "/api/run", payload: { force: true } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toContain("already in progress");

    release(makeRun());
    const firstRes = await first;
    expect(firstRes.statusCode).toBe(200);
    await web.stop();
  });

  it("returns 501 when no trigger is wired", async () => {
    const web = buildWebServer(makePorts(), CONFIG, new NullLogger(), "paper");
    const res = await web.instance.inject({ method: "POST", url: "/api/run", payload: {} });
    expect(res.statusCode).toBe(501);
    await web.stop();
  });

  it("still serves the static dashboard and health endpoint", async () => {
    const web = buildWebServer(makePorts(), CONFIG, new NullLogger(), "paper");
    const health = await web.instance.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    const page = await web.instance.inject({ method: "GET", url: "/" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("run-now");
    await web.stop();
  });
});
