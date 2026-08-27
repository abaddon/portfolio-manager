import { describe, expect, it, vi, afterEach } from "vitest";
import { FredAdapter } from "../../src/adapters/marketdata/fred.js";
import { AdapterError } from "../../src/shared/errors.js";

function obs(rows: { date: string; value: string | null }[]) {
  return new Response(
    JSON.stringify({
      observations: rows.map((r) => ({ realtime_start: r.date, realtime_end: r.date, date: r.date, value: r.value ?? "." })),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Routes stubbed fetches by the series_id query parameter. */
function mockFred(routes: Record<string, (url: string) => Response>) {
  const fn = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const seriesId = new URL(url).searchParams.get("series_id") ?? "?";
    const route = routes[seriesId] ?? routes["*"];
    if (!route) throw new Error(`no stub for series ${seriesId}`);
    return route(url);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("FredAdapter (FRED macro series)", () => {
  it("builds a macro snapshot from per-series observations, mapping missing values to null", async () => {
    const monthlyCpi = [
      { date: "2026-07-01", value: "332.813" },
      { date: "2026-06-01", value: "332.568" },
      { date: "2026-05-01", value: "333.979" },
      { date: "2026-04-01", value: "332.407" },
      { date: "2026-03-01", value: "330.293" },
      { date: "2026-02-01", value: "327.460" },
      { date: "2026-01-01", value: "326.588" },
      { date: "2025-12-01", value: "326.031" },
      { date: "2025-11-01", value: "325.063" },
      { date: "2025-10-01", value: null }, // missing month — must be skipped
      { date: "2025-09-01", value: "324.245" },
      { date: "2025-08-01", value: "323.291" },
      { date: "2025-07-01", value: "322.169" },
    ];
    mockFred({
      DFF: () => obs([{ date: "2026-08-25", value: "3.63" }]),
      DGS10: () => obs([{ date: "2026-08-25", value: "4.10" }]),
      DGS2: () => obs([{ date: "2026-08-25", value: "3.90" }]),
      T10Y2Y: () => obs([{ date: "2026-08-25", value: null }]),
      VIXCLS: () => obs([{ date: "2026-08-25", value: "15.50" }]),
      UNRATE: () => obs([{ date: "2026-07-01", value: "4.2" }]),
      SP500: () => obs([{ date: "2026-08-25", value: "6400.5" }]),
      CPIAUCSL: () => obs(monthlyCpi),
    });

    const adapter = new FredAdapter("test-key");
    const macro = await adapter.macroSnapshot();

    expect(macro.fedFundsRatePct).toBe(3.63);
    expect(macro.treasury10yPct).toBe(4.1);
    expect(macro.treasury2yPct).toBe(3.9);
    expect(macro.yieldSpread10y2yPct).toBeNull(); // "." observation
    expect(macro.vix).toBe(15.5);
    expect(macro.unemploymentPct).toBe(4.2);
    expect(macro.sp500).toBe(6400.5);
    // CPI YoY: 332.813 vs 322.169 → 3.3%
    expect(macro.cpiYoYPct).toBeCloseTo(3.3, 1);
    expect(macro.asOf).toBeTruthy();
  });

  it("returns null CPI YoY when 12 months of history are unavailable", async () => {
    mockFred({
      "*": () => obs([{ date: "2026-07-01", value: "332.813" }]),
      CPIAUCSL: () => obs([{ date: "2026-07-01", value: "332.813" }]),
    });
    const macro = await new FredAdapter("test-key").macroSnapshot();
    expect(macro.cpiYoYPct).toBeNull();
    expect(macro.vix).toBe(332.813); // "*" route served the other series
  });

  it("maps a rejected api_key (400) to an auth AdapterError", async () => {
    mockFred({
      "*": () => new Response(JSON.stringify({ error_code: 400, error_message: "Bad Request. The value for variable api_key is not registered." }), { status: 400 }),
    });
    await expect(new FredAdapter("bad-key").macroSnapshot()).rejects.toMatchObject({ kind: "auth" });
  });

  it("retries once on 429 and gives up with rate-limit afterwards", async () => {
    let calls = 0;
    const fn = mockFred({
      "*": () => {
        calls++;
        return calls <= 1 ? new Response("{}", { status: 429 }) : obs([{ date: "2026-08-25", value: "3.63" }]);
      },
      CPIAUCSL: () => obs([{ date: "2026-07-01", value: "332.813" }]),
    });
    const macro = await new FredAdapter("k").macroSnapshot();
    expect(macro.fedFundsRatePct).toBe(3.63);

    // Now every response is a 429: the adapter surfaces rate-limit.
    let calls2 = 0;
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls2++;
      return new Response("{}", { status: 429 });
    }));
    const err = await new FredAdapter("k").macroSnapshot().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).kind).toBe("rate-limit");
    expect(fn).toHaveBeenCalled();
    expect(calls2).toBeGreaterThanOrEqual(2); // retried once, then threw
  });
});
