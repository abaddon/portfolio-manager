import { AdapterError } from "../../shared/errors.js";
import type { FxPort } from "../../application/ports.js";

/**
 * FX rates from the free er-api (open.er-api.com, no key, daily ECB-based
 * rates), cached 12h, with USD-cross resolution. Finnhub's free tier does not
 * include /forex/rates (403), so FX has its own provider here.
 */
export class ErApiFxAdapter implements FxPort {
  private readonly base = "https://open.er-api.com/v6/latest/USD";
  private cached: { rates: Record<string, number>; at: number } | null = null;
  private readonly ttlMs = 12 * 3_600_000;

  constructor(private readonly opts: { ttlMs?: number; baseUrl?: string } = {}) {}

  async rate(from: string, to: string): Promise<number> {
    if (from === to) return 1;
    const rates = await this.rates();
    const f = rates[from];
    const t = rates[to];
    if (f === undefined || t === undefined) {
      throw new AdapterError(`er-api fx: unsupported pair ${from}>${to}`, "unsupported");
    }
    return t / f; // 1 from-unit in USD × to-units per USD
  }

  private async rates(): Promise<Record<string, number>> {
    const ttl = this.opts.ttlMs ?? this.ttlMs;
    if (this.cached && Date.now() - this.cached.at < ttl) return this.cached.rates;
    const url = this.opts.baseUrl ?? this.base;
    const res = await fetch(url);
    if (!res.ok) throw new AdapterError(`er-api fx HTTP ${res.status}`, "http");
    const data = (await res.json()) as { result?: string; rates?: Record<string, number> };
    if (data.result !== "success" || !data.rates) throw new AdapterError("er-api fx: unexpected payload", "parse");
    this.cached = { rates: data.rates, at: Date.now() };
    return data.rates;
  }
}

/** Tries adapters in order; the last one should be deterministic (demo). */
export class FallbackFxAdapter implements FxPort {
  constructor(private readonly chain: FxPort[]) {}

  async rate(from: string, to: string): Promise<number> {
    if (from === to) return 1;
    let lastError: unknown = null;
    for (const adapter of this.chain) {
      try {
        return await adapter.rate(from, to);
      } catch (err) {
        lastError = err;
      }
    }
    throw new AdapterError(`fx: all adapters failed for ${from}>${to}: ${String(lastError)}`, "http");
  }
}
