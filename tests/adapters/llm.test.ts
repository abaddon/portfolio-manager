import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HttpLlmClient, extractJson, makeLlmClient, PROVIDER_PROFILES } from "../../src/adapters/llm/http-llm-client.js";
import { AdapterError } from "../../src/shared/errors.js";

const originalFetch = globalThis.fetch;
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

describe("extractJson", () => {
  it("parses plain JSON objects and arrays", () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
    expect(extractJson("[1,2]")).toEqual([1, 2]);
  });

  it("handles markdown fences and surrounding prose", () => {
    expect(extractJson('Sure! Here it is:\n```json\n{"conclusion": "bullish"}\n```\nHope it helps.')).toEqual({ conclusion: "bullish" });
    expect(extractJson('The answer is {"x": "y"} thanks')).toEqual({ x: "y" });
  });

  it("returns null for non-JSON", () => {
    expect(extractJson("no json here")).toBeNull();
  });
});

describe("HttpLlmClient", () => {
  const Schema = z.object({ conclusion: z.enum(["bullish", "bearish"]), confidence: z.number() });

  function client() {
    return new HttpLlmClient({ name: "deepseek", baseUrl: "https://api.example.com/v1", model: "m", apiKey: "key", wireFormat: "openai" });
  }

  it("sends OpenAI-format requests with bearer auth", async () => {
    const fetchMock = stubFetch([
      { body: { choices: [{ message: { content: "hi" } }] } },
    ]);
    const c = client();
    expect(await c.chat({ system: "s", user: "u" })).toBe("hi");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer key");
    expect(JSON.parse(String(init.body)).messages).toHaveLength(2);
  });

  it("joins content-parts arrays (OpenRouter reasoning models return text as parts)", async () => {
    stubFetch([
      {
        body: {
          choices: [
            {
              message: {
                reasoning: "thinking…",
                content: [{ type: "text", text: "part one " }, { type: "text", text: "part two" }],
              },
            },
          ],
        },
      },
    ]);
    const c = client();
    expect(await c.chat({ system: "s", user: "u" })).toBe("part one part two");
  });

  it("repairs an empty-text response with one retry (empty content keeps the repair path)", async () => {
    const fetchMock = stubFetch([
      { body: { choices: [{ message: { content: [{ type: "text", text: "" }] } }] } },
      { body: { choices: [{ message: { content: '{"conclusion": "bullish", "confidence": 0.6}' } }] } },
    ]);
    const out = await client().chatJson({ system: "s", user: "u" }, Schema);
    expect(out.conclusion).toBe("bullish");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports the message shape when the response has no text content at all", async () => {
    stubFetch([{ body: { choices: [{ message: { role: "assistant", reasoning: "only thinking, no answer" } }] } }]);
    await expect(client().chat({ system: "s", user: "u" })).rejects.toThrow(/no text content.*message shape/);
  });

  it("disables thinking mode when configured (DeepSeek v4 default is ON)", async () => {
    const fetchMock = stubFetch([{ body: { choices: [{ message: { content: "hi" } }] } }]);
    const c = new HttpLlmClient(
      { name: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-flash", apiKey: "k", wireFormat: "openai", thinking: "disabled" },
    );
    await c.chat({ system: "s", user: "u" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).thinking).toEqual({ type: "disabled" });

    const fetchMock2 = stubFetch([{ body: { content: [{ type: "text", text: "hi" }] } }]);
    const a = new HttpLlmClient(
      { name: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "m", apiKey: "k", wireFormat: "anthropic", thinking: "disabled" },
    );
    await a.chat({ system: "s", user: "u" });
    const [, init2] = fetchMock2.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init2.body)).reasoning).toEqual({ effort: "none" });
  });

  it("sends Anthropic-format requests", async () => {
    const fetchMock = stubFetch([{ body: { content: [{ type: "text", text: "hi" }] } }]);
    const c = new HttpLlmClient({ name: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "m", apiKey: "key", wireFormat: "anthropic" });
    expect(await c.chat({ system: "s", user: "u" })).toBe("hi");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("key");
  });

  it("validates structured output with zod", async () => {
    stubFetch([{ body: { choices: [{ message: { content: '{"conclusion": "bullish", "confidence": 0.9}' } }] } }]);
    const out = await client().chatJson({ system: "s", user: "u" }, Schema);
    expect(out).toEqual({ conclusion: "bullish", confidence: 0.9 });
  });

  it("repairs invalid JSON with one retry", async () => {
    const fetchMock = stubFetch([
      { body: { choices: [{ message: { content: "not json at all" } }] } },
      { body: { choices: [{ message: { content: '{"conclusion": "bearish", "confidence": 0.4}' } }] } },
    ]);
    const out = await client().chatJson({ system: "s", user: "u" }, Schema);
    expect(out.conclusion).toBe("bearish");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("raises AdapterError after two failures", async () => {
    stubFetch([
      { body: { choices: [{ message: { content: "nope" } }] } },
      { body: { choices: [{ message: { content: "still nope" } }] } },
    ]);
    await expect(client().chatJson({ system: "s", user: "u" }, Schema)).rejects.toThrow(AdapterError);
  });

  it("maps auth and rate-limit failures to typed AdapterErrors", async () => {
    stubFetch([{ body: {}, status: 401 }]);
    await expect(client().chat({ system: "s", user: "u" })).rejects.toMatchObject({ kind: "auth" });
    stubFetch([{ body: {}, status: 429 }]);
    await expect(client().chat({ system: "s", user: "u" })).rejects.toMatchObject({ kind: "rate-limit" });
  });

  it("reports unavailable when no key is set", () => {
    const c = makeLlmClient({ provider: "deepseek", apiKey: null });
    expect(c.available()).toBe(false);
  });

  it("exposes profiles for all four providers", () => {
    expect(PROVIDER_PROFILES.deepseek.baseUrl).toContain("deepseek.com");
    expect(PROVIDER_PROFILES.openai.baseUrl).toContain("openai.com");
    expect(PROVIDER_PROFILES.anthropic.baseUrl).toContain("anthropic.com");
    expect(PROVIDER_PROFILES.openrouter.baseUrl).toContain("openrouter.ai");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
});
