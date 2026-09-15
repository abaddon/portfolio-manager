import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrateConfig, migrateConfigFile } from "../../src/config-migrate.js";
import { loadConfig } from "../../src/config.js";

/** A `config/local.json` in the shape the pre-review version shipped. */
function legacyConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $comment: "Live Trading212 account. Committee: DeepSeek (direct) + OpenRouter. High-risk / max-return risk profile.",
    mode: "live",
    universe: { tickers: ["RTX", "XOM", "MSFT", "SHW", "AMZN"], benchmark: "SPY" },
    allocation: { targets: [], rebalanceBand: 0.04, adaptation: { enabled: true, maxDeltaPerRun: 0.02 } },
    dataProviders: { prices: "finnhub", news: "finnhub", fundamentals: "finnhub", sentiment: "finnhub" },
    committee: {
      enabled: true,
      agents: [
        { id: "macro-strategist", name: "Macro Strategist", provider: "deepseek", model: "deepseek-v4-flash" },
        { id: "momentum-trader", name: "Momentum Trader", provider: "openrouter", model: "google/gemini-3.8-flash" },
        { id: "value-investor", name: "Value Investor", provider: "openrouter", model: "z-ai/glm-5.3-flash" },
      ],
    },
    llm: { thinking: "enabled", maxTokens: 8000, timeoutMs: 180000 },
    risk: {
      maxOrderValue: 2000,
      maxHeatPct: 0.855,
      minExpectedBenefitPct: 0.001,
      costBenefitMultiplier: 1.0,
      maxOrdersPerRun: 5,
      tickerCooldownDays: 1,
      minConfidence: 0.3,
      expectedReturnPerTradePct: 2.0,
    },
    schedule: { runAtMinutePastHour: 0 },
    ...over,
  };
}

function pathsOf(changes: { path: string }[]): string[] {
  return changes.map((c) => c.path).sort();
}

/** Writes a config plus the repo's default.json into a temp dir the loader accepts. */
function inTempDir(config: Record<string, unknown>): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "cfg-migrate-"));
  // A custom base config REPLACES the defaults, so give the loader the real one.
  writeFileSync(join(dir, "default.json"), readFileSync(resolve(process.cwd(), "config/default.json")));
  const path = join(dir, "local.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return { dir, path };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("migrateConfig (WP review follow-up)", () => {
  it("removes keys the new version dropped", () => {
    const config = legacyConfig();
    const { changes } = migrateConfig(config);
    expect(pathsOf(changes)).toContain("risk.expectedReturnPerTradePct");
    expect(pathsOf(changes)).toContain("risk.minExpectedBenefitPct");
    expect(pathsOf(changes)).toContain("allocation.adaptation");
    expect(pathsOf(changes)).toContain("committee.enabled");
    expect((config.risk as Record<string, unknown>).expectedReturnPerTradePct).toBeUndefined();
    expect((config.risk as Record<string, unknown>).minExpectedBenefitPct).toBeUndefined();
    expect((config.allocation as Record<string, unknown>).adaptation).toBeUndefined();
    expect((config.committee as Record<string, unknown>).enabled).toBeUndefined();
  });

  it("carries the old per-trade return forward as the assumed edge and its ceiling", () => {
    const config = legacyConfig();
    const { changes, notes } = migrateConfig(config);
    // 2.0 (percent) → 0.02 (fraction)
    expect((config.risk as Record<string, unknown>).baseEdgePct).toBeCloseTo(0.02, 6);
    expect((config.risk as Record<string, unknown>).maxEdgePct).toBeCloseTo(0.02, 6);
    expect(changes.find((c) => c.path === "risk.baseEdgePct")?.reason).toContain("expectedReturnPerTradePct");
    expect(notes.some((n) => n.includes("FULL signal strength"))).toBe(true);
  });

  it("writes the new gate, committee, cash and cadence keys explicitly", () => {
    const config = legacyConfig();
    const { changes } = migrateConfig(config);
    const paths = pathsOf(changes);
    for (const path of [
      "risk.minNetBenefitPct",
      "risk.minOrderValue",
      "risk.maxOrderValuePct",
      "risk.llmCostBenefitMultiplier",
      "committee.trustRegion",
      "committee.maxTurnoverPctPerSession",
      "committee.minWeightChange",
      "committee.minPositions",
      "allocation.cashBand",
      "schedule.triggerMode",
      "llm.budget.maxCallsPerRun",
      "llm.budget.maxSpendPerDayUsd",
      "dataProviders.candles",
    ]) {
      expect(paths, `${path} should have been added`).toContain(path);
    }
    expect((config.schedule as Record<string, unknown>).triggerMode).toBe("material");
    expect((config.llm as Record<string, any>).budget).toMatchObject({ maxCallsPerRun: 50, maxSpendPerDayUsd: 5 });
  });

  it("carries no new key over an explicit user value", () => {
    const config = legacyConfig({
      risk: { maxOrderValue: 2000, maxHeatPct: 0.855, costBenefitMultiplier: 1.5, maxOrdersPerRun: 5, tickerCooldownDays: 1, minConfidence: 0.3, baseEdgePct: 0.008, minNetBenefitPct: 0.001 },
      schedule: { triggerMode: "always" },
    });
    const { changes } = migrateConfig(config);
    expect((config.risk as Record<string, unknown>).baseEdgePct).toBe(0.008);
    expect((config.risk as Record<string, unknown>).minNetBenefitPct).toBe(0.001);
    // The explicit "always" survives and the note about event-driven spend is not claimed.
    expect((config.schedule as Record<string, unknown>).triggerMode).toBe("always");
    expect(pathsOf(changes)).not.toContain("schedule.triggerMode");
  });

  it("is idempotent: a second pass changes nothing", () => {
    const config = legacyConfig();
    migrateConfig(config);
    const afterFirst = JSON.stringify(config);
    const second = migrateConfig(config);
    expect(second.changes).toEqual([]);
    expect(JSON.stringify(config)).toBe(afterFirst);
  });

  it("repairs a gate that could never approve an order (the 36-runs/0-orders shape)", () => {
    // The historical live config: a 0.6% floor against a 0.5% maximum possible benefit.
    const config = legacyConfig({
      risk: {
        maxOrderValue: 2000,
        maxHeatPct: 0.855,
        minExpectedBenefitPct: 0.006,
        costBenefitMultiplier: 1.5,
        maxOrdersPerRun: 5,
        tickerCooldownDays: 1,
        minConfidence: 0.3,
        expectedReturnPerTradePct: 0.5,
      },
    });
    const { changes, notes } = migrateConfig(config);
    // Two changes touch baseEdgePct: the carry-over from the legacy key, then the
    // feasibility repair. The repair must be among them.
    const repairs = changes.filter((c) => c.path === "risk.baseEdgePct" && c.reason.includes("unsatisfiable"));
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.reason).toContain("no order could ever be approved");
    // 0.5% carried over from the old value cannot beat a 0.34% round trip × 1.5.
    expect(Number((config.risk as Record<string, unknown>).baseEdgePct)).toBeGreaterThan(0.005);
    expect(Number((config.risk as Record<string, unknown>).maxEdgePct)).toBeGreaterThanOrEqual(
      Number((config.risk as Record<string, unknown>).baseEdgePct),
    );
    expect(notes.some((n) => n.includes("gate check"))).toBe(true);
  });

  it("warns when the per-run call budget cannot cover one full run", () => {
    const config = legacyConfig({ llm: { thinking: "enabled", budget: { maxCallsPerRun: 5 } } });
    const { warnings } = migrateConfig(config);
    expect(warnings.some((w) => w.includes("maxCallsPerRun is 5"))).toBe(true);
  });
});

describe("migrateConfigFile", () => {
  it("does not write without --write, and reports what it would do", () => {
    const { path } = inTempDir(legacyConfig());
    const before = readFileSync(path, "utf8");
    const report = migrateConfigFile(path);
    expect(report.written).toBe(false);
    expect(report.backup).toBeNull();
    expect(report.changes.length).toBeGreaterThan(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("backs the original up before writing, and the result loads through the real loader", () => {
    const { dir, path } = inTempDir(legacyConfig());
    const report = migrateConfigFile(path, { write: true });
    expect(report.written).toBe(true);
    expect(report.backup).not.toBeNull();
    expect(existsSync(report.backup!)).toBe(true);
    // The backup is the untouched original.
    expect(JSON.parse(readFileSync(report.backup!, "utf8"))).toMatchObject({ mode: "live" });
    expect(readdirSync(dir).some((f) => f.startsWith("local.json.bak-"))).toBe(true);

    // And the migrated config is accepted by the real loader, with the expected effect.
    const loaded = loadConfig({ configPath: join(dir, "default.json"), env: {} as NodeJS.ProcessEnv });
    expect(loaded.config.mode).toBe("live");
    expect(loaded.config.risk.baseEdgePct).toBeGreaterThanOrEqual(0.0068); // can beat the round trip
    expect(loaded.config.schedule.triggerMode).toBe("material");
    expect(loaded.config.llm.budget.maxSpendPerDayUsd).toBe(5);
  });

  it("refuses a config that cannot be parsed, without touching it", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-bad-"));
    const path = join(dir, "local.json");
    writeFileSync(path, "{ this is not json");
    expect(() => migrateConfigFile(path, { write: true })).toThrow(/cannot parse/);
    expect(readFileSync(path, "utf8")).toBe("{ this is not json");
  });

  it("throws a clear error when the config does not exist", () => {
    expect(() => migrateConfigFile("/tmp/definitely-not-here.json")).toThrow(/config not found/);
  });
});

/**
 * The exact `config/local.json` the live account ran with before the review
 * (mode live, empty targets, thinking enabled, maxTokens 8000). It is kept here
 * as a fixture: the shape that produced 36 runs and 0 orders must always be
 * migratable and must never be accepted silently by a future schema.
 */
const OLD_LIVE_CONFIG = {
  $comment: "Live Trading212 account. Committee: DeepSeek (direct) + OpenRouter (gemini/glm). Thinking enabled for all models. High-risk / max-return risk profile.",
  mode: "live",
  universe: { tickers: ["RTX", "XOM", "MSFT", "SHW", "AMZN"], benchmark: "SPY" },
  allocation: { targets: [], rebalanceBand: 0.04 },
  dataProviders: { prices: "finnhub", news: "finnhub", fundamentals: "finnhub", sentiment: "finnhub" },
  committee: {
    agents: [
      { id: "macro-strategist", name: "Macro Strategist", provider: "deepseek", model: "deepseek-v4-flash" },
      { id: "momentum-trader", name: "Momentum Trader", provider: "openrouter", model: "google/gemini-3.8-flash" },
      { id: "value-investor", name: "Value Investor", provider: "openrouter", model: "z-ai/glm-5.3-flash" },
    ],
  },
  llm: { thinking: "enabled", maxTokens: 8000, timeoutMs: 180000 },
  risk: {
    maxOrderValue: 2000,
    maxHeatPct: 0.855,
    minExpectedBenefitPct: 0.001,
    costBenefitMultiplier: 1.0,
    maxOrdersPerRun: 5,
    tickerCooldownDays: 1,
    minConfidence: 0.3,
    expectedReturnPerTradePct: 2.0,
  },
};

describe("the pre-review live config (regression fixture)", () => {
  it("migrates to a gate that can trade, keeping the user's profile", () => {
    const config = JSON.parse(JSON.stringify(OLD_LIVE_CONFIG)) as Record<string, any>;
    const { changes, notes } = migrateConfig(config);

    // Nothing of the user's own profile is lost.
    expect(config.mode).toBe("live");
    expect(config.universe.tickers).toEqual(["RTX", "XOM", "MSFT", "SHW", "AMZN"]);
    expect(config.allocation.targets).toEqual([]); // bootstrap from the broker
    expect(config.llm.thinking).toBe("enabled");
    expect(config.risk.maxOrderValue).toBe(2000);
    expect(config.risk.maxHeatPct).toBe(0.855);
    expect(config.risk.maxOrdersPerRun).toBe(5);
    expect(config.risk.tickerCooldownDays).toBe(1);
    expect(config.risk.minConfidence).toBe(0.3);

    // The two removed keys are gone and their intent carried over: 2.0% per trade.
    expect(config.risk.expectedReturnPerTradePct).toBeUndefined();
    expect(config.risk.minExpectedBenefitPct).toBeUndefined();
    const carried = changes.filter((c) => c.path === "risk.baseEdgePct" && c.reason.includes("carried over"));
    expect(carried).toHaveLength(1);
    expect(config.risk.baseEdgePct).toBeCloseTo(0.02, 6);

    // And the gate can actually approve something (the historical failure).
    expect(changes.some((c) => c.reason.includes("unsatisfiable"))).toBe(false);
    expect(notes.some((n) => n.includes("gate check") && n.includes("best possible edge 2.000%"))).toBe(true);
  });

  it("is accepted by the loader only after migration (the old file is never silently OK)", () => {
    const { path } = inTempDir(JSON.parse(JSON.stringify(OLD_LIVE_CONFIG)));
    // The loader accepts it (unknown keys are dropped) — which is exactly why an
    // explicit migration step and its report exist. Loaded as an overlay over the
    // repo's default.json, i.e. the way the app merges a user config.
    const before = loadConfig({ overlayPath: path, env: {} as NodeJS.ProcessEnv });
    expect(before.config.risk.baseEdgePct).toBe(0.015); // default.json's value, not the user's intent
    expect(deprecatedKeysOf(path)).toContain("risk.expectedReturnPerTradePct");

    migrateConfigFile(path, { write: true });
    const after = loadConfig({ overlayPath: path, env: {} as NodeJS.ProcessEnv });
    expect(after.config.risk.baseEdgePct).toBeCloseTo(0.02, 6); // the user's intent, carried over
    expect(deprecatedKeysOf(path)).toEqual([]);
  });
});

function deprecatedKeysOf(path: string): string[] {
  return deprecatedConfigKeysOf(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
}

function deprecatedConfigKeysOf(raw: Record<string, unknown>): string[] {
  return Object.keys((raw.risk as Record<string, unknown>) ?? {}).filter((k) =>
    ["expectedReturnPerTradePct", "minExpectedBenefitPct"].includes(k),
  ).map((k) => `risk.${k}`);
}
