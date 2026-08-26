import { afterEach, describe, expect, it, vi } from "vitest";
import { Trading212Broker } from "../../src/adapters/broker/trading212.js";
import { AdapterError } from "../../src/shared/errors.js";

const INSTRUMENTS = [
  { ticker: "AAPL_US_EQ", shortName: "AAPL", name: "Apple", isin: "US0378331005", currencyCode: "USD", type: "STOCK" },
  { ticker: "MSFT_US_EQ", shortName: "MSFT", name: "Microsoft", isin: "US5949181045", currencyCode: "USD", type: "STOCK" },
  { ticker: "NU_US_EQ", shortName: "NU", name: "NU Holdings", isin: "KYG6683N1034", currencyCode: "USD", type: "STOCK" },
  { ticker: "UTX_US_EQ", shortName: "RTX", name: "RTX", isin: "US75513E1010", currencyCode: "USD", type: "STOCK" },
  { ticker: "VUSA_LSE_EQ", shortName: "VUSA", name: "Vanguard S&P 500", isin: "IE00B3XXRP09", currencyCode: "GBP", type: "ETF" },
];

function broker() {
  return new Trading212Broker({
    environment: "demo",
    apiKey: "k",
    apiSecret: "s",
    baseUrl: "https://demo.test",
  });
}

function stubFetch(responses: { path?: string; body: unknown; status?: number }[]) {
  const fn = vi.fn(async (url: string) => {
    const r = responses.shift()!;
    expect(String(url)).toContain(r.path ?? "");
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("Trading212Broker", () => {
  it("sends Basic key-pair auth", async () => {
    const fetchMock = stubFetch([{ path: "/equity/account/summary", body: { currency: "GBP", totalValue: 100, cash: { availableToTrade: 100 }, investments: { currentValue: 0 } } }]);
    await broker().account();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("k:s").toString("base64")}`);
  });

  it("maps account summary fields", async () => {
    stubFetch([{ path: "/equity/account/summary", body: { currency: "GBP", totalValue: 1234.5, cash: { availableToTrade: 500 }, investments: { currentValue: 734.5 } } }]);
    const account = await broker().account();
    expect(account).toEqual({ currency: "GBP", cash: 500, totalValue: 1234.5, investedValue: 734.5 });
  });

  it("resolves plain symbols to API instrument tickers via the metadata endpoint", async () => {
    stubFetch([{ path: "/equity/metadata/instruments", body: INSTRUMENTS }]);
    const b = broker();
    expect(await b.resolveInstrumentTicker("AAPL")).toBe("AAPL_US_EQ");
    expect(await b.resolveInstrumentTicker("AAPL_US_EQ")).toBe("AAPL_US_EQ"); // full id passes through
    expect(await b.resolveInstrumentTicker("VUSA")).toBe("VUSA_LSE_EQ");
    await expect(b.resolveInstrumentTicker("NOTREAL")).rejects.toMatchObject({ kind: "no-data" });
  });

  it("places market orders with the API ticker and negative quantity for sells", async () => {
    const fetchMock = stubFetch([
      { path: "/equity/metadata/instruments", body: INSTRUMENTS },
      { path: "/equity/orders/market", body: { id: 42, status: "NEW" } },
      { path: "/equity/orders/market", body: { id: 43, status: "NEW" } },
    ]);
    const b = broker();
    const buy = await b.submitOrder({ ticker: "AAPL", side: "BUY", quantity: 2, type: "MARKET" });
    expect(buy).toEqual({ brokerOrderId: "42", status: "SUBMITTED", submittedQuantity: 2 });
    const sell = await b.submitOrder({ ticker: "MSFT", side: "SELL", quantity: 1, type: "MARKET" });
    expect(sell.brokerOrderId).toBe("43");

    const bodies = fetchMock.mock.calls
      .filter((c) => (c as unknown as [string, RequestInit])[1].body !== undefined)
      .map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)));
    expect(bodies[0]).toEqual({ quantity: 2, ticker: "AAPL_US_EQ" });
    expect(bodies[1]).toEqual({ quantity: -1, ticker: "MSFT_US_EQ" });
    // Instruments were fetched once and cached (no second metadata call).
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/metadata/instruments"))).toHaveLength(1);
  });

  it("retries with reduced precision on quantity-precision-mismatch and reports the accepted quantity", async () => {
    const fetchMock = stubFetch([
      { path: "/equity/metadata/instruments", body: INSTRUMENTS },
      {
        path: "/equity/orders/market",
        body: { type: "/api-errors/quantity-precision-mismatch", title: "Error while placing the order", status: 400, detail: "invalid quantity precision 3" },
        status: 400,
      },
      { path: "/equity/orders/market", body: { id: 77, status: "NEW" } },
    ]);
    const b = broker();
    const res = await b.submitOrder({ ticker: "NU", side: "SELL", quantity: 0.8986, type: "MARKET" });
    expect(res.brokerOrderId).toBe("77");
    expect(res.submittedQuantity).toBeCloseTo(-0.9, 6); // retried with 1 decimal (3-1=2 → 0.9)
    const bodies = fetchMock.mock.calls
      .filter((c) => (c as unknown as [string, RequestInit])[1].body !== undefined)
      .map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)));
    expect(bodies[0].quantity).toBeCloseTo(-0.8986, 6);
    expect(bodies[1].quantity).toBeCloseTo(-0.9, 6);
  });

  it("gives up after exhausting precision retries", async () => {
    const failure = {
      path: "/equity/orders/market",
      body: { type: "/api-errors/quantity-precision-mismatch", title: "Error while placing the order", status: 400, detail: "invalid quantity precision 0" },
      status: 400,
    };
    stubFetch([{ path: "/equity/metadata/instruments", body: INSTRUMENTS }, failure, failure, failure, failure, failure]);
    await expect(broker().submitOrder({ ticker: "NU", side: "BUY", quantity: 1.5, type: "MARKET" })).rejects.toMatchObject({ kind: "http" });
  });

  it("maps legacy instrument ids to their current shortName (UTX_US_EQ → RTX)", async () => {
    stubFetch([
      { path: "/equity/metadata/instruments", body: INSTRUMENTS },
      {
        path: "/equity/positions",
        body: [
          { averagePricePaid: 211, currentPrice: 215, quantity: 0.95, instrument: { ticker: "UTX_US_EQ", currency: "USD" } },
        ],
      },
    ]);
    const positions = await broker().positions();
    expect(positions[0]?.ticker).toBe("RTX"); // shortName wins over the naive split
  });

  it("maps positions back to plain symbols with instrument currency", async () => {
    stubFetch([
      { path: "/equity/metadata/instruments", body: INSTRUMENTS },
      {
        path: "/equity/positions",
        body: [
          { averagePricePaid: 400, currentPrice: 420, quantity: 2, instrument: { ticker: "MSFT_US_EQ", currency: "USD" } },
          { averagePricePaid: 80, currentPrice: 88, quantity: 5, instrument: { ticker: "VUSA_LSE_EQ", currency: "GBP" } },
        ],
      },
    ]);
    const positions = await broker().positions();
    expect(positions).toHaveLength(2);
    expect(positions[0]).toMatchObject({ ticker: "MSFT", quantity: 2, averagePrice: 400, currentPrice: 420, currency: "USD" });
    expect(positions[1]).toMatchObject({ ticker: "VUSA", currency: "GBP" });
  });

  it("lists open broker orders mapped back to plain symbols", async () => {
    stubFetch([
      { path: "/equity/metadata/instruments", body: INSTRUMENTS },
      {
        path: "/equity/orders",
        body: [
          { id: 55, status: "NEW", side: "BUY", quantity: 0.2773, ticker: "MSFT_US_EQ", createdAt: "2026-08-26T01:56:55+03:00" },
          { id: 56, status: "NEW", side: "SELL", quantity: -2, ticker: "AAPL_US_EQ", createdAt: "2026-08-26T01:57:00+03:00" },
        ],
      },
    ]);
    const open = await broker().listOpenOrders();
    expect(open).toHaveLength(2);
    expect(open[0]).toMatchObject({ brokerOrderId: "55", ticker: "MSFT", side: "BUY", quantity: 0.2773 });
    expect(open[1]).toMatchObject({ brokerOrderId: "56", ticker: "AAPL", side: "SELL", quantity: 2 });
  });

  it("falls back to order history when a filled order 404s from the active endpoint", async () => {
    stubFetch([
      { path: "/equity/orders/42", body: { type: "api-error", title: "Requested entity not found", status: 404 }, status: 404 },
      {
        path: "/equity/history/orders",
        body: {
          items: [
            { order: { id: 42, status: "FILLED", filledQuantity: 2 }, fill: { price: 488.1, quantity: 2, filledAt: "2026-08-26T13:30:01Z" } },
          ],
        },
      },
    ]);
    const status = await broker().orderStatus("42");
    expect(status.status).toBe("FILLED");
    expect(status.filledQuantity).toBe(2);
    expect(status.filledPriceAvg).toBeCloseTo(488.1, 6);
  });

  it("computes the average fill price from filledValue/filledQuantity", async () => {
    stubFetch([{ path: "/equity/orders/42", body: { id: 42, status: "FILLED", filledQuantity: 2, filledValue: 422 } }]);
    const status = await broker().orderStatus("42");
    expect(status.status).toBe("FILLED");
    expect(status.filledPriceAvg).toBeCloseTo(211, 6);
  });

  it("maps auth failures to typed errors with guidance", async () => {
    stubFetch([
      { path: "/equity/account/summary", body: {}, status: 403 },
      { path: "/equity/account/summary", body: {}, status: 403 },
    ]);
    const b = broker();
    await expect(b.account()).rejects.toMatchObject({ kind: "auth" });
    await expect(b.account()).rejects.toThrow(/scopes/);
  });

  it("throws at construction without an API key", () => {
    expect(() => new Trading212Broker({ environment: "live", apiKey: "", apiSecret: null })).toThrow(AdapterError);
  });
});
