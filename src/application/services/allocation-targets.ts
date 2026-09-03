import type { AllocationTarget } from "../../domain/portfolio.js";
import type { AppPorts } from "../ports.js";

/**
 * The effective asset allocation: persisted committee updates override the
 * configured seeds. This is the only allocation source in the unified
 * committee flow (ADR 0009) — the committee session is the sole producer of
 * target updates (see CommitteeService.applyWinnerTargets).
 */
export class AllocationTargetsService {
  constructor(
    private readonly ports: AppPorts,
    private readonly seeds: AllocationTarget[],
  ) {}

  /** Current effective targets: persisted updates override the config seeds. */
  async currentTargets(): Promise<AllocationTarget[]> {
    const current = await this.ports.allocationTargets.current();
    // Bootstrapped allocation (no configured seeds): the repo rows ARE the targets.
    if (this.seeds.length === 0) return current;
    // Configured seeds: repo rows override, but only for tickers still in the seeds.
    const byTicker = new Map(this.seeds.map((t) => [t.ticker, t]));
    for (const t of current) if (byTicker.has(t.ticker)) byTicker.set(t.ticker, t);
    return [...byTicker.values()];
  }
}
