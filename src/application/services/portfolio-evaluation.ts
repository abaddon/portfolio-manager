import { newId } from "../../shared/id.js";
import { toIso } from "../../shared/clock.js";
import { roundValue } from "../../shared/money.js";
import { DomainError } from "../../shared/errors.js";
import { buildPortfolioSnapshot, computeDrift, computeHeat, NavLedger, type AllocationDrift, type AllocationTarget, type PortfolioSnapshot, type Position } from "../../domain/portfolio.js";
import type { AppPorts, CashFlow } from "../ports.js";

export interface PortfolioEvaluation {
  snapshot: PortfolioSnapshot;
  drift: AllocationDrift[];
  heat: number; // fraction of NAV at risk
  nav: { units: number; navPerUnit: number };
}

/**
 * Builds the portfolio snapshot from the broker (source of truth), converts
 * instrument currencies into the account currency, computes allocation drift
 * and portfolio heat, and persists both the snapshot and the unitized NAV.
 *
 * NAV is money-weighted: external cash flows since the previous snapshot
 * (broker transactions feed, when available) mint/redeem units at the previous
 * NAV before the new valuation, so deposits and withdrawals never count as
 * performance. A failing feed is contained (WARN, units unchanged this run).
 */
export class PortfolioEvaluationService {
  constructor(
    private readonly ports: AppPorts,
    private readonly seedTargets: AllocationTarget[],
    private readonly rebalanceBand: number,
    private readonly stopDistancePct: number,
    private readonly benchmark: string | null = null,
  ) {}

  /** Effective targets: allocation-review updates override the config seeds. */
  async currentTargets(): Promise<AllocationTarget[]> {
    const current = await this.ports.allocationTargets.current();
    // Bootstrapped allocation (no configured seeds): the repo rows ARE the targets.
    if (this.seedTargets.length === 0) return current;
    // Configured seeds: repo rows override, but only for tickers still in the seeds.
    const byTicker = new Map(this.seedTargets.map((t) => [t.ticker, t]));
    for (const t of current) if (byTicker.has(t.ticker)) byTicker.set(t.ticker, t);
    return [...byTicker.values()];
  }

  async evaluate(runId: string): Promise<PortfolioEvaluation> {
    const account = await this.ports.broker.account();
    const rawPositions = await this.ports.broker.positions();
    const now = toIso(this.ports.clock.now());

    // Benchmark day change for relative performance (contained failure).
    let benchmarkChangePct: number | null = null;
    if (this.benchmark) {
      try {
        benchmarkChangePct = (await this.ports.prices.quote(this.benchmark)).changePct;
      } catch (err) {
        this.ports.logger.warn(`benchmark quote unavailable for ${this.benchmark}`, { error: String(err) });
      }
    }

    // Enrich positions with live quotes (fall back to broker-reported price)
    // and FX conversion into the account currency.
    const positions: Position[] = [];
    for (const p of rawPositions) {
      let currentPrice = p.currentPrice;
      try {
        const q = await this.ports.prices.quote(p.ticker);
        currentPrice = q.price;
      } catch (err) {
        this.ports.logger.warn(`quote unavailable for ${p.ticker}, using broker price`, { error: String(err) });
      }
      const fxRate =
        p.currency === account.currency
          ? 1
          : await this.ports.fx
              .rate(p.currency, account.currency)
              .catch((err) => {
                this.ports.logger.warn(`fx rate unavailable for ${p.currency}>${account.currency}, assuming 1`, {
                  error: String(err),
                });
                return 1;
              });
      positions.push({ ...p, currentPrice, fxRate });
    }

    const prev = await this.ports.portfolio.latest();
    const snapshot = buildPortfolioSnapshot({
      id: newId("snap"),
      runId,
      asOf: now,
      currency: account.currency,
      cash: account.cash,
      positions,
      prevTotalValue: prev?.totalValue ?? null,
      benchmarkChangePct,
    });

    await this.ports.portfolio.save(snapshot);

    const targets = await this.currentTargets();
    const drift = computeDrift(snapshot, targets, this.rebalanceBand);
    const heat = computeHeat(snapshot, this.stopDistancePct);

    const prevNav = await this.ports.portfolio.latestNav();
    const ledger = prevNav ? NavLedger.resume(prevNav) : new NavLedger();
    if (prevNav && prev && this.ports.broker.cashFlows) {
      await this.applyCashFlows(ledger, runId, prev.asOf, now, account.currency);
    }
    ledger.recordValue(snapshot.totalValue);
    const { units, navPerUnit } = ledger.state;
    await this.ports.portfolio.saveNav(runId, now, units, navPerUnit, snapshot.totalValue);

    return { snapshot, drift, heat, nav: { units, navPerUnit } };
  }

  /** Applies deposits/withdrawals in (sinceIso, now] to the ledger; every failure is contained. */
  private async applyCashFlows(ledger: NavLedger, runId: string, sinceIso: string, now: string, accountCurrency: string): Promise<void> {
    let flows: CashFlow[];
    try {
      flows = await this.ports.broker.cashFlows!(sinceIso);
    } catch (err) {
      this.ports.logger.warn("broker cash flows unavailable — NAV units left unchanged this run", { error: String(err) });
      return;
    }
    const since = new Date(sinceIso).getTime();
    const applied: { amount: number; original: CashFlow }[] = [];
    for (const flow of flows) {
      const at = new Date(flow.occurredAt).getTime();
      if (!Number.isFinite(at) || at <= since) continue;
      let amount = flow.amount;
      if (flow.currency !== accountCurrency) {
        try {
          amount = roundValue(flow.amount * (await this.ports.fx.rate(flow.currency, accountCurrency)));
        } catch (err) {
          this.ports.logger.warn(`fx rate unavailable for cash flow ${flow.currency}>${accountCurrency}, flow skipped`, { error: String(err) });
          continue;
        }
      }
      try {
        ledger.applyCashFlow(amount);
        applied.push({ amount, original: flow });
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        this.ports.logger.warn(`cash flow ${flow.reference ?? flow.occurredAt} not applied to NAV: ${err.message}`);
      }
    }
    if (applied.length === 0) return;
    const netAmount = roundValue(applied.reduce((sum, f) => sum + f.amount, 0));
    this.ports.logger.info(`NAV cash flows applied: ${applied.length} flow(s), net ${netAmount} ${accountCurrency}`);
    this.ports.events.publish({
      id: newId("evt"),
      runId,
      type: "NavCashFlowsApplied",
      payload: {
        count: applied.length,
        netAmount,
        currency: accountCurrency,
        since: sinceIso,
        until: now,
        flows: applied.map((f) => ({ ...f.original, accountAmount: f.amount })),
        units: ledger.state.units,
      },
      occurredAt: now,
    });
  }
}
