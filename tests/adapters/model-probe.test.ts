import { afterEach, describe, expect, it, vi } from "vitest";
import { formatProbeResults, modelExists, probeModel } from "../../src/adapters/llm/model-probe.js";
import type { LlmProviderProfile } from "../../src/adapters/llm/http-llm-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const profile = (over: Partial<LlmProviderProfile> = {}): LlmProviderProfile => ({
  name: "deepseek",
  baseUrl: "https://api.example.com/v1",
  model: "deepseek-v4-flash",
  apiKey: "key",
  wireFormat: "openai",
  ...over,
});

function stubFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("modelExists", () => {
  it("matches exact ids, vendor-prefixed ids and ~aliases", () => {
    const ids = ["deepseek-v4-flash", "google/gemini-3.8-flash", "z-ai/glm-5.3-flash"];
    expect(modelExists("deepseek-v4-flash", ids)).toBe(true);
    expect(modelExists("gemini-3.8-flash", ids)).toBe(true); // config without the vendor prefix
    expect(modelExists("google/gemini-3.8-flash", ids)).toBe(true);
    expect(modelExists("~google/gemini-3.8-flash", ids)).toBe(true); // OpenRouter alias form
    expect(modelExists("~deepseek/deepseek-v4-flash-latest", ["deepseek/deepseek-v4-flash-latest"])).toBe(true);
  });

  it("rejects a retired or renamed id", () => {
    expect(modelExists("moonshotai/kimi-k3", ["moonshotai/kimi-k2", "deepseek/deepseek-v4-pro"])).toBe(false);
    expect(modelExists("deepseek-v4-turbo", ["deepseek-v4-flash", "deepseek-v4-pro"])).toBe(false);
  });
});

describe("probeModel", () => {
  it("reports ok when the provider lists the model", async () => {
    const fetchMock = stubFetch({ data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] });
    const result = await probeModel(profile());
    expect(result).toEqual({ provider: "deepseek", model: "deepseek-v4-flash", verdict: "ok", detail: "listed by deepseek" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/models");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer key");
  });

  it("reports missing with the reason a live start must refuse on", async () => {
    stubFetch({ data: [{ id: "deepseek-v4-pro" }] });
    const result = await probeModel(profile({ model: "moonshotai/kimi-k3" }));
    expect(result.verdict).toBe("missing");
    expect(result.detail).toContain("retired, renamed or blocked");
    expect(result.detail).toContain("1 models");
  });

  it("accepts an array-shaped models response and anthropic auth", async () => {
    const fetchMock = stubFetch([{ id: "claude-3-5-haiku-latest" }]);
    const result = await probeModel(profile({ name: "anthropic", model: "claude-3-5-haiku-latest", wireFormat: "anthropic" }));
    expect(result.verdict).toBe("ok");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("key");
  });

  it("never blocks a start on an unusable check (auth, 404 endpoint, network)", async () => {
    stubFetch({ error: "nope" }, 401);
    expect((await probeModel(profile())).verdict).toBe("unreachable");

    stubFetch({ error: "not found" }, 404);
    expect((await probeModel(profile())).verdict).toBe("unsupported");

    stubFetch({ data: [] });
    expect((await probeModel(profile())).verdict).toBe("unsupported");

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const offline = await probeModel(profile());
    expect(offline.verdict).toBe("unreachable");
    expect(offline.detail).toContain("ECONNREFUSED");

    expect((await probeModel(profile({ apiKey: null }))).verdict).toBe("unreachable");
  });

  it("formats one line per model for the startup log", () => {
    const lines = formatProbeResults([
      { provider: "deepseek", model: "deepseek-v4-flash", verdict: "ok", detail: "listed by deepseek" },
      { provider: "openrouter", model: "moonshotai/kimi-k3", verdict: "missing", detail: "not listed" },
    ]);
    expect(lines[0]).toContain("OK");
    expect(lines[0]).toContain("deepseek/deepseek-v4-flash");
    expect(lines[1]).toContain("MISSING");
    expect(lines[1]).toContain("moonshotai/kimi-k3");
  });
});
