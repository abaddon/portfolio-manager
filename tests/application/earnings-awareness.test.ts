import { describe, expect, it } from "vitest";
import { MarketAnalysisService } from "../../src/application/services/market-analysis.js";
import { MultiRoleLlmAnalyst } from "../../src/application/services/analysts.js";
import { FixedClock } from "../../src/shared/clock.js";
import { NullLogger } from "../../src/shared/logger.js";
import { InMemoryEventBus } from "../../src/shared/events.js";
import type { Analyst, AnalystContext, AppPorts, EarningsEvent, EventCalendarPort } from "../../src/application/ports.js";
import type { AnalysisReport } from "../../src/domain/analysis.js";

class CapturingAnalyst implements Analyst {
  readonly kind = "market" as const;
  contexts: AnalystContext[] = [];
  async analyze(runId: string, ctx: AnalystContext, now: string): Promise<AnalysisReport> {
    this.contexts.push(ctx);
    return {
      id: `an-${this.contexts.length}`,
      runId,
      ticker: ctx.ticker,
      analyst: this.kind,
      conclusion: "neutral",
      confidence: 0.5,
      rationale: "captured",
      signals: { targetWeightAdjustment: 0, confidence: 0 },
      createdAt: now,
      details: {},
    } as unknown as AnalysisReport;
  }
}

function harness(calendar: EventCalendarPort | null) {
  const clock = new FixedClock(new Date("2026-09-14T14:00:00Z"));
  const warnings: string[] = [];
  const ports = {
    clock,
    logger: { debug: () => {}, info: () => {}, warn: (m: string) => warnings.push(m), error: () => {} },
    events: new InMemoryEventBus(),
    llm: { available: () => false, chat: async () => "", chatJson: async <T,>(): Promise<T> => ({}) as T },
    prices: {
      quote: async (ticker: string) => ({ ticker, price: 100, currency: "USD", prevClose: 99, changePct: 1, volume: null, asOf: "t" }),
      candles: async () => [],
    },
    news: { latestNews: async () => [] },
    fundamentals: { fundamentals: async () => { throw new Error("n/a"); } },
    sentiment: { sentiment: async (ticker: string) => ({ ticker, score: 0, label: "neutral", source: "t", details: {} }) },
    macro: null,
    eventCalendar: calendar,
    analysis: { save: async () => {}, saveMany: async () => {}, byRun: async () => [], latestByTicker: async () => [] },
    marketData: {
      saveSnapshots: async () => {},
      saveNews: async () => {},
      saveSentiment: async () => {},
      saveMacro: async () => {},
      snapshotsByTicker: async () => [],
      latestNews: async () => [],
      latestSentiment: async () => [],
      latestMacro: async () => [],
    },
  } as unknown as AppPorts;
  return { ports, warnings, clock };
}

describe("earnings awareness (WP-P2.3)", () => {
  it("puts days-to-earnings in every analyst's context from ONE calendar call per run", async () => {
    let calls = 0;
    // The provider filters by the requested horizon (Finnhub does this server
    // side); the service only converts dates into day counts.
    const calendar: EventCalendarPort = {
      upcomingEarnings: async (tickers, withinDays) => {
        calls++;
        expect(tickers).toEqual(["MSFT", "AAPL"]);
        const events: EarningsEvent[] = [
          { ticker: "MSFT", date: "2026-09-17", hour: "amc", epsEstimate: 3.2 }, // 3 days out
          { ticker: "AAPL", date: "2026-09-30", hour: "bmo", epsEstimate: null }, // 16 days out
        ];
        // The provider filters by the requested horizon (Finnhub server-side);
        // this fake honours the parameter so the service only converts dates.
        const horizon = Date.now() + withinDays * 86_400_000;
        return events.filter((e) => new Date(`${e.date}T12:00:00Z`).getTime() <= horizon + 86_400_000);
      },
    };
    const { ports } = harness(calendar);
    const analyst = new CapturingAnalyst();
    await new MarketAnalysisService(ports, [analyst]).analyze("run1", ["MSFT", "AAPL"], "SPY");

    expect(calls).toBe(1);
    expect(analyst.contexts.map((c) => [c.ticker, c.daysToEarnings])).toEqual([
      ["MSFT", 3],
      ["AAPL", 16],
    ]);
    // A ticker with no scheduled report in the window is null, not zero.
    expect(analyst.contexts.every((c) => typeof c.daysToEarnings === "number" || c.daysToEarnings === null)).toBe(true);
  });

  it("contains a failing calendar: analysts run without event awareness", async () => {
    const calendar: EventCalendarPort = {
      upcomingEarnings: async () => {
        throw new Error("finnhub 429");
      },
    };
    const { ports, warnings } = harness(calendar);
    const analyst = new CapturingAnalyst();
    await new MarketAnalysisService(ports, [analyst]).analyze("run1", ["MSFT"], "SPY");
    expect(analyst.contexts[0]!.daysToEarnings).toBeNull();
    expect(warnings.some((w) => w.includes("earnings calendar unavailable"))).toBe(true);
  });

  it("works with no calendar configured at all", async () => {
    const { ports } = harness(null);
    const analyst = new CapturingAnalyst();
    await new MarketAnalysisService(ports, [analyst]).analyze("run1", ["MSFT"], "SPY");
    expect(analyst.contexts[0]!.daysToEarnings).toBeNull();
  });

  it("tells the analyst roles about the print in their prompt", async () => {
    const prompts: string[] = [];
    const llm = {
      available: () => true,
      chat: async () => "",
      chatJson: async <T,>(): Promise<T> => ({}) as T,
      chatJsonMulti: async <K extends string>(opts: { user: string }): Promise<Partial<Record<K, unknown>>> => {
        prompts.push(opts.user);
        return {} as Partial<Record<K, unknown>>;
      },
    };
    const analyst = new MultiRoleLlmAnalyst({ llm, logger: new NullLogger() });
    const ctx = {
      ticker: "MSFT",
      snapshot: null,
      candles: [],
      news: [],
      fundamentals: null,
      sentiment: null,
      benchmarkSnapshot: null,
      macro: null,
      daysToEarnings: 2,
    } as AnalystContext;
    await analyst.analyzeBatch("run1", ctx, "t");
    // The prompt carries a `### daysToEarnings` section (a bare number, since the
    // context dump JSON-encodes each value) so every role can weigh event risk.
    expect(prompts[0]).toContain("### daysToEarnings");
    expect(prompts[0]).toContain("2");
  });
});
