import { newId } from "../../shared/id.js";
import { toIso } from "../../shared/clock.js";
import { ConfigurationError } from "../../shared/errors.js";
import { buildPortfolioSnapshot, type AllocationTarget, type Position } from "../../domain/portfolio.js";
import type { AppPorts } from "../ports.js";

export interface BootstrapResult {
  bootstrapped: boolean;
  targets: AllocationTarget[];
}

/**
 * Allocation bootstrap: when no targets are configured (empty config list)
 * and none exist from a previous review, the EXISTING broker portfolio IS the
 * allocation — its current weights become the initial targets (persisted as
 * the first "review" rows), and the normal workflow (review → evaluate →
 * decide) proceeds from there.
 */
export class AllocationBootstrapService {
  constructor(private readonly ports: AppPorts, private readonly seeds: AllocationTarget[]) {}

  async bootstrapIfNeeded(runId: string): Promise<BootstrapResult> {
    // Reviewed/derived targets already exist → nothing to bootstrap.
    const existing = await this.ports.allocationTargets.current();
    if (existing.length > 0) return { bootstrapped: false, targets: existing };

    // Explicitly configured seeds → use them.
    if (this.seeds.length > 0) return { bootstrapped: false, targets: this.seeds };

    // Derive from the broker: source of truth for the existing allocation.
    const account = await this.ports.broker.account();
    const rawPositions = await this.ports.broker.positions();
    if (rawPositions.length === 0) {
      throw new ConfigurationError(
        "no allocation targets configured and the broker account holds no positions — " +
          "define allocation.targets in the config or hold positions in the account",
      );
    }

    const now = toIso(this.ports.clock.now());
    const positions: Position[] = [];
    for (const p of rawPositions) {
      let currentPrice = p.currentPrice;
      try {
        currentPrice = (await this.ports.prices.quote(p.ticker)).price;
      } catch {
        // broker-reported price is good enough for the bootstrap
      }
      const fxRate =
        p.currency === account.currency
          ? 1
          : await this.ports.fx.rate(p.currency, account.currency).catch(() => 1);
      positions.push({ ...p, currentPrice, fxRate });
    }

    const snapshot = buildPortfolioSnapshot({
      id: newId("snap"),
      runId,
      asOf: now,
      currency: account.currency,
      cash: account.cash,
      positions,
      prevTotalValue: null,
    });

    const updates = snapshot.positions
      .filter((p) => p.weight > 0)
      .map((p) => ({
        id: newId("tg"),
        runId,
        ticker: p.ticker,
        weight: p.weight,
        originalWeight: p.weight,
        rationale: "bootstrapped from the existing broker portfolio",
        conviction: 1,
        updatedAt: now,
      }));
    await this.ports.allocationTargets.saveUpdates(updates);

    const targets: AllocationTarget[] = updates.map((u) => ({ ticker: u.ticker, weight: u.weight }));
    this.ports.events.publish({
      id: newId("evt"),
      runId,
      type: "TargetsBootstrapped",
      payload: { targets: targets.map((t) => ({ ticker: t.ticker, weight: t.weight })) },
      occurredAt: now,
    });
    this.ports.logger.info(
      `allocation bootstrapped from the existing portfolio: ${targets.map((t) => `${t.ticker} ${(t.weight * 100).toFixed(1)}%`).join(", ")}`,
    );
    return { bootstrapped: true, targets };
  }
}
