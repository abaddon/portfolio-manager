import { describe, expect, it, vi } from "vitest";
import { FallbackSentimentPort, NewsSentimentPort, heuristicScore, labelFor } from "../../src/application/services/news-sentiment.js";
import { NullLogger } from "../../src/shared/logger.js";
import { AdapterError } from "../../src/shared/errors.js";
import type { NewsItem } from "../../src/domain/analysis.js";

const NEWS: NewsItem[] = [
  { id: "1", ticker: "AAPL", headline: "AAPL beats expectations and rallies on record iPhone sales", source: "s", url: null, publishedAt: "x", summary: null },
  { id: "2", ticker: "AAPL", headline: "Analysts upgrade AAPL, citing strong growth", source: "s", url: null, publishedAt: "x", summary: null },
];

function llm(available: boolean, score = 0.6): import("../../src/application/ports.js").LlmPort {
  return {
    available: () => available,
    chat: async () => "",
    chatJson: async <T,>(): Promise<T> => ({ score, rationale: "positive product momentum and upgrades" }) as T,
  };
}

describe("NewsSentimentPort", () => {
  it("scores headlines with the LLM when available", async () => {
    const port = new NewsSentimentPort({ latestNews: async () => NEWS }, llm(true), new NullLogger());
    const s = await port.sentiment("AAPL", { news: NEWS });
    expect(s.score).toBeCloseTo(0.6, 6);
    expect(s.label).toBe("very-positive");
    expect(s.source).toBe("news-llm");
    expect(s.details.rationale).toContain("positive");
  });

  it("fetches news when the caller provides none", async () => {
    const newsPort = { latestNews: vi.fn(async () => NEWS) };
    const port = new NewsSentimentPort(newsPort, llm(true), new NullLogger());
    await port.sentiment("AAPL", { news: [] });
    expect(newsPort.latestNews).toHaveBeenCalledWith("AAPL", 10);
  });

  it("falls back to the keyword heuristic without an LLM", async () => {
    const port = new NewsSentimentPort({ latestNews: async () => NEWS }, llm(false), new NullLogger());
    const s = await port.sentiment("AAPL", { news: NEWS });
    expect(s.source).toBe("news-heuristic");
    expect(s.score).toBeGreaterThan(0);

    const negative: NewsItem[] = [
      { id: "3", ticker: "X", headline: "X plunges after cutting guidance and announcing layoffs", source: "s", url: null, publishedAt: "x", summary: null },
      { id: "4", ticker: "X", headline: "Regulators open probe, shares drop", source: "s", url: null, publishedAt: "x", summary: null },
    ];
    const s2 = await port.sentiment("X", { news: negative });
    expect(s2.score).toBeLessThan(0);
  });

  it("throws no-data when there is no news at all", async () => {
    const port = new NewsSentimentPort({ latestNews: async () => [] }, llm(false), new NullLogger());
    await expect(port.sentiment("AAPL", { news: [] })).rejects.toMatchObject({ kind: "no-data" });
  });
});

describe("FallbackSentimentPort", () => {
  it("uses the first source that succeeds", async () => {
    const failing = { sentiment: async () => { throw new AdapterError("plan limitation", "unsupported"); } };
    const working = { sentiment: async () => ({ ticker: "AAPL", score: 0.4, label: "positive" as const, source: "news-llm", details: {} }) };
    const chain = new FallbackSentimentPort([failing, working]);
    const s = await chain.sentiment("AAPL", { news: [] });
    expect(s.score).toBeCloseTo(0.4, 6);
  });

  it("reports when every source fails", async () => {
    const failing = { sentiment: async () => { throw new AdapterError("nope", "no-data"); } };
    await expect(new FallbackSentimentPort([failing]).sentiment("AAPL", { news: [] })).rejects.toThrow(/all sources failed/);
  });
});

describe("helpers", () => {
  it("maps scores to labels", () => {
    expect(labelFor(0.5)).toBe("very-positive");
    expect(labelFor(0.2)).toBe("positive");
    expect(labelFor(0.05)).toBe("neutral");
    expect(labelFor(-0.2)).toBe("negative");
    expect(labelFor(-0.5)).toBe("very-negative");
  });

  it("scores keyword polarity", () => {
    expect(heuristicScore(["strong growth and record gains"])).toBeGreaterThan(0);
    expect(heuristicScore(["losses and layoffs"])).toBeLessThan(0);
    expect(heuristicScore(["the company reported results"])).toBe(0);
  });
});
