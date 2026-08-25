import { newId } from "../../shared/id.js";
import { toIso } from "../../shared/clock.js";
import { roundTo } from "../../shared/money.js";
import { buildPortfolioSnapshot, computeDrift, computeHeat, type AllocationDrift, type AllocationTarget, type PortfolioSnapshot, type Position } from "../../domain/portfolio.js";
import type { AppPorts } from "../ports.js";

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
 */
export class PortfolioEvaluationService {
  constructor(
    private readonly ports: AppPorts,
    private readonly targets: AllocationTarget[],
    private readonly rebalanceBand: number,
    private readonly stopDistancePct: number,
  ) {}

  async evaluate(runId: string): Promise<PortfolioEvaluation> {
    const account = await this.ports.broker.account();
    const rawPositions = await this.ports.broker.positions();
    const now = toIso(this.ports.clock.now());

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
    });

    await this.ports.portfolio.save(snapshot);

    const drift = computeDrift(snapshot, this.targets, this.rebalanceBand);
    const heat = computeHeat(snapshot, this.stopDistancePct);

    const prevNav = await this.ports.portfolio.latestNav();
    const units = prevNav?.units ?? 1000;
    const navPerUnit = roundTo(snapshot.totalValue / units, 4);
    await this.ports.portfolio.saveNav(runId, now, units, navPerUnit, snapshot.totalValue);

    return { snapshot, drift, heat, nav: { units, navPerUnit } };
  }
}
