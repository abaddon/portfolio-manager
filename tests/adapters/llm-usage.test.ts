import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  DEFAULT_MODEL_PRICES,
  HttpLlmClient,
  estimateUsageCostUsd,
  extractUsage,
  makeLlmClient,
  resolveModelPrice,
  type RawLlmUsage,
} from "../../src/adapters/llm/http-llm-client.js";
import { AdapterError } from "../../src/shared/errors.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(responses: { body: unknown; status?: number }[]) {
  const fn = vi.fn(async () => {
    const r = responses.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("extractUsage", () => {
  it("reads OpenAI/OpenRouter prompt + completion tokens and cached details", () => {
    expect(
      extractUsage({
        usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 800 } },
      }),
    ).toEqual({ promptTokens: 1200, completionTokens: 300, cachedTokens: 800 });
  });

  it("reads Anthropic input/output and cache-read tokens", () => {
    expect(extractUsage({ usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 640 } })).toEqual({
      promptTokens: 900,
      completionTokens: 120,
      cachedTokens: 640,
    });
  });

  it("sums DeepSeek cache hit/miss fields when there is no prompt total", () => {
    expect(extractUsage({ usage: { prompt_cache_hit_tokens: 512, prompt_cache_miss_tokens: 128, completion_tokens: 64 } })).toEqual({
      promptTokens: 640,
      completionTokens: 64,
      cachedTokens: 512,
    });
  });

  it("returns zeros when the provider reports no usage (never throws)", () => {
    expect(extractUsage({})).toEqual({ promptTokens: 0, completionTokens: 0, cachedTokens: 0 });
    expect(extractUsage({ usage: { prompt_tokens: "many" } })).toEqual({ promptTokens: 0, completionTokens: 0, cachedTokens: 0 });
  });
});

describe("resolveModelPrice", () => {
  it("matches an exact model id first", () => {
    expect(resolveModelPrice("deepseek-v4-flash", DEFAULT_MODEL_PRICES)?.inputPerMillionUsd).toBe(0.28);
  });

  it("matches the longest table key contained in a provider-prefixed id", () => {
    expect(resolveModelPrice("~deepseek/deepseek-v4-flash-latest", DEFAULT_MODEL_PRICES)?.outputPerMillionUsd).toBe(0.42);
    expect(resolveModelPrice("deepseek/deepseek-v4-pro-0813", DEFAULT_MODEL_PRICES)?.outputPerMillionUsd).toBe(2.19);
  });

  it("returns null for an unpriced model (usage is recorded, cost stays 0)", () => {
    expect(resolveModelPrice("some/unknown-model", DEFAULT_MODEL_PRICES)).toBeNull();
  });
});

describe("estimateUsageCostUsd", () => {
  it("prices fresh input, cached input and output separately", () => {
    const usage: RawLlmUsage = { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 500_000 };
    // 500k fresh @0.28 + 500k cached @0.028 + 1M out @0.42
    expect(estimateUsageCostUsd(usage, DEFAULT_MODEL_PRICES["deepseek-v4-flash"]!)).toBeCloseTo(0.574, 6);
  });

  it("ignores an over-reported cached count (cached can never exceed prompt)", () => {
    const usage: RawLlmUsage = { promptTokens: 100, completionTokens: 0, cachedTokens: 999 };
    expect(estimateUsageCostUsd(usage, { inputPerMillionUsd: 1, outputPerMillionUsd: 0 })).toBeCloseTo(0.0001, 9);
  });

  it("costs nothing without a price", () => {
    expect(estimateUsageCostUsd({ promptTokens: 10, completionTokens: 10, cachedTokens: 0 }, null)).toBe(0);
  });
});

describe("HttpLlmClient usage reporting", () => {
  const makeClient = (onUsage: (u: RawLlmUsage & { usdCost: number; provider: string; model: string }) => void) =>
    new HttpLlmClient(
      { name: "deepseek", baseUrl: "https://api.example.com/v1", model: "deepseek-v4-flash", apiKey: "key", wireFormat: "openai" },
      { onUsage },
    );

  it("reports prompt/completion/cached tokens and the estimated cost after a call", async () => {
    stubFetch([
      {
        body: {
          choices: [{ message: { content: "hello" } }],
          usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 400 } },
        },
      },
    ]);
    const seen: (RawLlmUsage & { usdCost: number; provider: string; model: string })[] = [];
    const text = await makeClient((u) => seen.push(u)).chat({ system: "s", user: "u" });
    expect(text).toBe("hello");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      promptTokens: 1000,
      completionTokens: 500,
      cachedTokens: 400,
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    // 600 fresh @0.28 + 400 cached @0.028 + 500 out @0.42 per 1M tokens
    expect(seen[0]!.usdCost).toBeCloseTo(0.000389, 6);
  });

  it("accounts for both calls of a JSON repair retry", async () => {
    stubFetch([
      { body: { choices: [{ message: { content: "not json" } }], usage: { prompt_tokens: 100, completion_tokens: 10 } } },
      { body: { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 130, completion_tokens: 12 } } },
    ]);
    const seen: unknown[] = [];
    const { z } = await import("zod");
    const out = await makeClient((u) => seen.push(u)).chatJson({ system: "s", user: "u" }, z.object({ ok: z.boolean() }));
    expect(out).toEqual({ ok: true });
    expect(seen).toHaveLength(2);
  });

  it("reports nothing when the provider call failed", async () => {
    stubFetch([{ status: 429, body: { error: "rate limited" } }]);
    const seen: unknown[] = [];
    await expect(makeClient((u) => seen.push(u)).chat({ system: "s", user: "u" })).rejects.toBeInstanceOf(AdapterError);
    expect(seen).toHaveLength(0);
  });

  it("honours a per-call thinking override over the client default", async () => {
    const fetchMock = stubFetch([
      { body: { choices: [{ message: { content: "a" } }] } },
      { body: { choices: [{ message: { content: "b" } }] } },
    ]);
    const client = new HttpLlmClient(
      {
        name: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "m",
        apiKey: "key",
        wireFormat: "openai",
        thinking: "enabled",
      },
      {},
    );
    await client.chat({ system: "s", user: "u", thinking: "disabled" });
    await client.chat({ system: "s", user: "u" });
    const first = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    const second = JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(first.thinking).toEqual({ type: "disabled" });
    expect(first.reasoning).toEqual({ enabled: false });
    expect(second.thinking).toBeUndefined();
  });

  it("forwards the price table and usage sink through makeLlmClient", async () => {
    stubFetch([{ body: { choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } }]);
    const seen: { usdCost: number }[] = [];
    const client = makeLlmClient({
      provider: "deepseek",
      apiKey: "key",
      prices: { "deepseek-v4-flash": { inputPerMillionUsd: 1, outputPerMillionUsd: 10 } },
      onUsage: (u) => seen.push({ usdCost: u.usdCost }),
    });
    await client.chat({ system: "s", user: "u" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.usdCost).toBeCloseTo(0.00006, 9);
  });
});

describe("HttpLlmClient.chatJsonMulti (WP-P1.2)", () => {
  const schemaA = z.object({ conclusion: z.enum(["bullish", "bearish"]), confidence: z.number() });
  const schemaB = z.object({ score: z.number().min(-1).max(1) });

  function client() {
    return new HttpLlmClient({ name: "deepseek", baseUrl: "https://api.example.com/v1", model: "m", apiKey: "key", wireFormat: "openai" });
  }

  it("asks for one JSON object with every key and validates each value separately", async () => {
    const fetchMock = stubFetch([
      { body: { choices: [{ message: { content: JSON.stringify({ market: { conclusion: "bullish", confidence: 0.7 }, sentiment: { score: -0.4 } }) } }] } },
    ]);
    const out = await client().chatJsonMulti({ system: "s", user: "u" }, { market: schemaA, sentiment: schemaB });
    expect(out).toEqual({ market: { conclusion: "bullish", confidence: 0.7 }, sentiment: { score: -0.4 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.messages[0].content).toContain('"market": <market object>');
    expect(body.messages[0].content).toContain('"sentiment": <sentiment object>');
  });

  it("omits only the keys that fail validation instead of failing the call", async () => {
    stubFetch([
      { body: { choices: [{ message: { content: JSON.stringify({ market: { conclusion: "bullish", confidence: 0.7 }, sentiment: { score: 5 } }) } }] } },
      // The repair retry returns the missing key.
      { body: { choices: [{ message: { content: JSON.stringify({ sentiment: { score: 0.2 } }) } }] } },
    ]);
    const out = await client().chatJsonMulti({ system: "s", user: "u" }, { market: schemaA, sentiment: schemaB });
    expect(out.market).toEqual({ conclusion: "bullish", confidence: 0.7 });
    expect(out.sentiment).toEqual({ score: 0.2 });
  });

  it("returns whatever validated when the reply is not JSON at all", async () => {
    stubFetch([
      { body: { choices: [{ message: { content: "I cannot help with that." } }] } },
      { body: { choices: [{ message: { content: JSON.stringify({ market: { conclusion: "bearish", confidence: 0.4 } }) } }] } },
    ]);
    const out = await client().chatJsonMulti({ system: "s", user: "u" }, { market: schemaA, sentiment: schemaB });
    expect(out).toEqual({ market: { conclusion: "bearish", confidence: 0.4 } });
  });
});
