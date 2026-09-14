import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { buildAnalysts, MultiRoleLlmAnalyst } from "../../src/application/services/analysts.js";
import { MarketAnalysisService } from "../../src/application/services/market-analysis.js";
import { NullLogger } from "../../src/shared/logger.js";
import { FixedClock } from "../../src/shared/clock.js";
import { InMemoryEventBus } from "../../src/shared/events.js";
import type { Analyst, AnalystContext, AppPorts, LlmChatOptions, LlmPort } from "../../src/application/ports.js";
import type { AnalysisReport } from "../../src/domain/analysis.js";

const ROLES = ["market", "sentiment", "news", "fundamentals"] as const;

/** One role's plausible multi-role payload. */
function roleOutput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conclusion: "bullish",
    confidence: 0.7,
    rationale: "The evidence in this role's inputs points upward for the coming sessions.",
    targetWeightAdjustment: 0.1,
    adjustmentConfidence: 0.6,
    ...over,
  };
}

/** LLM stub: `payload` is what the model answers, or a list of answers per call. */
class MultiLlm implements LlmPort {
  calls = 0;
  userPrompts: string[] = [];
  constructor(private readonly answers: Record<string, unknown>[]) {}
  available(): boolean {
    return true;
  }
  async chat(): Promise<string> {
    return "";
  }
  async chatJson<T>(_opts: LlmChatOptions, _schema: ZodType<T>): Promise<T> {
    throw new Error("single-role path must not be used when chatJsonMulti exists");
  }
  async chatJsonMulti<K extends string>(opts: LlmChatOptions, schemas: Record<K, ZodType<unknown>>): Promise<Partial<Record<K, unknown>>> {
    this.calls++;
    this.userPrompts.push(opts.user);
    const answer = this.answers[Math.min(this.calls - 1, this.answers.length - 1)]!;
    const out: Partial<Record<K, unknown>> = {};
    for (const key of Object.keys(schemas) as K[]) {
      const value = (answer as Record<string, unknown>)[key];
      if (value === undefined) continue;
      const parsed = schemas[key]!.safeParse(value);
      if (parsed.success) out[key] = parsed.data;
    }
    return out;
  }
}

function context(ticker = "MSFT"): AnalystContext {
  return {
    ticker,
    snapshot: { ticker, price: 420, currency: "USD", prevClose: 415, changePct: 1.2, volume: 1_000_000, asOf: "t" },
    candles: [],
    news: [{ id: "n1", ticker, headline: `${ticker} beats expectations`, source: "s", url: null, publishedAt: "t", summary: null }],
    fundamentals: {
      ticker,
      currency: "USD",
      pe: 30,
      pb: 10,
      eps: 14,
      revenueGrowthPct: 12,
      profitMarginPct: 30,
      debtToEquity: 0.5,
      dividendYieldPct: 0.8,
      marketCap: 3_000_000,
      sector: "Technology",
      asOf: "t",
      details: {},
    },
    sentiment: { ticker, score: 0.4, label: "positive", source: "test", details: {} },
    benchmarkSnapshot: { ticker: "SPY", price: 600, currency: "USD", prevClose: 598, changePct: 0.3, volume: null, asOf: "t" },
    macro: null,
  };
}

describe("MultiRoleLlmAnalyst (WP-P1.2)", () => {
  it("returns all four roles from a single call", async () => {
    const llm = new MultiLlm([
      { market: roleOutput(), sentiment: roleOutput({ conclusion: "neutral" }), news: roleOutput(), fundamentals: roleOutput({ conclusion: "bearish" }) },
    ]);
    const analyst = new MultiRoleLlmAnalyst({ llm, logger: new NullLogger() });
    const reports = await analyst.analyzeBatch("run1", context(), "t");

    expect(llm.calls).toBe(1);
    expect(reports.map((r) => r.analyst)).toEqual([...ROLES]);
    expect(reports.map((r) => r.conclusion)).toEqual(["bullish", "neutral", "bullish", "bearish"]);
    // Every report carries the LLM engine marker and the raw output for audit.
    for (const report of reports) {
      expect(report.details.engine).toBe("llm");
      expect(report.details.call).toBe("multi");
      expect(report.signals.targetWeightAdjustment).toBeCloseTo(0.1, 4);
    }
    // One prompt, carrying the ticker's data once.
    expect(llm.userPrompts[0]).toContain("MSFT");
    expect(llm.userPrompts[0]).toContain("Technology");
  });

  it("falls back per role when a key is missing or invalid, keeping the others", async () => {
    const llm = new MultiLlm([
      {
        market: roleOutput(),
        sentiment: { conclusion: "sideways", confidence: 2 }, // invalid: bad enum + out-of-range
        // news missing entirely
        fundamentals: roleOutput({ targetWeightAdjustment: -1 }), // valid for the schema, clamped for the portfolio
      },
    ]);
    const analyst = new MultiRoleLlmAnalyst({ llm, logger: new NullLogger() });
    const reports = await analyst.analyzeBatch("run1", context(), "t");

    expect(llm.calls).toBe(1); // the client's repair retry lives inside chatJsonMulti, not here
    expect(reports.map((r) => r.analyst)).toEqual([...ROLES]);
    expect(reports.find((r) => r.analyst === "market")?.details.engine).toBe("llm");
    // sentiment and news came from the offline rule sets instead.
    expect(reports.find((r) => r.analyst === "sentiment")?.details.engine).toBe("offline");
    expect(reports.find((r) => r.analyst === "news")?.details.engine).toBe("offline");
    // An adjustment at the schema edge is accepted and clamped to the portfolio
    // limit, not rejected.
    const fundamentals = reports.find((r) => r.analyst === "fundamentals")!;
    expect(fundamentals.details.engine).toBe("llm");
    expect(fundamentals.signals.targetWeightAdjustment).toBe(-0.5);
  });

  it("is what buildAnalysts wires when a key is present, and the service still produces 4 reports per ticker", async () => {
    const llm = new MultiLlm([{ market: roleOutput(), sentiment: roleOutput(), news: roleOutput(), fundamentals: roleOutput() }]);
    const ports = {
      clock: new FixedClock(new Date("2026-08-26T14:00:00Z")),
      logger: new NullLogger(),
      events: new InMemoryEventBus(),
      llm,
      prices: {
        quote: async (ticker: string) => ({ ticker, price: 100, currency: "USD", prevClose: 99, changePct: 1, volume: null, asOf: "t" }),
        candles: async () => [],
      },
      news: { latestNews: async () => [] },
      fundamentals: { fundamentals: async () => { throw new Error("n/a"); } },
      sentiment: { sentiment: async (ticker: string) => ({ ticker, score: 0.1, label: "neutral", source: "test", details: {} }) },
      macro: null,
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

    const analysts: Analyst[] = buildAnalysts(ports);
    expect(analysts).toHaveLength(1);
    expect(analysts[0]).toBeInstanceOf(MultiRoleLlmAnalyst);

    const service = new MarketAnalysisService(ports, analysts);
    const reports: AnalysisReport[] = await service.analyze("run1", ["MSFT", "AAPL", "NVDA"], "SPY");
    // 3 tickers → 3 calls (one each), 12 reports.
    expect(llm.calls).toBe(3);
    expect(reports).toHaveLength(12);
    expect(new Set(reports.map((r) => r.ticker))).toEqual(new Set(["MSFT", "AAPL", "NVDA"]));
  });
});
