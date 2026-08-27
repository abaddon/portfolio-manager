import { describe, expect, it } from "vitest";
import { buildPortfolioSnapshot, computeDrift, computeHeat, NavLedger } from "../../src/domain/portfolio.js";

const snapshotParams = (over: Partial<Parameters<typeof buildPortfolioSnapshot>[0]> = {}) => ({
  id: "snap1",
  runId: "run1",
  asOf: "2026-08-26T14:00:00Z",
  currency: "GBP",
  cash: 5_000,
  positions: [
    { ticker: "MSFT", quantity: 2, averagePrice: 400, currentPrice: 420, currency: "USD", fxRate: 0.79 },
    { ticker: "VUSA.L", quantity: 5, averagePrice: 80, currentPrice: 88, currency: "GBP", fxRate: 1 },
  ],
  prevTotalValue: null,
  ...over,
});

describe("buildPortfolioSnapshot", () => {
  it("converts instrument values into the account currency", () => {
    const snap = buildPortfolioSnapshot(snapshotParams());
    const msft = snap.positions.find((p) => p.ticker === "MSFT")!;
    expect(msft.marketValueLocal).toBeCloseTo(840, 2); // 2 × 420 USD
    expect(msft.marketValue).toBeCloseTo(663.6, 2); // × 0.79 → GBP
    const vusa = snap.positions.find((p) => p.ticker === "VUSA.L")!;
    expect(vusa.marketValue).toBeCloseTo(440, 2); // 5 × 88 GBP
    expect(snap.investedValue).toBeCloseTo(1103.6, 2);
    expect(snap.totalValue).toBeCloseTo(6103.6, 2);
  });

  it("computes weights and unrealized P&L in account currency", () => {
    const snap = buildPortfolioSnapshot(snapshotParams());
    const msft = snap.positions.find((p) => p.ticker === "MSFT")!;
    expect(msft.weight).toBeCloseTo(663.6 / 6103.6, 4);
    expect(msft.unrealizedPnl).toBeCloseTo((420 - 400) * 2 * 0.79, 2);
    expect(msft.unrealizedPnlPct).toBeCloseTo(5, 2);
  });

  it("computes day change against the previous total value", () => {
    const snap = buildPortfolioSnapshot(snapshotParams({ prevTotalValue: 6_000 }));
    expect(snap.dayChangePct).toBeCloseTo(1.7267, 2);
  });

  it("carries the benchmark day change when provided", () => {
    expect(buildPortfolioSnapshot(snapshotParams()).benchmarkChangePct).toBeNull();
    const snap = buildPortfolioSnapshot(snapshotParams({ benchmarkChangePct: 0.42 }));
    expect(snap.benchmarkChangePct).toBeCloseTo(0.42, 2);
  });

  it("rejects empty portfolios", () => {
    expect(() =>
      buildPortfolioSnapshot(snapshotParams({ cash: 0, positions: [] })),
    ).toThrow(/positive/);
  });
});

describe("computeDrift", () => {
  const snap = buildPortfolioSnapshot(snapshotParams());
  const targets = [
    { ticker: "MSFT", weight: 0.15 },
    { ticker: "VUSA.L", weight: 0.05 },
    { ticker: "NVDA", weight: 0.1 },
  ];

  it("measures drift against targets and flags band breaches", () => {
    const drift = computeDrift(snap, targets, 0.04);
    const msft = drift.find((d) => d.ticker === "MSFT")!;
    expect(msft.currentWeight).toBeCloseTo(663.6 / 6103.6, 4);
    expect(msft.drift).toBeCloseTo(msft.currentWeight - 0.15, 4);
    expect(msft.hint).toBe("buy"); // 10.9% vs 15% target → underweight
    const nvda = drift.find((d) => d.ticker === "NVDA")!;
    expect(nvda.currentWeight).toBe(0);
    expect(nvda.hint).toBe("buy"); // not held
    const vusa = drift.find((d) => d.ticker === "VUSA.L")!;
    expect(vusa.hint).toBe("hold"); // 7.2% vs 5% target = 2.2% drift ≤ 4% band
    expect(vusa.insideBand).toBe(true);
  });

  it("rejects target weights above 1", () => {
    expect(() => computeDrift(snap, [{ ticker: "X", weight: 1.1 }], 0.04)).toThrow(/invalid target/);
    expect(() => computeDrift(snap, [{ ticker: "A", weight: 0.6 }, { ticker: "B", weight: 0.6 }], 0.04)).toThrow(/sum/);
  });
});

describe("computeHeat", () => {
  it("weights each position by its stop distance", () => {
    const snap = buildPortfolioSnapshot(snapshotParams());
    expect(computeHeat(snap, 0.1)).toBeCloseTo((663.6 + 440) / 6103.6 * 0.9, 4);
  });
});

describe("NavLedger (unitized accounting)", () => {
  it("starts at 1000 units and cash flows adjust units, not performance", () => {
    const ledger = new NavLedger();
    ledger.recordValue(10_000);
    expect(ledger.state).toEqual({ units: 1000, navPerUnit: 10 });
    ledger.applyCashFlow(1000); // deposit → more units at current NAV
    expect(ledger.state.units).toBeCloseTo(1100, 2);
    ledger.recordValue(11_000); // NAV unchanged by the deposit alone
    expect(ledger.state.navPerUnit).toBeCloseTo(10, 2);
    ledger.recordValue(12_100); // +10% market move → NAV +10%
    expect(ledger.state.navPerUnit).toBeCloseTo(11, 2);
  });
});

describe("NavLedger.resume (continuing a persisted ledger)", () => {
  it("resumes from persisted units/NAV and applies withdrawals before the next valuation", () => {
    const ledger = NavLedger.resume({ units: 1100, navPerUnit: 10 });
    expect(ledger.state).toEqual({ units: 1100, navPerUnit: 10 });
    ledger.applyCashFlow(-550); // withdrawal → fewer units at the current NAV
    expect(ledger.state.units).toBeCloseTo(1045, 4);
    ledger.recordValue(10_450); // value net of the withdrawal → NAV unchanged
    expect(ledger.state.navPerUnit).toBeCloseTo(10, 4);
  });
});
