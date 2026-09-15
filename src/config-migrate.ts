import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { ConfigurationError } from "./shared/errors.js";
import { DecisionEngine } from "./domain/decision.js";
import { loadConfig } from "./config.js";

export interface ConfigMigrationChange {
  /** Dotted path of the key that changed. */
  path: string;
  from: unknown;
  to: unknown;
  /** Why the change was made. */
  reason: string;
}

export interface ConfigMigrationReport {
  /** The config file that was inspected. */
  path: string;
  changes: ConfigMigrationChange[];
  /** Effects of the new version that apply even though no key changed. */
  notes: string[];
  /** Warnings worth reading before starting the service. */
  warnings: string[];
  /** True when the config was written back to disk. */
  written: boolean;
  /** Backup path when the file was rewritten. */
  backup: string | null;
}

/** Reads the user's overlay and validates the EFFECTIVE config with the real loader. */
function loadUserConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) throw new ConfigurationError(`config not found: ${path}`);
  let user: Record<string, unknown>;
  try {
    user = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigurationError(`cannot parse ${path}: ${String(err)}`);
  }
  // The effective config (default.json ← local.json ← overlay) must validate;
  // a failure here means migration cannot fix it (a mistyped enum, a missing
  // section), so it is surfaced rather than guessed at.
  loadConfig({ overlayPath: path, env: {} as NodeJS.ProcessEnv });
  return user;
}

function section(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = target[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) return existing as Record<string, unknown>;
  const created: Record<string, unknown> = {};
  target[key] = created;
  return created;
}

function setIfAbsent(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  changes: ConfigMigrationChange[],
  scope: string,
  reason: string,
): void {
  if (target[key] !== undefined) return;
  target[key] = value;
  changes.push({ path: `${scope}.${key}`, from: undefined, to: value, reason });
}

function removeKey(
  target: Record<string, unknown>,
  key: string,
  changes: ConfigMigrationChange[],
  scope: string,
  reason: string,
): unknown {
  if (target[key] === undefined) return undefined;
  const from = target[key];
  delete target[key];
  changes.push({ path: `${scope}.${key}`, from, to: undefined, reason });
  return from;
}

/**
 * Brings an older `config/local.json` onto the current schema (ADR 0012 and the
 * WP-P1/P2 work packages). Pure: it edits the object you hand it and reports what
 * it did, so it can be unit-tested and dry-run.
 *
 * Two classes of change:
 *  - **removed keys** are migrated to their replacement, carrying the user's
 *    intent forward (`expectedReturnPerTradePct` → `baseEdgePct`/`maxEdgePct`);
 *  - **new keys** are written explicitly at the value the new version defaults to,
 *    so the behaviour the user gets is visible in their own file rather than
 *    hidden in `default.json`.
 *
 * It also refuses to leave behind a gate that cannot trade: if the strongest
 * possible signal cannot beat the round trip, `baseEdgePct` is raised to the
 * smallest workable value and the change is reported (this is the failure that
 * produced 36 runs and 0 orders).
 */
export function migrateConfig(user: Record<string, unknown>): { changes: ConfigMigrationChange[]; notes: string[]; warnings: string[] } {
  const changes: ConfigMigrationChange[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  const risk = section(user, "risk");
  const allocation = section(user, "allocation");
  const committee = section(user, "committee");
  const schedule = section(user, "schedule");
  const llm = section(user, "llm");
  const dataProviders = section(user, "dataProviders");

  /* --- removed keys → replacements (ADR 0012) --- */
  const legacyReturn = removeKey(
    risk,
    "expectedReturnPerTradePct",
    changes,
    "risk",
    "removed: a flat per-trade return assumption applied to every order is now an edge derived from the research",
  );
  const legacyFloor = removeKey(
    risk,
    "minExpectedBenefitPct",
    changes,
    "risk",
    "removed: it was a second confidence floor in disguise; risk.minNetBenefitPct replaces it",
  );
  const legacyAdaptation = removeKey(
    allocation,
    "adaptation",
    changes,
    "allocation",
    "removed with the classic flow (ADR 0009); the committee owns allocation changes now",
  );
  const legacySignalThreshold = removeKey(
    risk,
    "signalThreshold",
    changes,
    "risk",
    "removed with the classic flow (ADR 0009)",
  );
  const legacyCommitteeEnabled = removeKey(
    committee,
    "enabled",
    changes,
    "committee",
    "removed: the committee is the only decision flow (ADR 0009)",
  );
  void legacyFloor;
  void legacyAdaptation;
  void legacySignalThreshold;
  void legacyCommitteeEnabled;

  /* --- intent carried forward --- */
  if (typeof legacyReturn === "number" && legacyReturn > 0) {
    // Old value was a percentage (2.0 = 2%). The new edge is a fraction.
    setIfAbsent(risk, "baseEdgePct", legacyReturn / 100, changes, "risk", `carried over from risk.expectedReturnPerTradePct (${legacyReturn}%)`);
    setIfAbsent(risk, "maxEdgePct", legacyReturn / 100, changes, "risk", `carried over from risk.expectedReturnPerTradePct (${legacyReturn}%) as the ceiling`);
    notes.push(
      `the flat ${legacyReturn}%/trade assumption became an assumed edge of ${legacyReturn}% at FULL signal strength — a weak signal now assumes proportionally less, which is the point of ADR 0012`,
    );
  }

  /* --- new gate keys, written at their defaults so the file shows them --- */
  setIfAbsent(risk, "baseEdgePct", 0.015, changes, "risk", "edge assumed at full signal strength (ADR 0012)");
  setIfAbsent(risk, "maxEdgePct", 0.02, changes, "risk", "hard ceiling on the assumed edge (ADR 0012)");
  setIfAbsent(risk, "minNetBenefitPct", 0.0005, changes, "risk", "benefit after round-trip costs, as a fraction of order value (ADR 0012)");
  setIfAbsent(risk, "minOrderValue", 25, changes, "risk", "orders below this never repay their fixed costs (ADR 0012)");
  setIfAbsent(risk, "maxOrderValuePct", 0.25, changes, "risk", "a single order may not exceed this fraction of NAV (ADR 0012)");
  setIfAbsent(risk, "llmCostBenefitMultiplier", 1, changes, "risk", "the run's inference cost must be covered by the net benefit it produced (ADR 0011/0012)");
  setIfAbsent(risk, "stopDistancePct", 0.1, changes, "risk", "heat formula parameter, no stop order is placed (ADR 0004)");

  /* --- committee guardrails added by WP-P1.4 / WP-P2.2 --- */
  setIfAbsent(committee, "trustRegion", 0.4, changes, "committee", "a session applies only this fraction of a requested weight change (WP-P1.4)");
  setIfAbsent(committee, "trustRegionConfidenceWeight", 0.5, changes, "committee", "how much the winner's confidence damps that move (WP-P1.4)");
  setIfAbsent(committee, "maxTurnoverPctPerSession", 0.1, changes, "committee", "notional a session may move, as a fraction of NAV (WP-P1.4)");
  setIfAbsent(committee, "minWeightChange", 0.005, changes, "committee", "changes below this are noise and are not traded (WP-P1.4)");
  setIfAbsent(committee, "minPositions", 0, changes, "committee", "warn when the funded position count falls below this (WP-P2.2)");

  /* --- cash policy (WP-P1.5) --- */
  setIfAbsent(allocation, "cashBand", 0.03, changes, "allocation", "band around the cash target (WP-P1.5)");

  /* --- cadence (WP-P1.1) --- */
  setIfAbsent(schedule, "triggerMode", "material", changes, "schedule", "run the analysts + committee only when something material changed (WP-P1.1); set \"always\" to restore hourly sessions");
  if (schedule.triggerMode === "material") {
    notes.push("hourly LLM spend is now event-driven: a stats-only hour makes no inference calls at all");
  }

  /* --- LLM budget + pricing (WP-P0.4) --- */
  const budget = section(llm, "budget");
  setIfAbsent(budget, "maxCallsPerRun", 50, changes, "llm.budget", "hard cap on LLM calls in one run (ADR 0011)");
  setIfAbsent(budget, "maxSpendPerDayUsd", 5, changes, "llm.budget", "hard cap on USD spend over the trailing window (ADR 0011)");
  setIfAbsent(budget, "spendWindowHours", 24, changes, "llm.budget", "length of that window (ADR 0011)");

  /* --- event feeds (WP-P2.3) --- */
  if (dataProviders.candles === undefined) {
    dataProviders.candles = "yahoo";
    changes.push({
      path: "dataProviders.candles",
      from: undefined,
      to: "yahoo",
      reason: "candles feed for the analysts and the risk metrics (Finnhub's free tier has no candle endpoint)",
    });
  }

  /* --- maxCallsPerRun sanity against the per-run call budget --- */
  const maxCalls = Number(budget.maxCallsPerRun ?? 0);
  if (maxCalls > 0 && maxCalls < 20) {
    warnings.push(
      `llm.budget.maxCallsPerRun is ${maxCalls}: a full 5-ticker run needs about 5 analyst calls + the committee's 12, so runs will be cut short`,
    );
  }

  /* --- the gate must be able to trade at all --- */
  const instrumentCurrency = "USD";
  const model = {
    spreadBps: 2,
    fxFeePct: 0.0015,
    stampDutyPct: 0.005,
    platformFeePct: 0,
  };
  const engineFor = (): DecisionEngine =>
    new DecisionEngine(model, {
      maxOrderValue: Number(risk.maxOrderValue ?? 1000),
      maxOrderValuePct: Number(risk.maxOrderValuePct ?? 0.25),
      minOrderValue: Number(risk.minOrderValue ?? 25),
      maxHeatPct: Number(risk.maxHeatPct ?? 0.855),
      baseEdgePct: Number(risk.baseEdgePct ?? 0.015),
      maxEdgePct: Number(risk.maxEdgePct ?? 0.02),
      minNetBenefitPct: Number(risk.minNetBenefitPct ?? 0.0005),
      llmCostBenefitMultiplier: Number(risk.llmCostBenefitMultiplier ?? 1),
      costBenefitMultiplier: Number(risk.costBenefitMultiplier ?? 2),
      maxOrdersPerRun: Number(risk.maxOrdersPerRun ?? 3),
      tickerCooldownDays: Number(risk.tickerCooldownDays ?? 2),
      minConfidence: Number(risk.minConfidence ?? 0.4),
    });
  const accountCurrency = "GBP";
  const costRatio = engineFor().roundTripCostRatio({
    accountCurrency,
    instrumentCurrency,
    action: "BUY",
    ticker: "SAMPLE",
  });
  const requiredEdge = costRatio * Math.max(Number(risk.costBenefitMultiplier ?? 2), Number(risk.llmCostBenefitMultiplier ?? 1));
  let bestEdge = engineFor().computeEdgePct(1);
  if (bestEdge < requiredEdge) {
    const from = risk.baseEdgePct;
    // Raise the assumed edge just past what the round trip actually requires, and
    // keep the ceiling above it.
    const raised = Math.ceil(requiredEdge * 10_000 + 1) / 10_000;
    risk.baseEdgePct = raised;
    changes.push({
      path: "risk.baseEdgePct",
      from,
      to: raised,
      reason: `the gate was unsatisfiable: the best possible assumed edge (${(bestEdge * 100).toFixed(3)}%) could not beat the round-trip cost (${(costRatio * 100).toFixed(3)}%) by the required multiple — no order could ever be approved (the 36-runs/0-orders failure)`,
    });
    if (Number(risk.maxEdgePct ?? 0) < raised) {
      const previousCap = risk.maxEdgePct;
      risk.maxEdgePct = raised;
      changes.push({
        path: "risk.maxEdgePct",
        from: previousCap,
        to: raised,
        reason: "the ceiling must be at least the assumed edge at full signal strength",
      });
    }
    bestEdge = engineFor().computeEdgePct(1);
  }
  notes.push(
    `gate check: round-trip cost ${(costRatio * 100).toFixed(3)}%, required edge ${(requiredEdge * 100).toFixed(3)}%, best possible edge ${(bestEdge * 100).toFixed(3)}%`,
  );

  return { changes, notes, warnings };
}

/**
 * Runs the migration against a real file. Dry-run by default: nothing is written
 * unless `write` is true, and the original is backed up first.
 */
export function migrateConfigFile(path: string, opts: { write?: boolean } = {}): ConfigMigrationReport {
  const user = loadUserConfig(path);
  const before = JSON.stringify(user);
  const { changes, notes, warnings } = migrateConfig(user);
  const report: ConfigMigrationReport = { path, changes, notes, warnings, written: false, backup: null };

  if (opts.write !== true || JSON.stringify(user) === before) return report;
  const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(path, backup);
  writeFileSync(path, `${JSON.stringify(user, null, 2)}\n`);
  report.written = true;
  report.backup = backup;
  return report;
}
