import { newId } from "../../shared/id.js";
import { toIso } from "../../shared/clock.js";
import { clamp, roundTo, WEIGHT_DP } from "../../shared/money.js";
import type { AnalysisReport } from "../../domain/analysis.js";
import type { AllocationTarget, AllocationTargetUpdate } from "../../domain/portfolio.js";
import type { AppPorts } from "../ports.js";
import { DEFAULT_WEIGHTS } from "./decisions.js";

export interface AllocationReviewConfig {
  enabled: boolean;
  /** Maximum target-weight change per run (fraction of portfolio). */
  maxDeltaPerRun: number;
  /** Minimum aggregated analyst conviction before a target is touched. */
  minConviction: number;
  /** No single name may exceed this target weight. */
  maxTarget: number;
  /** Total invested targets may not exceed 1 - this cash floor. */
  minCashBuffer: number;
}

export interface AllocationReviewResult {
  updates: AllocationTargetUpdate[];
  targets: AllocationTarget[];
}

/**
 * The allocation-review step: after analysis, each ticker's target weight is
 * re-examined. Analysts propose adjustments via their targetWeightAdjustment
 * signals; changes apply only with sufficient conviction, bounded per run,
 * capped per name, and kept under the cash floor. Every change is persisted
 * with its rationale — the dashboard shows the evolving allocation and why.
 */
export class AllocationReviewService {
  constructor(
    private readonly ports: AppPorts,
    private readonly seeds: AllocationTarget[],
    private readonly cfg: AllocationReviewConfig,
  ) {}

  /** Current effective targets: persisted reviews override the config seeds. */
  async currentTargets(): Promise<AllocationTarget[]> {
    const current = await this.ports.allocationTargets.current();
    const byTicker = new Map(this.seeds.map((t) => [t.ticker, t]));
    for (const t of current) if (byTicker.has(t.ticker)) byTicker.set(t.ticker, t);
    return [...byTicker.values()];
  }

  async review(runId: string, reports: AnalysisReport[]): Promise<AllocationReviewResult> {
    const current = await this.currentTargets();
    if (!this.cfg.enabled || reports.length === 0) {
      return { updates: [], targets: current };
    }

    const byTicker = new Map<string, AnalysisReport[]>();
    for (const r of reports) {
      const list = byTicker.get(r.ticker) ?? [];
      list.push(r);
      byTicker.set(r.ticker, list);
    }

    // Proposals: conviction-gated, per-run bounded, per-name capped.
    const proposals = new Map<string, { target: AllocationTarget; weight: number; conviction: number }>();
    for (const target of current) {
      const rs = byTicker.get(target.ticker) ?? [];
      const signal = this.aggregate(rs, (r) => r.signals.targetWeightAdjustment);
      const conviction = this.aggregate(rs, (r) => r.signals.confidence);
      if (rs.length === 0 || conviction < this.cfg.minConviction) continue;
      const delta = clamp(signal, -this.cfg.maxDeltaPerRun, this.cfg.maxDeltaPerRun);
      const weight = roundTo(clamp(target.weight + delta, 0, this.cfg.maxTarget), WEIGHT_DP);
      if (Math.abs(weight - target.weight) < 1e-4) continue;
      proposals.set(target.ticker, { target, weight, conviction });
    }
    if (proposals.size === 0) return { updates: [], targets: current };

    // Cash floor: scale proposals down proportionally if the new total would
    // leave less cash than configured.
    const totalAfter = current.reduce(
      (sum, t) => sum + (proposals.get(t.ticker)?.weight ?? t.weight),
      0,
    );
    const cap = 1 - this.cfg.minCashBuffer;
    const scale = totalAfter > cap ? cap / totalAfter : 1;

    const now = toIso(this.ports.clock.now());
    const updates: AllocationTargetUpdate[] = [];
    for (const p of proposals.values()) {
      const weight = roundTo(p.weight * scale, WEIGHT_DP);
      if (Math.abs(weight - p.target.weight) < 1e-4) continue;
      const rs = byTicker.get(p.target.ticker) ?? [];
      const rationale = rs
        .map((r) => `${r.analyst}: ${r.rationale}`)
        .join(" | ")
        .slice(0, 400);
      updates.push({
        id: newId("tg"),
        runId,
        ticker: p.target.ticker,
        weight,
        originalWeight: this.seeds.find((s) => s.ticker === p.target.ticker)?.weight ?? p.target.weight,
        rationale,
        conviction: roundTo(p.conviction, 4),
        updatedAt: now,
      });
    }
    await this.ports.allocationTargets.saveUpdates(updates);
    return { updates, targets: await this.currentTargets() };
  }

  private aggregate(reports: AnalysisReport[], pick: (r: AnalysisReport) => number): number {
    let totalWeight = 0;
    let weighted = 0;
    for (const r of reports) {
      const w = DEFAULT_WEIGHTS[r.analyst] ?? 0.25;
      totalWeight += w;
      weighted += pick(r) * w;
    }
    return totalWeight > 0 ? roundTo(weighted / totalWeight, 4) : 0;
  }
}
