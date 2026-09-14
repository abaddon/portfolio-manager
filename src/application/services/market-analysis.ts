import { newId } from "../../shared/id.js";
import { toIso } from "../../shared/clock.js";
import { isLlmBudgetExceeded } from "./llm-budget.js";
import type { AnalysisReport, Candle, Fundamentals, MacroSnapshot, MarketSnapshot, NewsItem, SentimentScore } from "../../domain/analysis.js";
import type { Analyst, AnalystContext, AppPorts, MacroEvent } from "../ports.js";

/** Per-ticker data gathering with per-source error containment: one failing source never kills the run. */
export class MarketAnalysisService {
  /**
   * Set when an LLM budget stop cut the analysis short (null = complete), so a
   * truncated analysis is never mistaken for a full one.
   */
  lastStopReason: string | null = null;

  /**
   * Days to earnings per ticker for the LAST run (WP-P2.3), so the committee
   * sees the same event awareness the analysts had without a second fetch.
   */
  lastEarnings: ReadonlyMap<string, number> = new Map();

  /** Upcoming macro releases for the last run (WP-P2.3); empty when unknown. */
  lastMacroEvents: MacroEvent[] = [];

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
    this.lastStopReason = null;
    const benchmarkSnapshot = await this.safe("prices", benchmark, () => this.ports.prices.quote(benchmark));
    // Macro regime (FRED) is fetched once per run and shared by every analyst.
    const macro = await this.gatherMacro(runId);
    // Scheduled earnings once per run (WP-P2.3): one provider request, shared by
    // every analyst and by the committee. Absent/unavailable → unknown, never a
    // run failure.
    const earnings = await this.gatherEarnings(tickers);
    this.lastEarnings = earnings;
    this.lastMacroEvents = await this.gatherMacroEvents();
    const reports: AnalysisReport[] = [];
    const now = toIso(this.ports.clock.now());

    for (const ticker of tickers) {
      const ctx = await this.gather(ticker, benchmarkSnapshot, macro, earnings);
      await this.persistInputs(runId, ctx, now);
      for (const analyst of this.analysts) {
        try {
          // A multi-role analyst answers every role in one call (WP-P1.2).
          if (analyst.analyzeBatch) {
            reports.push(...(await analyst.analyzeBatch(runId, ctx, now)));
            continue;
          }
          reports.push(await analyst.analyze(runId, ctx, now));
        } catch (err) {
          // A budget stop is not an analyst failure: keep the reports already
          // produced and stop instead of logging an error per analyst.
          if (isLlmBudgetExceeded(err)) {
            this.lastStopReason = err.message;
            this.ports.logger.warn(`analysis stopped by the LLM budget: ${err.message}`);
            await this.ports.analysis.saveMany(reports);
            return reports;
          }
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

  /**
   * Days until each ticker's next earnings report, fetched once per run. An
   * unknown date is null — "no print in the window", not "no data".
   */
  private async gatherEarnings(tickers: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.ports.eventCalendar) return out;
    const horizonDays = 30;
    try {
      const upcoming = await this.ports.eventCalendar.upcomingEarnings(tickers, horizonDays);
      const now = this.ports.clock.now().getTime();
      for (const event of upcoming) {
        const at = new Date(`${event.date}T12:00:00Z`).getTime();
        if (!Number.isFinite(at)) continue;
        const days = Math.max(0, Math.round((at - now) / 86_400_000));
        const existing = out.get(event.ticker);
        if (existing === undefined || days < existing) out.set(event.ticker, days);
      }
      this.ports.logger.debug(
        `earnings calendar: ${out.size} of ${tickers.length} names report within ${horizonDays} days`,
      );
    } catch (err) {
      this.ports.logger.warn("earnings calendar unavailable — analysts run without event awareness", {
        error: String(err),
      });
    }
    return out;
  }

  /** Upcoming macro releases (WP-P2.3): one provider request per run, contained. */
  private async gatherMacroEvents(): Promise<MacroEvent[]> {
    const port = this.ports.eventCalendar;
    if (!port?.upcomingMacro) return [];
    try {
      return await port.upcomingMacro(14);
    } catch (err) {
      this.ports.logger.warn("macro event calendar unavailable", { error: String(err) });
      return [];
    }
  }

  private async gather(
    ticker: string,
    benchmarkSnapshot: MarketSnapshot | null,
    macro: MacroSnapshot | null,
    earnings: ReadonlyMap<string, number> = new Map(),
  ): Promise<AnalystContext> {
    const [snapshot, candles, news, fundamentals] = await Promise.all([
      this.safe("prices", ticker, () => this.ports.prices.quote(ticker)),
      this.safe("prices", ticker, async () => this.ports.prices.candles(ticker, { interval: "60", count: 40 })),
      this.safe("news", ticker, () => this.ports.news.latestNews(ticker, 10)),
      this.safe("fundamentals", ticker, () => this.ports.fundamentals.fundamentals(ticker)),
    ]);
    // ONE sentiment call per ticker, with the news already in hand: the port
    // scores it (LLM or heuristic) and memoises per headline, so re-running it
    // "in case it failed standalone" would buy nothing and could pay twice
    // (WP-P0.6).
    const sentiment: SentimentScore | null = await this.safe("sentiment", ticker, () =>
      this.ports.sentiment.sentiment(ticker, { news: (news ?? []) as NewsItem[] }),
    );
    return {
      ticker,
      snapshot: snapshot as MarketSnapshot | null,
      candles: (candles ?? []) as Candle[],
      news: (news ?? []) as NewsItem[],
      fundamentals: fundamentals as Fundamentals | null,
      sentiment,
      benchmarkSnapshot,
      macro,
      daysToEarnings: earnings.get(ticker) ?? null,
    };
  }
}
