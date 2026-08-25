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

/**
 * Two-phase order flow (reserve → broker → confirm): every order is persisted
 * as PENDING before it is sent, so a crash between decision and submission
 * can never lose the intent, and a rejected submission never burns a slot.
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
      await this.ports.orders.save(order);
      result.orders.push(order);

      this.ports.events.publish({
        id: newId("evt"),
        runId,
        type: "OrderRequested",
        payload: {
          orderId: order.id,
          decisionId: decision.id,
          ticker: p.ticker,
          side: p.action,
          quantity: p.quantity,
          estimatedValue: p.estimatedValue,
          estimatedCost: p.costEstimate.total,
          expectedBenefit: p.expectedBenefit,
        },
        occurredAt: now,
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
          this.ports.events.publish({
            id: newId("evt"),
            runId,
            type: "OrderRejected",
            payload: { orderId: order.id, ticker: p.ticker, reason: "broker rejected the order" },
            occurredAt: toIso(this.ports.clock.now()),
          });
          continue;
        }

        if (submitted.status === "FILLED") {
          await this.confirmFill(runId, order, decision, p.estimatedPrice, p.estimatedValue);
        } else {
          // SUBMITTED / PENDING: poll once for a fill (market orders fill fast).
          await this.delay(this.pollDelayMs);
          const remote = await this.ports.broker.orderStatus(submitted.brokerOrderId);
          if (["FILLED", "PARTIALLY_FILLED"].includes(remote.status)) {
            const price = remote.filledPriceAvg ?? p.estimatedPrice;
            const accountValue = p.estimatedPrice > 0 ? p.estimatedValue * (price / p.estimatedPrice) : p.estimatedValue;
            await this.confirmFill(runId, order, decision, price, roundValue(accountValue));
          } else if (["REJECTED", "CANCELLED"].includes(remote.status)) {
            order.markRejected(`broker status ${remote.status}`);
            await this.ports.orders.save(order);
            result.rejected.push(order);
          } else {
            order.markSubmitted(submitted.brokerOrderId, toIso(this.ports.clock.now()));
            await this.ports.orders.save(order);
          }
        }

        if (order.fill) result.filled.push(order);
      } catch (err) {
        order.markFailed(String(err));
        await this.ports.orders.save(order);
        result.failed.push(order);
        this.ports.events.publish({
          id: newId("evt"),
          runId,
          type: "OrderFailed",
          payload: { orderId: order.id, ticker: p.ticker, error: String(err) },
          occurredAt: toIso(this.ports.clock.now()),
        });
      }
    }
    return result;
  }

  private async confirmFill(
    runId: string,
    order: Order,
    decision: Decision,
    fillPrice: number,
    accountValue: number,
  ): Promise<void> {
    const costs = this.engine.estimateCosts({
      orderValue: roundValue(accountValue),
      accountCurrency: decision.proposal.costEstimate.currency,
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
    this.ports.events.publish({
      id: newId("evt"),
      runId,
      type: "OrderFilled",
      payload: {
        orderId: order.id,
        ticker: order.ticker,
        side: order.side,
        quantity: fill.filledQuantity,
        price: fill.filledPriceAvg,
        realizedCost: fill.realizedCost.total,
      },
      occurredAt: fill.filledAt,
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
