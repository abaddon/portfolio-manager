/**
 * Money-safe arithmetic helpers. Floats are used for storage/display but every
 * monetary boundary is rounded to a fixed precision (4 dp for prices, 2 dp for
 * values) so the ledger stays deterministic and testable.
 */

export const PRICE_DP = 4;
export const VALUE_DP = 2;
export const WEIGHT_DP = 4;

export function roundTo(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}

export function roundPrice(n: number): number {
  return roundTo(n, PRICE_DP);
}

export function roundValue(n: number, dp: number = VALUE_DP): number {
  return roundTo(n, dp);
}

export function pctToFraction(pct: number): number {
  return pct / 100;
}

export function fractionToPct(fraction: number): number {
  return roundTo(fraction * 100, 3);
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
