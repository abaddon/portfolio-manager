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

  it("maps 401/403 to auth errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    await expect(new FinnhubAdapter("k").quote("AAPL")).rejects.toBeInstanceOf(AdapterError);
    await expect(new FinnhubAdapter("k").quote("AAPL")).rejects.toMatchObject({ kind: "auth" });
  }, 10_000);
});
