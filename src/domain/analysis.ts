import { DomainError } from "../shared/errors.js";

/** The four analyst roles of the hourly market-analysis step. */
export type AnalystKind = "market" | "sentiment" | "news" | "fundamentals";

export const ANALYST_KINDS: readonly AnalystKind[] = ["market", "sentiment", "news", "fundamentals"];

export type Conclusion = "bullish" | "bearish" | "neutral";

export interface Candle {
  ticker: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketSnapshot {
  ticker: string;
  price: number;
  currency: string;
  prevClose: number | null;
  changePct: number | null;
  volume: number | null;
  asOf: string;
}

export interface NewsItem {
  id: string;
  ticker: string;
  headline: string;
  source: string;
  url: string | null;
  publishedAt: string | null;
  summary: string | null;
}

export interface SentimentScore {
  ticker: string;
  score: number; // -1 (very negative) .. +1 (very positive)
  label: "very-negative" | "negative" | "neutral" | "positive" | "very-positive";
  source: string;
  details: Record<string, unknown>;
}

export interface Fundamentals {
  ticker: string;
  currency: string | null;
  pe: number | null;
  pb: number | null;
  eps: number | null;
  revenueGrowthPct: number | null;
  profitMarginPct: number | null;
  debtToEquity: number | null;
  dividendYieldPct: number | null;
  marketCap: number | null;
  sector: string | null;
  asOf: string;
  details: Record<string, unknown>;
}

export interface AnalysisSignals {
  /** Suggested adjustment of target allocation weight, -1..+1 (fraction of portfolio). */
  targetWeightAdjustment: number;
  /** LLM confidence that the adjustment improves the portfolio, 0..1. */
  confidence: number;
}

export class AnalysisReport {
  constructor(
    readonly id: string,
    readonly runId: string,
    readonly ticker: string,
    readonly analyst: AnalystKind,
    readonly conclusion: Conclusion,
    readonly confidence: number, // 0..1
    readonly rationale: string,
    readonly signals: AnalysisSignals,
    readonly createdAt: string,
    readonly details: Record<string, unknown> = {},
  ) {
    if (confidence < 0 || confidence > 1) {
      throw new DomainError(`confidence out of range for ${analyst}/${ticker}: ${confidence}`);
    }
  }

  /** A report carries a decision only when its analyst is confident enough. */
  get isActionable(): boolean {
    return this.signals.confidence >= 0.6;
  }
}

export const EMPTY_SIGNALS: AnalysisSignals = { targetWeightAdjustment: 0, confidence: 0 };
