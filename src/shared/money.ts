/**
 * Money-safe arithmetic helpers. Floats are used for storage/display but every
 * monetary boundary is rounded to a fixed precision (4 dp for prices, 2 dp for
 * values) so the ledger stays deterministic and testable.
 */

export const PRICE_DP = 4;
export const VALUE_DP = 2;
export const WEIGHT_DP = 4;

/**
 * Half-away-from-zero rounding, symmetric in sign: `roundTo(-x, dp) ===
 * -roundTo(x, dp)`. `Math.round` alone breaks ties toward +∞, which rounded
 * negative money toward zero (roundTo(-0.125, 2) was -0.12, not -0.13) and
 * could return -0 for the ledger. The epsilon compensates binary
 * representation on the magnitude, so it applies with the right sign.
 */
export function roundTo(n: number, dp: number): number {
  const f = 10 ** dp;
  const rounded = (n < 0 ? -1 : 1) * Math.round((Math.abs(n) + Number.EPSILON) * f) / f;
  return rounded === 0 ? 0 : rounded; // normalise -0
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
