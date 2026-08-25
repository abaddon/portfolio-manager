import { z } from "zod";
import { AdapterError } from "../../shared/errors.js";
import type { Position } from "../../domain/portfolio.js";
import type { AccountSummary, BrokerPort, RemoteOrderStatus, SubmitOrderRequest, SubmitOrderResult } from "../../application/ports.js";

/**
 * Trading212 REST client (beta API, docs.trading212.com).
 * Auth: key-pair Basic auth (API key : API secret); falls back to the legacy
 * single-key `Authorization` header when only a key is provided.
 * Base URL: demo.trading212.com (practice) or live.trading212.com.
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
  averagePrice: z.number().optional(),
}).passthrough();

export class Trading212Broker implements BrokerPort {
  readonly kind = "trading212" as const;

  private readonly baseUrl: string;

  constructor(
    private readonly opts: {
      environment: "demo" | "live";
      apiKey: string;
      apiSecret: string | null;
      baseUrl?: string;
      liveBaseUrl?: string;
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
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = { method, headers: this.headers() };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    if (res.status === 401 || res.status === 403) throw new AdapterError(`trading212 auth failed (${res.status})`, "auth");
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

  async account(): Promise<AccountSummary> {
    const s = await this.request("GET", "/api/v0/equity/account/summary", undefined, AccountSummarySchema);
    return {
      currency: s.currency ?? "GBP",
      cash: s.cash?.availableToTrade ?? 0,
      totalValue: s.totalValue ?? 0,
      investedValue: s.investments?.currentValue ?? 0,
    };
  }

  async positions(): Promise<Position[]> {
    const raw = await this.request("GET", "/api/v0/equity/positions", undefined, PositionsSchema);
    return raw.map((p) => ({
      ticker: p.instrument.ticker,
      quantity: p.quantity,
      averagePrice: p.averagePricePaid,
      currentPrice: p.currentPrice,
      currency: p.instrument.currency ?? "USD",
    }));
  }

  async submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderResult> {
    // T212 convention: negative quantity = sell side.
    const quantity = req.side === "SELL" ? -Math.abs(req.quantity) : Math.abs(req.quantity);
    const res = await this.request(
      "POST",
      "/api/v0/equity/orders/market",
      { quantity, ticker: req.ticker },
      OrderResponseSchema,
    );
    return {
      brokerOrderId: String(res.id),
      status: mapStatus(res.status),
    };
  }

  async orderStatus(brokerOrderId: string): Promise<RemoteOrderStatus> {
    const res = await this.request("GET", `/api/v0/equity/orders/${brokerOrderId}`, undefined, OrderResponseSchema);
    return {
      status: res.status,
      filledQuantity: res.filledQuantity ?? 0,
      filledPriceAvg: res.averagePrice ?? null,
    };
  }
}

function mapStatus(brokerStatus: string): SubmitOrderResult["status"] {
  switch (brokerStatus) {
    case "FILLED":
    case "PARTIALLY_FILLED":
      return "FILLED";
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
