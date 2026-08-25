import { describe, expect, it } from "vitest";
import { PaperBroker } from "../../src/adapters/broker/paper-broker.js";
import { DemoFxAdapter } from "../../src/adapters/marketdata/demo.js";
import type { MarketSnapshot } from "../../src/domain/analysis.js";

/** Fixed-price quote stub: MSFT 400 USD, VUSA.L 100 GBP. */
const prices = {
  quote: async (ticker: string): Promise<MarketSnapshot> => ({
    ticker,
    price: ticker === "MSFT" ? 400 : 100,
    currency: ticker.endsWith(".L") ? "GBP" : "USD",
    prevClose: null,
    changePct: null,
    volume: null,
    asOf: "2026-08-26T14:00:00Z",
  }),
};

function broker(over: Partial<ConstructorParameters<typeof PaperBroker>[0]> = {}) {
  return new PaperBroker({
    currency: "GBP",
    initialCash: 10_000,
    initialPositions: [{ ticker: "MSFT", quantity: 2, averagePrice: 400 }],
    fx: new DemoFxAdapter(),
    prices,
    spreadBps: 2,
    fxFeePct: 0.0015,
    ...over,
  });
}

describe("PaperBroker", () => {
  it("reports the account in account currency", async () => {
    const b = broker();
    const account = await b.account();
    expect(account.currency).toBe("GBP");
    expect(account.cash).toBe(10_000);
  });

  it("fills a buy with spread and FX fee applied to the cash ledger", async () => {
    const b = broker();
    // MSFT lastPrice = 400 (seed). Buy 1 share: gross 400 USD → 316 GBP at 0.79.
    const res = await b.submitOrder({ ticker: "MSFT", side: "BUY", quantity: 1, type: "MARKET" });
    expect(res.status).toBe("FILLED");
    const account = await b.account();
    const halfSpread = 2 / 2 / 10_000;
    const expectedCost = 400 * 0.79 * (1 + halfSpread) * (1 + 0.0015);
    expect(account.cash).toBeCloseTo(10_000 - expectedCost, 2);
    const positions = await b.positions();
    expect(positions.find((p) => p.ticker === "MSFT")?.quantity).toBe(3);
    expect(positions.find((p) => p.ticker === "MSFT")?.averagePrice).toBeCloseTo(400, 4);
  });

  it("credits sells net of spread and FX fee", async () => {
    const b = broker();
    const buy = await b.submitOrder({ ticker: "MSFT", side: "BUY", quantity: 1, type: "MARKET" });
    expect(buy.status).toBe("FILLED");
    const before = (await b.account()).cash;
    const sell = await b.submitOrder({ ticker: "MSFT", side: "SELL", quantity: 1, type: "MARKET" });
    expect(sell.status).toBe("FILLED");
    const after = (await b.account()).cash;
    expect(after).toBeGreaterThan(before); // round trip loses spread + fx
    expect((await b.positions()).find((p) => p.ticker === "MSFT")?.quantity).toBe(2);
  });

  it("rejects buys beyond cash and sells beyond holdings", async () => {
    const b = broker();
    await expect(
      b.submitOrder({ ticker: "MSFT", side: "BUY", quantity: 100, type: "MARKET" }),
    ).rejects.toThrow(/insufficient cash/);
    await expect(
      b.submitOrder({ ticker: "MSFT", side: "SELL", quantity: 10, type: "MARKET" }),
    ).rejects.toThrow(/insufficient MSFT/);
  });

  it("does not charge the FX fee on same-currency instruments", async () => {
    const b = broker({ currency: "GBP" });
    await b.submitOrder({ ticker: "VUSA.L", side: "BUY", quantity: 1, type: "MARKET" });
    const account = await b.account();
    // VUSA.L seed price 100 (no initial position → currencyGuess GBP, fillPrice fallback 100).
    const halfSpread = 2 / 2 / 10_000;
    expect(account.cash).toBeCloseTo(10_000 - 100 * (1 + halfSpread), 2);
  });

  it("tracks order status for submitted orders", async () => {
    const b = broker();
    const res = await b.submitOrder({ ticker: "MSFT", side: "BUY", quantity: 1, type: "MARKET" });
    const status = await b.orderStatus(res.brokerOrderId);
    expect(status.status).toBe("FILLED");
    expect(status.filledQuantity).toBe(1);
  });
});
