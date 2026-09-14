import { z, type ZodType } from "zod";
import { AdapterError } from "../../shared/errors.js";
import type { LlmChatOptions, LlmPort } from "../../application/ports.js";

export interface LlmProviderProfile {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  /** Anthropic uses a non-OpenAI wire format. */
  wireFormat: "openai" | "anthropic";
  /** Extra headers (e.g. OpenRouter optional-site metadata). */
  extraHeaders?: Record<string, string>;
  /** Thinking-mode toggle (DeepSeek v4 defaults to thinking ON). */
  thinking?: "enabled" | "disabled";
}

/** Token counts reported by a provider for one call. */
export interface RawLlmUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

/** USD per 1M tokens, used to price reported usage. */
export interface LlmModelPrice {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  /** Discounted input price for provider-cached prompt tokens (defaults to input). */
  cachedInputPerMillionUsd?: number;
}

/**
 * Prices are estimates used for budget accounting only (never for trading
 * decisions). A model without an entry costs 0 — its calls then record tokens
 * without a price, which is visibly honest on the dashboard.
 */
export const DEFAULT_MODEL_PRICES: Record<string, LlmModelPrice> = {
  "deepseek-v4-flash": { inputPerMillionUsd: 0.28, outputPerMillionUsd: 0.42, cachedInputPerMillionUsd: 0.028 },
  "deepseek-v4-pro": { inputPerMillionUsd: 0.55, outputPerMillionUsd: 2.19, cachedInputPerMillionUsd: 0.055 },
  "gpt-4o-mini": { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6, cachedInputPerMillionUsd: 0.075 },
  "claude-3-5-haiku-latest": { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4, cachedInputPerMillionUsd: 0.08 },
};

/**
 * Resolves a model id against a price table: exact match first, then the
 * longest table key contained in the id (so one `deepseek-v4-flash` entry
 * prices `~deepseek/deepseek-v4-flash-latest`).
 */
export function resolveModelPrice(model: string, prices: Record<string, LlmModelPrice>): LlmModelPrice | null {
  if (prices[model]) return prices[model]!;
  const candidates = Object.keys(prices)
    .filter((key) => model.includes(key))
    .sort((a, b) => b.length - a.length);
  return candidates.length > 0 ? prices[candidates[0]!]! : null;
}

/** Cost in USD of reported usage; 0 when the model has no price entry. */
export function estimateUsageCostUsd(usage: RawLlmUsage, price: LlmModelPrice | null): number {
  if (!price) return 0;
  const cached = Math.min(usage.cachedTokens, usage.promptTokens);
  const fresh = usage.promptTokens - cached;
  const cachedPrice = price.cachedInputPerMillionUsd ?? price.inputPerMillionUsd;
  const usd =
    (fresh / 1_000_000) * price.inputPerMillionUsd +
    (cached / 1_000_000) * cachedPrice +
    (usage.completionTokens / 1_000_000) * price.outputPerMillionUsd;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export const PROVIDER_PROFILES = {
  deepseek: { name: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-flash", wireFormat: "openai" },
  openai: { name: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", wireFormat: "openai" },
  anthropic: { name: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-3-5-haiku-latest", wireFormat: "anthropic" },
  openrouter: { name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-v4-flash", wireFormat: "openai" },
} as const satisfies Record<string, Omit<LlmProviderProfile, "apiKey">>;

/**
 * Minimal typed chat client for the four supported providers. DeepSeek,
 * OpenAI and OpenRouter share the OpenAI wire format; Anthropic uses its own
 * messages format. Structured output = plain JSON with zod validation and one
 * retry (no provider-specific json-mode dependency).
 */
export class HttpLlmClient implements LlmPort {
  constructor(
    private readonly profile: LlmProviderProfile,
    private readonly opts: {
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
      /** Price table used to turn reported usage into USD (defaults to DEFAULT_MODEL_PRICES). */
      prices?: Record<string, LlmModelPrice>;
      /** Run this client's spend belongs to (accounting only). */
      runId?: string;
      /** Accounting label ("analysts", "sentiment", or the committee agent id). */
      agentId?: string;
      /** Called after every successful call with the token usage and its estimated cost. */
      onUsage?: (usage: RawLlmUsage & { usdCost: number; provider: string; model: string }) => void;
    } = {},
  ) {}

  available(): boolean {
    return this.profile.apiKey !== null && this.profile.apiKey.length > 0;
  }

  async chat(opts: LlmChatOptions): Promise<string> {
    if (!this.available()) throw new AdapterError("no API key for LLM provider", "auth");
    const body: Record<string, unknown> =
      this.profile.wireFormat === "anthropic"
        ? {
            model: this.profile.model,
            system: opts.system,
            messages: [{ role: "user", content: opts.user }],
            max_tokens: opts.maxTokens ?? this.opts.maxTokens ?? 2000,
            temperature: opts.temperature ?? this.opts.temperature ?? 0.2,
          }
        : {
            model: this.profile.model,
            messages: [
              { role: "system", content: opts.system },
              { role: "user", content: opts.user },
            ],
            max_tokens: opts.maxTokens ?? this.opts.maxTokens ?? 2000,
            temperature: opts.temperature ?? this.opts.temperature ?? 0.2,
          };
    // Thinking-mode control: DeepSeek v4 defaults to thinking ON; disable it
    // for cheap, deterministic structured output. (Anthropic: effort none.)
    // A per-call override wins over the client default (cheap classification
    // calls stay reasoning-free even when proposals use thinking).
    const thinking = opts.thinking ?? this.profile.thinking;
    if (thinking === "disabled") {
      if (this.profile.wireFormat === "anthropic") {
        body.reasoning = { effort: "none" };
      } else {
        body.thinking = { type: "disabled" };
        // Some OpenRouter-hosted reasoning models (deepseek-v4-pro-0813,
        // kimi-k3, …) ignore `thinking` and burn the whole output budget on
        // reasoning; OpenRouter's unified `reasoning` param actually stops it.
        if (this.profile.name === "openrouter") body.reasoning = { enabled: false };
      }
    }
    const { text, usage } = await this.request(
      this.profile.wireFormat === "anthropic" ? "/messages" : "/chat/completions",
      body,
    );
    this.reportUsage(usage);
    return text;
  }

  /** Reports token usage + estimated cost for one successful call (never throws). */
  private reportUsage(usage: RawLlmUsage): void {
    if (!this.opts.onUsage) return;
    try {
      const prices = this.opts.prices ?? DEFAULT_MODEL_PRICES;
      const usdCost = estimateUsageCostUsd(usage, resolveModelPrice(this.profile.model, prices));
      this.opts.onUsage({ ...usage, usdCost, provider: this.profile.name, model: this.profile.model });
    } catch {
      // accounting must never break a run
    }
  }

  async chatJson<T>(opts: LlmChatOptions, schema: ZodType<T>): Promise<T> {
    const raw = await this.chat(opts);
    const parsed = extractJson(raw);
    if (parsed !== null) {
      const result = schema.safeParse(parsed);
      if (result.success) return result.data;
    }
    // One repair attempt: ask the model to fix its own output.
    const repairOpts: LlmChatOptions = {
      system: `${opts.system}\n\nYour previous answer was not valid JSON matching the schema. Return ONLY the corrected JSON object.`,
      user: `Previous answer:\n${raw}\n\nReturn only the corrected JSON object.`,
      temperature: 0,
    };
    if (opts.maxTokens !== undefined) repairOpts.maxTokens = opts.maxTokens;
    if (opts.thinking !== undefined) repairOpts.thinking = opts.thinking;
    const repaired = await this.chat(repairOpts);
    const parsed2 = extractJson(repaired);
    if (parsed2 === null) throw new AdapterError("LLM returned non-JSON output twice", "parse");
    const result = schema.safeParse(parsed2);
    if (!result.success) {
      throw new AdapterError(`LLM output failed schema validation: ${result.error.message}`, "parse");
    }
    return result.data;
  }

  /**
   * One call, several validated objects (WP-P1.2). The prompt asks for a single
   * JSON object keyed by the requested names; each value is validated against its
   * own schema after the same one-repair-retry policy as `chatJson`. Keys that
   * still fail are omitted rather than failing the whole call.
   */
  async chatJsonMulti<K extends string>(
    opts: LlmChatOptions,
    schemas: Record<K, ZodType<unknown>>,
  ): Promise<Partial<Record<K, unknown>>> {
    const keys = Object.keys(schemas) as K[];
    const shape = keys.map((k) => `"${k}": <${k} object>`).join(", ");
    const asking: LlmChatOptions = {
      ...opts,
      system: `${opts.system}\n\nRespond with ONE JSON object containing exactly these keys: { ${shape} }. Each value must satisfy the field rules given for that key. Never output anything except the JSON object.`,
    };
    const raw = await this.chat(asking);
    const parsed = extractJson(raw);
    const out: Partial<Record<K, unknown>> = {};
    const applyParsed = (value: unknown): K[] => {
      const missing: K[] = [];
      const record = (value ?? {}) as Record<string, unknown>;
      for (const key of keys) {
        if (!(key in record)) {
          missing.push(key);
          continue;
        }
        const result = schemas[key]!.safeParse(record[key]);
        if (result.success) out[key] = result.data;
        else missing.push(key);
      }
      return missing;
    };
    if (parsed !== null) {
      const missing = applyParsed(parsed);
      if (missing.length === 0) return out;
      // Repair only the missing/invalid keys, in one extra call.
      const repaired = await this.chat({
        system: `${asking.system}\n\nYour previous answer was missing or invalid for: ${missing.join(", ")}. Return ONLY a JSON object with those keys.`,
        user: `Previous answer:\n${raw}\n\nReturn only the corrected JSON object.`,
        temperature: 0,
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
      });
      const parsed2 = extractJson(repaired);
      if (parsed2 !== null) applyParsed(reparsedMerge(parsed, parsed2));
      return out;
    }
    const repaired = await this.chat({
      system: `${asking.system}\n\nYour previous answer was not valid JSON. Return ONLY the JSON object with those keys.`,
      user: `Previous answer:\n${raw}\n\nReturn only the corrected JSON object.`,
      temperature: 0,
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
    });
    const parsed2 = extractJson(repaired);
    if (parsed2 !== null) applyParsed(parsed2);
    return out;
  }

  private async request(path: string, body: unknown): Promise<{ text: string; usage: RawLlmUsage }> {
    const url = `${this.profile.baseUrl.replace(/\/$/, "")}${path}`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.profile.wireFormat === "anthropic") {
      headers["x-api-key"] = this.profile.apiKey ?? "";
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.authorization = `Bearer ${this.profile.apiKey ?? ""}`;
    }
    Object.assign(headers, this.profile.extraHeaders ?? {});

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 60_000);
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      if (res.status === 401 || res.status === 403) throw new AdapterError(`LLM auth failed (${res.status})`, "auth");
      if (res.status === 429) throw new AdapterError("LLM rate limited (429)", "rate-limit");
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        throw new AdapterError(`LLM HTTP ${res.status}: ${detail}`, "http");
      }
      const data = (await res.json()) as Record<string, unknown>;
      const usage = extractUsage(data);
      if (this.profile.wireFormat === "anthropic") {
        const content = (data.content ?? []) as { type: string; text?: string }[];
        const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
        if (!text) throw new AdapterError("anthropic returned no text content", "parse");
        return { text, usage };
      }
      const choices = (data.choices ?? []) as { message?: { content?: unknown; refusal?: unknown; reasoning?: unknown } }[];
      const content = choices[0]?.message?.content;
      const text = openAiTextContent(content);
      if (text === null) {
        // Diagnose the shape so provider quirks surface in the error itself.
        const message = choices[0]?.message ?? {};
        const shape = JSON.stringify(Object.fromEntries(Object.entries(message).map(([k, v]) => [k, typeof v])));
        let snippet = "";
        try {
          snippet = ` content=${JSON.stringify(content).slice(0, 300)}`;
        } catch {
          // ignore unstringifiable content
        }
        throw new AdapterError(`openai-format response had no text content (message shape: ${shape};${snippet})`, "parse");
      }
      return { text, usage };
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      if (err instanceof Error && err.name === "AbortError") throw new AdapterError("LLM request timed out", "http", err);
      throw new AdapterError(`LLM request failed: ${String(err)}`, "http", err);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Normalises the provider-reported token usage across wire formats:
 * OpenAI/OpenRouter (`usage.prompt_tokens`, `completion_tokens`,
 * `prompt_tokens_details.cached_tokens`), Anthropic (`usage.input_tokens`,
 * `output_tokens`, `cache_read_input_tokens`) and DeepSeek's cache hit/miss
 * fields. Unreported counts are 0 — a missing usage block never fails a call.
 */
export function extractUsage(data: Record<string, unknown>): RawLlmUsage {
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  const num = (key: string): number => {
    const value = usage[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  // DeepSeek reports cache hit/miss separately instead of a total prompt count.
  const promptTokens = num("prompt_tokens") || num("input_tokens") || num("prompt_cache_hit_tokens") + num("prompt_cache_miss_tokens");
  const details = (usage.prompt_tokens_details ?? usage.input_tokens_details) as Record<string, unknown> | undefined;
  const nestedCached = details && typeof details.cached_tokens === "number" ? details.cached_tokens : 0;
  const cachedTokens = Math.max(num("cached_tokens"), num("cache_read_input_tokens"), num("prompt_cache_hit_tokens"), nestedCached);
  return {
    promptTokens,
    completionTokens: num("completion_tokens") || num("output_tokens"),
    cachedTokens,
  };
}

/**
 * Normalises an OpenAI-wire `message.content`: plain string, a parts array
 * (`[{type:"text", text}, ...]` — OpenRouter returns this shape for some
 * reasoning-capable models such as llama-4), or a single part object
 * (`{type:"text", text}` / `{text}` — some providers emit one part without
 * the array). Returns null when no text is present.
 */
export function openAiTextContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content; // empty strings keep the caller's repair-retry path alive
  }
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type?: unknown; text?: unknown } => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text")
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  if (typeof content === "object" && content !== null) {
    const obj = content as { type?: unknown; text?: unknown };
    if ((obj.type === undefined || obj.type === "text") && typeof obj.text === "string") return obj.text;
  }
  return null;
}

/** Merges a repair response over the original parse (repairs usually carry only the missing keys). */
function reparsedMerge(first: unknown, second: unknown): Record<string, unknown> {
  return {
    ...((first ?? {}) as Record<string, unknown>),
    ...((second ?? {}) as Record<string, unknown>),
  };
}

/** Extracts the first JSON object/array from an LLM reply (handles markdown fences and surrounding prose). */
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    // fall through to substring scan
  }
  const firstBrace = candidate.indexOf("{");
  const firstBracket = candidate.indexOf("[");
  let start = -1;
  let endChar = "";
  if (firstBrace === -1 && firstBracket === -1) return null;
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    start = firstBrace;
    endChar = "}";
  } else {
    start = firstBracket;
    endChar = "]";
  }
  const end = candidate.lastIndexOf(endChar);
  if (end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

export function makeLlmClient(params: {
  provider: string;
  config?: { baseUrl?: string; model?: string };
  apiKey: string | null;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  thinking?: "enabled" | "disabled";
  /** Price table for cost accounting (defaults to DEFAULT_MODEL_PRICES). */
  prices?: Record<string, LlmModelPrice>;
  /** Called after each successful call with token usage + estimated cost. */
  onUsage?: (usage: RawLlmUsage & { usdCost: number; provider: string; model: string }) => void;
}): LlmPort {
  const base = PROVIDER_PROFILES[params.provider as keyof typeof PROVIDER_PROFILES];
  if (!base) throw new AdapterError(`unknown LLM provider: ${params.provider}`, "unsupported");
  const profile: LlmProviderProfile = {
    name: base.name,
    baseUrl: params.config?.baseUrl ?? base.baseUrl,
    model: params.config?.model ?? base.model,
    apiKey: params.apiKey,
    wireFormat: base.wireFormat as LlmProviderProfile["wireFormat"],
  };
  if (params.thinking !== undefined) profile.thinking = params.thinking;
  const clientOpts: {
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    prices?: Record<string, LlmModelPrice>;
    onUsage?: (usage: RawLlmUsage & { usdCost: number; provider: string; model: string }) => void;
  } = {};
  if (params.temperature !== undefined) clientOpts.temperature = params.temperature;
  if (params.maxTokens !== undefined) clientOpts.maxTokens = params.maxTokens;
  if (params.timeoutMs !== undefined) clientOpts.timeoutMs = params.timeoutMs;
  if (params.prices !== undefined) clientOpts.prices = params.prices;
  if (params.onUsage !== undefined) clientOpts.onUsage = params.onUsage;
  return new HttpLlmClient(profile, clientOpts);
}

/** Fallback used when no key is configured: keeps the LlmPort contract satisfied. */
export class UnavailableLlmClient implements LlmPort {
  available(): boolean {
    return false;
  }
  async chat(): Promise<string> {
    throw new AdapterError("no LLM provider configured", "auth");
  }
  async chatJson<T>(): Promise<T> {
    throw new AdapterError("no LLM provider configured", "auth");
  }
}

export function jsonSchemaHint(): z.ZodType<Record<string, unknown>> {
  return z.record(z.unknown());
}
