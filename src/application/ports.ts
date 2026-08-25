import type { ZodType } from "zod";
import type { Clock } from "../shared/clock.js";
import type { DomainEvent } from "../shared/events.js";
import type { Logger } from "../shared/logger.js";
import type { AnalysisReport, AnalystKind, Candle, Fundamentals, MarketSnapshot, NewsItem, SentimentScore } from "../domain/analysis.js";
import type { Position, PortfolioSnapshot } from "../domain/portfolio.js";
import type { Decision } from "../domain/decision.js";
import type { Order, OrderSide, OrderStatus, OrderType } from "../domain/execution.js";
import type { Run } from "../domain/run.js";

/* ------------------------------------------------------------------ */
/* LLM port (driven)                                                   */
/* ------------------------------------------------------------------ */

export interface LlmChatOptions {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmPort {
  /** Whether a real model is configured (false → use offline analysts). */
  available(): boolean;
  /** Plain chat completion. */
  chat(opts: LlmChatOptions): Promise<string>;
  /** Chat completion parsed and validated against a zod schema (with one retry). */
  chatJson<T>(opts: LlmChatOptions, schema: ZodType<T>): Promise<T>;
}

/* ------------------------------------------------------------------ */
/* Market data ports (driven)                                          */
/* ------------------------------------------------------------------ */

export interface PriceDataPort {
  quote(ticker: string): Promise<MarketSnapshot>;
  candles(ticker: string, opts?: { interval?: string; count?: number }): Promise<Candle[]>;
}

export interface NewsPort {
  latestNews(ticker: string, limit?: number): Promise<NewsItem[]>;
}

export interface FundamentalsPort {
  fundamentals(ticker: string): Promise<Fundamentals>;
}

export interface SentimentPort {
  sentiment(ticker: string, context: { news: NewsItem[] }): Promise<SentimentScore>;
}

/** FX conversion into the account currency (used for allocation weights and costs). */
export interface FxPort {
  rate(from: string, to: string): Promise<number>;
}

/* ------------------------------------------------------------------ */
/* Broker port (driven)                                                */
/* ------------------------------------------------------------------ */

export interface AccountSummary {
  currency: string;
  cash: number;
  totalValue: number;
  investedValue: number;
}

export interface SubmitOrderRequest {
  ticker: string;
  side: OrderSide;
  quantity: number;
  type: OrderType;
  limitPrice?: number;
}

export interface SubmitOrderResult {
  brokerOrderId: string;
  status: "SUBMITTED" | "FILLED" | "REJECTED" | "PENDING";
}

export interface RemoteOrderStatus {
  status: string; // broker-native status string
  filledQuantity: number;
  filledPriceAvg: number | null;
}

export interface BrokerPort {
  kind: "paper" | "trading212";
  account(): Promise<AccountSummary>;
  positions(): Promise<Position[]>;
  submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderResult>;
  orderStatus(brokerOrderId: string): Promise<RemoteOrderStatus>;
  cancelOrder?(brokerOrderId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Analysts (driving side of the analysis step)                        */
/* ------------------------------------------------------------------ */

export interface AnalystContext {
  ticker: string;
  snapshot: MarketSnapshot | null;
  candles: Candle[];
  news: NewsItem[];
  fundamentals: Fundamentals | null;
  sentiment: SentimentScore | null;
  benchmarkSnapshot: MarketSnapshot | null;
}

export interface Analyst {
  readonly kind: AnalystKind;
  analyze(runId: string, ctx: AnalystContext, now: string): Promise<AnalysisReport>;
}

/* ------------------------------------------------------------------ */
/* Repositories (driven)                                               */
/* ------------------------------------------------------------------ */

export interface RunRepository {
  save(run: Run): Promise<void>;
  get(id: string): Promise<Run | null>;
  latest(limit?: number): Promise<Run[]>;
  /** Most recent run started in the same market hour as `startedAt` (idempotency guard). */
  findSameHour(startedAt: Date): Promise<Run | null>;
}

export interface AnalysisRepository {
  save(report: AnalysisReport): Promise<void>;
  saveMany(reports: AnalysisReport[]): Promise<void>;
  byRun(runId: string): Promise<AnalysisReport[]>;
  latestByTicker(ticker: string, limit?: number): Promise<AnalysisReport[]>;
}

export interface PortfolioRepository {
  save(snapshot: PortfolioSnapshot): Promise<void>;
  latest(): Promise<PortfolioSnapshot | null>;
  history(limit?: number): Promise<PortfolioSnapshot[]>;
  saveNav(runId: string, asOf: string, units: number, navPerUnit: number, totalValue: number): Promise<void>;
  latestNav(): Promise<{ units: number; navPerUnit: number; totalValue: number } | null>;
}

export interface DecisionRepository {
  save(decision: Decision): Promise<void>;
  byRun(runId: string): Promise<Decision[]>;
  latest(limit?: number): Promise<Decision[]>;
}

export interface OrderRepository {
  save(order: Order): Promise<void>;
  get(id: string): Promise<Order | null>;
  byRun(runId: string): Promise<Order[]>;
  latest(limit?: number): Promise<Order[]>;
  /** Non-pending orders for a ticker since a timestamp (anti-churn cooldown). */
  recentByTicker(ticker: string, since: string): Promise<Order[]>;
}

export interface EventRepository {
  append(events: DomainEvent[]): Promise<void>;
  byRun(runId: string): Promise<DomainEvent[]>;
  recent(limit?: number): Promise<DomainEvent[]>;
}

export interface SettingsRepository {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Cross-cutting ports                                                 */
/* ------------------------------------------------------------------ */

export interface MarketCalendarPort {
  isOpen(now: Date): boolean;
}

export interface EventSink {
  publish(event: DomainEvent): void;
}

/** Bundled dependencies every application service needs. */
export interface AppPorts {
  clock: Clock;
  logger: Logger;
  events: EventSink;
  calendar: MarketCalendarPort;
  llm: LlmPort;
  prices: PriceDataPort;
  news: NewsPort;
  fundamentals: FundamentalsPort;
  sentiment: SentimentPort;
  fx: FxPort;
  broker: BrokerPort;
  runs: RunRepository;
  analysis: AnalysisRepository;
  portfolio: PortfolioRepository;
  decisions: DecisionRepository;
  orders: OrderRepository;
  eventRepo: EventRepository;
}

export type { OrderStatus };
