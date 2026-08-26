import { DomainError } from "../shared/errors.js";

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT";

/** Order lifecycle: PENDING (persisted, not yet sent) → SUBMITTED → FILLED/REJECTED. */
export type OrderStatus =
  | "PENDING"
  | "SUBMITTED"
  | "FILLED"
  | "PARTIALLY_FILLED"
  | "REJECTED"
  | "FAILED"
  | "CANCELLED";

export interface RealizedCost {
  spread: number;
  fxFee: number;
  stampDuty: number;
  platformFee: number;
  total: number;
}

export interface OrderFill {
  filledQuantity: number;
  filledPriceAvg: number;
  currency: string;
  filledAt: string;
  realizedCost: RealizedCost;
}

export class Order {
  constructor(
    readonly id: string,
    readonly runId: string,
    readonly decisionId: string | null,
    readonly ticker: string,
    readonly side: OrderSide,
    public quantity: number,
    readonly type: OrderType,
    readonly currency: string,
    public status: OrderStatus,
    public brokerOrderId: string | null,
    public fill: OrderFill | null,
    public submittedAt: string | null,
    public error: string | null,
    public createdAt: string,
    public details: Record<string, unknown> = {},
  ) {}

  /** Two-phase flow: reserve locally first, only then submit to the broker. */
  static create(params: {
    id: string;
    runId: string;
    decisionId: string | null;
    ticker: string;
    side: OrderSide;
    quantity: number;
    type: OrderType;
    currency: string;
    createdAt: string;
  }): Order {
    if (params.quantity <= 0) throw new DomainError(`order quantity must be positive: ${params.quantity}`);
    return new Order(
      params.id,
      params.runId,
      params.decisionId,
      params.ticker,
      params.side,
      params.quantity,
      params.type,
      params.currency,
      "PENDING",
      null,
      null,
      null,
      null,
      params.createdAt,
      {},
    );
  }

  markSubmitted(brokerOrderId: string, at: string): void {
    if (this.status !== "PENDING") throw new DomainError(`order ${this.id} is ${this.status}, cannot submit`);
    this.status = "SUBMITTED";
    this.brokerOrderId = brokerOrderId;
    this.submittedAt = at;
  }

  /** Aligns the local record with the quantity the broker actually accepted (precision retries). */
  updateQuantity(quantity: number): void {
    if (quantity <= 0) throw new DomainError(`order quantity must be positive: ${quantity}`);
    if (this.status === "FILLED" || this.status === "PARTIALLY_FILLED") {
      throw new DomainError(`order ${this.id} already filled, cannot change quantity`);
    }
    this.quantity = quantity;
  }

  markFilled(fill: OrderFill): void {
    if (this.status !== "SUBMITTED" && this.status !== "PARTIALLY_FILLED") {
      throw new DomainError(`order ${this.id} is ${this.status}, cannot fill`);
    }
    this.fill = fill;
    this.status = fill.filledQuantity >= this.quantity ? "FILLED" : "PARTIALLY_FILLED";
  }

  markRejected(reason: string): void {
    if (this.status !== "SUBMITTED") throw new DomainError(`order ${this.id} is ${this.status}, cannot reject`);
    this.status = "REJECTED";
    this.error = reason;
  }

  markFailed(reason: string): void {
    this.status = "FAILED";
    this.error = reason;
  }

  /**
   * Reopens a FAILED order for re-submission. Only safe for failures where
   * the broker rejected the order outright (it was never created there).
   */
  reopen(): void {
    if (this.status !== "FAILED") throw new DomainError(`order ${this.id} is ${this.status}, only FAILED orders can reopen`);
    this.status = "PENDING";
    this.error = null;
  }
}
