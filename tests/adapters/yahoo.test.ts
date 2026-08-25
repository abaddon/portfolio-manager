import { afterEach, describe, expect, it, vi } from "vitest";
import { CombinedPriceDataAdapter, YahooCandlesAdapter } from "../../src/adapters/marketdata/yahoo.js";

const SAMPLE = {
  chart: {
    result: [
      {
        meta: { symbol: "AAPL", regularMarketPrice: 309.9, chartPreviousClose: 310.34, currency: "USD" },
        timestamp: [1787688000, 1787688060, 1787688120],
        indicators: {
          quote: [
            {
              open: [310, 311, null],
              high: [312, 313, null],
              low: [309, 310, null],
              close: [311, 312, 313],
              volume: [1000, 2000, 3000],
            },
          ],
        },
      },
    ],
    error: null,
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("YahooCandlesAdapter", () => {
  it("parses candles from the chart payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(SAMPLE), { status: 200 })));
    const candles = await new YahooCandlesAdapter().candles("AAPL", { interval: "60", count: 5 });
    expect(candles).toHaveLength(3);
    expect(candles[0]).toMatchObject({ ticker: "AAPL", open: 310, high: 312, low: 309, close: 311, volume: 1000 });
    expect(candles[2]!.open).toBe(313); // null open falls back to close
  });

  it("parses the quote from chart meta", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(SAMPLE), { status: 200 })));
    const quote = await new YahooCandlesAdapter().quote("AAPL");
    expect(quote.price).toBeCloseTo(309.9, 6);
    expect(quote.currency).toBe("USD");
    expect(quote.changePct).toBeCloseTo(((309.9 - 310.34) / 310.34) * 100, 4);
  });

  it("maps missing data to typed errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ chart: { result: null, error: { code: "Not Found" } } }), { status: 200 })),
    );
    await expect(new YahooCandlesAdapter().candles("NOPE")).rejects.toMatchObject({ kind: "no-data" });
  });
});

describe("CombinedPriceDataAdapter", () => {
  it("delegates quotes and candles to their respective sources", async () => {
    const quotes = { quote: vi.fn(async (t: string) => ({ ticker: t, price: 1, currency: "USD", prevClose: null, changePct: null, volume: null, asOf: "x" })) };
    const candles = { candles: vi.fn(async () => []) };
    const combined = new CombinedPriceDataAdapter(quotes, candles);
    await combined.quote("MSFT");
    await combined.candles("MSFT");
    expect(quotes.quote).toHaveBeenCalledWith("MSFT");
    expect(candles.candles).toHaveBeenCalledWith("MSFT", undefined);
  });
});
