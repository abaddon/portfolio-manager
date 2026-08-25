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
}

export const PROVIDER_PROFILES = {
  deepseek: { name: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", wireFormat: "openai" },
  openai: { name: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", wireFormat: "openai" },
  anthropic: { name: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-3-5-haiku-latest", wireFormat: "anthropic" },
  openrouter: { name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat", wireFormat: "openai" },
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
    private readonly opts: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
  ) {}

  available(): boolean {
    return this.profile.apiKey !== null && this.profile.apiKey.length > 0;
  }

  async chat(opts: LlmChatOptions): Promise<string> {
    if (!this.available()) throw new AdapterError("no API key for LLM provider", "auth");
    const body =
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
    const text = await this.request(this.profile.wireFormat === "anthropic" ? "/messages" : "/chat/completions", body);
    return text;
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
    const repaired = await this.chat(repairOpts);
    const parsed2 = extractJson(repaired);
    if (parsed2 === null) throw new AdapterError("LLM returned non-JSON output twice", "parse");
    const result = schema.safeParse(parsed2);
    if (!result.success) {
      throw new AdapterError(`LLM output failed schema validation: ${result.error.message}`, "parse");
    }
    return result.data;
  }

  private async request(path: string, body: unknown): Promise<string> {
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
      if (this.profile.wireFormat === "anthropic") {
        const content = (data.content ?? []) as { type: string; text?: string }[];
        const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
        if (!text) throw new AdapterError("anthropic returned no text content", "parse");
        return text;
      }
      const choices = (data.choices ?? []) as { message?: { content?: unknown } }[];
      const content = choices[0]?.message?.content;
      if (typeof content !== "string") throw new AdapterError("openai-format response had no text content", "parse");
      return content;
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      if (err instanceof Error && err.name === "AbortError") throw new AdapterError("LLM request timed out", "http", err);
      throw new AdapterError(`LLM request failed: ${String(err)}`, "http", err);
    } finally {
      clearTimeout(timer);
    }
  }
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
  const clientOpts: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {};
  if (params.temperature !== undefined) clientOpts.temperature = params.temperature;
  if (params.maxTokens !== undefined) clientOpts.maxTokens = params.maxTokens;
  if (params.timeoutMs !== undefined) clientOpts.timeoutMs = params.timeoutMs;
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
