import { describe, expect, it } from "vitest";
import { roundTo, roundValue, roundPrice, clamp } from "../../src/shared/money.js";

describe("money rounding is sign-symmetric", () => {
  it("rounds halves away from zero on both signs", () => {
    // The old implementation used bare Math.round, which breaks ties toward +∞:
    // roundTo(-0.125, 2) returned -0.12 while roundTo(0.125, 2) returned 0.13.
    expect(roundTo(0.125, 2)).toBeCloseTo(0.13, 10);
    expect(roundTo(-0.125, 2)).toBeCloseTo(-0.13, 10);
    expect(roundTo(12.5, 0)).toBe(13);
    expect(roundTo(-12.5, 0)).toBe(-13);
    expect(roundTo(1.005, 2)).toBeCloseTo(1.01, 10);
    expect(roundTo(-1.005, 2)).toBeCloseTo(-1.01, 10);
  });

  it("satisfies roundValue(-x) === -roundValue(x) for ledger amounts", () => {
    for (const v of [0.005, 1.005, 2.675, 123.456, 0.001, 99.994]) {
      expect(roundValue(-v)).toBeCloseTo(-roundValue(v), 10);
    }
    for (const v of [1.23456, 9.99999]) {
      expect(roundPrice(-v)).toBeCloseTo(-roundPrice(v), 10);
    }
  });

  it("never returns negative zero", () => {
    expect(Object.is(roundTo(-0.001, 2), 0)).toBe(true);
    expect(Object.is(roundTo(-0, 2), 0)).toBe(true);
    expect(Object.is(roundValue(-0.0001), 0)).toBe(true);
  });

  it("leaves exact values and clamping untouched", () => {
    expect(roundValue(12.34)).toBe(12.34);
    expect(roundValue(-12.34)).toBe(-12.34);
    expect(roundTo(0, 4)).toBe(0);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(5, 0, 1)).toBe(1);
  });
});
