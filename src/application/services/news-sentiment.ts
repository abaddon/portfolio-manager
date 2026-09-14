import { z } from "zod";
import { AdapterError } from "../../shared/errors.js";
import { clamp } from "../../shared/money.js";
import type { SentimentScore } from "../../domain/analysis.js";
import type { LlmPort, NewsPort, SentimentPort } from "../ports.js";
import type { Logger } from "../../shared/logger.js";

const NewsSentimentSchema = z.object({
  score: z.number().min(-1).max(1),
  rationale: z.string().min(5),
});

const POSITIVE_WORDS = [
  "beat", "beats", "rally", "surge", "soar", "upgrade", "strong", "growth", "record",
  "gain", "gains", "buy", "outperform", "positive", "raises", "boost", "approval", "wins", "expands",
];
const NEGATIVE_WORDS = [
  "miss", "misses", "cut", "cuts", "plunge", "plunges", "downgrade", "weak", "layoff", "layoffs",
  "probe", "lawsuit", "recall", "negative", "drop", "drops", "loss", "sell", "underperform", "slump", "warns",
];

export function labelFor(score: number): SentimentScore["label"] {
  if (score > 0.35) return "very-positive";
  if (score > 0.1) return "positive";
  if (score < -0.35) return "very-negative";
  if (score < -0.1) return "negative";
  return "neutral";
}

/** Crude keyword heuristic used only when no LLM is configured. */
export function heuristicScore(headlines: string[]): number {
  let pos = 0;
  let neg = 0;
  for (const h of headlines) {
    const words = h.toLowerCase().split(/\W+/);
    for (const w of words) {
      if (POSITIVE_WORDS.includes(w)) pos++;
      else if (NEGATIVE_WORDS.includes(w)) neg++;
    }
  }
  if (pos + neg === 0) return 0;
  return clamp((pos - neg) / (pos + neg), -1, 1);
}

/** Normalises a headline into the memoisation key (case/whitespace insensitive). */
function headlineKey(headline: string): string {
  return headline.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * News-derived sentiment: scores the latest headlines for a ticker.
 * LLM-scored when a model is configured (richer judgement), keyword
 * heuristic otherwise. Used as the fallback when the dedicated sentiment
 * provider is unavailable (Finnhub's social sentiment is not on the free
 * plan).
 *
 * Cost control (WP-P0.6): a headline is scored **once** per `(ticker, headline)`
 * for the life of the process, so a story re-fetched every hour (the
 * `news_items` table dedupes on exactly that key) never costs a second
 * inference. Only headlines with no cached score are sent to the model, and the
 * call is skipped entirely when all of them are already known.
 */
export class NewsSentimentPort implements SentimentPort {
  private readonly cache = new Map<string, SentimentScore>();

  constructor(
    private readonly news: NewsPort,
    private readonly llm: LlmPort,
    private readonly logger: Logger,
  ) {}

  /** Number of scored headlines held (tests + dashboard diagnostics). */
  get cacheSize(): number {
    return this.cache.size;
  }

  async sentiment(ticker: string, context: { news: import("../../domain/analysis.js").NewsItem[] }): Promise<SentimentScore> {
    const items = context.news.length > 0 ? context.news : await this.news.latestNews(ticker, 10);
    if (items.length === 0) {
      throw new AdapterError(`no news available to score sentiment for ${ticker}`, "no-data");
    }
    const headlines = items.map((n) => n.headline);
    const uncached = headlines.filter((h) => !this.cache.has(`${ticker}::${headlineKey(h)}`));

    if (uncached.length > 0) {
      const score = this.llm.available() ? await this.scoreWithLlm(ticker, uncached) : null;
      const scored: SentimentScore =
        score ?? {
          ticker,
          score: heuristicScore(uncached),
          label: labelFor(heuristicScore(uncached)),
          source: "news-heuristic",
          details: { items: items.length, scored: uncached.length },
        };
      for (const headline of uncached) this.cache.set(`${ticker}::${headlineKey(headline)}`, scored);
      this.logger.debug(
        `news sentiment for ${ticker}: ${scored.score} (${scored.source}, ${uncached.length}/${headlines.length} new)`,
      );
      return { ...scored, details: { ...scored.details, items: items.length } };
    }

    // Every headline already scored: reuse the cached score for this ticker
    // without spending a call.
    const cached = headlines
      .map((h) => this.cache.get(`${ticker}::${headlineKey(h)}`))
      .filter((s): s is SentimentScore => s !== undefined);
    const newest = cached.at(-1)!;
    this.logger.debug(`news sentiment for ${ticker}: ${newest.score} (cached, ${headlines.length} headline(s))`);
    return { ...newest, details: { ...newest.details, items: items.length, cached: true } };
  }

  /** One LLM call for the uncached headlines of this ticker. */
  private async scoreWithLlm(ticker: string, uncached: string[]): Promise<SentimentScore> {
    const out = await this.llm.chatJson<{ score: number; rationale: string }>(
      {
        system:
          "You score the sentiment of news headlines for a ticker. Respond with a single JSON object: " +
          '{"score": <-1..1>, "rationale": "<one sentence>"}. Score -1 = very negative news, +1 = very positive news, 0 = neutral/mixed. Base it ONLY on the headlines given.',
        user: `Ticker: ${ticker}\nHeadlines:\n${uncached.map((h) => `- ${h}`).join("\n")}`,
        temperature: 0,
        // Cheap classification: never pay for reasoning here.
        thinking: "disabled",
      },
      NewsSentimentSchema,
    );
    return {
      ticker,
      score: out.score,
      label: labelFor(out.score),
      source: "news-llm",
      details: { rationale: out.rationale, scored: uncached.length },
    };
  }
}

/**
 * Tries sentiment sources in order; the first success wins.
 *
 * A source that fails with a permanent error (`unsupported` — e.g. Finnhub's
 * social sentiment on the free plan, which answers 403 for every request) is
 * disabled for the life of the process instead of being re-tried on every
 * ticker of every run (WP-P0.6).
 */
export class FallbackSentimentPort implements SentimentPort {
  private readonly disabled = new Set<number>();

  constructor(private readonly chain: SentimentPort[]) {}

  /** Indexes of the sources disabled by a permanent failure (tests/diagnostics). */
  get disabledCount(): number {
    return this.disabled.size;
  }

  async sentiment(ticker: string, context: { news: import("../../domain/analysis.js").NewsItem[] }): Promise<SentimentScore> {
    let lastError: unknown = null;
    for (const [index, port] of this.chain.entries()) {
      if (this.disabled.has(index)) continue;
      try {
        return await port.sentiment(ticker, context);
      } catch (err) {
        lastError = err;
        // Permanent: this plan does not include the endpoint. Never ask again.
        if (err instanceof AdapterError && err.kind === "unsupported") this.disabled.add(index);
      }
    }
    throw new AdapterError(`sentiment: all sources failed for ${ticker}: ${String(lastError)}`, "no-data");
  }
}
