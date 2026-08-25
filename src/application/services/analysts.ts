import { z } from "zod";
import { newId } from "../../shared/id.js";
import { clamp, roundTo } from "../../shared/money.js";
import { AdapterError } from "../../shared/errors.js";
import {
  AnalysisReport,
  EMPTY_SIGNALS,
  type AnalystKind,
  type Candle,
  type Conclusion,
} from "../../domain/analysis.js";
import type { Analyst, AnalystContext, AppPorts } from "../ports.js";

export const AnalysisOutputSchema = z.object({
  conclusion: z.enum(["bullish", "bearish", "neutral"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(10),
  targetWeightAdjustment: z.number().min(-1).max(1),
  adjustmentConfidence: z.number().min(0).max(1),
});

export type AnalysisOutput = z.infer<typeof AnalysisOutputSchema>;

const ROLE_PROMPTS: Record<AnalystKind, string> = {
  market:
    "You are the Market Analyst. Evaluate price action, trend and technical signals from recent candles. " +
    "You are quantitative and cautious; never invent data you have not been given.",
  sentiment:
    "You are the Sentiment Analyst. Evaluate the mood of the market around this ticker from the sentiment data and news tone provided. " +
    "Focus on the balance and strength of sentiment, not on repeating headlines.",
  news:
    "You are the News Analyst. Assess the latest news items for this ticker: what matters, how material it is, and the net direction. " +
    "Only use the news you are given; explicitly state if news is missing or stale.",
  fundamentals:
    "You are the Fundamentals Analyst. Assess valuation and financial health from the fundamentals provided. " +
    "Use valuation discipline; flag when data is missing instead of guessing.",
};

const DATA_DUMP_KEYS = ["ticker", "price", "currency", "changePct", "candles", "news", "fundamentals", "sentiment", "benchmark"] as const;

function contextToPrompt(ctx: AnalystContext): string {
  const data: Record<string, unknown> = {
    ticker: ctx.ticker,
    price: ctx.snapshot ? { price: ctx.snapshot.price, currency: ctx.snapshot.currency, changePct: ctx.snapshot.changePct } : null,
    candles:
      ctx.candles.length === 0
        ? null
        : ctx.candles.slice(-20).map((c: Candle) => ({
            t: c.timestamp.slice(0, 16),
            o: c.open,
            h: c.high,
            l: c.low,
            c: c.close,
            v: c.volume,
          })),
    news:
      ctx.news.length === 0
        ? null
        : ctx.news.slice(0, 10).map((n) => ({ headline: n.headline, source: n.source, publishedAt: n.publishedAt })),
    fundamentals: ctx.fundamentals
      ? {
          pe: ctx.fundamentals.pe,
          pb: ctx.fundamentals.pb,
          eps: ctx.fundamentals.eps,
          revenueGrowthPct: ctx.fundamentals.revenueGrowthPct,
          profitMarginPct: ctx.fundamentals.profitMarginPct,
          debtToEquity: ctx.fundamentals.debtToEquity,
          dividendYieldPct: ctx.fundamentals.dividendYieldPct,
          marketCap: ctx.fundamentals.marketCap,
          sector: ctx.fundamentals.sector,
        }
      : null,
    sentiment: ctx.sentiment ? { score: ctx.sentiment.score, label: ctx.sentiment.label } : null,
    benchmark: ctx.benchmarkSnapshot
      ? { ticker: ctx.benchmarkSnapshot.ticker, changePct: ctx.benchmarkSnapshot.changePct }
      : null,
  };
  return Object.entries(data)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `### ${k}\n${JSON.stringify(v)}`)
    .join("\n\n");
}

function buildSystemPrompt(kind: AnalystKind): string {
  return [
    ROLE_PROMPTS[kind],
    "",
    "You MUST respond with a single JSON object with exactly these fields:",
    '{"conclusion": "bullish"|"bearish"|"neutral", "confidence": <0..1>, "rationale": "<2-4 sentences>", "targetWeightAdjustment": <-1..1 fraction of the whole portfolio>, "adjustmentConfidence": <0..1>}',
    "",
    "Rules:",
    "- targetWeightAdjustment is the change you recommend to this ticker's target allocation weight (positive = allocate more, negative = reduce). Keep |targetWeightAdjustment| <= 0.15 unless the evidence is overwhelming.",
    "- adjustmentConfidence is how confident you are that this adjustment improves the portfolio; use 0 when you recommend no change or have no usable data.",
    "- Never output anything except the JSON object.",
    ...(DATA_DUMP_KEYS.map((k) => `- Field ${k} may be null: that means the data was unavailable.`)),
  ].join("\n");
}

/** LLM-backed analyst: one prompt per role, zod-validated structured output. */
export class LlmAnalyst implements Analyst {
  constructor(
    readonly kind: AnalystKind,
    private readonly ports: Pick<AppPorts, "llm" | "logger">,
  ) {}

  async analyze(runId: string, ctx: AnalystContext, now: string): Promise<AnalysisReport> {
    const user = contextToPrompt(ctx);
    const output = await this.ports.llm.chatJson<AnalysisOutput>(
      { system: buildSystemPrompt(this.kind), user },
      AnalysisOutputSchema,
    );
    this.ports.logger.debug(`llm analyst ${this.kind}/${ctx.ticker}`, output as unknown as Record<string, unknown>);
    return new AnalysisReport(
      newId("an"),
      runId,
      ctx.ticker,
      this.kind,
      output.conclusion,
      output.confidence,
      output.rationale,
      {
        targetWeightAdjustment: clamp(roundTo(output.targetWeightAdjustment, 4), -0.5, 0.5),
        confidence: output.adjustmentConfidence,
      },
      now,
      { engine: "llm", raw: output },
    );
  }
}

/* ---------------------- Offline (keyless) analysts ---------------------- */

function sma(candles: Candle[], n: number): number | null {
  if (candles.length < n) return null;
  const slice = candles.slice(-n);
  return roundTo(slice.reduce((s, c) => s + c.close, 0) / n, 4);
}

function rsi(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  const closes = candles.slice(-(period + 1));
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!.close;
    const cur = closes[i]!.close;
    const d = cur - prev;
    if (d >= 0) gains += d;
    else losses -= d;
  }
  if (gains + losses === 0) return 50;
  return roundTo((gains / (gains + losses)) * 100, 2);
}

function reportFrom(kind: AnalystKind, runId: string, ctx: AnalystContext, now: string, out: {
  conclusion: Conclusion;
  confidence: number;
  rationale: string;
  adjustment: number;
  adjustmentConfidence: number;
}): AnalysisReport {
  return new AnalysisReport(
    newId("an"),
    runId,
    ctx.ticker,
    kind,
    out.conclusion,
    out.confidence,
    out.rationale,
    { targetWeightAdjustment: clamp(roundTo(out.adjustment, 4), -0.15, 0.15), confidence: out.adjustmentConfidence },
    now,
    { engine: "offline" },
  );
}

/**
 * Deterministic, rule-based analysts used when no LLM key is configured.
 * They make the whole pipeline runnable and testable offline; outputs are
 * deliberately conservative.
 */
export class OfflineMarketAnalyst implements Analyst {
  readonly kind: AnalystKind = "market";
  async analyze(runId: string, ctx: AnalystContext, now: string): Promise<AnalysisReport> {
    const r = rsi(ctx.candles);
    const ma = sma(ctx.candles, 20);
    const price = ctx.snapshot?.price ?? ctx.candles.at(-1)?.close ?? null;
    if (price === null) return reportFrom(this.kind, runId, ctx, now, {
      conclusion: "neutral", confidence: 0.1, rationale: "No price data available.", adjustment: 0, adjustmentConfidence: 0,
    });
    const trend = ma !== null ? (price - ma) / ma : 0;
    let score = 0;
    if (r !== null) score += (r - 50) / 50; // momentum
    score += clamp(trend * 5, -0.5, 0.5); // trend vs 20-bar average
    const conclusion: Conclusion = score > 0.15 ? "bullish" : score < -0.15 ? "bearish" : "neutral";
    const strength = clamp(Math.abs(score) / 0.5, 0, 1);
    const adjustment = score * 0.05;
    return reportFrom(this.kind, runId, ctx, now, {
      conclusion,
      confidence: 0.3 + 0.4 * strength,
      rationale: `RSI(14)=${r ?? "n/a"}, price ${trend >= 0 ? "+" : ""}${(trend * 100).toFixed(2)}% vs 20-bar SMA. Composite technical score ${score.toFixed(2)}.`,
      adjustment,
      adjustmentConfidence: strength * 0.5,
    });
  }
}

export class OfflineSentimentAnalyst implements Analyst {
  readonly kind: AnalystKind = "sentiment";
  async analyze(runId: string, ctx: AnalystContext, now: string): Promise<AnalysisReport> {
    if (!ctx.sentiment) {
      return reportFrom(this.kind, runId, ctx, now, {
        conclusion: "neutral", confidence: 0.1, rationale: "No sentiment data available.", adjustment: 0, adjustmentConfidence: 0,
      });
    }
    const s = ctx.sentiment.score;
    const conclusion: Conclusion = s > 0.15 ? "bullish" : s < -0.15 ? "bearish" : "neutral";
    const strength = clamp(Math.abs(s), 0, 1);
    return reportFrom(this.kind, runId, ctx, now, {
      conclusion,
      confidence: 0.3 + 0.4 * strength,
      rationale: `Sentiment score ${s.toFixed(2)} (${ctx.sentiment.label}) from ${ctx.sentiment.source}.`,
      adjustment: s * 0.06,
      adjustmentConfidence: strength * 0.4,
    });
  }
}

export class OfflineNewsAnalyst implements Analyst {
  readonly kind: AnalystKind = "news";
  async analyze(runId: string, ctx: AnalystContext, now: string): Promise<AnalysisReport> {
    if (ctx.news.length === 0) {
      return reportFrom(this.kind, runId, ctx, now, {
        conclusion: "neutral", confidence: 0.1, rationale: "No recent news items.", adjustment: 0, adjustmentConfidence: 0,
      });
    }
    const s = ctx.sentiment?.score ?? 0;
    const n = Math.min(ctx.news.length, 10);
    const conclusion: Conclusion = s > 0.15 ? "bullish" : s < -0.15 ? "bearish" : "neutral";
    return reportFrom(this.kind, runId, ctx, now, {
      conclusion,
      confidence: 0.25 + 0.05 * Math.min(n, 5),
      rationale: `${n} recent news item(s). Net news sentiment ${s.toFixed(2)}. Headlines: ${ctx.news.slice(0, 3).map((x) => `"${x.headline}"`).join("; ")}`,
      adjustment: s * 0.04,
      adjustmentConfidence: 0.3,
    });
  }
}

export class OfflineFundamentalsAnalyst implements Analyst {
  readonly kind: AnalystKind = "fundamentals";
  async analyze(runId: string, ctx: AnalystContext, now: string): Promise<AnalysisReport> {
    const f = ctx.fundamentals;
    if (!f) {
      return reportFrom(this.kind, runId, ctx, now, {
        conclusion: "neutral", confidence: 0.1, rationale: "No fundamentals data available.", adjustment: 0, adjustmentConfidence: 0,
      });
    }
    let score = 0;
    const parts: string[] = [];
    if (f.pe !== null) {
      const v = f.pe <= 15 ? 0.3 : f.pe <= 25 ? 0.1 : f.pe >= 45 ? -0.3 : -0.1;
      score += v;
      parts.push(`P/E=${f.pe}`);
    }
    if (f.revenueGrowthPct !== null) {
      score += f.revenueGrowthPct > 0 ? 0.15 : -0.1;
      parts.push(`revenue growth=${f.revenueGrowthPct}%`);
    }
    if (f.profitMarginPct !== null) {
      score += f.profitMarginPct > 0 ? 0.1 : -0.15;
      parts.push(`margin=${f.profitMarginPct}%`);
    }
    const conclusion: Conclusion = score >= 0.25 ? "bullish" : score <= -0.25 ? "bearish" : "neutral";
    return reportFrom(this.kind, runId, ctx, now, {
      conclusion,
      confidence: 0.3 + 0.1 * parts.length,
      rationale: `Valuation/financial heuristics (${parts.join(", ")}): composite score ${score.toFixed(2)}.`,
      adjustment: clamp(score * 0.08, -0.15, 0.15),
      adjustmentConfidence: 0.35,
    });
  }
}

/** Builds the four analysts for a run, LLM-backed when a key is present. */
export function buildAnalysts(ports: AppPorts): Analyst[] {
  if (ports.llm.available()) {
    return (["market", "sentiment", "news", "fundamentals"] as const).map((k) => new LlmAnalyst(k, ports));
  }
  ports.logger.warn("no LLM API key configured — using offline rule-based analysts");
  return [
    new OfflineMarketAnalyst(),
    new OfflineSentimentAnalyst(),
    new OfflineNewsAnalyst(),
    new OfflineFundamentalsAnalyst(),
  ];
}

export function missingDataError(source: string, ticker: string): AdapterError {
  return new AdapterError(`${source}: no data for ${ticker}`, "no-data");
}

export { EMPTY_SIGNALS };
