import { describe, expect, it } from "vitest";
import { Order } from "../../src/domain/execution.js";

function newOrder(over: Partial<Parameters<typeof Order.create>[0]> = {}) {
  return Order.create({
    id: "ord1",
    runId: "run1",
    decisionId: "dec1",
    ticker: "AAPL",
    side: "BUY",
    quantity: 1.5,
    type: "MARKET",
    currency: "USD",
    createdAt: "2026-08-26T14:00:00Z",
    ...over,
  });
}

describe("Order lifecycle (two-phase reserve → submit → fill)", () => {
  it("starts PENDING with positive quantity enforced", () => {
    const o = newOrder();
    expect(o.status).toBe("PENDING");
    expect(o.fill).toBeNull();
    expect(() => newOrder({ quantity: 0 })).toThrow(/positive/);
    expect(() => newOrder({ quantity: -1 })).toThrow(/positive/);
  });

  it("submits, then fills", () => {
    const o = newOrder();
    o.markSubmitted("b-42", "2026-08-26T14:00:01Z");
    expect(o.status).toBe("SUBMITTED");
    expect(o.brokerOrderId).toBe("b-42");
    o.markFilled({
      filledQuantity: 1.5,
      filledPriceAvg: 210,
      currency: "USD",
      filledAt: "2026-08-26T14:00:02Z",
      realizedCost: { spread: 0.1, fxFee: 0.5, stampDuty: 0, platformFee: 0, total: 0.6 },
    });
    expect(o.status).toBe("FILLED");
    expect(o.fill?.filledPriceAvg).toBe(210);
  });

  it("marks partial fills distinctly", () => {
    const o = newOrder();
    o.markSubmitted("b-42", "2026-08-26T14:00:01Z");
    o.markFilled({ filledQuantity: 0.5, filledPriceAvg: 210, currency: "USD", filledAt: "x", realizedCost: { spread: 0, fxFee: 0, stampDuty: 0, platformFee: 0, total: 0 } });
    expect(o.status).toBe("PARTIALLY_FILLED");
  });

  it("rejects and fails carry the reason", () => {
    const a = newOrder({ id: "a" });
    a.markSubmitted("b-1", "t");
    a.markRejected("insufficient margin");
    expect(a.status).toBe("REJECTED");
    expect(a.error).toBe("insufficient margin");

    const b = newOrder({ id: "b" });
    b.markFailed("network error");
    expect(b.status).toBe("FAILED");
    expect(b.error).toBe("network error");
  });

  it("guards illegal state transitions", () => {
    const o = newOrder();
    expect(() => o.markFilled({ filledQuantity: 1, filledPriceAvg: 1, currency: "USD", filledAt: "x", realizedCost: { spread: 0, fxFee: 0, stampDuty: 0, platformFee: 0, total: 0 } })).toThrow(/PENDING/);
    expect(() => o.markSubmitted("b", "t")).not.toThrow();
    expect(() => o.markSubmitted("b2", "t2")).toThrow(/SUBMITTED/);
    o.markRejected("no");
    expect(() => o.markFilled({ filledQuantity: 1, filledPriceAvg: 1, currency: "USD", filledAt: "x", realizedCost: { spread: 0, fxFee: 0, stampDuty: 0, platformFee: 0, total: 0 } })).toThrow(/REJECTED/);
  });
});
