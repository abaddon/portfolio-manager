import { z } from "zod";
import { AdapterError } from "../../shared/errors.js";
import type { MacroSnapshot } from "../../domain/analysis.js";
import type { MacroDataPort } from "../../application/ports.js";

const ObservationsResponseSchema = z.object({
  observations: z.array(
    z.object({
      date: z.string(),
      value: z.string(),
    }),
  ),
});

/** FRED series per macro field (percent series are already in % units). */
const SERIES = {
  fedFundsRatePct: "DFF",
  treasury10yPct: "DGS10",
  treasury2yPct: "DGS2",
  yieldSpread10y2yPct: "T10Y2Y",
  vix: "VIXCLS",
  unemploymentPct: "UNRATE",
  sp500: "SP500",
} as const;

/**
 * FRED (Federal Reserve Economic Data) macro adapter. Fetches one daily/monthly
 * observation per series per run (8 series → 8 requests, far below the keyed
 * 120 req/min limit). Missing values (".") map to null; one failing series
 * never kills the snapshot.
 */
export class FredAdapter implements MacroDataPort {
  private readonly base = "https://api.stlouisfed.org/fred/series";

  constructor(private readonly apiKey: string) {}

  async macroSnapshot(): Promise<MacroSnapshot> {
    const entries = await Promise.all(
      Object.entries(SERIES).map(async ([field, seriesId]) => {
        const observations = await this.observations(seriesId, 2);
        const latest = latestValid(observations);
        return [field, latest] as const;
      }),
    );
    const cpiYoYPct = await this.cpiYoY();
    const macro = Object.fromEntries(entries) as Omit<MacroSnapshot, "asOf" | "cpiYoYPct">;
    return { ...macro, cpiYoYPct, asOf: new Date().toISOString() };
  }

  /** Latest value of a series (null when missing or absent). */
  private async observations(seriesId: string, limit: number): Promise<{ date: string; value: number | null }[]> {
    const url =
      `${this.base}/observations?series_id=${encodeURIComponent(seriesId)}` +
      `&sort_order=desc&limit=${limit}&file_type=json&api_key=${encodeURIComponent(this.apiKey)}`;
    const res = await this.requestWithRetry(url);
    if (res.status === 400) {
      // FRED reports unregistered keys as a 400 with this message.
      const body = (await res.text()).slice(0, 200);
      if (body.includes("api_key")) throw new AdapterError("fred api key rejected (400)", "auth");
      throw new AdapterError(`fred HTTP 400 for ${seriesId}`, "http");
    }
    if (res.status === 429) throw new AdapterError("fred rate limited", "rate-limit");
    if (!res.ok) throw new AdapterError(`fred HTTP ${res.status}`, "http");
    const parsed = ObservationsResponseSchema.safeParse(await res.json());
    if (!parsed.success) throw new AdapterError(`fred parse error: ${parsed.error.message}`, "parse");
    return parsed.data.observations.map((o) => ({ date: o.date, value: o.value === "." ? null : Number(o.value) }));
  }

  private async requestWithRetry(url: string): Promise<Response> {
    const res = await fetch(url);
    // FRED intermittently 502s under load (observed live); one retry on
    // transient responses like the 429 handling.
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2_000));
      return fetch(url);
    }
    return res;
  }

  /** CPIAUCSL is monthly; compute the 12-month % change from 13 observations. */
  private async cpiYoY(): Promise<number | null> {
    const observations = await this.observations("CPIAUCSL", 13);
    const latest = observations.find((o) => o.value !== null);
    if (!latest?.value) return null;
    // Walk back ~12 months from the latest date; tolerate missing months.
    const cutoff = new Date(latest.date);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 12);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    const yearAgo = observations.find((o) => o.value !== null && o.date <= cutoffIso);
    if (!yearAgo?.value) return null;
    return round2(((latest.value / yearAgo.value) - 1) * 100);
  }
}

function latestValid(observations: { date: string; value: number | null }[]): number | null {
  for (const o of observations) {
    if (o.value !== null) return o.value;
  }
  return null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
