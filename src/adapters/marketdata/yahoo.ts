import { z } from "zod";
import { AdapterError } from "../../shared/errors.js";
import type { Candle, MarketSnapshot } from "../../domain/analysis.js";
import type { PriceDataPort } from "../../application/ports.js";

const ChartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z.object({
            symbol: z.string(),
            regularMarketPrice: z.number().optional(),
            chartPreviousClose: z.number().optional(),
            currency: z.string().optional(),
          }).passthrough(),
          timestamp: z.array(z.number()).optional(),
          indicators: z
            .object({
              quote: z.array(
                z.object({
                  open: z.array(z.number().nullable()),
                  high: z.array(z.number().nullable()),
                  low: z.array(z.number().nullable()),
                  close: z.array(z.number().nullable()),
                  volume: z.array(z.number().nullable()),
                }).passthrough(),
              ),
            })
            .passthrough()
            .optional(),
        }),
      )
      .nullable()
      .optional(),
    error: z.unknown().optional(),
  }).passthrough(),
});

/**
 * Free, keyless OHLC candles from Yahoo Finance's public chart endpoint.
 * Used when the market-data provider doesn't include candles (Finnhub's free
 * tier returns 403 for /stock/candle).
 */
export class YahooCandlesAdapter implements Pick<PriceDataPort, "candles" | "quote"> {
  private readonly base = "https://query1.finance.yahoo.com/v8/finance/chart";

  private async chart(ticker: string, interval: string, range: string) {
    const url = `${this.base}/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}&includePrePost=false`;
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (trading-portfolio-manager)" } });
    if (res.status === 429) throw new AdapterError("yahoo candles rate limited", "rate-limit");
    if (!res.ok) throw new AdapterError(`yahoo candles HTTP ${res.status}`, "http");
    const parsed = ChartSchema.safeParse(await res.json());
    if (!parsed.success) throw new AdapterError(`yahoo candles parse error: ${parsed.error.message}`, "parse");
    const result = parsed.data.chart.result?.[0];
    if (!result || !result.timestamp || result.timestamp.length === 0) {
      throw new AdapterError(`yahoo candles: no data for ${ticker}`, "no-data");
    }
    return { result, timestamps: result.timestamp, chart: parsed.data.chart };
  }

  async candles(ticker: string, opts: { interval?: string; count?: number } = {}): Promise<Candle[]> {
    const interval = opts.interval ?? "60";
    // Yahoo expects formats like "60m"/"1h", not bare numbers.
    const yInterval = /^\d+$/.test(interval) ? `${interval}m` : interval;
    const range = rangeFor(interval, opts.count ?? 40);
    const { result, timestamps } = await this.chart(ticker, yInterval, range);
    const quote = result.indicators?.quote?.[0];
    if (!quote) throw new AdapterError(`yahoo candles: no quotes for ${ticker}`, "no-data");
    const out: Candle[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = quote.close[i];
      if (close === null || close === undefined) continue;
      out.push({
        ticker,
        timestamp: new Date(timestamps[i]! * 1000).toISOString(),
        open: quote.open[i] ?? close,
        high: quote.high[i] ?? close,
        low: quote.low[i] ?? close,
        close,
        volume: quote.volume[i] ?? 0,
      });
    }
    return out.slice(-(opts.count ?? 40));
  }

  async quote(ticker: string): Promise<MarketSnapshot> {
    const { result, chart } = await this.chart(ticker, "1d", "1d");
    const price = chart.result?.[0]?.meta.regularMarketPrice ?? result.meta.regularMarketPrice;
    if (price === undefined) throw new AdapterError(`yahoo: no quote for ${ticker}`, "no-data");
    const prevClose = result.meta.chartPreviousClose ?? null;
    return {
      ticker,
      price,
      currency: result.meta.currency ?? "USD",
      prevClose,
      changePct: prevClose !== null && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null,
      volume: null,
      asOf: new Date().toISOString(),
    };
  }
}

function rangeFor(interval: string, count: number): string {
  const minutes = Number(interval) || 60;
  const totalMinutes = count * minutes;
  if (totalMinutes <= 60 * 24 * 2) return "5d";
  if (totalMinutes <= 60 * 24 * 31) return "1mo";
  return "3mo";
}

/** Delegating price port: quotes from one source, candles from another. */
export class CombinedPriceDataAdapter implements PriceDataPort {
  constructor(
    private readonly quotes: Pick<PriceDataPort, "quote">,
    private readonly candlesSource: Pick<PriceDataPort, "candles">,
  ) {}

  quote(ticker: string): Promise<MarketSnapshot> {
    return this.quotes.quote(ticker);
  }

  candles(ticker: string, opts?: { interval?: string; count?: number }): Promise<Candle[]> {
    return this.candlesSource.candles(ticker, opts);
  }
}
