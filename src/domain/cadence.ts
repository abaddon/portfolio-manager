import type { AllocationDrift } from "./portfolio.js";

/**
 * Why a run should (or should not) spend tokens on analysts and the committee
 * (WP-P1.1). Every trigger is evaluated from data the cheap hourly pass already
 * has, so the decision costs nothing.
 */
export type CadenceTriggerKind =
  | "drift"
  | "nav-move"
  | "unfunded-target"
  | "new-news"
  | "planning-slot"
  | "manual"
  | "always";

export interface CadenceInput {
  drift: AllocationDrift[];
  /** |NAV change| since the previous run, as a fraction (null on the first run). */
  navMovePct: number | null;
  /** Hours since the last completed run (null when there is none). */
  hoursSinceLastRun: number | null;
  /** True when any target is marked UNFUNDED after the previous session. */
  hasUnfundedTargets: boolean;
  /** Headlines gathered since the previous run (already deduplicated). */
  newHeadlines: string[];
}

export interface CadenceConfig {
  triggerMode: "always" | "material";
  navMovePct: number;
  driftPct: number;
  planningIntervalHours: number;
  newsLookbackHours: number;
}

export interface CadenceDecision {
  /** True when the expensive path (analysis + committee) should run. */
  material: boolean;
  /** Every trigger that fired, most significant first. */
  triggers: CadenceTriggerKind[];
  /** One line explaining the decision, for the run summary and the dashboard. */
  reason: string;
}

/**
 * Pure materiality test. The default is to **not** spend: an hourly full
 * committee session on a multi-week allocation produced no measurable edge and
 * ~37 inference calls per run (see docs/DECISION_PROCESS_REVIEW.md §3, §6.1).
 * A run with no trigger still snapshots the portfolio, evaluates drift/heat/NAV
 * and sweeps orders — it just does not buy an opinion about it.
 *
 * `force` (the dashboard button and `pnpm run-once --force`) and
 * `triggerMode: "always"` bypass the test entirely.
 */
export function evaluateCadence(input: CadenceInput, cfg: CadenceConfig, opts: { force?: boolean } = {}): CadenceDecision {
  if (cfg.triggerMode === "always") {
    return { material: true, triggers: ["always"], reason: "triggerMode=always — every market hour runs the full path" };
  }
  if (opts.force) {
    return { material: true, triggers: ["manual"], reason: "manual/forced run" };
  }

  const triggers: CadenceTriggerKind[] = [];
  const details: string[] = [];

  if (input.hasUnfundedTargets) {
    triggers.push("unfunded-target");
    details.push("a previous session left an unfunded target");
  }

  const outsideBand = input.drift.filter((d) => !d.insideBand);
  if (outsideBand.length > 0) {
    const worst = outsideBand.reduce((a, b) => (Math.abs(b.drift) > Math.abs(a.drift) ? b : a));
    const threshold = Math.max(cfg.driftPct, 0);
    if (threshold === 0 || Math.abs(worst.drift) >= threshold) {
      triggers.push("drift");
      details.push(
        `${outsideBand.length} target(s) outside the band, worst ${worst.ticker} ${(worst.drift * 100).toFixed(1)}pp`,
      );
    }
  }

  if (input.navMovePct !== null && Math.abs(input.navMovePct) >= cfg.navMovePct) {
    triggers.push("nav-move");
    details.push(`NAV moved ${(input.navMovePct * 100).toFixed(2)}% since the last run`);
  }

  if (input.newHeadlines.length > 0) {
    triggers.push("new-news");
    details.push(`${input.newHeadlines.length} new headline(s) since the last run`);
  }

  if (input.hoursSinceLastRun !== null && input.hoursSinceLastRun >= cfg.planningIntervalHours) {
    triggers.push("planning-slot");
    details.push(`${input.hoursSinceLastRun.toFixed(1)}h since the last session (planning slot)`);
  }
  if (input.hoursSinceLastRun === null) {
    triggers.push("planning-slot");
    details.push("no previous session on record");
  }

  return {
    material: triggers.length > 0,
    triggers,
    reason: triggers.length > 0 ? details.join("; ") : "nothing material changed — stats-only pass (no LLM spend)",
  };
}
