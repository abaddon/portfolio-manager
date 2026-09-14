import type { Candle } from "./analysis.js";
import { roundTo, roundValue } from "../shared/money.js";

/**
 * Instrument risk metrics computed from the hourly candles the analysis step
 * already fetches (WP-P2.1). The review's finding was that the system sized
 * positions on a proxy — `heat = Σ weight × (1 − stopDistancePct)`, which is just
 * "invested fraction × 0.9" — with no volatility, no beta and no drawdown
 * anywhere in the decision. These are pure functions over data already in hand,
 * so the committee can be told, per name: how much this thing moves, how it
 * moves relative to the benchmark, where it sits in its recent range, and how
 * deep its recent drawdown was.
 */
export interface InstrumentMetrics {
  ticker: string;
  /** Bars the metrics were computed from (0 → everything below is null). */
  bars: number;
  /** Realised volatility per bar and annualised (fraction, e.g. 0.012 = 1.2%/day). */
  volatilityPerBarPct: number | null;
  volatilityAnnualisedPct: number | null;
  /** Beta and correlation against the benchmark's bar returns (null without it). */
  beta: number | null;
  correlation: number | null;
  /** Simple moving averages of the close and the price's distance from them. */
  sma20: number | null;
  sma50: number | null;
  /** (price − sma20) / sma20, as a fraction. */
  trendVsSma20Pct: number | null;
  /** Momentum over the last n bars, as a fraction. */
  momentum5Pct: number | null;
  momentum20Pct: number | null;
  /** Deepest peak-to-trough decline inside the window, as a negative fraction. */
  maxDrawdownPct: number | null;
  /** Position of the last close inside the window's [low, high], 0..1. */
  rangePosition: number | null;
  /** Highest and lowest close in the window. */
  highClose: number | null;
  lowClose: number | null;
  /** Last bar's volume against the window's average (1 = normal). */
  volumeRatio: number | null;
}

export const EMPTY_METRICS: Omit<InstrumentMetrics, "ticker" | "bars"> = {
  volatilityPerBarPct: null,
  volatilityAnnualisedPct: null,
  beta: null,
  correlation: null,
  sma20: null,
  sma50: null,
  trendVsSma20Pct: null,
  momentum5Pct: null,
  momentum20Pct: null,
  maxDrawdownPct: null,
  rangePosition: null,
  highClose: null,
  lowClose: null,
  volumeRatio: null,
};

/** Bars per year for hourly US equity data (6.5 h × 252 sessions). */
export const BARS_PER_YEAR = 1_638;

function returns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    if (prev <= 0) continue;
    out.push(closes[i]! / prev - 1);
  }
  return out;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Population standard deviation of a return series (null with < 2 samples). */
function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const avg = mean(values)!;
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function covariance(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const ax = a.slice(-n);
  const bx = b.slice(-n);
  const axMean = mean(ax)!;
  const bxMean = mean(bx)!;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (ax[i]! - axMean) * (bx[i]! - bxMean);
  return sum / (n - 1);
}

/** Deepest peak-to-trough decline in the series (negative fraction, null with < 2 bars). */
export function maxDrawdownPct(closes: number[]): number | null {
  if (closes.length < 2) return null;
  let peak = closes[0]!;
  let worst = 0;
  for (const close of closes) {
    if (close > peak) peak = close;
    if (peak > 0) {
      const drawdown = close / peak - 1;
      if (drawdown < worst) worst = drawdown;
    }
  }
  return roundTo(worst, 6);
}

/**
 * Metrics for one instrument. `benchmarkCandles` is optional: without it beta
 * and correlation are null and everything else still computes. A series shorter
 * than the relevant window yields null for that metric rather than a guess.
 */
export function computeInstrumentMetrics(
  ticker: string,
  candles: readonly Candle[],
  benchmarkCandles: readonly Candle[] = [],
): InstrumentMetrics {
  const bars = candles.length;
  const closes = candles.map((c) => c.close).filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < 2) return { ticker, bars, ...EMPTY_METRICS };

  const returnsSeries = returns(closes);
  const perBar = stdev(returnsSeries);
  const last = closes.at(-1)!;
  const benchCloses = benchmarkCandles.map((c) => c.close).filter((c) => Number.isFinite(c) && c > 0);
  const benchReturns = returns(benchCloses);
  const benchSd = stdev(benchReturns);
  // Beta is cov(instrument, benchmark) / var(benchmark) — the benchmark's
  // variance, not the instrument's (a ×2 instrument must read beta 2).
  const cov = benchReturns.length >= 2 ? covariance(returnsSeries, benchReturns) : null;
  const benchVariance = benchSd === null ? null : benchSd ** 2;

  const sma = (window: number): number | null =>
    closes.length < window ? null : roundTo(closes.slice(-window).reduce((sum, c) => sum + c, 0) / window, 4);
  const momentum = (window: number): number | null => {
    if (closes.length <= window) return null;
    const then = closes[closes.length - 1 - window]!;
    return then > 0 ? roundTo(last / then - 1, 6) : null;
  };
  const sma20 = sma(20);
  const high = Math.max(...closes);
  const low = Math.min(...closes);
  const volumes = candles.map((c) => c.volume).filter((v) => Number.isFinite(v) && v > 0);
  const avgVolume = mean(volumes);

  return {
    ticker,
    bars,
    volatilityPerBarPct: perBar === null ? null : roundTo(perBar, 6),
    volatilityAnnualisedPct: perBar === null ? null : roundTo(perBar * Math.sqrt(BARS_PER_YEAR), 6),
    beta: cov !== null && benchVariance !== null && benchVariance > 0 ? roundTo(cov / benchVariance, 4) : null,
    correlation:
      cov !== null && perBar !== null && benchSd !== null && perBar > 0 && benchSd > 0
        ? roundTo(cov / (perBar * benchSd), 4)
        : null,
    sma20,
    sma50: sma(50),
    trendVsSma20Pct: sma20 !== null && sma20 > 0 ? roundTo(last / sma20 - 1, 6) : null,
    momentum5Pct: momentum(5),
    momentum20Pct: momentum(20),
    maxDrawdownPct: maxDrawdownPct(closes),
    rangePosition: high > low ? roundTo((last - low) / (high - low), 4) : null,
    highClose: roundTo(high, 4),
    lowClose: roundTo(low, 4),
    volumeRatio: avgVolume !== null && avgVolume > 0 && volumes.length > 0 ? roundTo(volumes.at(-1)! / avgVolume, 4) : null,
  };
}

/**
 * Rebalance band for one name, aware of what a trade costs and how much the name
 * moves (WP-P2.1). A uniform 4 % band (the old default) is simultaneously too
 * tight for a volatile name — it trades noise — and too loose for a calm one
 * whose round trip is cheap.
 *
 *   band = max(configuredBand, costBand, volatilityBand)
 *   costBand       = roundTripCostRatio × costMultiple     (must at least pay for the trip)
 *   volatilityBand = volatilityPerBar × volMultiple        (must be bigger than normal noise)
 */
export function rebalanceBandFor(params: {
  configuredBand: number;
  roundTripCostRatio: number;
  costMultiple: number;
  volatilityPerBarPct: number | null;
  volatilityMultiple: number;
}): number {
  const { configuredBand, roundTripCostRatio, costMultiple, volatilityPerBarPct, volatilityMultiple } = params;
  const costBand = roundTripCostRatio * costMultiple;
  const volBand = volatilityPerBarPct === null ? 0 : volatilityPerBarPct * volatilityMultiple;
  return roundTo(Math.max(configuredBand, costBand, volBand), 4);
}

/**
 * Portfolio risk concentration: the share of NAV in the largest position and a
 * crude Herfindahl-style effective number of positions. Used to warn when a
 * "diversified" book is really one bet (WP-P2.2 uses it for the sector caps).
 */
export function concentration(params: { weights: number[] }): {
  largestWeight: number;
  effectivePositions: number;
  top3Weight: number;
} {
  const sorted = [...params.weights].filter((w) => w > 0).sort((a, b) => b - a);
  const sum = sorted.reduce((total, w) => total + w, 0);
  const squares = sorted.reduce((total, w) => total + w * w, 0);
  return {
    largestWeight: sorted.length > 0 ? roundTo(sorted[0]!, 4) : 0,
    effectivePositions: squares > 0 ? roundTo((sum * sum) / squares, 2) : 0,
    top3Weight: roundValue(sorted.slice(0, 3).reduce((total, w) => total + w, 0), 4),
  };
}
