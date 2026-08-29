import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/adapters/persistence/sqlite.js";
import {
  SqliteAnalysisRepository,
  SqliteDecisionRepository,
  SqliteEventRepository,
  SqliteOrderRepository,
  SqlitePortfolioRepository,
  SqliteRunRepository,
  SqliteSettingsRepository,
} from "../../src/adapters/persistence/repositories.js";
import { SqliteAllocationTargetRepository } from "../../src/adapters/persistence/allocation-targets.js";
import { SqliteCommitteeRepository } from "../../src/adapters/persistence/committee.js";
import { InMemoryEventBus } from "../../src/shared/events.js";
import { FixedClock } from "../../src/shared/clock.js";
import { NullLogger } from "../../src/shared/logger.js";
import { AnalysisReport } from "../../src/domain/analysis.js";
import { DecisionEngine, type CostModel, type RiskLimits } from "../../src/domain/decision.js";
import { buildPortfolioSnapshot } from "../../src/domain/portfolio.js";
import type { AppPorts, LlmChatOptions, LlmPort } from "../../src/application/ports.js";
import { DecisionService } from "../../src/application/services/decisions.js";
import { CommitteeService, type CommitteeConfig, type CommitteeRunContext } from "../../src/application/services/committee.js";

const AGENTS = [
  { id: "a1", name: "Macro Strategist", provider: "openrouter", model: "anthropic/claude-3.5-haiku" },
  { id: "a2", name: "Momentum Trader", provider: "openrouter", model: "openai/gpt-4o-mini" },
  { id: "a3", name: "Value Investor", provider: "openrouter", model: "deepseek/deepseek-chat" },
  { id: "a4", name: "Risk Parity Manager", provider: "openrouter", model: "meta-llama/llama-3.1-8b-instruct" },
];

const CFG: CommitteeConfig = {
  enabled: true,
  maxVoteRounds: 3,
  agents: AGENTS,
  maxTarget: 0.25,
  minCashBuffer: 0.05,
};

/**
 * Scripted per-agent LLM. The vote prompt lists the votable proposals as
 * "- <id> — ..." lines; the fake returns a single choice over those ids
 * computed by `voteFn(ids, round)` — the ids are the OTHER agents' proposals,
 * in creation order (a1, a2, a3, a4).
 */
class ScriptedLlm implements LlmPort {
  constructor(
    private readonly propose: unknown,
    private readonly feedbackVerdict: "positive" | "negative",
    private readonly voteFn: (ids: string[], round: number) => string,
    private readonly feedbackComment = "scripted review comment",
  ) {}

  available(): boolean {
    return true;
  }
  async chat(_opts: LlmChatOptions): Promise<string> {
    return "";
  }
  async chatJson<T>(opts: LlmChatOptions): Promise<T> {
    const sys = opts.system;
    if (sys.includes("propose YOUR target asset allocation")) return this.propose as T;
    if (sys.includes("Review it critically")) {
      return { verdict: this.feedbackVerdict, comment: this.feedbackComment } as T;
    }
    if (sys.includes("vote for exactly ONE proposal")) {
      const round = Number(/vote round (\d+)/.exec(sys)?.[1] ?? "1");
      const ids = [...sys.matchAll(/^- (\S+) — /gm)].map((m) => m[1]!);
      return { choice: this.voteFn(ids, round) } as T;
    }
    throw new Error(`unexpected prompt: ${sys.slice(0, 80)}`);
  }
}

const PROPOSALS: Record<string, unknown> = {
  a1: {
    title: "Defensive tilt",
    rationale: "Macro risks argue for defensiveness; keep cash and trim the biggest names gradually.",
    confidence: 0.8,
    targets: [{ ticker: "MSFT", weight: 0.3 }],
    orders: [{ ticker: "AAPL", side: "BUY", value: 250, reason: "add to the diversified core" }],
  },
  a2: {
    title: "Growth momentum",
    rationale: "Momentum favors adding to winners; add to AAPL and trim the stretched MSFT weight.",
    confidence: 0.85,
    targets: [{ ticker: "MSFT", weight: 0.25 }],
    orders: [],
  },
  a3: {
    title: "Value concentration",
    rationale: "Concentrate on the cheapest quality name and wait for better entry points elsewhere.",
    confidence: 0.7,
    targets: [{ ticker: "AAPL", weight: 0.35 }],
    orders: [],
  },
  a4: {
    title: "Risk parity rebalance",
    rationale: "Balance risk contributions across the two names and hold a larger cash cushion.",
    confidence: 0.75,
    targets: [{ ticker: "AAPL", weight: 0.25 }],
    orders: [],
  },
};

function makePorts(db: ReturnType<typeof openDatabase>): { ports: AppPorts; published: { type: string }[] } {
  const clock = new FixedClock(new Date("2026-08-26T14:00:00Z"));
  const bus = new InMemoryEventBus();
  const eventRepo = new SqliteEventRepository(db);
  const published: { type: string }[] = [];
  bus.subscribe((e) => {
    published.push(e as { type: string });
    void eventRepo.append([e]);
  });
  const empty = async () => undefined;
  const ports: AppPorts = {
    clock,
    logger: new NullLogger(),
    events: bus,
    calendar: { isOpen: () => true },
    llm: { available: () => false, chat: async () => "", chatJson: async <T,>(): Promise<T> => ({}) as T },
    prices: { quote: async (t: string) => ({ ticker: t, price: t === "AAPL" ? 190 : 420, currency: "USD", prevClose: null, changePct: null, volume: null, asOf: "x" }), candles: async () => [] },
    news: { latestNews: async () => [] },
    fundamentals: { fundamentals: async () => { throw new Error("n/a"); } },
    sentiment: { sentiment: async () => ({ ticker: "X", score: 0, label: "neutral", source: "x", details: {} }) },
    macro: null,
    fx: { rate: async () => 0.79 },
    broker: {
      kind: "paper",
      account: async () => ({ currency: "GBP", cash: 5000, totalValue: 5663.6, investedValue: 663.6 }),
      positions: async () => [{ ticker: "MSFT", quantity: 2, averagePrice: 400, currentPrice: 420, currency: "USD" }],
      submitOrder: async (req: { ticker: string }) => ({ brokerOrderId: `broker-${req.ticker}`, status: "FILLED" }),
      orderStatus: async () => ({ status: "FILLED", filledQuantity: 1, filledPriceAvg: 150 }),
    },
    runs: new SqliteRunRepository(db),
    analysis: new SqliteAnalysisRepository(db),
    portfolio: new SqlitePortfolioRepository(db),
    decisions: new SqliteDecisionRepository(db),
    orders: new SqliteOrderRepository(db),
    eventRepo,
    marketData: { saveSnapshots: empty, saveNews: empty, saveSentiment: empty, saveMacro: empty, snapshotsByTicker: async () => [], latestNews: async () => [], latestSentiment: async () => [], latestMacro: async () => [] },
    allocationTargets: new SqliteAllocationTargetRepository(db),
    settings: new SqliteSettingsRepository(db),
    committee: new SqliteCommitteeRepository(db),
  };
  return { ports, published };
}

const COSTS: CostModel = { spreadBps: 2, fxFeePct: 0.0015, stampDutyPct: 0.005, platformFeePct: 0 };
const RISK: RiskLimits = {
  maxOrderValue: 2000,
  maxHeatPct: 0.6,
  minExpectedBenefitPct: 0.0001,
  costBenefitMultiplier: 1.0,
  maxOrdersPerRun: 3,
  tickerCooldownDays: 0,
  minConfidence: 0.15,
};

function ctx(): CommitteeRunContext {
  const snapshot = buildPortfolioSnapshot({
    id: "snap1",
    runId: "run1",
    asOf: "2026-08-26T14:00:00Z",
    currency: "GBP",
    cash: 5000,
    positions: [{ ticker: "MSFT", quantity: 2, averagePrice: 400, currentPrice: 420, currency: "USD", fxRate: 0.79 }],
    prevTotalValue: null,
    benchmarkChangePct: null,
  });
  const reports = [
    new AnalysisReport("r1", "run1", "MSFT", "market", "bullish", 0.7, "uptrend", { targetWeightAdjustment: 0.1, confidence: 0.7 }, "t", {}),
    new AnalysisReport("r2", "run1", "AAPL", "fundamentals", "bullish", 0.6, "cheap", { targetWeightAdjustment: 0.08, confidence: 0.6 }, "t", {}),
  ];
  return {
    snapshot,
    drift: [
      { ticker: "MSFT", targetWeight: 0.4, currentWeight: 0.1171, drift: -0.2829, insideBand: false, hint: "buy" },
      { ticker: "AAPL", targetWeight: 0.3, currentWeight: 0, drift: -0.3, insideBand: false, hint: "buy" },
    ],
    heat: 0.1,
    reports,
    targets: [
      { ticker: "MSFT", weight: 0.4 },
      { ticker: "AAPL", weight: 0.3 },
    ],
  };
}

function build(db = openDatabase(":memory:")) {
  const { ports, published } = makePorts(db);
  const engine = new DecisionEngine(COSTS, RISK);
  const decisions = new DecisionService(ports, engine, {
    signalThreshold: 0.05,
    minTradeValue: 10,
    expectedReturnPerTradePct: 0.5,
    tickerCooldownDays: 0,
  });
  return { ports, published, engine, decisions };
}

/**
 * Vote scenario (4 agents, one vote each per round):
 * Round 1 → a1 votes p2, a2 votes p1, a3 votes p1, a4 votes p2 ⇒
 * p1=2, p2=2, p3=0, p4=0: tie at the top → the two lowest-scoring proposals
 * (p3, p4) are excluded. Round 2 (active p1,p2) → a1 votes p2, a2 votes p1,
 * a3 votes p1, a4 votes p1 ⇒ p1 +3, p2 +1 → cumulative p1=5, p2=3 →
 * p1 (Macro Strategist) wins.
 */
function voteFns(): Record<string, (ids: string[], round: number) => string> {
  return {
    // others (creation order): a1→[A2,A3,A4], a2→[A1,A3,A4], a3→[A1,A2,A4], a4→[A1,A2,A3]
    a1: (ids) => ids[0]!, // A2
    a2: (ids) => ids[0]!, // A1
    a3: (ids) => ids[0]!, // A1
    a4: (ids, round) => (round === 1 ? ids[1]! : ids[0]!), // A2 (round 1), A1 (round 2)
  };
}

describe("CommitteeService — full session", () => {
  it("proposes → reviews → votes with a tie run-off → applies the winner (targets + gated order)", async () => {
    const { ports, published, decisions } = build();
    const fns = voteFns();
    const llms = new Map<string, LlmPort>();
    for (const agent of AGENTS) {
      llms.set(agent.id, new ScriptedLlm(PROPOSALS[agent.id], agent.id === "a2" ? "negative" : "positive", fns[agent.id]!));
    }
    const svc = new CommitteeService(ports, llms, CFG, decisions);

    const outcome = await svc.runSession("run1", ctx());
    await new Promise((r) => setTimeout(r, 0)); // flush event persistence chain

    expect(outcome.session.status).toBe("COMPLETED");
    expect(outcome.session.round).toBe(2);
    const detail = await ports.committee.detail(outcome.session.id);
    expect(detail.proposals).toHaveLength(4);

    // Round 1: tie at the top → the two lowest-scoring proposals excluded.
    const excluded = detail.proposals.filter((p) => p.status === "excluded");
    expect(excluded.map((p) => p.agentId).sort()).toEqual(["a3", "a4"]);
    for (const p of excluded) {
      expect(p.excludedRound).toBe(1);
      expect(p.points).toBe(0);
    }

    // Round 2: the run-off winner.
    const winner = detail.proposals.find((p) => p.status === "accepted")!;
    expect(winner.agentId).toBe("a1");
    expect(winner.points).toBe(5);
    expect(outcome.session.winnerProposalId).toBe(winner.id);
    const defeated = detail.proposals.find((p) => p.status === "defeated")!;
    expect(defeated.agentId).toBe("a2");
    expect(defeated.points).toBe(3);

    // Feedback: every agent reviewed every other proposal (4 × 3).
    expect(detail.feedback).toHaveLength(12);
    for (const p of detail.proposals) {
      expect(detail.feedback.filter((f) => f.proposalId === p.id)).toHaveLength(3);
    }

    // Votes: one vote per agent per round (4 voters × 2 rounds).
    expect(detail.votes.filter((v) => v.round === 1)).toHaveLength(4);
    expect(detail.votes.filter((v) => v.round === 2)).toHaveLength(4);

    // The winner's allocation was applied with the review guardrails: the
    // proposed MSFT 0.3 is clamped to the per-name cap (maxTarget 0.25);
    // AAPL (not mentioned by the winner) keeps its current target — only
    // changed tickers are persisted.
    const targets = await ports.allocationTargets.current();
    expect(targets.find((t) => t.ticker === "MSFT")?.weight).toBeCloseTo(0.25, 4);
    expect(targets.find((t) => t.ticker === "AAPL")).toBeUndefined();

    // The winner's order went through the economic gate and was approved.
    expect(outcome.decisions).toHaveLength(1);
    const decision = outcome.decisions[0]!;
    expect(decision.ticker).toBe("AAPL");
    expect(decision.action).toBe("BUY");
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe("ECONOMICALLY_VIABLE");
    expect(decision.details.source).toBe("committee");
    expect(decision.details.agentId).toBe("a1");
    expect(decision.details.points).toBe(5);
    expect(decision.proposal.rationale).toContain("Macro Strategist");

    // Events recorded the whole flow.
    const types = published.map((e) => e.type);
    for (const t of [
      "CommitteeSessionStarted",
      "CommitteeProposalsReady",
      "CommitteeFeedbackCompleted",
      "CommitteeVoteRoundCompleted",
      "CommitteeProposalExcluded",
      "CommitteeWinnerAccepted",
      "CommitteeSessionCompleted",
    ]) {
      expect(types).toContain(t);
    }
  });

  it("fails the session (without trades or target changes) when an agent's LLM is unavailable", async () => {
    const { ports, decisions } = build();
    const llms = new Map<string, LlmPort>();
    for (const agent of AGENTS) {
      llms.set(agent.id, {
        available: () => agent.id !== "a2",
        chat: async () => "",
        chatJson: async <T,>(): Promise<T> => ({}) as T,
      });
    }
    const svc = new CommitteeService(ports, llms, CFG, decisions);
    const outcome = await svc.runSession("run1", ctx());

    expect(outcome.session.status).toBe("FAILED");
    expect(outcome.session.error).toContain("a2");
    expect(outcome.decisions).toHaveLength(0);
    expect(await ports.allocationTargets.current()).toHaveLength(0);
  });

  it("persists the enable/disable toggle in settings", async () => {
    const { ports, decisions } = build();
    const llms = new Map<string, LlmPort>();
    const svc = new CommitteeService(ports, llms, CFG, decisions);
    expect(await svc.isEnabled()).toBe(true); // config default
    await svc.setEnabled(false);
    expect(await svc.isEnabled()).toBe(false);
    await svc.setEnabled(true);
    expect(await svc.isEnabled()).toBe(true);
    expect(await ports.settings.get("committee.enabled")).toBe(true);
  });

  it("coerces an invalid vote choice into a valid ballot instead of failing", async () => {
    const { ports, decisions } = build();
    const llms = new Map<string, LlmPort>();
    for (const agent of AGENTS) {
      llms.set(
        agent.id,
        new ScriptedLlm(
          {
            title: `proposal by ${agent.id}`,
            rationale: "A sensible allocation rationale long enough for validation.",
            confidence: 0.8,
            targets: [{ ticker: "MSFT", weight: 0.3 }],
            orders: [],
          },
          "positive",
          () => "bogus-id", // not a valid choice — coerceChoice must salvage it
        ),
      );
    }
    const svc = new CommitteeService(ports, llms, CFG, decisions);
    const outcome = await svc.runSession("run1", ctx());
    expect(outcome.session.status).toBe("COMPLETED");
    const detail = await ports.committee.detail(outcome.session.id);
    expect(detail.proposals.find((p) => p.status === "accepted")).toBeTruthy();
    // Every cast vote landed on a real proposal id (coerced, not rejected).
    const proposalIds = new Set(detail.proposals.map((p) => p.id));
    for (const v of detail.votes) {
      expect(proposalIds.has(v.proposalId)).toBe(true);
      expect(v.points).toBe(1);
    }
  });

  it("truncates oversized agent text instead of failing the session", async () => {
    const { ports, decisions } = build();
    const llms = new Map<string, LlmPort>();
    for (const agent of AGENTS) {
      llms.set(
        agent.id,
        new ScriptedLlm(
          {
            title: "T".repeat(500), // 500-char title — truncated, not rejected
            rationale: "R".repeat(5000), // 5000-char rationale
            confidence: 0.8,
            targets: [{ ticker: "MSFT", weight: 0.3 }],
            orders: [{ ticker: "MSFT", side: "BUY", value: 100, reason: "Y".repeat(2000) }],
          },
          "positive",
          (ids) => ids[0]!,
          "C".repeat(5000), // 5000-char feedback comment
        ),
      );
    }
    const svc = new CommitteeService(ports, llms, CFG, decisions);
    const outcome = await svc.runSession("run1", ctx());
    expect(outcome.session.status).toBe("COMPLETED");
    const detail = await ports.committee.detail(outcome.session.id);
    for (const p of detail.proposals) {
      expect(p.title.length).toBeLessThanOrEqual(140);
      expect(p.rationale.length).toBeLessThanOrEqual(3000);
      for (const o of p.orders) expect(o.reason.length).toBeLessThanOrEqual(600);
    }
    for (const f of detail.feedback) {
      expect(f.comment.length).toBeLessThanOrEqual(1200);
    }
  });
});
