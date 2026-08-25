import { DomainError } from "../shared/errors.js";
import { roundTo, roundValue, WEIGHT_DP } from "../shared/money.js";

export interface Position {
  ticker: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  /** Instrument currency (ISO 4217), e.g. USD for US stocks. */
  currency: string;
  /** Conversion rate instrument currency → account currency (1 when identical). */
  fxRate?: number;
}

export interface PositionWithValue extends Position {
  /** Value in instrument currency. */
  marketValueLocal: number;
  /** Value in account currency (used for weights and totals). */
  marketValue: number;
  weight: number; // 0..1 of portfolio total value
  unrealizedPnl: number; // account currency
  unrealizedPnlPct: number;
}

export interface PortfolioSnapshot {
  id: string;
  runId: string;
  asOf: string;
  currency: string;
  cash: number;
  positions: PositionWithValue[];
  totalValue: number;
  investedValue: number;
  dayChangePct: number | null;
  /** Day change of the benchmark (e.g. SPY) at snapshot time, for relative performance. */
  benchmarkChangePct: number | null;
}

export interface AllocationTarget {
  ticker: string;
  weight: number; // 0..1
}

export interface AllocationDrift {
  ticker: string;
  targetWeight: number;
  currentWeight: number;
  drift: number; // current - target, positive = overweight
  insideBand: boolean;
  hint: "buy" | "sell" | "hold";
}

/**
 * Portfolio aggregate: builds snapshots from raw broker positions and computes
 * allocation drift against the plan. Pure domain logic, no I/O.
 */
export function buildPortfolioSnapshot(params: {
  id: string;
  runId: string;
  asOf: string;
  currency: string;
  cash: number;
  positions: Position[];
  prevTotalValue: number | null;
  benchmarkChangePct?: number | null;
}): PortfolioSnapshot {
  const withValue: PositionWithValue[] = params.positions.map((p) => {
    const fxRate = p.fxRate ?? 1;
    const marketValueLocal = roundValue(p.quantity * p.currentPrice);
    const marketValue = roundValue(marketValueLocal * fxRate);
    return { ...p, fxRate, marketValueLocal, marketValue, weight: 0, unrealizedPnl: 0, unrealizedPnlPct: 0 };
  });
  const investedValue = roundValue(withValue.reduce((sum, p) => sum + p.marketValue, 0));
  const totalValue = roundValue(investedValue + params.cash);
  if (totalValue <= 0) throw new DomainError("portfolio total value must be positive");
  for (const p of withValue) {
    p.weight = roundTo(p.marketValue / totalValue, WEIGHT_DP);
    p.unrealizedPnl = roundValue((p.currentPrice - p.averagePrice) * p.quantity * (p.fxRate ?? 1));
    p.unrealizedPnlPct =
      p.averagePrice > 0 ? roundValue(((p.currentPrice - p.averagePrice) / p.averagePrice) * 100) : 0;
  }
  const dayChangePct =
    params.prevTotalValue !== null && params.prevTotalValue > 0
      ? roundValue(((totalValue - params.prevTotalValue) / params.prevTotalValue) * 100)
      : null;
  return {
    id: params.id,
    runId: params.runId,
    asOf: params.asOf,
    currency: params.currency,
    cash: roundValue(params.cash),
    positions: withValue,
    totalValue,
    investedValue,
    dayChangePct,
    benchmarkChangePct: params.benchmarkChangePct ?? null,
  };
}

export function computeDrift(snapshot: PortfolioSnapshot, targets: AllocationTarget[], band: number): AllocationDrift[] {
  const byTicker = new Map(snapshot.positions.map((p) => [p.ticker, p.weight]));
  const drift = targets.map((t) => {
    if (t.weight < 0 || t.weight > 1) throw new DomainError(`invalid target weight for ${t.ticker}: ${t.weight}`);
    const currentWeight = byTicker.get(t.ticker) ?? 0;
    const d = roundTo(currentWeight - t.weight, WEIGHT_DP);
    const insideBand = Math.abs(d) <= band;
    let hint: "buy" | "sell" | "hold" = "hold";
    if (!insideBand) hint = d < 0 ? "buy" : "sell";
    return { ticker: t.ticker, targetWeight: t.weight, currentWeight, drift: d, insideBand, hint };
  });
  const sum = roundValue(targets.reduce((s, t) => s + t.weight, 0));
  if (sum > 1 + 1e-9) throw new DomainError(`target weights sum to ${sum} (>1)`);
  return drift;
}

/** Portfolio heat: Σ weight × (1 − stopDistance) — risk capital at stake per name. */
export function computeHeat(snapshot: PortfolioSnapshot, stopDistancePct: number): number {
  return roundTo(snapshot.positions.reduce((sum, p) => sum + p.weight * (1 - stopDistancePct), 0), WEIGHT_DP);
}

/** Money-weighted unitized NAV ledger (same accounting used by the reference fund). */
export class NavLedger {
  private units = 0;
  private navPerUnit = 0;
  private started = false;

  recordValue(totalValue: number): void {
    if (!this.started) {
      this.started = true;
      this.units = 1000;
      this.navPerUnit = roundValue(totalValue / this.units);
      return;
    }
    if (this.units > 0) this.navPerUnit = roundValue(totalValue / this.units);
  }

  /** Cash flow in/out adjusts units so flows never distort performance. */
  applyCashFlow(amount: number): void {
    if (this.units === 0) throw new DomainError("cannot apply cash flow before ledger start");
    const extraUnits = roundValue(amount / this.navPerUnit);
    this.units += extraUnits;
  }

  get state(): { units: number; navPerUnit: number } {
    return { units: this.units, navPerUnit: this.navPerUnit };
  }
}
