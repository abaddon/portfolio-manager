import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { ConfigurationError } from "../../src/shared/errors.js";
import { DemoMarketDataAdapter } from "../../src/adapters/marketdata/demo.js";
import { FinnhubAdapter } from "../../src/adapters/marketdata/finnhub.js";
import { YahooCandlesAdapter } from "../../src/adapters/marketdata/yahoo.js";
import { vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

const cleanEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ ...extra }) as NodeJS.ProcessEnv;

describe("loadConfig — a mistyped --config overlay must never fail open", () => {
  it("throws when the overlay path does not exist", () => {
    expect(() => loadConfig({ overlayPath: "config/definitely-not-here.json", env: cleanEnv() })).toThrow(
      ConfigurationError,
    );
  });

  it("still applies an overlay that does exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "tpm-overlay-"));
    const path = join(dir, "paper.json");
    writeFileSync(path, JSON.stringify({ mode: "paper" }));
    const loaded = loadConfig({ overlayPath: path, env: cleanEnv() });
    expect(loaded.config.mode).toBe("paper");
  });

  it("rejects an invalid TPM_PORT instead of building a NaN port", () => {
    expect(() => loadConfig({ env: cleanEnv({ TPM_PORT: "abc" }) })).toThrow(ConfigurationError);
    expect(() => loadConfig({ env: cleanEnv({ TPM_PORT: "0" }) })).toThrow(ConfigurationError);
    expect(() => loadConfig({ env: cleanEnv({ TPM_PORT: "70000" }) })).toThrow(ConfigurationError);
    expect(loadConfig({ env: cleanEnv({ TPM_PORT: "9001" }) }).config.web.port).toBe(9001);
  });
});

describe("Finnhub fundamentals field mapping", () => {
  function stubFinnhub(metric: Record<string, unknown>, profile: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        const body = url.includes("profile2") ? profile : { metric };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
  }

  it("reads the slash-keyed debt/equity ratio Finnhub actually returns", async () => {
    stubFinnhub({ "totalDebt/totalEquityQuarterly": 0.7844 }, {});
    const f = await new FinnhubAdapter("k").fundamentals("AAPL");
    expect(f.debtToEquity).toBeCloseTo(0.7844, 4);
  });

  it("falls back to the annual ratio when the quarterly one is absent", async () => {
    stubFinnhub({ "totalDebt/totalEquityAnnual": 1.3547 }, {});
    expect((await new FinnhubAdapter("k").fundamentals("AAPL")).debtToEquity).toBeCloseTo(1.3547, 4);
  });

  it("normalises market cap from millions to units", async () => {
    stubFinnhub({ peTTM: 37.6 }, { marketCapitalization: 4_849_208.19 });
    const f = await new FinnhubAdapter("k").fundamentals("AAPL");
    expect(f.marketCap).toBeCloseTo(4.84920819e12, 0);
  });
});

describe("Yahoo candles — interval → range mapping", () => {
  function stubChart(bars: number) {
    const timestamps = Array.from({ length: bars }, (_, i) => 1_780_000_000 + i * 3600);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: { symbol: "AAPL" },
                  timestamp: timestamps,
                  indicators: {
                    quote: [
                      {
                        open: timestamps.map(() => 1),
                        high: timestamps.map(() => 1),
                        low: timestamps.map(() => 1),
                        close: timestamps.map(() => 1),
                        volume: timestamps.map(() => 1),
                      },
                    ],
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
  }

  it("asks for a range wide enough for weekly bars (not a 60-minute assumption)", async () => {
    stubChart(3);
    await new YahooCandlesAdapter().candles("AAPL", { interval: "1wk", count: 40 });
    const url = String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    // 40 weekly bars ≈ 280 days → the 3mo window, not "5d".
    expect(url).toContain("range=3mo");
    expect(url).toContain("interval=1wk");
  });

  it("maps bare numbers to Yahoo's minute format", async () => {
    stubChart(2);
    await new YahooCandlesAdapter().candles("AAPL", { interval: "60", count: 40 });
    const url = String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(url).toContain("interval=60m");
    expect(url).toContain("range=5d");
  });

  it("returns nothing (without a request) when count is 0", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    expect(await new YahooCandlesAdapter().candles("AAPL", { count: 0 })).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("DemoMarketDataAdapter — timestamps follow the clock", () => {
  it("stamps each call with the current time, not the construction time", async () => {
    let now = new Date("2026-09-14T09:00:00Z");
    const adapter = new DemoMarketDataAdapter({ now: () => now });
    expect((await adapter.quote("AAPL")).asOf).toBe("2026-09-14T09:00:00.000Z");
    now = new Date("2026-09-14T16:00:00Z");
    const later = await adapter.quote("AAPL");
    expect(later.asOf).toBe("2026-09-14T16:00:00.000Z");

    const candles = await adapter.candles("AAPL", { interval: "60", count: 3 });
    // Aligned down to the hour: the last bar of a 3-bar series ending at 16:00 starts at 16:00.
    expect(candles.at(-1)!.timestamp).toBe("2026-09-14T16:00:00.000Z");
    const news = await adapter.latestNews("AAPL", 1);
    expect(new Date(news[0]!.publishedAt!).getTime()).toBeLessThan(now.getTime());
  });
});

describe("config fixture sanity", () => {
  it("the paper overlay used by the docs exists", () => {
    expect(existsSync("config/paper-real-data.json")).toBe(true);
  });
});
