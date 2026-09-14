import type { ZodType } from "zod";
import type { Clock } from "../shared/clock.js";
import type { DomainEvent } from "../shared/events.js";
import type { Logger } from "../shared/logger.js";
import type { AnalysisReport, AnalystKind, Candle, Fundamentals, MacroSnapshot, MarketSnapshot, NewsItem, SentimentScore } from "../domain/analysis.js";
import type { AllocationTarget, AllocationTargetUpdate, Position, PortfolioSnapshot } from "../domain/portfolio.js";
import type { Decision } from "../domain/decision.js";
import type { Order, OrderSide, OrderStatus, OrderType } from "../domain/execution.js";
import type { Run } from "../domain/run.js";
import type {
  CommitteeFeedback,
  CommitteeProposal,
  CommitteeSession,
  CommitteeSessionDetail,
  CommitteeVote,
} from "../domain/committee.js";

/* ------------------------------------------------------------------ */
/* LLM port (driven)                                                   */
/* ------------------------------------------------------------------ */

export interface LlmChatOptions {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Per-call thinking-mode override (falls back to the client's configured
   * mode). Cheap classification calls (sentiment, feedback, votes) run with
   * thinking off even when the provider default is on.
   */
  thinking?: "enabled" | "disabled";
}

export interface LlmPort {
  /** Whether a real model is configured (false → use offline analysts). */
  available(): boolean;
  /** Plain chat completion. */
  chat(opts: LlmChatOptions): Promise<string>;
  /** Chat completion parsed and validated against a zod schema (with one retry). */
  chatJson<T>(opts: LlmChatOptions, schema: ZodType<T>): Promise<T>;
  /**
   * One call producing several independently-validated objects (WP-P1.2): the
   * model returns a JSON object keyed by `keys`, and each value is validated
   * against its own schema. A key whose value fails validation after the repair
   * retry is simply absent from the result — the caller decides what to do.
   */
  chatJsonMulti?<K extends string>(
    opts: LlmChatOptions,
    schemas: Record<K, ZodType<unknown>>,
  ): Promise<Partial<Record<K, unknown>>>;
}

/* ------------------------------------------------------------------ */
/* LLM cost accounting / budget (cross-cutting)                        */
/* ------------------------------------------------------------------ */

/** Token usage + estimated cost of one successful LLM call. */
export interface LlmUsage {
  runId: string;
  /** Committee agent id, or "analysts" / "sentiment" for the shared clients. */
  agentId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Provider-reported cached prompt tokens (0 when unreported). */
  cachedTokens: number;
  usdCost: number;
  at: string;
}

/**
 * Records every LLM call and enforces the per-run / per-day budget. Optional on
 * `AppPorts` so tests and offline runs work without one; when absent, calls are
 * simply not accounted for.
 */
export interface LlmUsageRecorder {
  /** Binds subsequent usage reports to a run (the pipeline sets this per run). */
  setActiveRun(runId: string | null): void;
  /** Loads the trailing-window spend from the store (idempotent; call before the first call of a run). */
  prime(): Promise<void>;
  /** Persists the usage and totals it. */
  record(usage: LlmUsage): Promise<void>;
  /** Total spend in USD over the trailing spend window (see the implementation). */
  spendUsd(): Promise<number>;
  /** Calls made in the given run so far. */
  callsInRun(runId: string): number;
  /** True when no further call may be made in this run (call cap or day cap). */
  exhausted(runId: string): boolean;
  /** Human-readable exhaustion reason (null when the budget is available). */
  exhaustedReason(runId: string): string | null;
  /** Per-run totals for the run summary / dashboard. */
  summary(runId: string): { calls: number; promptTokens: number; completionTokens: number; usdCost: number };
}

/** Thrown when a call is attempted after the budget is exhausted. */
export class LlmBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmBudgetExceededError";
  }
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

/** An instrument-level scheduled event (earnings) and a macro release. */
export interface EarningsEvent {
  ticker: string;
  /** ISO date (yyyy-mm-dd) of the next scheduled report, when known. */
  date: string;
  /** Bars/session in which it happens: before-open / after-close / unknown. */
  hour: "bmo" | "amc" | "unknown";
  /** Estimated EPS for that report, when the provider gives one. */
  epsEstimate: number | null;
}

export interface MacroEvent {
  /** e.g. "FOMC", "CPI", "NFP". */
  name: string;
  date: string;
  /** Provider-reported importance: high | medium | low | unknown. */
  importance: "high" | "medium" | "low" | "unknown";
}

/**
 * Scheduled events (WP-P2.3): earnings dates and macro releases. Optional — when
 * the provider is not configured or fails, the feature is simply off and the
 * analysts/committee are told nothing rather than something wrong.
 */
export interface EventCalendarPort {
  /** Upcoming earnings for the given tickers within `withinDays`. */
  upcomingEarnings(tickers: readonly string[], withinDays: number): Promise<EarningsEvent[]>;
  /**
   * Upcoming macro releases within `withinDays`. Optional: providers that only
   * cover earnings (Finnhub's free tier) leave it undefined and the system
   * reports no macro releases rather than inventing any.
   */
  upcomingMacro?(withinDays: number): Promise<MacroEvent[]>;
}

/** Macroeconomic regime data (FRED). Fetch once per run, not per ticker. */
export interface MacroDataPort {
  macroSnapshot(): Promise<MacroSnapshot>;
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
  /** The quantity actually accepted by the broker (may differ after precision retries). */
  submittedQuantity?: number;
}

export interface RemoteOrderStatus {
  status: string; // broker-native status string
  filledQuantity: number;
  filledPriceAvg: number | null;
}

export interface RemoteOpenOrder {
  brokerOrderId: string;
  /** Plain symbol (mapped back from the broker's instrument ticker). */
  ticker: string;
  side: OrderSide;
  /** Absolute quantity. */
  quantity: number;
  status: string;
  createdAt: string;
}

/** An external cash movement on the account (not a trade): deposit or withdrawal. */
export interface CashFlow {
  /** Signed amount in `currency`: deposits positive, withdrawals negative. */
  amount: number;
  currency: string;
  occurredAt: string;
  type: "DEPOSIT" | "WITHDRAWAL";
  reference: string | null;
}

export interface BrokerPort {
  kind: "paper" | "trading212";
  account(): Promise<AccountSummary>;
  positions(): Promise<Position[]>;
  submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderResult>;
  orderStatus(brokerOrderId: string): Promise<RemoteOrderStatus>;
  /** Orders currently open at the broker (for crash reconciliation). */
  listOpenOrders?(): Promise<RemoteOpenOrder[]>;
  cancelOrder?(brokerOrderId: string): Promise<void>;
  /**
   * External cash flows strictly after `sinceIso`, for NAV unit accounting.
   * Optional: brokers without a transactions feed keep NAV units fixed.
   */
  cashFlows?(sinceIso: string): Promise<CashFlow[]>;
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
  /** Macro regime snapshot shared by all analysts of the run (null = unavailable). */
  macro: MacroSnapshot | null;
  /** Days until this ticker's next scheduled earnings report (null = unknown), WP-P2.3. */
  daysToEarnings?: number | null;
}

export interface Analyst {
  readonly kind: AnalystKind;
  analyze(runId: string, ctx: AnalystContext, now: string): Promise<AnalysisReport>;
  /**
   * Optional: produce SEVERAL analyst reports for one ticker in a single LLM call
   * (WP-P1.2). When present, `MarketAnalysisService` uses it instead of calling
   * `analyze` once per role.
   */
  analyzeBatch?(runId: string, ctx: AnalystContext, now: string): Promise<AnalysisReport[]>;
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
  /**
   * Runs still marked RUNNING (an interrupted process left them behind). Startup
   * closes them out so the dashboard and the hour guard see the truth (WP-P0.5).
   */
  findRunning?(): Promise<Run[]>;
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
  /** Orders still open at the broker (awaiting fill confirmation). */
  openOrders(): Promise<Order[]>;
  /** Orders left PENDING from an interrupted run (submission never confirmed). */
  stalePending(beforeIso: string): Promise<Order[]>;
}

export interface EventRepository {
  append(events: DomainEvent[]): Promise<void>;
  byRun(runId: string): Promise<DomainEvent[]>;
  recent(limit?: number): Promise<DomainEvent[]>;
}

/** Persisted raw market inputs (quotes, news, sentiment, macro) per run. */
export interface MarketDataRepository {
  saveSnapshots(snapshots: { id: string; runId: string; snapshot: MarketSnapshot }[]): Promise<void>;
  saveNews(items: { id: string; runId: string; item: NewsItem }[]): Promise<void>;
  saveSentiment(scores: { id: string; runId: string; score: SentimentScore; asOf: string }[]): Promise<void>;
  saveMacro(snapshot: { id: string; runId: string; snapshot: MacroSnapshot }): Promise<void>;
  snapshotsByTicker(ticker: string, limit?: number): Promise<MarketSnapshot[]>;
  latestNews(limit?: number): Promise<{ runId: string; item: NewsItem }[]>;
  latestSentiment(limit?: number): Promise<{ runId: string; score: SentimentScore }[]>;
  latestMacro(limit?: number): Promise<{ runId: string; snapshot: MacroSnapshot }[]>;
}

/** Allocation-review history: the evolving target weights with their reasons. */
export interface AllocationTargetRepository {
  saveUpdates(updates: AllocationTargetUpdate[]): Promise<void>;
  /** Latest target per ticker (empty before the first review). */
  current(): Promise<AllocationTarget[]>;
  recentUpdates(limit?: number): Promise<AllocationTargetUpdate[]>;
}

export interface SettingsRepository {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
}

/** Append-only LLM usage log (token spend accounting + trailing-window budget). */
export interface LlmUsageRepository {
  save(usage: LlmUsage): Promise<void>;
  /** Total USD spend strictly after `sinceIso`. */
  spendSince(sinceIso: string): Promise<number>;
  byRun(runId: string): Promise<LlmUsage[]>;
}

/** Asset Allocation Committee persistence (sessions, proposals, feedback, votes). */
export interface CommitteeRepository {
  saveSession(session: CommitteeSession): Promise<void>;
  saveProposals(proposals: CommitteeProposal[]): Promise<void>;
  saveFeedback(items: CommitteeFeedback[]): Promise<void>;
  saveVotes(votes: CommitteeVote[]): Promise<void>;
  latestSession(): Promise<CommitteeSession | null>;
  detail(sessionId: string): Promise<CommitteeSessionDetail>;
  byRun(runId: string): Promise<CommitteeSession[]>;
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
  /** Token/cost accounting + per-run and per-day budget guards (optional). */
  llmBudget?: LlmUsageRecorder;
  prices: PriceDataPort;
  news: NewsPort;
  fundamentals: FundamentalsPort;
  sentiment: SentimentPort;
  /** Macro regime data (FRED); null when not configured — analysis runs without it. */
  macro: MacroDataPort | null;
  /** Scheduled events (earnings, macro releases); null/absent when not configured. */
  eventCalendar?: EventCalendarPort | null;
  fx: FxPort;
  broker: BrokerPort;
  runs: RunRepository;
  analysis: AnalysisRepository;
  portfolio: PortfolioRepository;
  decisions: DecisionRepository;
  orders: OrderRepository;
  eventRepo: EventRepository;
  marketData: MarketDataRepository;
  allocationTargets: AllocationTargetRepository;
  settings: SettingsRepository;
  committee: CommitteeRepository;
  /** Token usage log (optional; required for the spend budget to survive restarts). */
  llmUsage?: LlmUsageRepository;
}

export type { OrderStatus };
