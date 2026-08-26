import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { buildApp } from "../../src/composition/root.js";
import { FixedClock } from "../../src/shared/clock.js";
import { NullLogger } from "../../src/shared/logger.js";

const CONFIG = resolve(process.cwd(), "tests/fixtures/live-test-config.json");
const OPEN = new Date("2026-08-26T14:30:00Z"); // Wed, 10:30 ET — NYSE open

const INSTRUMENTS = [
  { ticker: "MSFT_US_EQ", shortName: "MSFT", name: "Microsoft", isin: "US5949181045", currencyCode: "USD", type: "STOCK" },
  { ticker: "AAPL_US_EQ", shortName: "AAPL", name: "Apple", isin: "US0378331005", currencyCode: "USD", type: "STOCK" },
  { ticker: "SPY_US_EQ", shortName: "SPY", name: "SPDR S&P 500", isin: "US78462F1030", currencyCode: "USD", type: "ETF" },
];

const PRICES: Record<string, number> = { MSFT_US_EQ: 420, AAPL_US_EQ: 210 };

/**
 * Simulated Trading212 DEMO REST API: a routing stub that behaves like the
 * real endpoints (verified against the official OpenAPI spec).
 */
function stubTrading212Api() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let nextOrderId = 1000;
  const submitted: { id: number; ticker: string; quantity: number }[] = [];

  const router = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(url).replace("https://demo.test", "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });

    if (path === "/api/v0/equity/metadata/instruments") return json(INSTRUMENTS);
    if (path === "/api/v0/equity/account/summary") {
      return json({ currency: "GBP", totalValue: 5664, cash: { availableToTrade: 5000 }, investments: { currentValue: 664 } });
    }
    if (path === "/api/v0/equity/positions") {
      return json([
        {
          averagePricePaid: 400,
          currentPrice: 420,
          quantity: 2,
          instrument: { ticker: "MSFT_US_EQ", currency: "USD" },
        },
      ]);
    }
    if (method === "POST" && path === "/api/v0/equity/orders/market") {
      const id = ++nextOrderId;
      submitted.push({ id, ticker: String(body.ticker), quantity: Number(body.quantity) });
      return json({ id, status: "NEW" });
    }
    const orderMatch = /^\/api\/v0\/equity\/orders\/(\d+)$/.exec(path);
    if (method === "GET" && orderMatch) {
      const s = submitted.find((x) => x.id === Number(orderMatch[1]));
      if (!s) return json({ id: Number(orderMatch[1]), status: "REJECTED" }, 404);
      const price = PRICES[s.ticker] ?? 100;
      return json({
        id: s.id,
        status: "FILLED",
        filledQuantity: Math.abs(s.quantity),
        filledValue: Math.abs(s.quantity) * price,
      });
    }
    return json({ error: `unexpected ${method} ${path}` }, 500);
  });
  vi.stubGlobal("fetch", router);
  return { router, calls, submitted };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => vi.unstubAllGlobals());

describe("Live-mode pipeline end-to-end (Trading212 DEMO API stubbed over HTTP)", () => {
  it("reads the account via the real adapter, resolves instrument ids, places market orders and confirms fills", async () => {
    const t212 = stubTrading212Api();
    const app = buildApp({
      configPath: CONFIG,
      env: {
        TRADING212_API_KEY: "k",
        TRADING212_API_SECRET: "s",
        TRADING212_ACCOUNT_DEMO: "1",
      } as NodeJS.ProcessEnv,
      dbPath: ":memory:",
      logger: new NullLogger(),
      clock: new FixedClock(OPEN),
    });

    try {
      expect(app.brokerEnvironment).toBe("demo");
      const run = await app.orchestrator.runOnce();
      await app.flushEvents();
      expect(run.status).toBe("COMPLETED");

      // Account read through the real Trading212 adapter (stubbed HTTP).
      const snapshot = await app.ports.portfolio.latest();
      expect(snapshot?.currency).toBe("GBP");
      expect(snapshot?.benchmarkChangePct).not.toBeNull(); // SPY day change persisted

      // Positions mapped from AAPL_US_EQ-style identifiers back to plain symbols.
      expect(snapshot?.positions.map((p) => p.ticker)).toContain("MSFT");

      // Orders went through instrument resolution and market-order placement.
      const orders = await app.ports.orders.byRun(run.id);
      expect(orders).toHaveLength(2);
      for (const o of orders) {
        expect(o.status).toBe("FILLED");
        expect(o.fill?.realizedCost.fxFee).toBeGreaterThan(0);
      }

      const marketPosts = t212.calls.filter((c) => c.method === "POST" && c.path === "/api/v0/equity/orders/market");
      expect(marketPosts).toHaveLength(2);
      const tickers = marketPosts.map((c) => (c.body as { ticker: string }).ticker).sort();
      expect(tickers).toEqual(["AAPL_US_EQ", "MSFT_US_EQ"]);
      for (const c of marketPosts) expect((c.body as { quantity: number }).quantity).toBeGreaterThan(0);

      // Fill confirmation used the status endpoint (late-fill polling path).
      const statusPolls = t212.calls.filter((c) => c.method === "GET" && /\/equity\/orders\/\d+/.test(c.path));
      expect(statusPolls.length).toBeGreaterThanOrEqual(2);

      // Event trail intact.
      const events = await app.ports.eventRepo.byRun(run.id);
      expect(events.filter((e) => e.type === "OrderFilled")).toHaveLength(2);
    } finally {
      app.close();
    }
  }, 20_000);

  it("sweeps orders left SUBMITTED by a previous run into FILLED", async () => {
    const t212 = stubTrading212Api();
    const app = buildApp({
      configPath: CONFIG,
      env: {
        TRADING212_API_KEY: "k",
        TRADING212_API_SECRET: "s",
        TRADING212_ACCOUNT_DEMO: "1",
      } as NodeJS.ProcessEnv,
      dbPath: ":memory:",
      logger: new NullLogger(),
      clock: new FixedClock(OPEN),
    });

    try {
      // Simulate an interrupted run: an order reached the broker (id 9001, NEW)
      // but our confirmation never persisted the fill.
      t212.submitted.push({ id: 9001, ticker: "MSFT_US_EQ", quantity: 1 });
      const { Order } = await import("../../src/domain/execution.js");
      const stale = Order.create({
        id: "ord-stale",
        runId: "run-prev",
        decisionId: "dec-prev",
        ticker: "MSFT",
        side: "BUY",
        quantity: 1,
        type: "MARKET",
        currency: "USD",
        createdAt: "2026-08-26T13:00:00Z",
      });
      stale.markSubmitted("9001", "2026-08-26T13:00:01Z");
      stale.details = { pricing: { accountCurrency: "GBP", estimatedPrice: 420, estimatedAccountValue: 331.8 } };
      await app.ports.orders.save(stale);

      const run = await app.orchestrator.runOnce();
      await app.flushEvents();
      expect(run.status).toBe("COMPLETED");

      const swept = await app.ports.orders.get("ord-stale");
      expect(swept?.status).toBe("FILLED");
      expect(swept?.fill?.filledPriceAvg).toBe(420);
      expect(swept?.fill?.realizedCost.fxFee).toBeGreaterThan(0);
    } finally {
      app.close();
    }
  }, 20_000);
});
