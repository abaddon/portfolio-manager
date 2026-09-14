import { describe, expect, it } from "vitest";
import { InstrumentMetricsService } from "../../src/application/services/instrument-metrics.js";
import { buildPortfolioSnapshot } from "../../src/domain/portfolio.js";
import type { Candle } from "../../src/domain/analysis.js";
import type { AppPorts } from "../../src/application/ports.js";

function candles(ticker: string, closes: number[]): Candle[] {
  return closes.map((close, i) => ({ ticker, timestamp: String(i), open: close, high: close, low: close, close, volume: 1_000 }));
}

function ports(candlesFor: (ticker: string) => Candle[] | Error, sectors: Record<string, string> = {}) {
  const asked: string[] = [];
  const warnings: string[] = [];
  const prices = {
    quote: async () => {
      throw new Error("unused");
    },
    candles: async (ticker: string) => {
      asked.push(ticker);
      const result = candlesFor(ticker);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return {
    asked,
    warnings,
    ports: {
      prices,
      fundamentals: {
        fundamentals: async (ticker: string) => {
          const sector = sectors[ticker];
          if (!sector) throw new Error("no fundamentals");
          return { ticker, currency: "USD", pe: 20, pb: 5, eps: 1, revenueGrowthPct: 5, profitMarginPct: 20, debtToEquity: 0.5, dividendYieldPct: 1, marketCap: 1000, sector, asOf: "t", details: {} };
        },
      },
      logger: { debug: () => {}, info: () => {}, warn: (msg: string) => warnings.push(msg), error: () => {} },
    } as unknown as Pick<AppPorts, "prices" | "logger" | "fundamentals">,
  };
}

function snapshot(positions: { ticker: string; weight: number }[]) {
  return buildPortfolioSnapshot({
    id: "s",
    runId: "r",
    asOf: "t",
    currency: "GBP",
    cash: 100,
    // value = weight × 100 (10 shares at 10) → the snapshot's weights are exactly
    // the requested ones once cash is added on top.
    positions: positions.map((p) => ({
      ticker: p.ticker,
      quantity: p.weight * 10,
      averagePrice: 10,
      currentPrice: 10,
      currency: "GBP",
    })),
    prevTotalValue: null,
  });
}

describe("InstrumentMetricsService (WP-P2.1)", () => {
  it("fetches the benchmark once and computes metrics for the universe and the held names", async () => {
    const { ports: p, asked } = ports((ticker) => candles(ticker, [100, 101, 102, 101, 103]));
    const svc = new InstrumentMetricsService(p, { tickers: ["MSFT", "AAPL"], benchmark: "SPY" });
    const result = await svc.collect(snapshot([{ ticker: "NVDA", weight: 0.5 }]));

    expect(asked.filter((t) => t === "SPY")).toHaveLength(1);
    expect(new Set(result.metrics.map((m) => m.ticker))).toEqual(new Set(["MSFT", "AAPL", "NVDA"]));
    expect(result.benchmarkBars).toBe(5);
    expect(result.metrics.every((m) => m.bars === 5)).toBe(true);
  });

  it("contains a failing benchmark: beta is null, everything else still computes", async () => {
    const { ports: p, warnings } = ports((ticker) => (ticker === "SPY" ? new Error("yahoo 429") : candles(ticker, [100, 101, 102])));
    const svc = new InstrumentMetricsService(p, { tickers: ["MSFT"], benchmark: "SPY" });
    const result = await svc.collect(snapshot([]));

    expect(result.benchmarkBars).toBe(0);
    expect(result.metrics[0]!.beta).toBeNull();
    expect(result.metrics[0]!.correlation).toBeNull();
    expect(result.metrics[0]!.bars).toBe(3); // the name's own metrics are unaffected
    expect(warnings.some((w) => w.includes("beta/correlation disabled"))).toBe(true);
  });

  it("contains a failing ticker: null metrics for that name, the rest continue", async () => {
    const { ports: p, warnings } = ports((ticker) => (ticker === "AAPL" ? new Error("no candles") : candles(ticker, [100, 101])));
    const svc = new InstrumentMetricsService(p, { tickers: ["MSFT", "AAPL"], benchmark: "SPY" });
    const result = await svc.collect(snapshot([]));

    const aapl = result.metrics.find((m) => m.ticker === "AAPL")!;
    expect(aapl.bars).toBe(0);
    expect(aapl.volatilityPerBarPct).toBeNull();
    expect(result.metrics.find((m) => m.ticker === "MSFT")!.bars).toBe(2);
    expect(warnings.some((w) => w.includes("risk metrics skipped"))).toBe(true);
  });

  it("collects sectors for the names whose fundamentals are available", async () => {
    const { ports: p } = ports((ticker) => candles(ticker, [100, 101]), { MSFT: "Technology", NVDA: "Technology" });
    const svc = new InstrumentMetricsService(p, { tickers: ["MSFT", "NVDA", "XOM"], benchmark: "SPY" });
    const result = await svc.collect(snapshot([]));
    expect(result.sectors).toEqual({ MSFT: "Technology", NVDA: "Technology" });
  });

  it("reports portfolio concentration from the snapshot weights", async () => {
    const { ports: p } = ports((ticker) => candles(ticker, [100, 101]));
    const svc = new InstrumentMetricsService(p, { tickers: [], benchmark: "SPY" });
    const result = await svc.collect(snapshot([{ ticker: "MSFT", weight: 0.6 }, { ticker: "AAPL", weight: 0.2 }]));
    // Weights are normalised over total value (cash included): 60/20 of 180.
    expect(result.concentration.largestWeight).toBeCloseTo(0.6 / 1.8, 4);
    expect(result.concentration.top3Weight).toBeCloseTo(0.8 / 1.8, 4);
    expect(result.concentration.effectivePositions).toBeGreaterThan(1);
  });
});
