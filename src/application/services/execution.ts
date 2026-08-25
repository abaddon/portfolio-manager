import { newId } from "../../shared/id.js";
import { toIso } from "../../shared/clock.js";
import { roundValue } from "../../shared/money.js";
import { DecisionEngine, type Decision } from "../../domain/decision.js";
import { Order, type OrderFill } from "../../domain/execution.js";
import type { AppPorts } from "../ports.js";

export interface ExecutionResult {
  orders: Order[];
  filled: Order[];
  rejected: Order[];
  failed: Order[];
}

export interface SweepResult {
  checked: number;
  filled: number;
  rejected: number;
}

/** Pricing/cost context stored on every order for late fill confirmation. */
interface OrderPricingContext {
  accountCurrency: string;
  estimatedPrice: number;
  estimatedAccountValue: number;
}

/**
 * Two-phase order flow (reserve → broker → confirm): every order is persisted
 * as PENDING before it is sent, so a crash between decision and submission
 * can never lose the intent, and a rejected submission never burns a slot.
 *
 * Sweep: Trading212 market orders can stay NEW/CONFIRMED for a while; the
 * sweep re-polls open (SUBMITTED) orders and confirms late fills.
 */
export class ExecutionService {
  constructor(
    private readonly ports: AppPorts,
    private readonly engine: DecisionEngine,
    private readonly maxOrdersPerRun: number,
    private readonly pollDelayMs = 1500,
  ) {}

  async execute(runId: string, decisions: Decision[]): Promise<ExecutionResult> {
    const approved = decisions
      .filter((d) => d.approved && d.action !== "HOLD")
      .sort((a, b) => b.proposal.expectedBenefit - a.proposal.expectedBenefit)
      .slice(0, this.maxOrdersPerRun);

    const result: ExecutionResult = { orders: [], filled: [], rejected: [], failed: [] };
    const now = toIso(this.ports.clock.now());

    for (const decision of approved) {
      const p = decision.proposal;
      const order = Order.create({
        id: newId("ord"),
        runId,
        decisionId: decision.id,
        ticker: p.ticker,
        side: p.action === "BUY" ? "BUY" : "SELL",
        quantity: p.quantity,
        type: "MARKET",
        currency: p.currency,
        createdAt: now,
      });
      const pricing: OrderPricingContext = {
        accountCurrency: p.costEstimate.currency,
        estimatedPrice: p.estimatedPrice,
        estimatedAccountValue: p.estimatedValue,
      };
      order.details = { ...order.details, pricing };
      await this.ports.orders.save(order);
      result.orders.push(order);

      this.emit(runId, "OrderRequested", {
        orderId: order.id,
        decisionId: decision.id,
        ticker: p.ticker,
        side: p.action,
        quantity: p.quantity,
        estimatedValue: p.estimatedValue,
        estimatedCost: p.costEstimate.total,
        expectedBenefit: p.expectedBenefit,
      });

      try {
        const submitted = await this.ports.broker.submitOrder({
          ticker: p.ticker,
          side: p.action === "BUY" ? "BUY" : "SELL",
          quantity: p.quantity,
          type: "MARKET",
        });
        order.markSubmitted(submitted.brokerOrderId, toIso(this.ports.clock.now()));

        if (submitted.status === "REJECTED") {
          order.markRejected("broker rejected the order");
          await this.ports.orders.save(order);
          result.rejected.push(order);
          this.emit(runId, "OrderRejected", { orderId: order.id, ticker: p.ticker, reason: "broker rejected the order" });
          continue;
        }

        if (submitted.status === "FILLED") {
          await this.confirmFill(runId, order, p.estimatedPrice, p.estimatedValue, pricing.accountCurrency);
        } else {
          // SUBMITTED / PENDING: poll once for a fill (market orders fill fast).
          await this.delay(this.pollDelayMs);
          const remote = await this.ports.broker.orderStatus(submitted.brokerOrderId);
          if (["FILLED", "PARTIALLY_FILLED"].includes(remote.status)) {
            const price = remote.filledPriceAvg ?? p.estimatedPrice;
            const accountValue =
              p.estimatedPrice > 0 ? roundValue(p.estimatedValue * (price / p.estimatedPrice)) : p.estimatedValue;
            await this.confirmFill(runId, order, price, accountValue, pricing.accountCurrency);
          } else if (["REJECTED", "CANCELLED"].includes(remote.status)) {
            order.markRejected(`broker status ${remote.status}`);
            await this.ports.orders.save(order);
            result.rejected.push(order);
          } else {
            // Still open at the broker (e.g. NEW before market open): leave
            // SUBMITTED — the sweep confirms the fill on a later run.
            await this.ports.orders.save(order);
          }
        }

        if (order.fill) result.filled.push(order);
      } catch (err) {
        order.markFailed(String(err));
        await this.ports.orders.save(order);
        result.failed.push(order);
        this.emit(runId, "OrderFailed", { orderId: order.id, ticker: p.ticker, error: String(err) });
      }
    }
    return result;
  }

  /**
   * Re-polls orders still SUBMITTED at the broker (e.g. Trading212 orders
   * confirmed late) and closes them out with fills or rejections. Runs at the
   * start of every pipeline run and is safe to call repeatedly.
   */
  async sweepOpenOrders(): Promise<SweepResult> {
    const result: SweepResult = { checked: 0, filled: 0, rejected: 0 };
    const open = await this.ports.orders.openOrders();
    for (const order of open) {
      if (!order.brokerOrderId) continue;
      result.checked++;
      try {
        const remote = await this.ports.broker.orderStatus(order.brokerOrderId);
        if (["FILLED", "PARTIALLY_FILLED"].includes(remote.status) && remote.filledPriceAvg !== null) {
          const pricing = (order.details.pricing ?? {}) as Partial<OrderPricingContext>;
          const estimatedPrice = pricing.estimatedPrice ?? remote.filledPriceAvg;
          const estimatedAccountValue = pricing.estimatedAccountValue ?? 0;
          const accountValue =
            estimatedPrice > 0 ? roundValue(estimatedAccountValue * (remote.filledPriceAvg / estimatedPrice)) : 0;
          await this.confirmFill(order.runId, order, remote.filledPriceAvg, accountValue, pricing.accountCurrency ?? "?");
          result.filled++;
        } else if (["REJECTED", "CANCELLED"].includes(remote.status)) {
          order.markRejected(`broker status ${remote.status}`);
          await this.ports.orders.save(order);
          result.rejected++;
        }
        // Still open: leave SUBMITTED for the next sweep.
      } catch (err) {
        this.ports.logger.warn(`order sweep failed for ${order.id}`, { error: String(err) });
      }
    }
    if (result.checked > 0) {
      this.ports.logger.info(`order sweep: checked ${result.checked}, filled ${result.filled}, rejected ${result.rejected}`);
    }
    return result;
  }

  /**
   * Crash reconciliation for orders left PENDING by an interrupted run:
   * because order placement is not idempotent on the Trading212 API, we must
   * NOT re-submit blindly. Instead we match each stale PENDING order against
   * the orders currently open at the broker (same ticker, side, quantity,
   * created within a small window):
   *   - match found  → the order DID reach the broker: adopt its id, mark SUBMITTED;
   *   - no match     → it never left: mark FAILED (surfaces on the dashboard).
   */
  async reconcileStalePending(staleBeforeIso: string): Promise<{ adopted: number; failed: number }> {
    const stale = await this.ports.orders.stalePending(staleBeforeIso);
    if (stale.length === 0) return { adopted: 0, failed: 0 };
    const open = await this.ports.broker.listOpenOrders?.().catch((err) => {
      this.ports.logger.warn("cannot list broker open orders for reconciliation", { error: String(err) });
      return null;
    });
    if (open === null || open === undefined) return { adopted: 0, failed: 0 }; // retry next run

    const result = { adopted: 0, failed: 0 };
    for (const order of stale) {
      const match = open.find(
        (o) =>
          o.ticker === order.ticker &&
          o.side === order.side &&
          Math.abs(o.quantity - order.quantity) < 1e-4 &&
          Math.abs(new Date(o.createdAt).getTime() - new Date(order.createdAt).getTime()) < 15 * 60_000,
      );
      if (match) {
        order.markSubmitted(match.brokerOrderId, toIso(this.ports.clock.now()));
        await this.ports.orders.save(order);
        result.adopted++;
        this.ports.logger.info(`reconciled PENDING order ${order.id} → broker ${match.brokerOrderId} (${match.status})`);
      } else {
        order.markFailed("interrupted before submission — no matching order found at the broker");
        await this.ports.orders.save(order);
        result.failed++;
      }
    }
    return result;
  }

  private async confirmFill(
    runId: string,
    order: Order,
    fillPrice: number,
    accountValue: number,
    accountCurrency: string,
  ): Promise<void> {
    const costs = this.engine.estimateCosts({
      orderValue: roundValue(accountValue),
      accountCurrency,
      instrumentCurrency: order.currency,
      action: order.side,
      ticker: order.ticker,
    });
    const fill: OrderFill = {
      filledQuantity: order.quantity,
      filledPriceAvg: roundValue(fillPrice, 4),
      currency: order.currency,
      filledAt: toIso(this.ports.clock.now()),
      realizedCost: {
        spread: costs.spread,
        fxFee: costs.fxFee,
        stampDuty: costs.stampDuty,
        platformFee: costs.platformFee,
        total: costs.total,
      },
    };
    order.markFilled(fill);
    await this.ports.orders.save(order);
    this.emit(runId, "OrderFilled", {
      orderId: order.id,
      ticker: order.ticker,
      side: order.side,
      quantity: fill.filledQuantity,
      price: fill.filledPriceAvg,
      realizedCost: fill.realizedCost.total,
    });
  }

  private emit(runId: string, type: string, payload: Record<string, unknown>): void {
    this.ports.events.publish({
      id: newId("evt"),
      runId,
      type,
      payload,
      occurredAt: toIso(this.ports.clock.now()),
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
