import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ConfigurationError } from "./shared/errors.js";

const MarketSessionSchema = z.object({
  tz: z.string(),
  open: z.string().regex(/^\d{2}:\d{2}$/),
  close: z.string().regex(/^\d{2}:\d{2}$/),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
  earlyClose: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  earlyCloses: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
});

const CostModelSchema = z.object({
  spreadBps: z.number().nonnegative(),
  fxFeePct: z.number().nonnegative(),
  stampDutyPct: z.number().nonnegative(),
  platformFeePct: z.number().nonnegative(),
});

/**
 * Economic-gate limits (ADR 0012). The gate compares an **assumed edge**
 * derived from the research against the position's **round-trip** cost:
 *  - `baseEdgePct` is the edge assumed at full signal strength (the strongest
 *    evidence the analysts can produce), capped by `maxEdgePct`;
 *  - `costBenefitMultiplier` requires the edge to beat the round trip by a margin;
 *  - `minNetBenefitPct` is the floor on (benefit − costs) as a fraction of order value;
 *  - `minOrderValue` / `maxOrderValuePct` bound the size at which the trade is worth doing;
 *  - `llmCostBenefitMultiplier` requires the run's inference spend to be covered
 *    by the net benefit of the decisions it produced.
 * `expectedReturnPerTradePct` (removed) was a flat per-trade return assumption
 * applied to every order regardless of evidence; it now maps onto `baseEdgePct`.
 */
const RiskSchema = z.object({
  maxOrderValue: z.number().positive(),
  maxOrderValuePct: z.number().min(0).max(1).default(0.25),
  minOrderValue: z.number().nonnegative().default(25),
  maxHeatPct: z.number().min(0).max(1),
  baseEdgePct: z.number().nonnegative().default(0.01),
  maxEdgePct: z.number().nonnegative().default(0.02),
  minNetBenefitPct: z.number().nonnegative().default(0.0005),
  llmCostBenefitMultiplier: z.number().nonnegative().default(1),
  costBenefitMultiplier: z.number().positive(),
  maxOrdersPerRun: z.number().int().positive(),
  tickerCooldownDays: z.number().int().nonnegative(),
  stopDistancePct: z.number().min(0).max(1).default(0.1),
  minConfidence: z.number().min(0).max(1).default(0.6),
});

const LlmProviderSchema = z.object({
  baseUrl: z.string(),
  model: z.string(),
  apiKeyEnv: z.string().optional(),
});

/** One asset-allocation-committee member: a persona on a specific model/provider. */
const CommitteeAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.enum(["deepseek", "openai", "anthropic", "openrouter"]).default("openrouter"),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
});

const AppConfigSchema = z.object({
  mode: z.enum(["paper", "live"]).default("paper"),
  account: z.object({
    currency: z.string().length(3).default("GBP"),
    initialCash: z.number().positive().default(10_000),
    initialPositions: z.array(z.object({ ticker: z.string(), quantity: z.number().positive() })).default([]),
  }),
  universe: z.object({
    tickers: z.array(z.string()).min(1),
    benchmark: z.string().default("SPY"),
  }),
  allocation: z.object({
    targets: z
      .array(z.object({ ticker: z.string().min(1), weight: z.number().min(0).max(1) }))
      .default([]), // empty = bootstrap the allocation from the broker's current positions
    rebalanceBand: z.number().min(0).default(0.04),
  }),
  risk: RiskSchema,
  costs: CostModelSchema,
  /**
   * Asset Allocation Committee — THE decision flow (ADR 0009). Every run it
   * proposes, reviews and votes on the allocation; the winning proposal's
   * targets are persisted (per-name cap + cash-floor guardrails below) and
   * its orders pass the economic gate before execution. Always on; needs ≥3
   * agents (validated in loadConfig), each on its own provider/model.
   */
  committee: z
    .object({
      /** Cap on vote rounds; a tie that survives it is settled deterministically. */
      maxVoteRounds: z.number().int().min(1).max(10).default(3),
      /** Needs ≥3 agents (validated in loadConfig). */
      agents: z.array(CommitteeAgentSchema).default([]),
      /** Guardrail: no single name may exceed this target weight. */
      maxTarget: z.number().min(0).max(1).default(0.25),
      /** Guardrail: total invested targets stay under 1 − this cash floor. */
      minCashBuffer: z.number().min(0).max(1).default(0.05),
    })
    .default({}),
  schedule: z.object({
    runAtMinutePastHour: z.number().int().min(0).max(59).default(0),
    runOnStartup: z.boolean().default(true),
    primaryMarket: z.string(),
    markets: z.record(z.string(), MarketSessionSchema),
    /**
     * When the expensive path (analysts + committee) runs (WP-P1.1).
     *  - `always`: every market hour, as before;
     *  - `material`: only when a trigger fires (drift, NAV move, new material
     *    news, an unfunded target, or the daily planning slot). The hourly pass
     *    still takes the snapshot, evaluates the portfolio and sweeps orders.
     */
    triggerMode: z.enum(["always", "material"]).default("material"),
    materiality: z
      .object({
        /** |NAV change since the previous run| that warrants a fresh look (fraction). */
        navMovePct: z.number().min(0).default(0.01),
        /** Any target further than this from its weight warrants a fresh look (fraction). */
        driftPct: z.number().min(0).default(0.05),
        /** Minimum hours between two "daily planning" sessions. */
        planningIntervalHours: z.number().positive().default(20),
        /** Ignore news whose materiality cannot be judged — headlines alone never trigger. */
        newsLookbackHours: z.number().positive().default(6),
      })
      .default({}),
  }),
  llm: z.object({
    provider: z.enum(["deepseek", "openai", "anthropic", "openrouter"]).default("deepseek"),
    model: z.string().optional(),
    temperature: z.number().min(0).max(2).default(0.2),
    maxTokens: z.number().int().positive().default(2000),
    timeoutMs: z.number().int().positive().default(60_000),
    thinking: z.enum(["enabled", "disabled"]).default("disabled"),
    providers: z.record(z.string(), LlmProviderSchema).default({}),
    /**
     * Cost accounting + budget guards (optional). `pricing` maps a model id (or
     * a substring of one) to USD per 1M tokens; the built-in table covers the
     * default models, and an unpriced model records tokens with cost 0.
     */
    budget: z
      .object({
        maxCallsPerRun: z.number().int().min(0).default(200),
        maxSpendPerDayUsd: z.number().min(0).default(5),
        spendWindowHours: z.number().positive().default(24),
      })
      .default({}),
    pricing: z
      .record(
        z.string(),
        z.object({
          inputPerMillionUsd: z.number().min(0),
          outputPerMillionUsd: z.number().min(0),
          cachedInputPerMillionUsd: z.number().min(0).optional(),
        }),
      )
      .default({}),
  }),
  dataProviders: z.object({
    prices: z.enum(["finnhub", "demo"]).default("demo"),
    candles: z.enum(["yahoo", "demo"]).default("yahoo"),
    news: z.enum(["finnhub", "demo"]).default("demo"),
    fundamentals: z.enum(["finnhub", "demo"]).default("demo"),
    sentiment: z.enum(["finnhub", "demo"]).default("demo"),
    macro: z.enum(["fred", "none"]).default("none"),
    fx: z.enum(["erapi", "demo"]).default("erapi"),
  }),
  trading212: z.object({
    baseUrl: z.string().default("https://demo.trading212.com"),
    liveBaseUrl: z.string().default("https://live.trading212.com"),
  }),
  web: z.object({ host: z.string().default("127.0.0.1"), port: z.number().int().positive().default(8790) }),
  database: z.object({ path: z.string().default("data/trading.db") }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** Deep-merges plain objects (b used as overlay). */
function deepMerge<T>(a: T, b: unknown): T {
  if (typeof a !== "object" || a === null || Array.isArray(a)) return (b as T) ?? a;
  if (typeof b !== "object" || b === null || Array.isArray(b)) return a;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    out[k] = k in out && typeof out[k] === "object" && out[k] !== null ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

const envVarFor: Record<"deepseek" | "openai" | "anthropic" | "openrouter", string> = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export interface LoadedConfig {
  config: AppConfig;
  llmApiKey: string | null;
  broker: { env: "demo" | "live"; apiKey: string | null; apiSecret: string | null };
  providerKeys: Record<string, string>;
}

/**
 * Keys that were removed or renamed (ADR 0012). They are silently dropped by
 * schema validation, so a stale `local.json` would keep looking like it
 * configures the gate while doing nothing — surface it as a warning instead.
 */
export function deprecatedConfigKeys(raw: unknown): { key: string; replacement: string }[] {
  const out: { key: string; replacement: string }[] = [];
  const risk = (raw as { risk?: Record<string, unknown> } | null)?.risk;
  if (risk && typeof risk === "object") {
    if (risk.expectedReturnPerTradePct !== undefined) {
      out.push({
        key: "risk.expectedReturnPerTradePct",
        replacement: `risk.baseEdgePct (was read as a flat per-trade return applied to every order; now a signal-scaled edge — migrate the value deliberately). Ignored value: ${String(risk.expectedReturnPerTradePct)}`,
      });
    }
    if (risk.minExpectedBenefitPct !== undefined) {
      out.push({
        key: "risk.minExpectedBenefitPct",
        replacement: `risk.minNetBenefitPct (was a second confidence floor in disguise). Ignored value: ${String(risk.minExpectedBenefitPct)}`,
      });
    }
  }
  return out;
}

export function loadConfig(args: { configPath?: string; overlayPath?: string; env?: NodeJS.ProcessEnv } = {}): LoadedConfig {
  const env = args.env ?? process.env;
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultPath = resolve(here, "../config/default.json");
  const localPath = resolve(dirname(defaultPath), "local.json");

  let raw: unknown;
  if (args.configPath) {
    // A custom base config REPLACES the defaults entirely (tests pass complete configs).
    raw = loadJson(args.configPath);
  } else {
    raw = existsSync(defaultPath) ? loadJson(defaultPath) : {};
    if (existsSync(localPath)) raw = deepMerge(raw, loadJson(localPath));
    // A CLI overlay merges ON TOP (user profiles; wins over local.json). It
    // must EXIST: silently ignoring a mistyped profile path fails open onto
    // config/local.json — which is `mode: "live"` — and places real orders.
    if (args.overlayPath !== undefined) {
      if (!existsSync(args.overlayPath)) {
        throw new ConfigurationError(
          `config overlay not found: ${args.overlayPath} — refusing to fall back to the base/local config`,
        );
      }
      raw = deepMerge(raw, loadJson(args.overlayPath));
    }
  }

  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigurationError(`invalid configuration: ${parsed.error.message}`);
  }
  const config = parsed.data;
  for (const stale of deprecatedConfigKeys(raw)) {
    console.warn(`[WARN] config key ${stale.key} is no longer used — ${stale.replacement}`);
  }
  if (config.committee.agents.length < 3) {
    throw new ConfigurationError(
      `the asset allocation committee makes every decision — configure at least 3 committee.agents (got ${config.committee.agents.length})`,
    );
  }

  // Environment overrides
  const providerKeys: Record<string, string> = {};
  for (const [name, envName] of Object.entries(envVarFor)) {
    const key = env[envName] ?? "";
    if (key) providerKeys[name] = key;
  }
  if (env.FINNHUB_API_KEY) providerKeys.finnhub = env.FINNHUB_API_KEY;
  if (env.ALPHAVANTAGE_API_KEY) providerKeys.alphavantage = env.ALPHAVANTAGE_API_KEY;
  // NOTE: the user's .env spells it FREED_API_KEY (missing the "R") — keep as-is.
  if (env.FREED_API_KEY) providerKeys.fred = env.FREED_API_KEY;
  // Env overrides run AFTER the schema, so they are validated here by hand.
  if (env.TPM_PORT) {
    const port = Number(env.TPM_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new ConfigurationError(`invalid TPM_PORT: ${env.TPM_PORT} (expected an integer 1..65535)`);
    }
    config.web.port = port;
  }
  if (env.TPM_DB_PATH) config.database.path = env.TPM_DB_PATH;

  const llmApiKey = providerKeys[config.llm.provider] ?? null;
  const brokerEnv = env.TRADING212_ACCOUNT_DEMO === "1" ? "demo" : "live";

  return {
    config,
    llmApiKey,
    broker: {
      env: brokerEnv,
      apiKey: env.TRADING212_API_KEY ?? null,
      apiSecret: env.TRADING212_API_SECRET ?? null,
    },
    providerKeys,
  };
}
