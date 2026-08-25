import { z } from "zod";
import { AdapterError } from "../../shared/errors.js";
import type {
  Candle,
  Fundamentals,
  MarketSnapshot,
  NewsItem,
  SentimentScore,
} from "../../domain/analysis.js";
import type { FxPort, FundamentalsPort, NewsPort, PriceDataPort, SentimentPort } from "../../application/ports.js";

const QuoteSchema = z.object({
  c: z.number(), // current
  d: z.number().nullable(), // change
  dp: z.number().nullable(), // percent change
  h: z.number(),
  l: z.number(),
  o: z.number(),
  pc: z.number(), // previous close
  t: z.number(),
});

const CandlesSchema = z.object({
  c: z.array(z.number()),
  h: z.array(z.number()),
  l: z.array(z.number()),
  o: z.array(z.number()),
  t: z.array(z.number()),
  v: z.array(z.number()),
  s: z.string(),
});

const NewsItemSchema = z.object({
  id: z.number(),
  headline: z.string(),
  source: z.string(),
  url: z.string(),
  datetime: z.number(),
  summary: z.string().optional(),
});

const CompanyProfileSchema = z.object({
  pe: z.number().nullable().optional(),
  marketCapitalization: z.number().nullable().optional(),
  name: z.string().optional(),
});

const BasicFinancialsSchema = z.object({
  metric: z.object({
    peTTM: z.number().nullable().optional(),
    pbAnnual: z.number().nullable().optional(),
    epsTTM: z.number().nullable().optional(),
    revenueGrowthTTMYoy: z.number().nullable().optional(),
    grossMarginTTM: z.number().nullable().optional(),
    netProfitMarginTTM: z.number().nullable().optional(),
    totalDebtTotalEquityQuarterly: z.number().nullable().optional(),
    dividendYieldIndicatedAnnual: z.number().nullable().optional(),
  }).partial(),
});

const SentimentSchema = z.object({
  data: z.array(z.object({ symbol: z.string() }).passthrough()).optional(),
});

const FX_SYMBOLS: Record<string, string> = { USD: "USD", GBP: "GBP", EUR: "EUR", CHF: "CHF", JPY: "JPY", CAD: "CAD", AUD: "AUD", SEK: "SEK", NOK: "NOK", DKK: "DKK" };

/**
 * Finnhub adapter: quotes, candles, company news, basic financials, social
 * sentiment and FX rates. Free tier is 60 calls/min — the hourly pipeline
 * stays well inside it for a small universe.
 */
export class FinnhubAdapter implements PriceDataPort, NewsPort, FundamentalsPort, SentimentPort, FxPort {
  private readonly base = "https://finnhub.io/api/v1";
  private readonly fxCache = new Map<string, { rate: number; at: number }>();
  private readonly fxTtlMs = 3_600_000;

  constructor(private readonly apiKey: string) {}

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const url = `${this.base}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.apiKey)}`;
    const res = await fetch(url);
    if (res.status === 401 || res.status === 403) throw new AdapterError("finnhub auth failed", "auth");
    if (res.status === 429) throw new AdapterError("finnhub rate limited", "rate-limit");
    if (!res.ok) throw new AdapterError(`finnhub HTTP ${res.status}`, "http");
    const data: unknown = await res.json();
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new AdapterError(`finnhub parse error: ${parsed.error.message}`, "parse");
    return parsed.data;
  }

  async quote(ticker: string): Promise<MarketSnapshot> {
    const q = await this.get<z.infer<typeof QuoteSchema>>(`/quote?symbol=${encodeURIComponent(ticker)}`, QuoteSchema);
    if (q.c === 0 && q.pc === 0) throw new AdapterError(`finnhub: no quote for ${ticker}`, "no-data");
    return {
      ticker,
      price: q.c,
      currency: inferCurrency(ticker),
      prevClose: q.pc,
      changePct: q.dp ?? (q.pc > 0 ? ((q.c - q.pc) / q.pc) * 100 : null),
      volume: null,
      asOf: new Date(q.t * 1000).toISOString(),
    };
  }

  async candles(ticker: string, opts: { interval?: string; count?: number } = {}): Promise<Candle[]> {
    const resolution = opts.interval ?? "60";
    const from = Math.floor(Date.now() / 1000) - (opts.count ?? 40) * Number(resolution) * 60;
    const c = await this.get<z.infer<typeof CandlesSchema>>(
      `/stock/candle?symbol=${encodeURIComponent(ticker)}&resolution=${resolution}&from=${from}&to=${Math.floor(Date.now() / 1000)}`,
      CandlesSchema,
    );
    if (c.s === "no_data" || c.t.length === 0) throw new AdapterError(`finnhub: no candles for ${ticker}`, "no-data");
    return c.t.map((t, i) => ({
      ticker,
      timestamp: new Date(t * 1000).toISOString(),
      open: c.o[i] ?? 0,
      high: c.h[i] ?? 0,
      low: c.l[i] ?? 0,
      close: c.c[i] ?? 0,
      volume: c.v[i] ?? 0,
    }));
  }

  async latestNews(ticker: string, limit = 10): Promise<NewsItem[]> {
    const items = await this.get<z.infer<typeof NewsItemSchema>[]>(
      `/company-news?symbol=${encodeURIComponent(ticker)}&from=${dateDaysAgo(7)}&to=${dateToday()}`,
      z.array(NewsItemSchema),
    );
    return items.slice(0, limit).map((n) => ({
      id: String(n.id),
      ticker,
      headline: n.headline,
      source: n.source,
      url: n.url,
      publishedAt: new Date(n.datetime * 1000).toISOString(),
      summary: n.summary ?? null,
    }));
  }

  async fundamentals(ticker: string): Promise<Fundamentals> {
    const [profile, financials] = await Promise.all([
      this.get<z.infer<typeof CompanyProfileSchema>>(`/stock/profile2?symbol=${encodeURIComponent(ticker)}`, CompanyProfileSchema).catch(
        () => null,
      ),
      this.get<z.infer<typeof BasicFinancialsSchema>>(`/stock/metric?symbol=${encodeURIComponent(ticker)}`, BasicFinancialsSchema).catch(
        () => null,
      ),
    ]);
    if (!profile && !financials) throw new AdapterError(`finnhub: no fundamentals for ${ticker}`, "no-data");
    const m = financials?.metric ?? {};
    return {
      ticker,
      currency: inferCurrency(ticker),
      pe: m.peTTM ?? profile?.pe ?? null,
      pb: m.pbAnnual ?? null,
      eps: m.epsTTM ?? null,
      revenueGrowthPct: m.revenueGrowthTTMYoy !== null && m.revenueGrowthTTMYoy !== undefined ? round2(m.revenueGrowthTTMYoy * 100) : null,
      profitMarginPct: m.netProfitMarginTTM !== null && m.netProfitMarginTTM !== undefined ? round2(m.netProfitMarginTTM * 100) : null,
      debtToEquity: m.totalDebtTotalEquityQuarterly ?? null,
      dividendYieldPct:
        m.dividendYieldIndicatedAnnual !== null && m.dividendYieldIndicatedAnnual !== undefined
          ? round2(m.dividendYieldIndicatedAnnual * 100)
          : null,
      marketCap: profile?.marketCapitalization ?? null,
      sector: null,
      asOf: new Date().toISOString(),
      details: { profileName: profile?.name ?? null },
    };
  }

  async sentiment(ticker: string): Promise<SentimentScore> {
    const data = await this.get<z.infer<typeof SentimentSchema>>(
      `/stock/social-sentiment?symbol=${encodeURIComponent(ticker)}`,
      SentimentSchema,
    ).catch(() => null);
    const items = data?.data ?? [];
    if (items.length === 0) throw new AdapterError(`finnhub: no sentiment for ${ticker}`, "no-data");
    const total = items.reduce((s, it) => {
      const mentions = Number((it as Record<string, unknown>).redditMention ?? 0) + Number((it as Record<string, unknown>).twitterMention ?? 0);
      const score = Number((it as Record<string, unknown>).redditSentiment ?? 0) + Number((it as Record<string, unknown>).twitterSentiment ?? 0);
      return { mentions: s.mentions + mentions, score: s.score + score * mentions };
    }, { mentions: 0, score: 0 });
    const score = total.mentions > 0 ? clamp(total.score / total.mentions, -1, 1) : 0;
    return {
      ticker,
      score: round2(score),
      label: score > 0.35 ? "very-positive" : score > 0.1 ? "positive" : score < -0.35 ? "very-negative" : score < -0.1 ? "negative" : "neutral",
      source: "finnhub-social",
      details: { mentions: total.mentions },
    };
  }

  async rate(from: string, to: string): Promise<number> {
    if (from === to) return 1;
    const key = `${from}>${to}`;
    const cached = this.fxCache.get(key);
    if (cached && Date.now() - cached.at < this.fxTtlMs) return cached.rate;
    const f = FX_SYMBOLS[from];
    const t = FX_SYMBOLS[to];
    if (!f || !t) throw new AdapterError(`finnhub fx: unsupported pair ${from}>${to}`, "unsupported");
    const q = await this.get<{ c: number }>(`/forex/rates?base=${f}`, z.object({ c: z.number() }).passthrough()).catch(() => null);
    if (!q || q.c === 0) throw new AdapterError(`finnhub fx: no rate for ${from}>${to}`, "no-data");
    let rate = q.c; // rate = `to` units per 1 `from` when base==from
    if (f !== from) rate = 1 / rate;
    this.fxCache.set(key, { rate, at: Date.now() });
    return rate;
  }
}

function inferCurrency(ticker: string): string {
  const t = ticker.toUpperCase();
  if (t.endsWith(".L")) return "GBX"; // LSE tickers are quoted in GBX (pence) on some feeds; T212 uses GBP
  if (t.includes("-") || t.includes(":")) return "USD";
  return "USD";
}

function dateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function dateToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
