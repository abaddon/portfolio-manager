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

const RiskSchema = z.object({
  maxOrderValue: z.number().positive(),
  maxHeatPct: z.number().min(0).max(1),
  minExpectedBenefitPct: z.number().nonnegative(),
  costBenefitMultiplier: z.number().positive(),
  maxOrdersPerRun: z.number().int().positive(),
  tickerCooldownDays: z.number().int().nonnegative(),
  stopDistancePct: z.number().min(0).max(1).default(0.1),
  expectedReturnPerTradePct: z.number().nonnegative().default(0.5),
  signalThreshold: z.number().min(0).max(1).default(0.05),
  minConfidence: z.number().min(0).max(1).default(0.6),
});

const LlmProviderSchema = z.object({
  baseUrl: z.string(),
  model: z.string(),
  apiKeyEnv: z.string().optional(),
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
    targets: z.record(z.string(), z.number().min(0).max(1)),
    cashBuffer: z.number().min(0).max(1).default(0.1),
    rebalanceBand: z.number().min(0).default(0.04),
  }),
  risk: RiskSchema,
  costs: CostModelSchema,
  schedule: z.object({
    runAtMinutePastHour: z.number().int().min(0).max(59).default(0),
    runOnStartup: z.boolean().default(true),
    primaryMarket: z.string(),
    markets: z.record(z.string(), MarketSessionSchema),
  }),
  llm: z.object({
    provider: z.enum(["deepseek", "openai", "anthropic", "openrouter"]).default("deepseek"),
    model: z.string().optional(),
    temperature: z.number().min(0).max(2).default(0.2),
    maxTokens: z.number().int().positive().default(2000),
    timeoutMs: z.number().int().positive().default(60_000),
    thinking: z.enum(["enabled", "disabled"]).default("disabled"),
    providers: z.record(z.string(), LlmProviderSchema).default({}),
  }),
  dataProviders: z.object({
    prices: z.enum(["finnhub", "demo"]).default("demo"),
    candles: z.enum(["yahoo", "demo"]).default("yahoo"),
    news: z.enum(["finnhub", "demo"]).default("demo"),
    fundamentals: z.enum(["finnhub", "demo"]).default("demo"),
    sentiment: z.enum(["finnhub", "demo"]).default("demo"),
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
    // A CLI overlay merges ON TOP (user profiles; wins over local.json).
    if (args.overlayPath && existsSync(args.overlayPath)) raw = deepMerge(raw, loadJson(args.overlayPath));
  }

  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigurationError(`invalid configuration: ${parsed.error.message}`);
  }
  const config = parsed.data;

  // Environment overrides
  const providerKeys: Record<string, string> = {};
  for (const [name, envName] of Object.entries(envVarFor)) {
    const key = env[envName] ?? "";
    if (key) providerKeys[name] = key;
  }
  if (env.FINNHUB_API_KEY) providerKeys.finnhub = env.FINNHUB_API_KEY;
  if (env.ALPHAVANTAGE_API_KEY) providerKeys.alphavantage = env.ALPHAVANTAGE_API_KEY;
  if (env.TPM_PORT) config.web.port = Number(env.TPM_PORT);
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
