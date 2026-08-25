import { newId } from "../../shared/id.js";
import { roundPrice, roundValue } from "../../shared/money.js";
import { AdapterError } from "../../shared/errors.js";
import type { Position } from "../../domain/portfolio.js";
import type { AccountSummary, BrokerPort, FxPort, PriceDataPort, RemoteOrderStatus, SubmitOrderRequest, SubmitOrderResult } from "../../application/ports.js";

export interface PaperBrokerConfig {
  currency: string;
  initialCash: number;
  initialPositions: { ticker: string; quantity: number; averagePrice?: number }[];
  /** Instrument → account-currency FX adapter. */
  fx: FxPort;
  /** Live price source: fills execute at the quoted mid price. */
  prices: Pick<PriceDataPort, "quote">;
  /** Half-spread applied to fills, in basis points (buy above mid, sell below mid). */
  spreadBps: number;
  /** FX conversion fee applied on cross-currency orders (0.0015 = T212 Invest). */
  fxFeePct: number;
}

interface PaperPosition {
  ticker: string;
  quantity: number;
  averagePrice: number;
  currency: string;
  lastPrice: number;
}

/**
 * Simulated broker: fills immediately at mid ± half-spread, applies the FX
 * conversion fee on cross-currency orders, and keeps the cash ledger in the
 * account currency. Deterministic given prices/FX — the test double of
 * choice for end-to-end runs.
 */
export class PaperBroker implements BrokerPort {
  readonly kind = "paper" as const;

  private cash: number;
  private readonly holdings = new Map<string, PaperPosition>();
  private readonly submitted = new Map<string, { status: string; filledQuantity: number; filledPriceAvg: number | null }>();

  constructor(private readonly cfg: PaperBrokerConfig) {
    this.cash = cfg.initialCash;
    for (const p of cfg.initialPositions) {
      const price = p.averagePrice ?? 100;
      this.holdings.set(p.ticker, {
        ticker: p.ticker,
        quantity: p.quantity,
        averagePrice: price,
        currency: currencyGuess(p.ticker),
        lastPrice: price,
      });
    }
  }

  async account(): Promise<AccountSummary> {
    let invested = 0;
    for (const p of this.holdings.values()) {
      const rate = await this.cfg.fx.rate(p.currency, this.cfg.currency);
      invested += p.quantity * p.lastPrice * rate;
    }
    return {
      currency: this.cfg.currency,
      cash: roundValue(this.cash),
      investedValue: roundValue(invested),
      totalValue: roundValue(invested + this.cash),
    };
  }

  async positions(): Promise<Position[]> {
    return [...this.holdings.values()].map((p) => ({
      ticker: p.ticker,
      quantity: roundPrice(p.quantity),
      averagePrice: p.averagePrice,
      currentPrice: p.lastPrice,
      currency: p.currency,
    }));
  }

  async submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderResult> {
    const halfSpread = this.cfg.spreadBps / 2 / 10_000;
    const instrumentCurrency = this.holdings.get(req.ticker)?.currency ?? currencyGuess(req.ticker);
    const rate = await this.cfg.fx.rate(instrumentCurrency, this.cfg.currency);
    const fxApplies = instrumentCurrency !== this.cfg.currency;
    const fillPrice = (await this.cfg.prices.quote(req.ticker)).price;

    if (req.side === "BUY") {
      const gross = req.quantity * fillPrice * rate;
      const spreadCost = gross * halfSpread;
      const fxCost = fxApplies ? gross * this.cfg.fxFeePct : 0;
      const total = roundValue(gross + spreadCost + fxCost);
      if (total > this.cash) {
        throw new AdapterError(`paper broker: insufficient cash (need ${total.toFixed(2)}, have ${this.cash.toFixed(2)})`, "unsupported");
      }
      this.cash = roundValue(this.cash - total);
      const existing = this.holdings.get(req.ticker);
      if (existing) {
        const newQty = existing.quantity + req.quantity;
        existing.averagePrice = roundPrice((existing.averagePrice * existing.quantity + fillPrice * req.quantity) / newQty);
        existing.quantity = newQty;
        existing.lastPrice = roundPrice(fillPrice * (1 + halfSpread));
      } else {
        this.holdings.set(req.ticker, {
          ticker: req.ticker,
          quantity: req.quantity,
          averagePrice: fillPrice,
          currency: instrumentCurrency,
          lastPrice: roundPrice(fillPrice * (1 + halfSpread)),
        });
      }
    } else {
      const existing = this.holdings.get(req.ticker);
      if (!existing || existing.quantity < req.quantity) {
        throw new AdapterError(`paper broker: insufficient ${req.ticker} position`, "unsupported");
      }
      const gross = req.quantity * fillPrice * rate;
      const spreadCost = gross * halfSpread;
      const fxCost = fxApplies ? gross * this.cfg.fxFeePct : 0;
      this.cash = roundValue(this.cash + gross - spreadCost - fxCost);
      existing.quantity = roundPrice(existing.quantity - req.quantity);
      existing.lastPrice = roundPrice(fillPrice * (1 - halfSpread));
      if (existing.quantity <= 0) this.holdings.delete(req.ticker);
    }

    const id = newId("pb");
    const filledPriceAvg = this.holdings.get(req.ticker)?.lastPrice ?? fillPrice;
    this.submitted.set(id, { status: "FILLED", filledQuantity: req.quantity, filledPriceAvg });
    return { brokerOrderId: id, status: "FILLED" };
  }

  async orderStatus(brokerOrderId: string): Promise<RemoteOrderStatus> {
    const s = this.submitted.get(brokerOrderId);
    if (!s) throw new AdapterError(`paper broker: unknown order ${brokerOrderId}`, "no-data");
    return { status: s.status, filledQuantity: s.filledQuantity, filledPriceAvg: s.filledPriceAvg };
  }

  /** Exposed for tests: the paper ledger's current state. */
  snapshot(): { cash: number; positions: PaperPosition[] } {
    return { cash: this.cash, positions: [...this.holdings.values()] };
  }
}

function currencyGuess(ticker: string): string {
  const t = ticker.toUpperCase();
  if (t.endsWith(".L")) return "GBP";
  if (t.endsWith(".DE") || t.endsWith(".PA")) return "EUR";
  return "USD";
}
