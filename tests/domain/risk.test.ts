import { describe, expect, it } from "vitest";
import {
  BARS_PER_YEAR,
  concentration,
  computeInstrumentMetrics,
  maxDrawdownPct,
  rebalanceBandFor,
} from "../../src/domain/risk.js";
import type { Candle } from "../../src/domain/analysis.js";

function candles(closes: number[], volume = 1_000): Candle[] {
  return closes.map((close, i) => ({
    ticker: "T",
    timestamp: new Date(Date.UTC(2026, 7, 26, 13 + i)).toISOString(),
    open: close,
    high: close * 1.001,
    low: close * 0.999,
    close,
    volume,
  }));
}

/** Alternating ±1% closes: a known, finite volatility. */
function alternating(n: number, step = 0.01, start = 100): number[] {
  const out = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1]! * (1 + (i % 2 === 0 ? step : -step)));
  return out;
}

describe("computeInstrumentMetrics (WP-P2.1)", () => {
  it("returns nulls rather than guesses for a series that is too short", () => {
    const empty = computeInstrumentMetrics("MSFT", []);
    expect(empty.bars).toBe(0);
    expect(empty.volatilityPerBarPct).toBeNull();
    expect(empty.beta).toBeNull();
    expect(empty.sma20).toBeNull();
    expect(empty.maxDrawdownPct).toBeNull();
    expect(empty.rangePosition).toBeNull();

    const oneBar = computeInstrumentMetrics("MSFT", candles([100]));
    expect(oneBar.bars).toBe(1);
    expect(oneBar.volatilityPerBarPct).toBeNull();
    expect(oneBar.rangePosition).toBeNull();
  });

  it("measures realised volatility per bar and annualised", () => {
    const closes = alternating(30, 0.01);
    const metrics = computeInstrumentMetrics("MSFT", candles(closes));
    // Compare against the sample standard deviation of the actual bar returns.
    const rets = closes.slice(1).map((c, i) => c / closes[i]! - 1);
    const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((sum, r) => sum + (r - avg) ** 2, 0) / (rets.length - 1));
    expect(metrics.volatilityPerBarPct).toBeCloseTo(sd, 5);
    expect(metrics.volatilityAnnualisedPct).toBeCloseTo(sd * Math.sqrt(BARS_PER_YEAR), 3);
  });

  it("computes beta and correlation against the benchmark", () => {
    // The instrument's bar returns are exactly twice the benchmark's (in
    // percentage terms) → beta 2, correlation 1. Both are built by compounding
    // the same ±1% / ±2% steps so the proportionality is exact.
    const bench: number[] = [100];
    const double: number[] = [100];
    for (let i = 1; i < 40; i++) {
      const up = i % 2 === 1;
      bench.push(bench[i - 1]! * (up ? 1.01 : 0.99));
      double.push(double[i - 1]! * (up ? 1.02 : 0.98));
    }
    const metrics = computeInstrumentMetrics("MSFT", candles(double), candles(bench));
    expect(metrics.beta).toBeCloseTo(2, 2);
    expect(metrics.correlation).toBeCloseTo(1, 3);

    // An uncorrelated (flat) benchmark leaves beta undefined, not zero-guessed.
    const flat = computeInstrumentMetrics("MSFT", candles(double), candles(new Array(40).fill(100)));
    expect(flat.beta).toBeNull();
    expect(flat.correlation).toBeNull();
  });

  it("computes moving averages, trend, momentum and range position", () => {
    const closes = [...new Array(20).fill(100), ...new Array(10).fill(120)];
    const metrics = computeInstrumentMetrics("MSFT", candles(closes));
    expect(metrics.sma20).toBeCloseTo(110, 4); // (100×10 + 120×10)/20
    expect(metrics.trendVsSma20Pct).toBeCloseTo(120 / 110 - 1, 6);
    expect(metrics.momentum5Pct).toBeCloseTo(0, 6); // flat over the last 5 bars
    expect(metrics.momentum20Pct).toBeCloseTo(0.2, 6); // 100 → 120
    expect(metrics.highClose).toBe(120);
    expect(metrics.lowClose).toBe(100);
    expect(metrics.rangePosition).toBe(1); // at the top of the window
  });

  it("measures the deepest drawdown inside the window", () => {
    expect(maxDrawdownPct([100, 120, 90, 130])).toBeCloseTo(90 / 120 - 1, 6);
    expect(maxDrawdownPct([100, 110, 120])).toBe(0); // never below a previous peak
    expect(maxDrawdownPct([100])).toBeNull();
    const metrics = computeInstrumentMetrics("MSFT", candles([100, 120, 90, 130]));
    expect(metrics.maxDrawdownPct).toBeCloseTo(-0.25, 6);
  });

  it("flags an unusual last-bar volume", () => {
    const series = candles(new Array(10).fill(100), 1_000);
    series[series.length - 1]!.volume = 3_000;
    // Nine bars at 1 000 and one at 3 000 → the last bar is 2.5× the average.
    expect(computeInstrumentMetrics("MSFT", series).volumeRatio).toBeCloseTo(2.5, 4);
    expect(computeInstrumentMetrics("MSFT", candles(new Array(10).fill(100), 0)).volumeRatio).toBeNull();
  });

  it("ignores non-finite prices instead of propagating NaN", () => {
    const series = candles([100, 101, 102]);
    series[1]!.close = Number.NaN;
    const metrics = computeInstrumentMetrics("MSFT", series);
    expect(metrics.bars).toBe(3);
    expect(Number.isFinite(metrics.volatilityPerBarPct ?? 0)).toBe(true);
  });
});

describe("rebalanceBandFor (WP-P2.1)", () => {
  it("never goes below the configured band", () => {
    expect(
      rebalanceBandFor({ configuredBand: 0.04, roundTripCostRatio: 0.001, costMultiple: 2, volatilityPerBarPct: 0.001, volatilityMultiple: 2 }),
    ).toBe(0.04);
  });

  it("widens for an expensive round trip", () => {
    // 0.34% round trip × 3 = 1.02% > the configured 0.5%.
    expect(
      rebalanceBandFor({ configuredBand: 0.005, roundTripCostRatio: 0.0034, costMultiple: 3, volatilityPerBarPct: null, volatilityMultiple: 2 }),
    ).toBeCloseTo(0.0102, 4);
  });

  it("widens for a volatile name so the band is not noise", () => {
    // 2% per-bar volatility × 1.5 = 3% band.
    expect(
      rebalanceBandFor({ configuredBand: 0.01, roundTripCostRatio: 0.0001, costMultiple: 1, volatilityPerBarPct: 0.02, volatilityMultiple: 1.5 }),
    ).toBeCloseTo(0.03, 4);
  });

  it("takes the widest of the three constraints", () => {
    const band = rebalanceBandFor({
      configuredBand: 0.01,
      roundTripCostRatio: 0.0034,
      costMultiple: 2,
      volatilityPerBarPct: 0.05,
      volatilityMultiple: 1,
    });
    expect(band).toBeCloseTo(0.05, 4);
  });
});

describe("concentration (WP-P2.1)", () => {
  it("reports the largest weight, the top-3 weight and an effective position count", () => {
    const equal = concentration({ weights: [0.2, 0.2, 0.2, 0.2, 0.2] });
    expect(equal.largestWeight).toBe(0.2);
    expect(equal.effectivePositions).toBeCloseTo(5, 2);
    expect(equal.top3Weight).toBeCloseTo(0.6, 4);

    // One name dominating: "five positions" is really one bet.
    const concentrated = concentration({ weights: [0.3, 0.25, 0.25, 0.1, 0.1] });
    expect(concentrated.largestWeight).toBe(0.3);
    expect(concentrated.effectivePositions).toBeLessThan(4.5); // far from the five names it holds
    expect(concentrated.top3Weight).toBeCloseTo(0.8, 4);
    const single = concentration({ weights: [1] });
    expect(single.effectivePositions).toBe(1);
    expect(single.largestWeight).toBe(1);

    expect(concentration({ weights: [] })).toEqual({ largestWeight: 0, effectivePositions: 0, top3Weight: 0 });
  });
});
