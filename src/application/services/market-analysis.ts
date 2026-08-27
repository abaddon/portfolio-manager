import { newId } from "../../shared/id.js";
import { toIso } from "../../shared/clock.js";
import type { AnalysisReport, Candle, Fundamentals, MacroSnapshot, MarketSnapshot, NewsItem, SentimentScore } from "../../domain/analysis.js";
import type { Analyst, AnalystContext, AppPorts } from "../ports.js";

/** Per-ticker data gathering with per-source error containment: one failing source never kills the run. */
export class MarketAnalysisService {
  constructor(
    private readonly ports: AppPorts,
    private readonly analysts: Analyst[],
  ) {}

  private async safe<T>(source: string, ticker: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      this.ports.logger.warn(`${source} unavailable for ${ticker}`, { error: String(err) });
      return null;
    }
  }

  async analyze(runId: string, tickers: readonly string[], benchmark: string): Promise<AnalysisReport[]> {
    const benchmarkSnapshot = await this.safe("prices", benchmark, () => this.ports.prices.quote(benchmark));
    // Macro regime (FRED) is fetched once per run and shared by every analyst.
    const macro = await this.gatherMacro(runId);
    const reports: AnalysisReport[] = [];
    const now = toIso(this.ports.clock.now());

    for (const ticker of tickers) {
      const ctx = await this.gather(ticker, benchmarkSnapshot, macro);
      await this.persistInputs(runId, ctx, now);
      for (const analyst of this.analysts) {
        try {
          reports.push(await analyst.analyze(runId, ctx, now));
        } catch (err) {
          this.ports.logger.error(`analyst ${analyst.kind} failed for ${ticker}`, { error: String(err) });
        }
      }
    }
    if (benchmarkSnapshot) {
      await this.ports.marketData.saveSnapshots([{ id: newId("ms"), runId, snapshot: benchmarkSnapshot }]);
    }
    await this.ports.analysis.saveMany(reports);
    return reports;
  }

  /** Persists the raw inputs the analysts saw, so decisions stay auditable and re-runnable. */
  private async persistInputs(runId: string, ctx: AnalystContext, now: string): Promise<void> {
    if (ctx.snapshot) {
      await this.ports.marketData.saveSnapshots([{ id: newId("ms"), runId, snapshot: ctx.snapshot }]);
    }
    if (ctx.news.length > 0) {
      await this.ports.marketData.saveNews(ctx.news.map((item) => ({ id: newId("news"), runId, item })));
    }
    if (ctx.sentiment) {
      await this.ports.marketData.saveSentiment([{ id: newId("sent"), runId, score: ctx.sentiment, asOf: now }]);
    }
  }

  /** Fetches the macro snapshot once and persists it for the audit trail. */
  private async gatherMacro(runId: string): Promise<MacroSnapshot | null> {
    if (!this.ports.macro) return null;
    const macro = await this.safe("macro", "universe", () => this.ports.macro!.macroSnapshot());
    if (macro) {
      await this.ports.marketData.saveMacro({ id: newId("mac"), runId, snapshot: macro });
    }
    return macro;
  }

  private async gather(ticker: string, benchmarkSnapshot: MarketSnapshot | null, macro: MacroSnapshot | null): Promise<AnalystContext> {
    const [snapshot, candles, news, fundamentals, sentiment] = await Promise.all([
      this.safe("prices", ticker, () => this.ports.prices.quote(ticker)),
      this.safe("prices", ticker, async () => this.ports.prices.candles(ticker, { interval: "60", count: 40 })),
      this.safe("news", ticker, () => this.ports.news.latestNews(ticker, 10)),
      this.safe("fundamentals", ticker, () => this.ports.fundamentals.fundamentals(ticker)),
      this.safe("sentiment", ticker, () => this.ports.sentiment.sentiment(ticker, { news: [] })),
    ]);
    // Sentiment depends on news when both exist; re-run with news if it failed standalone.
    const sentimentWithNews: SentimentScore | null =
      sentiment ?? (news ? await this.safe("sentiment", ticker, () => this.ports.sentiment.sentiment(ticker, { news })) : null);
    return {
      ticker,
      snapshot: snapshot as MarketSnapshot | null,
      candles: (candles ?? []) as Candle[],
      news: (news ?? []) as NewsItem[],
      fundamentals: fundamentals as Fundamentals | null,
      sentiment: sentimentWithNews,
      benchmarkSnapshot,
      macro,
    };
  }
}
