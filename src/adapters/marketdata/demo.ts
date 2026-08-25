import { AdapterError } from "../../shared/errors.js";
import type { Candle, Fundamentals, MarketSnapshot, NewsItem, SentimentScore } from "../../domain/analysis.js";
import type { FxPort, FundamentalsPort, NewsPort, PriceDataPort, SentimentPort } from "../../application/ports.js";

/** Deterministic string hash → 0..1 (stable across runs, no RNG state). */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

const BASE_PRICES: Record<string, number> = {
  MSFT: 420,
  AAPL: 210,
  NVDA: 120,
  AMZN: 195,
  GOOGL: 175,
  SPY: 580,
  META: 560,
  TSLA: 260,
  VOO: 550,
  "VUSA.L": 87,
};

const SECTORS = ["Technology", "Consumer Cyclical", "Financials", "Healthcare", "Energy"];

/**
 * Keyless deterministic market data: stable pseudo-random prices/candles/news/
 * fundamentals per ticker. Used for offline demo runs and tests; explicitly
 * NOT real market data (the dashboard marks runs as demo-data).
 */
export class DemoMarketDataAdapter implements PriceDataPort, NewsPort, FundamentalsPort, SentimentPort {
  constructor(private readonly opts: { basePrices?: Record<string, number>; now?: Date } = {}) {}

  private basePrice(ticker: string): number {
    return this.opts.basePrices?.[ticker] ?? BASE_PRICES[ticker] ?? 50 + hash01(ticker) * 300;
  }

  async quote(ticker: string): Promise<MarketSnapshot> {
    const price = round2(this.basePrice(ticker));
    const prevClose = round2(price / (1 + (hash01(`${ticker}:pc`) - 0.45) * 0.02));
    return {
      ticker,
      price,
      currency: currencyOf(ticker),
      prevClose,
      changePct: round2(((price - prevClose) / prevClose) * 100),
      volume: Math.floor(hash01(`${ticker}:vol`) * 5e7) + 1e6,
      asOf: (this.opts.now ?? new Date()).toISOString(),
    };
  }

  async candles(ticker: string, opts: { interval?: string; count?: number } = {}): Promise<Candle[]> {
    const count = opts.count ?? 40;
    const base = this.basePrice(ticker);
    const seed = hash01(`${ticker}:series`);
    const stepMs = Number(opts.interval ?? 60) * 60_000;
    const end = Math.floor((this.opts.now?.getTime() ?? Date.now()) / stepMs) * stepMs;
    const candles: Candle[] = [];
    let price = base * (0.9 + seed * 0.08);
    for (let i = count - 1; i >= 0; i--) {
      const drift = (hash01(`${ticker}:${i}:d`) - 0.48) * 0.004;
      const open = price;
      const close = price * (1 + drift);
      const high = Math.max(open, close) * (1 + hash01(`${ticker}:${i}:h`) * 0.003);
      const low = Math.min(open, close) * (1 - hash01(`${ticker}:${i}:l`) * 0.003);
      candles.push({
        ticker,
        timestamp: new Date(end - i * stepMs).toISOString(),
        open: round2(open),
        high: round2(high),
        low: round2(low),
        close: round2(close),
        volume: Math.floor(hash01(`${ticker}:${i}:v`) * 2e6) + 100_000,
      });
      price = close;
    }
    return candles;
  }

  async latestNews(ticker: string, limit = 10): Promise<NewsItem[]> {
    const n = 3 + Math.floor(hash01(`${ticker}:nnews`) * 5);
    const items: NewsItem[] = [];
    for (let i = 0; i < Math.min(n, limit); i++) {
      const tone = hash01(`${ticker}:news:${i}:tone`);
      items.push({
        id: `demo-${ticker}-${i}`,
        ticker,
        headline: [
          `${ticker} reports quarterly results, ${tone > 0.5 ? "beating" : "missing"} expectations`,
          `${ticker} announces product expansion into new markets`,
          `Analysts adjust ${ticker} price targets after earnings`,
          `${ticker} faces supply chain headwinds`,
        ][i % 4]!,
        source: "demo-feed",
        url: null,
        publishedAt: new Date((this.opts.now?.getTime() ?? Date.now()) - (i + 1) * 3_600_000).toISOString(),
        summary: tone > 0.5 ? "Positive development for the business." : "Mixed read-through for the business.",
      });
    }
    return items;
  }

  async fundamentals(ticker: string): Promise<Fundamentals> {
    const seed = hash01(`${ticker}:fund`);
    return {
      ticker,
      currency: currencyOf(ticker),
      pe: round2(10 + seed * 30),
      pb: round2(1 + seed * 8),
      eps: round2(1 + seed * 12),
      revenueGrowthPct: round2((seed - 0.4) * 40),
      profitMarginPct: round2(5 + seed * 30),
      debtToEquity: round2(seed * 2),
      dividendYieldPct: round2(seed * 3),
      marketCap: Math.floor((100 + seed * 3000) * 1e9),
      sector: SECTORS[Math.floor(seed * SECTORS.length) % SECTORS.length] ?? null,
      asOf: (this.opts.now ?? new Date()).toISOString(),
      details: { source: "demo" },
    };
  }

  async sentiment(ticker: string): Promise<SentimentScore> {
    const score = round2((hash01(`${ticker}:sent`) - 0.5) * 1.2);
    return {
      ticker,
      score,
      label: score > 0.35 ? "very-positive" : score > 0.1 ? "positive" : score < -0.35 ? "very-negative" : score < -0.1 ? "negative" : "neutral",
      source: "demo-sentiment",
      details: { mentions: Math.floor(hash01(`${ticker}:ment`) * 500) },
    };
  }
}

export function currencyOf(ticker: string): string {
  const t = ticker.toUpperCase();
  if (t.endsWith(".L")) return "GBP";
  if (t.endsWith(".DE") || t.endsWith(".PA") || t.endsWith(".AS") || t.endsWith(".MI")) return "EUR";
  return "USD";
}

/**
 * Fixed FX table (documented approximations, not live rates) with USD
 * cross-rate fallback. Real runs use Finnhub; demo/test runs use this.
 */
export class DemoFxAdapter implements FxPort {
  private readonly usdRates: Record<string, number> = {
    USD: 1,
    GBP: 0.79,
    EUR: 0.92,
    CHF: 0.88,
    JPY: 150,
    CAD: 1.36,
    AUD: 1.52,
    SEK: 10.4,
    NOK: 10.6,
    DKK: 6.9,
  };

  async rate(from: string, to: string): Promise<number> {
    if (from === to) return 1;
    const f = this.usdRates[from];
    const t = this.usdRates[to];
    if (f === undefined || t === undefined) {
      throw new AdapterError(`demo fx: unsupported pair ${from}>${to}`, "unsupported");
    }
    return t / f; // 1 from-unit in USD × to-units per USD
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
