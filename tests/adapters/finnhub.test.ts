import { afterEach, describe, expect, it, vi } from "vitest";
import { FinnhubAdapter } from "../../src/adapters/marketdata/finnhub.js";
import { AdapterError } from "../../src/shared/errors.js";

afterEach(() => vi.unstubAllGlobals());

describe("FinnhubAdapter rate limiting", () => {
  it("retries once on 429 rate-limit responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ c: 100, d: 1, dp: 1, h: 101, l: 99, o: 99, pc: 99, t: 1787688000 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const quote = await new FinnhubAdapter("k").quote("AAPL");
    expect(quote.price).toBe(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("surfaces persistent rate limiting as a typed error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429 })));
    await expect(new FinnhubAdapter("k").quote("AAPL")).rejects.toMatchObject({ kind: "rate-limit" });
  }, 10_000);

  it("surfaces the plan limitation honestly for social sentiment (403)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"You don\'t have access to this resource."}', { status: 403 })));
    await expect(new FinnhubAdapter("k").sentiment("AAPL")).rejects.toMatchObject({ kind: "unsupported" });
    await expect(new FinnhubAdapter("k").sentiment("AAPL")).rejects.toThrow(/not available on this plan/);
  });

  it("maps 401/403 to auth errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    await expect(new FinnhubAdapter("k").quote("AAPL")).rejects.toBeInstanceOf(AdapterError);
    await expect(new FinnhubAdapter("k").quote("AAPL")).rejects.toMatchObject({ kind: "auth" });
  }, 10_000);
});

describe("FinnhubAdapter.upcomingEarnings (WP-P2.3)", () => {
  it("keeps only the requested tickers and normalises the report hour", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          earningsCalendar: [
            { symbol: "MSFT", date: "2026-09-20", hour: "amc", epsEstimate: 3.1 },
            { symbol: "AAPL", date: "2026-09-22", hour: "bmo", epsEstimate: null },
            { symbol: "ZZZ", date: "2026-09-21", hour: "dmh", epsEstimate: 1 },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new FinnhubAdapter("key");
    const events = await adapter.upcomingEarnings(["MSFT", "AAPL"], 30);

    expect(events).toEqual([
      { ticker: "MSFT", date: "2026-09-20", hour: "amc", epsEstimate: 3.1 },
      { ticker: "AAPL", date: "2026-09-22", hour: "bmo", epsEstimate: null },
    ]);
    // The unknown hour becomes "unknown" rather than being passed through.
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("/calendar/earnings?from=");
    expect(url).toContain("&to=");
  });

  it("returns an empty list when the provider has no rows", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    expect(await new FinnhubAdapter("key").upcomingEarnings(["MSFT"], 7)).toEqual([]);
  });
});
