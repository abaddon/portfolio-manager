import { z } from "zod";
import { AdapterError } from "../../shared/errors.js";
import type { Position } from "../../domain/portfolio.js";
import type { AccountSummary, BrokerPort, CashFlow, RemoteOpenOrder, RemoteOrderStatus, SubmitOrderRequest, SubmitOrderResult } from "../../application/ports.js";

/**
 * Trading212 REST client (beta API, docs.trading212.com / _bundle/api.yaml).
 *
 * Auth: key-pair Basic auth (API key : API secret); falls back to the legacy
 * single-key `Authorization` header when only a key is provided.
 * Base URL: demo.trading212.com (practice) or live.trading212.com.
 *
 * Instrument identifiers: the API uses tickers like `AAPL_US_EQ` (unique
 * instrument ids), NOT plain symbols. This adapter resolves plain symbols via
 * the metadata/instruments endpoint (cached 10 min) and maps positions back
 * to plain symbols so the rest of the system works with the universe config.
 */

const AccountSummarySchema = z.object({
  currency: z.string().optional(),
  totalValue: z.number().optional(),
  cash: z.object({ availableToTrade: z.number().optional() }).passthrough().optional(),
  investments: z.object({ currentValue: z.number().optional() }).passthrough().optional(),
});

const PositionsSchema = z.array(
  z.object({
    averagePricePaid: z.number(),
    currentPrice: z.number(),
    quantity: z.number(),
    instrument: z.object({ ticker: z.string(), currency: z.string().optional(), name: z.string().optional() }).passthrough(),
  }).passthrough(),
);

const OrderResponseSchema = z.object({
  id: z.union([z.string(), z.number()]),
  status: z.string(),
  filledQuantity: z.number().optional(),
  filledValue: z.number().optional(),
}).passthrough();

const InstrumentsSchema = z.array(
  z.object({
    ticker: z.string(),
    shortName: z.string().optional(),
    name: z.string().optional(),
    isin: z.string().optional(),
    currencyCode: z.string().optional(),
    type: z.string().optional(),
  }).passthrough(),
);

const HistoryOrdersSchema = z.object({
  items: z.array(
    z.object({
      order: z
        .object({
          id: z.union([z.string(), z.number()]).optional(),
          status: z.string().optional(),
          filledQuantity: z.number().optional(),
        })
        .passthrough()
        .optional(),
      fill: z
        .object({
          price: z.number().optional(),
          quantity: z.number().optional(),
          filledAt: z.string().optional(),
        })
        .passthrough()
        .optional(),
    }).passthrough(),
  ),
}).passthrough();

/** GET /equity/history/transactions — "movements to and from your account". */
const TransactionsSchema = z.object({
  items: z.array(
    z.object({
      type: z.string().optional(), // WITHDRAW | DEPOSIT | FEE | TRANSFER | INTEREST_ON_FREE_CASH | LENDING_INTEREST
      amount: z.number().optional(),
      currency: z.string().optional(),
      dateTime: z.string().optional(),
      reference: z.union([z.string(), z.number()]).optional(),
    }).passthrough(),
  ),
  nextPagePath: z.string().nullable().optional(),
}).passthrough();

interface CachedInstrument {
  apiTicker: string;
  plain: string;
  shortName: string;
  currency: string;
  type: string;
}

const INSTRUMENT_CACHE_TTL_MS = 10 * 60_000;

export class Trading212Broker implements BrokerPort {
  readonly kind = "trading212" as const;

  private readonly baseUrl: string;
  private instruments: Map<string, CachedInstrument> | null = null;
  private instrumentsFetchedAt = 0;
  /** Serializes requests with spacing: T212 rate limits are per-account (e.g. 1/s on orders). */
  private queue: Promise<void> = Promise.resolve();
  private readonly minIntervalMs = 600;

  constructor(
    private readonly opts: {
      environment: "demo" | "live";
      apiKey: string;
      apiSecret: string | null;
      baseUrl?: string;
      liveBaseUrl?: string;
      /** Optional: warns when an instrument has to be mapped without metadata. */
      logger?: { warn(message: string, meta?: Record<string, unknown>): void };
    },
  ) {
    if (!opts.apiKey) throw new AdapterError("TRADING212_API_KEY is required for live mode", "auth");
    this.baseUrl = (opts.environment === "demo" ? (opts.baseUrl ?? "https://demo.trading212.com") : (opts.liveBaseUrl ?? "https://live.trading212.com")).replace(/\/$/, "");
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiSecret) {
      h.authorization = `Basic ${Buffer.from(`${this.opts.apiKey}:${this.opts.apiSecret}`).toString("base64")}`;
    } else {
      // Legacy single-key auth header.
      h.authorization = this.opts.apiKey;
    }
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown, schema?: z.ZodType<T>): Promise<T> {
    const prev = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => (release = resolve));
    await prev;
    try {
      await new Promise((r) => setTimeout(r, this.minIntervalMs));
      return await this.requestOnce(method, path, body, schema);
    } finally {
      release();
    }
  }

  private async requestOnce<T>(method: string, path: string, body?: unknown, schema?: z.ZodType<T>): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = { method, headers: this.headers() };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    if (res.status === 401 || res.status === 403) throw new AdapterError(`trading212 auth failed (${res.status}) — check the API key and its scopes`, "auth");
    if (res.status === 429) throw new AdapterError("trading212 rate limited (429)", "rate-limit");
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new AdapterError(`trading212 HTTP ${res.status}: ${detail}`, "http");
    }
    const data: unknown = await res.json().catch(() => null);
    if (schema) {
      const parsed = schema.safeParse(data);
      if (!parsed.success) throw new AdapterError(`trading212 parse error: ${parsed.error.message}`, "parse");
      return parsed.data;
    }
    return data as T;
  }

  /** Loads (and caches) the full instrument list from the metadata endpoint. */
  private async instrumentList(): Promise<CachedInstrument[]> {
    if (this.instruments && Date.now() - this.instrumentsFetchedAt < INSTRUMENT_CACHE_TTL_MS) {
      return [...this.instruments.values()];
    }
    const raw = await this.request("GET", "/api/v0/equity/metadata/instruments", undefined, InstrumentsSchema);
    const map = new Map<string, CachedInstrument>();
    for (const i of raw) {
      const plain = i.ticker.split("_")[0] ?? i.ticker;
      const instrument: CachedInstrument = {
        apiTicker: i.ticker,
        plain,
        shortName: i.shortName ?? plain,
        currency: i.currencyCode ?? "USD",
        type: i.type ?? "STOCK",
      };
      map.set(i.ticker, instrument);
    }
    this.instruments = map;
    this.instrumentsFetchedAt = Date.now();
    return [...map.values()];
  }

  /** Resolves a plain symbol (or full API ticker) to the API instrument ticker. */
  async resolveInstrumentTicker(ticker: string): Promise<string> {
    const list = await this.instrumentList();
    const upper = ticker.toUpperCase();
    const exact = [...this.instruments!.keys()].find((t) => t.toUpperCase() === upper);
    if (exact) return exact;
    const byShort = list.filter((i) => i.shortName.toUpperCase() === upper);
    if (byShort.length === 1) return byShort[0]!.apiTicker;
    const byPlain = list.filter((i) => i.plain.toUpperCase() === upper);
    if (byPlain.length === 1) return byPlain[0]!.apiTicker;
    if (byPlain.length > 1 || byShort.length > 1) {
      throw new AdapterError(`trading212: ambiguous instrument "${ticker}" (${[...byShort, ...byPlain].map((i) => i.apiTicker).join(", ")})`, "parse");
    }
    throw new AdapterError(`trading212: instrument not found for "${ticker}"`, "no-data");
  }

  /**
   * Maps an API instrument ticker back to the plain symbol for the universe.
   * Always resolves through the instrument list when possible (e.g.
   * UTX_US_EQ → RTX) so the mapping is deterministic across calls; the
   * split fallback is only a degraded-mode last resort — and it is LOUD,
   * because a guessed symbol silently breaks reconciliation matching (a live
   * broker order is then reported "no matching order found" and marked FAILED,
   * which opens the door to a double execution).
   */
  async toPlainTicker(apiTicker: string): Promise<string> {
    if (!this.instruments) {
      await this.instrumentList().catch(() => undefined);
    }
    const hit = this.instruments?.get(apiTicker);
    if (hit) return hit.shortName || hit.plain;
    const guessed = apiTicker.split("_")[0] ?? apiTicker;
    this.opts.logger?.warn(
      `trading212: no metadata for instrument "${apiTicker}" — falling back to the guessed symbol "${guessed}"`,
      { apiTicker, guessed },
    );
    return guessed;
  }

  async account(): Promise<AccountSummary> {
    const s = await this.request("GET", "/api/v0/equity/account/summary", undefined, AccountSummarySchema);
    // `availableToTrade` (NOT total cash) is the right field here: it is the
    // broker's own "investedValue + cash = totalValue" pairing, and it is the
    // cash actually available for a new order — which is what the decision
    // gate's cash floor must check. Verified live against the API:
    // availableToTrade 9.29 + investments.currentValue 771.39 = totalValue 780.68.
    // (Cash reserved by an order still in flight is therefore not counted, so a
    // pending order cannot be re-spent by the next run's gate.)
    return {
      currency: s.currency ?? "GBP",
      cash: s.cash?.availableToTrade ?? 0,
      totalValue: s.totalValue ?? 0,
      investedValue: s.investments?.currentValue ?? 0,
    };
  }

  async positions(): Promise<Position[]> {
    // Prime the instrument cache so position tickers map back to plain symbols.
    await this.instrumentList().catch(() => undefined);
    const raw = await this.request("GET", "/api/v0/equity/positions", undefined, PositionsSchema);
    const out: Position[] = [];
    for (const p of raw) {
      out.push({
        ticker: await this.toPlainTicker(p.instrument.ticker),
        quantity: p.quantity,
        averagePrice: p.averagePricePaid,
        currentPrice: p.currentPrice,
        currency: p.instrument.currency ?? this.instruments?.get(p.instrument.ticker)?.currency ?? "USD",
      });
    }
    return out;
  }

  async submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderResult> {
    // T212 convention: negative quantity = sell side.
    const sign = req.side === "SELL" ? -1 : 1;
    let quantity = Math.abs(req.quantity);
    const apiTicker = await this.resolveInstrumentTicker(req.ticker);

    // Some instruments reject certain decimal precisions with
    // /api-errors/quantity-precision-mismatch ("invalid quantity precision N").
    // Parse the detail and retry with progressively lower precision.
    //
    // The retry FLOORS toward zero: the quantity was sized and approved by the
    // economic gate (maxOrderValue / heat / cash), so the broker must never be
    // sent MORE than that. Rounding half-up turned an approved 12.5 into 13
    // at integer precision — 4% above the gate — and 0.4 into 0, an order that
    // cannot be accepted at all.
    let minDecimals = 4;
    for (let attempt = 0; attempt <= 4; attempt++) {
      const decimals = Math.min(minDecimals, 4);
      const q = floorTo(quantity, decimals);
      if (q <= 0) {
        throw new AdapterError(
          `trading212: ${req.ticker} quantity ${quantity} is below the smallest tradable precision (${decimals} dp)`,
          "unsupported",
        );
      }
      try {
        const res = await this.postMarketOrder(apiTicker, sign * q);
        return {
          brokerOrderId: String(res.id),
          status: mapStatus(res.status),
          submittedQuantity: sign * q,
        };
      } catch (err) {
        const precision = parseQuantityPrecisionError(err);
        if (precision === null || attempt === 4) throw err;
        // "precision N" is invalid → retry with N-1 decimals (floor: integers).
        minDecimals = Math.max(0, precision - 1);
      }
    }
    // Unreachable: the last attempt throws the broker error itself.
    throw new AdapterError(`trading212: could not place ${req.ticker} order`, "http");
  }

  /**
   * Places one market order, retrying ONCE on a 429.
   *
   * A 429 is safe to retry: the request was rejected before the order was
   * created (unlike a timeout, where the order may exist). Without this, a
   * transient rate limit — the order bucket is ~1/s and the sweep, the
   * reconciliation and the precision retries all fire in the same run —
   * permanently FAILED the order and dropped the trade, because nothing
   * retries a rate-limited failure (see ExecutionService.retryPrecisionFailures).
   */
  private async postMarketOrder(apiTicker: string, quantity: number): Promise<z.infer<typeof OrderResponseSchema>> {
    try {
      return await this.request("POST", "/api/v0/equity/orders/market", { quantity, ticker: apiTicker }, OrderResponseSchema);
    } catch (err) {
      if (!(err instanceof AdapterError) || err.kind !== "rate-limit") throw err;
      await new Promise((r) => setTimeout(r, 1_000));
      return await this.request("POST", "/api/v0/equity/orders/market", { quantity, ticker: apiTicker }, OrderResponseSchema);
    }
  }

  async orderStatus(brokerOrderId: string): Promise<RemoteOrderStatus> {
    try {
      const res = await this.request("GET", `/api/v0/equity/orders/${brokerOrderId}`, undefined, OrderResponseSchema);
      const filledQuantity = res.filledQuantity ?? 0;
      const filledValue = res.filledValue ?? 0;
      return {
        status: res.status,
        filledQuantity,
        filledPriceAvg: filledQuantity > 0 && filledValue > 0 ? filledValue / filledQuantity : null,
      };
    } catch (err) {
      // Filled orders leave the active-orders endpoint (404 "Order not found") —
      // their fills live in the order history instead. requestOnce: we are already
      // inside the serialized queue (re-entering request() would deadlock).
      if (err instanceof AdapterError && err.kind === "http" && err.message.includes("404")) {
        const history = await this.requestOnce("GET", "/api/v0/equity/history/orders?limit=50", undefined, HistoryOrdersSchema);
        const item = history.items.find((i) => String(i.order?.id) === brokerOrderId);
        if (item?.fill) {
          return {
            // Report the broker's OWN status: an order that partially filled and
            // was then cancelled must not be laundered into "FILLED" (settle()
            // already handles CANCELLED-with-a-fill correctly).
            status: item.order?.status ?? "FILLED",
            filledQuantity: Number(item.fill.quantity ?? 0),
            filledPriceAvg: item.fill.price != null ? Number(item.fill.price) : null,
          };
        }
        if (item?.order) {
          return {
            status: item.order.status ?? "FILLED",
            filledQuantity: Number(item.order.filledQuantity ?? 0),
            filledPriceAvg: null,
          };
        }
      }
      throw err;
    }
  }

  /**
   * Deposits and withdrawals strictly after `sinceIso` from the transactions
   * history (rate limit 6 req/min — normally a single page per run). Fees,
   * transfers and interest are not external flows and are ignored. Amounts are
   * normalised by type: deposits positive, withdrawals negative.
   *
   * The endpoint rejects `time` without a pagination cursor ("Both or none of
   * cursorId and time must be provided"), so the first page is fetched
   * unfiltered (newest-first) and filtered locally, and cursor pages keep the
   * original `time` so the pair stays valid.
   */
  async cashFlows(sinceIso: string): Promise<CashFlow[]> {
    const since = new Date(sinceIso).getTime();
    const out: CashFlow[] = [];
    const seen = new Set<string>();
    let path: string | null = "/api/v0/equity/history/transactions?limit=50";
    for (let page = 0; page < 5 && path; page++) {
      if (seen.has(path)) break; // the cursor did not advance — never count a page twice
      seen.add(path);
      const res: z.infer<typeof TransactionsSchema> = await this.request("GET", path, undefined, TransactionsSchema);
      for (const item of res.items) {
        if (item.type !== "DEPOSIT" && item.type !== "WITHDRAW") continue;
        if (item.amount === undefined || !item.dateTime) continue;
        const at = new Date(item.dateTime).getTime();
        if (!Number.isFinite(at) || at <= since) continue;
        const magnitude = Math.abs(item.amount);
        out.push({
          amount: item.type === "WITHDRAW" ? -magnitude : magnitude,
          currency: item.currency ?? "?",
          occurredAt: item.dateTime,
          type: item.type === "WITHDRAW" ? "WITHDRAWAL" : "DEPOSIT",
          reference: item.reference !== undefined ? String(item.reference) : null,
        });
      }
      if (!res.nextPagePath) {
        path = null;
      } else {
        path = res.nextPagePath.startsWith("/") ? res.nextPagePath : `/${res.nextPagePath}`;
        const hasCursor = path.includes("cursorId=") || path.includes("cursor=");
        if (hasCursor && !path.includes("time=")) {
          path += `${path.includes("?") ? "&" : "?"}time=${encodeURIComponent(sinceIso)}`;
        }
      }
    }
    return out;
  }

  async listOpenOrders(): Promise<RemoteOpenOrder[]> {
    const OpenOrdersSchema = z.array(
      z.object({
        id: z.union([z.string(), z.number()]),
        status: z.string(),
        side: z.enum(["BUY", "SELL"]).optional(),
        quantity: z.number(),
        ticker: z.string(),
        createdAt: z.string().optional(),
      }).passthrough(),
    );
    await this.instrumentList().catch(() => undefined);
    const raw = await this.request("GET", "/api/v0/equity/orders", undefined, OpenOrdersSchema);
    const out: RemoteOpenOrder[] = [];
    for (const o of raw) {
      out.push({
        brokerOrderId: String(o.id),
        ticker: await this.toPlainTicker(o.ticker),
        side: o.side ?? (o.quantity < 0 ? "SELL" : "BUY"),
        quantity: Math.abs(o.quantity),
        status: o.status,
        createdAt: o.createdAt ?? new Date().toISOString(),
      });
    }
    return out;
  }
}

function mapStatus(brokerStatus: string): SubmitOrderResult["status"] {
  switch (brokerStatus) {
    case "FILLED":
      return "FILLED";
    case "PARTIALLY_FILLED":
      // Not terminal: the remainder is still working. Reported as SUBMITTED so
      // the fill is confirmed (once, with the real quantity) when it settles.
      return "SUBMITTED";
    case "REJECTED":
      return "REJECTED";
    case "NEW":
    case "UNCONFIRMED":
    case "CONFIRMED":
    case "LOCAL":
    default:
      return "SUBMITTED";
  }
}

/** Extracts the offending precision from a quantity-precision-mismatch 400. */
export function parseQuantityPrecisionError(err: unknown): number | null {
  if (!(err instanceof AdapterError) || err.kind !== "http" || !err.message.includes("quantity-precision-mismatch")) {
    return null;
  }
  const match = /invalid quantity precision (\d+)/.exec(err.message);
  return match ? Number(match[1]) : null;
}

/** Truncates toward zero — used for broker quantity precision (never rounds UP past the approved size). */
function floorTo(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.floor(n * f + 1e-9) / f;
}
