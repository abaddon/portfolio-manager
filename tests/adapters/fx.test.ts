import { afterEach, describe, expect, it, vi } from "vitest";
import { ErApiFxAdapter, FallbackFxAdapter } from "../../src/adapters/marketdata/fx.js";
import { DemoFxAdapter } from "../../src/adapters/marketdata/demo.js";

afterEach(() => vi.unstubAllGlobals());

describe("ErApiFxAdapter", () => {
  it("resolves cross rates from the USD base table", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ result: "success", rates: { USD: 1, GBP: 0.78, EUR: 0.92, JPY: 150 } }), { status: 200 }),
      ),
    );
    const fx = new ErApiFxAdapter();
    expect(await fx.rate("USD", "GBP")).toBeCloseTo(0.78, 6);
    expect(await fx.rate("GBP", "USD")).toBeCloseTo(1 / 0.78, 6);
    expect(await fx.rate("EUR", "GBP")).toBeCloseTo(0.78 / 0.92, 6);
    await expect(fx.rate("USD", "ZZZ")).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("caches the rates table between calls", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ result: "success", rates: { USD: 1, GBP: 0.78 } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const fx = new ErApiFxAdapter();
    await fx.rate("USD", "GBP");
    await fx.rate("USD", "GBP");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("FallbackFxAdapter", () => {
  it("falls through to the next adapter on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })));
    const fx = new FallbackFxAdapter([new ErApiFxAdapter(), new DemoFxAdapter()]);
    const rate = await fx.rate("USD", "GBP");
    expect(rate).toBeCloseTo(0.79, 6); // demo table rate
  });

  it("throws only when the whole chain fails", async () => {
    const failing = { rate: async () => { throw new Error("boom"); } };
    await expect(new FallbackFxAdapter([failing]).rate("USD", "GBP")).rejects.toThrow(/all adapters failed/);
  });
});
