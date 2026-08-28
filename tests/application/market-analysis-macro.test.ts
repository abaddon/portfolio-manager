import { describe, expect, it, vi } from "vitest";
import { MarketAnalysisService } from "../../src/application/services/market-analysis.js";
import type { Analyst, AnalystContext, AppPorts } from "../../src/application/ports.js";
import type { MacroSnapshot } from "../../src/domain/analysis.js";
import { AnalysisReport } from "../../src/domain/analysis.js";
import { FixedClock } from "../../src/shared/clock.js";
import { NullLogger } from "../../src/shared/logger.js";
import { InMemoryEventBus } from "../../src/shared/events.js";

const MACRO: MacroSnapshot = {
  asOf: "2026-08-26T14:05:00Z",
  fedFundsRatePct: 3.63,
  treasury10yPct: 4.1,
  treasury2yPct: 3.9,
  yieldSpread10y2yPct: 0.2,
  vix: 15.5,
  cpiYoYPct: 3.3,
  unemploymentPct: 4.2,
  sp500: 6400.5,
};

/** Analyst that captures the context it was given (macro included). */
class CapturingAnalyst implements Analyst {
  readonly kind = "market" as const;
  contexts: AnalystContext[] = [];
  async analyze(runId: string, ctx: AnalystContext, now: string): Promise<AnalysisReport> {
    this.contexts.push(ctx);
    return new AnalysisReport(
      `an-${this.contexts.length}`,
      runId,
      ctx.ticker,
      this.kind,
      "neutral",
      0.5,
      "captured context for test assertions",
      { targetWeightAdjustment: 0, confidence: 0.5 },
      now,
      {},
    );
  }
}

function makePorts(overrides: Partial<AppPorts> & { macroCalls?: () => Promise<MacroSnapshot> }) {
  const saveMacro = vi.fn(async (_: { id: string; runId: string; snapshot: MacroSnapshot }) => {});
  const analyst = new CapturingAnalyst();
  const ports: AppPorts = {
    clock: new FixedClock(new Date("2026-08-26T14:00:00Z")),
    logger: new NullLogger(),
    events: new InMemoryEventBus(),
    calendar: { isOpen: () => true },
    llm: { available: () => false, chat: async () => "", chatJson: async <T,>(): Promise<T> => ({}) as T },
    prices: {
      quote: async (ticker: string) => ({
        ticker,
        price: ticker === "SPY" ? 600 : 100,
        currency: "USD",
        prevClose: null,
        changePct: 0.5,
        volume: null,
        asOf: "2026-08-26T14:00:00Z",
      }),
      candles: async () => [],
    },
    news: { latestNews: async () => [] },
    fundamentals: { fundamentals: async () => { throw new Error("n/a"); } },
    sentiment: { sentiment: async () => ({ ticker: "X", score: 0, label: "neutral", source: "x", details: {} }) },
    macro: { macroSnapshot: overrides.macroCalls ?? (async () => MACRO) },
    fx: { rate: async () => 1 },
    broker: { kind: "paper", account: async () => ({ currency: "GBP", cash: 0, totalValue: 0, investedValue: 0 }), positions: async () => [], submitOrder: async () => ({ brokerOrderId: "x", status: "SUBMITTED" }), orderStatus: async () => ({ status: "NEW", filledQuantity: 0, filledPriceAvg: null }) },
    runs: { save: async () => {}, get: async () => null, latest: async () => [], findSameHour: async () => null },
    analysis: { save: async () => {}, saveMany: async () => {}, byRun: async () => [], latestByTicker: async () => [] },
    portfolio: { save: async () => {}, latest: async () => null, history: async () => [], saveNav: async () => {}, latestNav: async () => null },
    decisions: { save: async () => {}, byRun: async () => [], latest: async () => [] },
    orders: { save: async () => {}, get: async () => null, byRun: async () => [], latest: async () => [], recentByTicker: async () => [], openOrders: async () => [], stalePending: async () => [] },
    eventRepo: { append: async () => {}, byRun: async () => [], recent: async () => [] },
    marketData: {
      saveSnapshots: async () => {},
      saveNews: async () => {},
      saveSentiment: async () => {},
      saveMacro,
      snapshotsByTicker: async () => [],
      latestNews: async () => [],
      latestSentiment: async () => [],
      latestMacro: async () => [],
    },
    allocationTargets: { saveUpdates: async () => {}, current: async () => [], recentUpdates: async () => [] },
    settings: { get: async () => null, set: async () => {} },
    committee: {
      saveSession: async () => {},
      saveProposals: async () => {},
      saveFeedback: async () => {},
      saveVotes: async () => {},
      latestSession: async () => null,
      detail: async () => ({
        session: { id: "x", runId: "r", status: "COMPLETED", round: 0, winnerProposalId: null, error: null, createdAt: "t", completedAt: "t", details: {} },
        proposals: [],
        feedback: [],
        votes: [],
      }),
      byRun: async () => [],
    },
    ...overrides,
  } as AppPorts;
  return { ports, saveMacro, analyst };
}

describe("MarketAnalysisService — FRED macro input", () => {
  it("fetches the macro snapshot once, persists it, and passes it to every analyst", async () => {
    const macroCalls = vi.fn(async () => MACRO);
    const { ports, saveMacro, analyst } = makePorts({ macroCalls });
    const svc = new MarketAnalysisService(ports, [analyst]);

    const reports = await svc.analyze("run1", ["MSFT", "AAPL"], "SPY");

    expect(macroCalls).toHaveBeenCalledTimes(1); // once per run, not per ticker
    expect(reports).toHaveLength(2);
    expect(saveMacro).toHaveBeenCalledTimes(1);
    expect(saveMacro.mock.calls[0]![0].snapshot).toEqual(MACRO);
    expect(analyst.contexts).toHaveLength(2);
    for (const ctx of analyst.contexts) {
      expect(ctx.macro).toEqual(MACRO);
    }
  });

  it("contains a failing FRED feed: the run proceeds with macro=null and nothing persisted", async () => {
    const macroCalls = vi.fn(async () => {
      throw new Error("fred down");
    });
    const { ports, saveMacro, analyst } = makePorts({ macroCalls });
    const svc = new MarketAnalysisService(ports, [analyst]);

    const reports = await svc.analyze("run1", ["MSFT"], "SPY");

    expect(reports).toHaveLength(1); // analysis still completes
    expect(saveMacro).not.toHaveBeenCalled();
    expect(analyst.contexts[0]!.macro).toBeNull();
  });

  it("leaves macro null when no macro port is wired", async () => {
    const { ports, saveMacro, analyst } = makePorts({});
    ports.macro = null;
    const svc = new MarketAnalysisService(ports, [analyst]);

    await svc.analyze("run1", ["MSFT"], "SPY");

    expect(saveMacro).not.toHaveBeenCalled();
    expect(analyst.contexts[0]!.macro).toBeNull();
  });
});
