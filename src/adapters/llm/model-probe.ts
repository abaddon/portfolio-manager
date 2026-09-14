import { AdapterError } from "../../shared/errors.js";
import type { LlmProviderProfile } from "./http-llm-client.js";

export type ModelProbeVerdict = "ok" | "missing" | "unreachable" | "unsupported";

export interface ModelProbeResult {
  provider: string;
  model: string;
  verdict: ModelProbeVerdict;
  detail: string;
}

function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/models`;
}

function authHeaders(profile: LlmProviderProfile): Record<string, string> {
  if (profile.wireFormat === "anthropic") {
    return { "x-api-key": profile.apiKey ?? "", "anthropic-version": "2023-06-01" };
  }
  return { authorization: `Bearer ${profile.apiKey ?? ""}` };
}

/**
 * Checks that a configured model id actually exists at its provider, **before**
 * the pipeline spends a run's worth of analysis on a committee that cannot
 * answer (WP-P0.5). A retired id used to surface as
 * `LLM HTTP 404: proposal agent momentum-trader (moonshotai/kimi-k3) failed`
 * after the analysis step had already been paid for.
 *
 * The check lists the provider's models (free, no inference) and looks for the
 * id by exact match or suffix — OpenRouter returns `vendor/model` while configs
 * often carry a `~vendor/model-latest` alias, so both forms must match.
 * Providers without a listable endpoint are reported `unsupported` and never
 * block a start: the probe is a guard, not a new failure mode.
 */
export async function probeModel(
  profile: LlmProviderProfile,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ModelProbeResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const result = (verdict: ModelProbeVerdict, detail: string): ModelProbeResult => ({
    provider: profile.name,
    model: profile.model,
    verdict,
    detail,
  });
  if (!profile.apiKey) return result("unreachable", "no API key configured for this provider");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await doFetch(modelsUrl(profile.baseUrl), { headers: authHeaders(profile), signal: controller.signal });
    if (res.status === 401 || res.status === 403) return result("unreachable", `auth failed (${res.status})`);
    if (res.status === 404) return result("unsupported", "provider does not expose a models list");
    if (!res.ok) return result("unreachable", `HTTP ${res.status}`);
    const data: unknown = await res.json();
    const list: unknown[] = Array.isArray(data) ? data : ((data as { data?: unknown } | null)?.data as unknown[]) ?? [];
    const ids = list
      .map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === "string");
    if (ids.length === 0) return result("unsupported", "provider returned an empty model list");
    if (modelExists(profile.model, ids)) return result("ok", `listed by ${profile.name}`);
    return result("missing", `not in ${profile.name}'s model list (${ids.length} models) — the id is retired, renamed or blocked`);
  } catch (err) {
    if (err instanceof AdapterError) return result("unreachable", err.message);
    return result("unreachable", err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** True when `model` matches a listed id exactly, by suffix, or ignoring an alias `~` prefix. */
export function modelExists(model: string, ids: string[]): boolean {
  const normalise = (value: string): string => value.replace(/^~/, "");
  const wanted = normalise(model);
  return ids.some((id) => {
    const listed = normalise(id);
    return listed === wanted || listed.endsWith(`/${wanted}`) || wanted.endsWith(`/${listed}`);
  });
}

/** One line per agent for the startup log / `pnpm verify-models`. */
export function formatProbeResults(results: ModelProbeResult[]): string[] {
  return results.map((r) => {
    const badge = r.verdict === "ok" ? "OK" : r.verdict.toUpperCase();
    return `${badge.padEnd(11)} ${r.provider}/${r.model} — ${r.detail}`;
  });
}
