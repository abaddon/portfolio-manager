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

/**
 * News-derived sentiment: scores the latest headlines for a ticker.
 * LLM-scored when a model is configured (richer judgement), keyword
 * heuristic otherwise. Used as the fallback when the dedicated sentiment
 * provider is unavailable (Finnhub's social sentiment is not on the free
 * plan).
 */
export class NewsSentimentPort implements SentimentPort {
  constructor(
    private readonly news: NewsPort,
    private readonly llm: LlmPort,
    private readonly logger: Logger,
  ) {}

  async sentiment(ticker: string, context: { news: import("../../domain/analysis.js").NewsItem[] }): Promise<SentimentScore> {
    const items = context.news.length > 0 ? context.news : await this.news.latestNews(ticker, 10);
    if (items.length === 0) {
      throw new AdapterError(`no news available to score sentiment for ${ticker}`, "no-data");
    }
    const headlines = items.map((n) => n.headline);

    if (this.llm.available()) {
      const out = await this.llm.chatJson<{ score: number; rationale: string }>(
        {
          system:
            "You score the sentiment of news headlines for a ticker. Respond with a single JSON object: " +
            '{"score": <-1..1>, "rationale": "<one sentence>"}. Score -1 = very negative news, +1 = very positive news, 0 = neutral/mixed. Base it ONLY on the headlines given.',
          user: `Ticker: ${ticker}\nHeadlines:\n${headlines.map((h) => `- ${h}`).join("\n")}`,
          temperature: 0,
        },
        NewsSentimentSchema,
      );
      this.logger.debug(`news sentiment for ${ticker}: ${out.score} (llm)`);
      return {
        ticker,
        score: out.score,
        label: labelFor(out.score),
        source: "news-llm",
        details: { rationale: out.rationale, items: items.length },
      };
    }

    const score = heuristicScore(headlines);
    this.logger.debug(`news sentiment for ${ticker}: ${score} (heuristic)`);
    return {
      ticker,
      score,
      label: labelFor(score),
      source: "news-heuristic",
      details: { items: items.length },
    };
  }
}

/** Tries sentiment sources in order; the first success wins. */
export class FallbackSentimentPort implements SentimentPort {
  constructor(private readonly chain: SentimentPort[]) {}

  async sentiment(ticker: string, context: { news: import("../../domain/analysis.js").NewsItem[] }): Promise<SentimentScore> {
    let lastError: unknown = null;
    for (const port of this.chain) {
      try {
        return await port.sentiment(ticker, context);
      } catch (err) {
        lastError = err;
      }
    }
    throw new AdapterError(`sentiment: all sources failed for ${ticker}: ${String(lastError)}`, "no-data");
  }
}
