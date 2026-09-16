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
import { computeSignalStrength } from "../../src/domain/decision.js";
import { CommitteeService, type CommitteeConfig, type CommitteeRunContext } from "../../src/application/services/committee.js";

const AGENTS = [
  { id: "a1", name: "Macro Strategist", provider: "openrouter", model: "anthropic/claude-3.5-haiku" },
  { id: "a2", name: "Momentum Trader", provider: "openrouter", model: "openai/gpt-4o-mini" },
  { id: "a3", name: "Value Investor", provider: "openrouter", model: "deepseek/deepseek-chat" },
  { id: "a4", name: "Risk Parity Manager", provider: "openrouter", model: "meta-llama/llama-3.1-8b-instruct" },
];

const CFG: CommitteeConfig = {
  maxVoteRounds: 3,
  agents: AGENTS,
  maxTarget: 0.25,
  minCashBuffer: 0.05,
  rebalanceBand: 0.04,
  proposalConfidenceWeight: 0.5,
  // Verbatim application by default: the existing sessions' expectations are
  // about funding semantics, not about the trust region (which has its own tests).
  minPositions: 0,
  sectorCaps: { defaultCap: null, bySector: {} },
  trustRegion: 1,
  trustRegionConfidenceWeight: 0,
  maxTurnoverPctPerSession: 0,
  minWeightChange: 0,
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
  maxOrderValuePct: 0,
  minOrderValue: 10,
  baseEdgePct: 0.02,
  maxEdgePct: 0.02,
  minNetBenefitPct: 0.0005,
  llmCostBenefitMultiplier: 1,
  costBenefitMultiplier: 1.0,
  maxOrdersPerRun: 3,
  tickerCooldownDays: 0,
  minConfidence: 0.15,
};

/** Parses the delimited constraints block out of a propose system prompt. */
function parseConstraints(prompt: string): any {
  const start = prompt.indexOf("<<<CONSTRAINTS");
  const end = prompt.indexOf("CONSTRAINTS>>>");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return JSON.parse(prompt.slice(start + "<<<CONSTRAINTS".length, end));
}

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
    const { ports, published, decisions, engine } = build();
    const fns = voteFns();
    const llms = new Map<string, LlmPort>();
    for (const agent of AGENTS) {
      llms.set(agent.id, new ScriptedLlm(PROPOSALS[agent.id], agent.id === "a2" ? "negative" : "positive", fns[agent.id]!));
    }
    const svc = new CommitteeService(ports, llms, CFG, decisions, engine);

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
    const msft = targets.find((t) => t.ticker === "MSFT")!;
    expect(msft.weight).toBeCloseTo(0.25, 4);
    expect(targets.find((t) => t.ticker === "AAPL")).toBeUndefined();
    // The winner moved the MSFT target but proposed no MSFT order, so the plan
    // is recorded as unfunded rather than silently becoming the allocation
    // (ADR 0013). The gate reason travels with it.
    expect(msft.status).toBe("UNFUNDED");
    expect(msft.unfundedReason).toContain("no funding order");

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
    expect(types).toContain("CommitteeTargetsUnfunded");
  });

  it("fails the session (without trades or target changes) when an agent's LLM is unavailable", async () => {
    const { ports, decisions, engine } = build();
    const llms = new Map<string, LlmPort>();
    for (const agent of AGENTS) {
      llms.set(agent.id, {
        available: () => agent.id !== "a2",
        chat: async () => "",
        chatJson: async <T,>(): Promise<T> => ({}) as T,
      });
    }
    const svc = new CommitteeService(ports, llms, CFG, decisions, engine);
    const outcome = await svc.runSession("run1", ctx());

    expect(outcome.session.status).toBe("FAILED");
    expect(outcome.session.error).toContain("a2");
    expect(outcome.decisions).toHaveLength(0);
    expect(await ports.allocationTargets.current()).toHaveLength(0);
  });

  it("gives every agent the analysts' weight recommendations in its context", async () => {
    const { ports, decisions, engine } = build();
    const captured: string[] = [];
    const llms = new Map<string, LlmPort>();
    for (const agent of AGENTS) {
      const base = new ScriptedLlm(PROPOSALS[agent.id], "positive", (ids) => ids[0]!);
      llms.set(agent.id, {
        available: () => true,
        chat: async () => "",
        chatJson: async <T,>(opts: LlmChatOptions): Promise<T> => {
          captured.push(opts.user);
          return base.chatJson<T>(opts);
        },
      });
    }
    const svc = new CommitteeService(ports, llms, CFG, decisions, engine);
    const outcome = await svc.runSession("run1", ctx());
    expect(outcome.session.status).toBe("COMPLETED");
    // The ctx() reports carry adjustments for MSFT (0.1) and AAPL (0.08).
    const context = captured[0]!;
    expect(context).toContain('"targetWeightAdjustment": 0.1');
    expect(context).toContain('"adjustmentConfidence": 0.6');
  });

  it("marks a target ACTIVE when an approved order funds it, and clears the residual", async () => {
    const { ports, published, decisions, engine } = build();
    const fns = voteFns();
    const llms = new Map<string, LlmPort>();
    // a1 (the winner) moves the MSFT target AND proposes the MSFT order that funds it.
    const funded = {
      ...PROPOSALS.a1!,
      targets: [{ ticker: "MSFT", weight: 0.25 }],
      orders: [{ ticker: "MSFT", side: "BUY" as const, value: 150, reason: "fund the higher MSFT target" }],
    };
    for (const agent of AGENTS) {
      llms.set(agent.id, new ScriptedLlm(agent.id === "a1" ? funded : PROPOSALS[agent.id]!, "positive", fns[agent.id]!));
    }
    const svc = new CommitteeService(ports, llms, CFG, decisions, engine);
    const outcome = await svc.runSession("run1", ctx());
    await new Promise((r) => setTimeout(r, 0));

    expect(outcome.session.status).toBe("COMPLETED");
    const msft = (await ports.allocationTargets.current()).find((t) => t.ticker === "MSFT")!;
    expect(msft.weight).toBeCloseTo(0.25, 4);
    expect(msft.status).toBe("ACTIVE");
    expect(msft.unfundedReason).toContain("funded by BUY");
    // An order was approved for it, and no unfunded event was raised.
    expect(outcome.decisions.find((d) => d.ticker === "MSFT")?.approved).toBe(true);
    expect(published.map((e) => e.type)).not.toContain("CommitteeTargetsUnfunded");
  });

  it("carries an unfunded target to the next session as a residual", async () => {
    const { ports, decisions, engine } = build();
    const fns = voteFns();
    const llms = new Map<string, LlmPort>();
    for (const agent of AGENTS) {
      llms.set(agent.id, new ScriptedLlm(PROPOSALS[agent.id]!, "positive", fns[agent.id]!));
    }
    const svc = new CommitteeService(ports, llms, CFG, decisions, engine);
    // First session: MSFT target moves with no MSFT order → UNFUNDED.
    await svc.runSession("run1", ctx());
    const afterFirst = (await ports.allocationTargets.current()).find((t) => t.ticker === "MSFT")!;
    expect(afterFirst.status).toBe("UNFUNDED");

    // Second session: the context now carries the previous plan's weight and its
    // status, and the agents are told to fund it.
    const captured: string[] = [];
    const llms2 = new Map<string, LlmPort>();
    for (const agent of AGENTS) {
      const base = new ScriptedLlm(PROPOSALS[agent.id]!, "positive", fns[agent.id]!);
      llms2.set(agent.id, {
        available: () => true,
        chat: async () => "",
        chatJson: async <T,>(opts: LlmChatOptions): Promise<T> => {
          captured.push(opts.system + "\n" + opts.user);
          return base.chatJson<T>(opts);
        },
      });
    }
    const ctx2: CommitteeRunContext = {
      ...ctx(),
      targets: (await ports.allocationTargets.current()).map((t) => ({ ...t })),
    };
    await new CommitteeService(ports, llms2, CFG, decisions, engine).runSession("run2", ctx2);

    const promptAndContext = captured.join("\n");
    expect(promptAndContext).toContain("unfundedTargets");
    expect(promptAndContext).toContain("fund these before proposing new changes");
    expect(promptAndContext).toContain("no funding order");
  });

  it("tells the agents what the gate will accept before they propose (constraints in the prompt)", async () => {
    const { ports, decisions, engine } = build();
    const systems: string[] = [];
    const llms = new Map<string, LlmPort>();
    for (const agent of AGENTS) {
      const base = new ScriptedLlm(PROPOSALS[agent.id]!, "positive", (ids) => ids[0]!);
      llms.set(agent.id, {
        available: () => true,
        chat: async () => "",
        chatJson: async <T,>(opts: LlmChatOptions): Promise<T> => {
          if (opts.system.includes("propose YOUR target asset allocation")) systems.push(opts.system);
          return base.chatJson<T>(opts);
        },
      });
    }
    const svc = new CommitteeService(ports, llms, CFG, decisions, engine);
    const outcome = await svc.runSession("run1", ctx());
    expect(outcome.session.status).toBe("COMPLETED");
    expect(systems).toHaveLength(AGENTS.length); // every proposer got the same block

    const prompt = systems[0]!;
    // The block is real JSON the agent can act on, not prose.
    const block = parseConstraints(prompt);
    expect(block.accountCurrency).toBe("GBP");
    expect(block.nav).toBeCloseTo(5663.6, 1);
    expect(block.cash).toBeCloseTo(5000, 1);
    // The budget is cash minus the committee's cash floor, not the whole balance.
    expect(block.investableCash).toBeCloseTo(5000 - 0.05 * 5663.6, 1);
    expect(block.cashFloorPct).toBeCloseTo(5, 2);
    expect(block.maxTargetWeight).toBe(0.25);
    expect(block.maxOrderValue).toBeCloseTo(engine.maxViableOrder(5663.6), 2);
    // Per-ticker feasibility: the smallest order that clears the gate at the
    // assumed edge, plus the drift the agents are being asked to close.
    const msft = block.actionableTickers.MSFT;
    expect(msft.currentWeight).toBeCloseTo(0.1171, 4);
    expect(msft.targetWeight).toBeCloseTo(0.4, 4);
    expect(msft.hint).toBe("buy");
    const expectedMin = engine.minViableOrder({
      // The prompt uses the SAME signal the gate will: the analysts' MSFT reports
      // (Δ 0.1 @ 0.7) blended with the median proposal confidence.
      edgePct: engine.computeEdgePct(
        computeSignalStrength({
          reports: ctx().reports,
          ticker: "MSFT",
          proposalConfidence: 0.65,
          proposalConfidenceWeight: 0.5,
          fullStrengthAdjustment: 0.15,
        }),
      ),
      costRatio: engine.roundTripCostRatio({ accountCurrency: "GBP", instrumentCurrency: "USD", action: "BUY", ticker: "MSFT" }),
      portfolioTotalValue: 5663.6,
    });
    expect(msft.minOrderValue).toBeCloseTo(expectedMin!, 2);
    expect(msft.minOrderValue).toBeGreaterThan(0);
    expect(prompt).toContain("unfundedTargets");
  });

  it("names the tickers no order size can fix instead of letting the agents propose them", async () => {
    const { ports, decisions } = build();
    // A cost model so expensive that no realistic order repays it.
    const expensive = new DecisionEngine(
      { spreadBps: 2, fxFeePct: 0.02, stampDutyPct: 0.005, platformFeePct: 0 },
      { ...RISK, baseEdgePct: 0.005, maxEdgePct: 0.005 },
    );
    const systems: string[] = [];
    const llms = new Map<string, LlmPort>();
    for (const agent of AGENTS) {
      const base = new ScriptedLlm(PROPOSALS[agent.id]!, "positive", (ids) => ids[0]!);
      llms.set(agent.id, {
        available: () => true,
        chat: async () => "",
        chatJson: async <T,>(opts: LlmChatOptions): Promise<T> => {
          if (opts.system.includes("propose YOUR target asset allocation")) systems.push(opts.system);
          return base.chatJson<T>(opts);
        },
      });
    }
    await new CommitteeService(ports, llms, CFG, decisions, expensive).runSession("run1", ctx());
    const prompt = systems[0]!;
    const block = parseConstraints(prompt);
    expect(block.actionableTickers).toEqual({});
    expect(block.notActionableTickers.MSFT).toContain("no order size can clear the gate");
    expect(block.notActionableTickers.AAPL).toContain("round-trip cost");
  });

  it("coerces an invalid vote choice into a valid ballot instead of failing", async () => {
    const { ports, decisions, engine } = build();
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
    const svc = new CommitteeService(ports, llms, CFG, decisions, engine);
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
    const { ports, decisions, engine } = build();
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
    const svc = new CommitteeService(ports, llms, CFG, decisions, engine);
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

describe("CommitteeService — context diet (WP-P1.3)", () => {
  /** Captures every prompt the session sends, grouped by phase. */
  function capturingSession(run = () => undefined) {
    const { ports, decisions, engine } = build();
    const prompts: { phase: "propose" | "review" | "vote"; system: string; user: string; thinking?: string }[] = [];
    const llms = new Map<string, LlmPort>();
    for (const agent of AGENTS) {
      const base = new ScriptedLlm(PROPOSALS[agent.id]!, "positive", (ids) => ids[0]!);
      llms.set(agent.id, {
        available: () => true,
        chat: async () => "",
        chatJson: async <T,>(opts: LlmChatOptions): Promise<T> => {
          const phase = opts.system.includes("propose YOUR target asset allocation")
            ? "propose"
            : opts.system.includes("Review it critically")
              ? "review"
              : "vote";
          prompts.push({ phase, system: opts.system, user: opts.user, ...(opts.thinking ? { thinking: opts.thinking } : {}) });
          return base.chatJson<T>(opts);
        },
      });
    }
    run();
    const svc = new CommitteeService(ports, llms, CFG, decisions, engine);
    return { svc, prompts };
  }

  it("sends the research once per session and a one-line summarised view to reviewers", async () => {
    const { svc, prompts } = capturingSession();
    const outcome = await svc.runSession("run1", ctx());
    expect(outcome.session.status).toBe("COMPLETED");

    const propose = prompts.filter((p) => p.phase === "propose");
    const review = prompts.filter((p) => p.phase === "review");
    const vote = prompts.filter((p) => p.phase === "vote");
    expect(propose).toHaveLength(AGENTS.length); // 4
    expect(review).toHaveLength(AGENTS.length * (AGENTS.length - 1)); // 12
    expect(vote.length).toBeGreaterThan(0);

    // Only the propose phase carries the analyst rationale prose.
    expect(propose[0]!.user).toContain('"analystResearch"');
    expect(propose[0]!.user).toContain("uptrend");
    for (const p of review) {
      expect(p.user).not.toContain('"analystResearch"');
      expect(p.user).toContain('"analystSummary"');
      expect(p.user).toContain("market:bullish(0.70)");
    }
    // The vote carries neither: the ballot is in its system prompt.
    for (const p of vote) {
      expect(p.user).not.toContain('"analystResearch"');
      expect(p.user).not.toContain('"analystSummary"');
      expect(p.user).toContain('"portfolio"');
    }

    // The session records what each phase cost in prompt characters, so the
    // effect is measurable on real runs (and the vote phase — the one that used
    // to re-send the whole research to emit a proposal id — is tiny).
    const stats = outcome.session.details.llmPhases as Record<string, { calls: number; promptChars: number }>;
    expect(stats.propose!.calls).toBe(AGENTS.length);
    expect(stats.review!.calls).toBe(AGENTS.length * (AGENTS.length - 1));
    expect(stats.vote!.calls).toBeGreaterThan(0);
    // Note: promptChars per call is NOT the diet metric — the vote prompt
    // legitimately carries every proposal and every piece of feedback in its
    // system prompt. The diet is about the CONTEXT (user prompt) each phase
    // sends, measured below.
    // Context characters are what the diet shrinks, and they are the only part
    // that differs between phases (the vote/review system prompts are
    // self-contained by design). Recorded so the numbers are visible.
    const contextChars = (phase: "propose" | "review" | "vote") =>
      (phase === "propose" ? propose : phase === "review" ? review : vote).reduce((sum, p) => sum + p.user.length, 0);
    const perCallContext = (phase: "propose" | "review" | "vote") => {
      const items = phase === "propose" ? propose : phase === "review" ? review : vote;
      return contextChars(phase) / items.length;
    };
    console.log(
      `[context diet] per-call user chars: propose ${perCallContext("propose").toFixed(0)} · ` +
        `review ${perCallContext("review").toFixed(0)} · vote ${perCallContext("vote").toFixed(0)}`,
    );
    // The vote context is the account state alone (no research, no summaries):
    // the phase that used to carry every analyst rationale to emit one proposal
    // id now carries less than half of a proposer's context.
    expect(perCallContext("vote")).toBeLessThan(perCallContext("propose") / 2);
    // Reviewers see a one-line view per analyst instead of the research prose:
    // strictly less context than a proposer, even though a review happens once
    // per (agent, proposal) pair rather than once per agent.
    expect(perCallContext("review")).toBeLessThan(perCallContext("propose"));
    // The saving compounds: 12 review calls + 3–9 vote calls now carry less per
    // call than the 3 proposal calls used to carry when every phase re-sent the
    // full blob.
    const reviewWithoutDiet = perCallContext("propose") * review.length;
    expect(contextChars("review")).toBeLessThan(reviewWithoutDiet);
    const sessionContext = contextChars("propose") + contextChars("review") + contextChars("vote");
    const withoutDiet = perCallContext("propose") * (propose.length + review.length + vote.length);
    console.log(
      `[context diet] session context chars: ${sessionContext.toFixed(0)} vs ` +
        `${withoutDiet.toFixed(0)} if every phase sent the propose context ` +
        `(${(100 - (sessionContext / withoutDiet) * 100).toFixed(0)}% less)`,
    );
    expect(sessionContext).toBeLessThan(withoutDiet * 0.6);
  });

  it("never pays for reasoning on feedback or votes", async () => {
    const { svc, prompts } = capturingSession();
    await svc.runSession("run1", ctx());
    expect(prompts.filter((p) => p.phase === "propose").every((p) => p.thinking === undefined)).toBe(true);
    expect(prompts.filter((p) => p.phase === "review").every((p) => p.thinking === "disabled")).toBe(true);
    expect(prompts.filter((p) => p.phase === "vote").every((p) => p.thinking === "disabled")).toBe(true);
  });

  it("does not ask a reasoning-mandatory seat to think off (OpenRouter answers 400)", async () => {
    // gemini-3.8-flash and glm-5.3-flash publish `reasoning: {mandatory: true}`:
    // forcing `thinking: disabled` on review/vote fails every such call.
    const { ports, decisions, engine } = build();
    const mandatory = AGENTS.map((a) => ({ ...a, requiresReasoning: true }));
    const phasesSeen: { id: string; phase: string; thinking?: string }[] = [];
    const llms = new Map<string, LlmPort>();
    for (const agent of mandatory) {
      const base = new ScriptedLlm(PROPOSALS[agent.id]!, "positive", (ids) => ids[0]!);
      llms.set(agent.id, {
        available: () => true,
        chat: async () => "",
        chatJson: async <T,>(opts: LlmChatOptions): Promise<T> => {
          const phase = opts.system.includes("propose YOUR target asset allocation")
            ? "propose"
            : opts.system.includes("Review it critically")
              ? "review"
              : "vote";
          phasesSeen.push({ id: agent.id, phase, ...(opts.thinking ? { thinking: opts.thinking } : {}) });
          return base.chatJson<T>(opts);
        },
      });
    }
    const svc = new CommitteeService(ports, llms, { ...CFG, agents: mandatory }, decisions, engine);
    const outcome = await svc.runSession("run1", ctx());
    expect(outcome.session.status).toBe("COMPLETED");
    const cheap = phasesSeen.filter((p) => p.phase !== "propose");
    expect(cheap.length).toBeGreaterThan(0);
    expect(cheap.every((p) => p.thinking === undefined)).toBe(true);
  });
});

describe("CommitteeService — trust region and turnover budget (WP-P1.4)", () => {
  /** A session whose winner wants a 5-point MSFT raise, with configurable dampers. */
  async function sessionWith(over: Partial<CommitteeConfig>) {
    const { ports, decisions, engine } = build();
    const winner = {
      ...PROPOSALS.a1!,
      confidence: 0.8,
      targets: [{ ticker: "MSFT", weight: 0.25 }],
      orders: [],
    };
    const fns = voteFns();
    const llms = new Map<string, LlmPort>();
    for (const agent of AGENTS) {
      llms.set(agent.id, new ScriptedLlm(agent.id === "a1" ? winner : PROPOSALS[agent.id]!, "positive", fns[agent.id]!));
    }
    const svc = new CommitteeService(ports, llms, { ...CFG, ...over }, decisions, engine);
    const outcome = await svc.runSession("run1", ctx());
    return { outcome, ports };
  }

  it("applies only part of the requested change by default damping", async () => {
    const { outcome, ports } = await sessionWith({ trustRegion: 0.4, trustRegionConfidenceWeight: 0.5 });
    expect(outcome.session.status).toBe("COMPLETED");
    // MSFT current 0.4 → requested 0.25; whole-number view: the applied target is
    // the current weight plus 40% × damp(0.8)=0.9 of the −0.15 request.
    const msft = (await ports.allocationTargets.current()).find((t) => t.ticker === "MSFT")!;
    expect(msft.weight).toBeCloseTo(0.4 - 0.15 * 0.4 * 0.9, 4);
    const trust = outcome.session.details.trustRegion as { requested: { ticker: string; requested: number; applied: number }[] };
    const msftRow = trust.requested.find((r) => r.ticker === "MSFT")!;
    expect(msftRow.requested).toBe(0.25);
    expect(msftRow.applied).toBeCloseTo(0.346, 3);
  });

  it("freezes the allocation when shrinkFactor is 0, so no target row is written", async () => {
    const { outcome, ports } = await sessionWith({ trustRegion: 0 });
    expect(outcome.session.status).toBe("COMPLETED");
    expect(await ports.allocationTargets.current()).toHaveLength(0);
    const trust = outcome.session.details.trustRegion as { turnover: number };
    expect(trust.turnover).toBe(0);
  });

  it("scales a swing down to the session's turnover budget", async () => {
    // Two names moving in opposite directions (MSFT up, AAPL down), 0.20 of
    // notional in total, under a 0.02-notional budget: both must be scaled by
    // the same factor.
    const { ports, decisions, engine } = build();
    const winner = {
      ...PROPOSALS.a1!,
      confidence: 1,
      // Both requests sit inside the 0.25 per-name cap and their sum inside the
      // invested cap, so the turnover budget is the only thing shaping them.
      targets: [
        { ticker: "MSFT", weight: 0.25 }, // current 0.4 → −0.15
        { ticker: "AAPL", weight: 0.25 }, // current 0.3 → −0.05
      ],
      orders: [],
    };
    const fns = voteFns();
    const llms = new Map<string, LlmPort>();
    for (const agent of AGENTS) {
      llms.set(agent.id, new ScriptedLlm(agent.id === "a1" ? winner : PROPOSALS[agent.id]!, "positive", fns[agent.id]!));
    }
    const svc = new CommitteeService(
      ports,
      llms,
      { ...CFG, trustRegion: 1, trustRegionConfidenceWeight: 0, maxTurnoverPctPerSession: 0.02, minWeightChange: 0 },
      decisions,
      engine,
    );
    const outcome = await svc.runSession("run1", ctx());
    const trust = outcome.session.details.trustRegion as { turnover: number; turnoverBudgetHit: boolean; requested: { applied: number; current: number }[] };
    expect(trust.turnoverBudgetHit).toBe(true);
    expect(trust.turnover).toBeCloseTo(0.02, 4);
    // Both moves scaled by the same factor 0.02/0.20 = 0.1: MSFT −0.015,
    // AAPL −0.005 — proportional, never one at the other's expense.
    const targets = await ports.allocationTargets.current();
    const msft = targets.find((t) => t.ticker === "MSFT")!;
    const aapl = targets.find((t) => t.ticker === "AAPL")!;
    expect(msft.weight).toBeCloseTo(0.4 - 0.15 * 0.1, 4);
    expect(aapl.weight).toBeCloseTo(0.3 - 0.05 * 0.1, 4);
  });

  it("labels an approved order with the target it funds", async () => {
    const { ports, decisions, engine } = build();
    const winner = {
      ...PROPOSALS.a1!,
      confidence: 0.9,
      // An AAPL-only change keeps the target sum inside the invested cap, so the
      // recorded weight is the winner's request itself.
      targets: [{ ticker: "MSFT", weight: 0.4 }],
      orders: [{ ticker: "AAPL", side: "BUY" as const, value: 150, reason: "fund the AAPL target" }],
    };
    const fns = voteFns();
    const llms = new Map<string, LlmPort>();
    for (const agent of AGENTS) {
      llms.set(agent.id, new ScriptedLlm(agent.id === "a1" ? winner : PROPOSALS[agent.id]!, "positive", fns[agent.id]!));
    }
    const svc = new CommitteeService(ports, llms, { ...CFG, trustRegion: 1, trustRegionConfidenceWeight: 0 }, decisions, engine);
    const outcome = await svc.runSession("run1", ctx());
    const decision = outcome.decisions.find((d) => d.ticker === "AAPL")!;
    expect(decision.approved).toBe(true);
    // AAPL's unchanged target (0.3) plus MSFT's 0.4 stay inside the invested cap,
    // so the funding hint reports the weight the run holds for the order.
    const funding = decision.details.funding as { needed: boolean; targetWeight: number; currentWeight: number };
    expect(funding.targetWeight).toBeCloseTo(0.3, 4);
    expect(funding.currentWeight).toBe(0);
    expect(funding.needed).toBe(true);
  });
});

describe("CommitteeService — instrument risk in the prompt (WP-P2.1)", () => {
  it("gives proposers the per-name risk table and keeps it out of the ballot", async () => {
    const { ports, decisions, engine } = build();
    const systems: string[] = [];
    const users: string[] = [];
    const llms = new Map<string, LlmPort>();
    for (const agent of AGENTS) {
      const base = new ScriptedLlm(PROPOSALS[agent.id]!, "positive", (ids) => ids[0]!);
      llms.set(agent.id, {
        available: () => true,
        chat: async () => "",
        chatJson: async <T,>(opts: LlmChatOptions): Promise<T> => {
          if (opts.system.includes("propose YOUR target asset allocation")) {
            systems.push(opts.system);
            users.push(opts.user);
          }
          return base.chatJson<T>(opts);
        },
      });
    }
    const risk = {
      benchmarkBars: 40,
      concentration: { largestWeight: 0.35, effectivePositions: 2.4, top3Weight: 0.8 },
      metrics: [
        {
          ticker: "MSFT",
          bars: 40,
          volatilityPerBarPct: 0.012,
          volatilityAnnualisedPct: 0.48,
          beta: 1.1,
          correlation: 0.8,
          sma20: 410,
          sma50: null,
          trendVsSma20Pct: 0.02,
          momentum5Pct: 0.01,
          momentum20Pct: 0.05,
          maxDrawdownPct: -0.08,
          rangePosition: 0.7,
          highClose: 430,
          lowClose: 380,
          volumeRatio: 1.2,
        },
      ],
    };
    const ctxWithRisk = { ...ctx(), risk } as CommitteeRunContext;
    await new CommitteeService(ports, llms, CFG, decisions, engine).runSession("run1", ctxWithRisk);

    const body = users[0]!;
    expect(body).toContain('"instrumentRisk"');
    expect(body).toContain('"beta": 1.1');
    expect(body).toContain('"maxDrawdownPct": -0.08');
    expect(body).toContain('"effectivePositions": 2.4');
    expect(body).toContain("Size positions on risk");
  });
});
describe("CommitteeService — sector caps in a session (WP-P2.2)", () => {
  it("scales a technology-heavy winner back to the sector cap and reports it", async () => {
    const { ports, decisions, engine } = build();
    // The winner wants 0.25 MSFT + 0.25 AAPL (both Technology) + 0.2 XOM.
    const winner = {
      ...PROPOSALS.a1!,
      confidence: 1,
      targets: [
        { ticker: "MSFT", weight: 0.25 },
        { ticker: "AAPL", weight: 0.25 },
      ],
      orders: [],
    };
    const fns = voteFns();
    const llms = new Map<string, LlmPort>();
    for (const agent of AGENTS) {
      llms.set(agent.id, new ScriptedLlm(agent.id === "a1" ? winner : PROPOSALS[agent.id]!, "positive", fns[agent.id]!));
    }
    const risk = {
      benchmarkBars: 40,
      concentration: { largestWeight: 0.4, effectivePositions: 2, top3Weight: 0.8 },
      sectors: { MSFT: "Technology", AAPL: "Technology" },
      metrics: [],
    };
    const svc = new CommitteeService(
      ports,
      llms,
      {
        ...CFG,
        trustRegion: 1,
        trustRegionConfidenceWeight: 0,
        maxTurnoverPctPerSession: 0,
        minWeightChange: 0,
        minPositions: 4,
        sectorCaps: { defaultCap: null, bySector: { Technology: 0.3 } },
      },
      decisions,
      engine,
    );
    const outcome = await svc.runSession("run1", { ...ctx(), risk } as CommitteeRunContext);
    expect(outcome.session.status).toBe("COMPLETED");

    const diversification = (outcome.session.details.trustRegion as { diversification: {
      sectorExposure: Record<string, number>;
      cappedSectors: { sector: string; exposure: number; cap: number }[];
      positionCount: number;
      belowMinPositions: boolean;
    } }).diversification;
    // MSFT 0.4 + AAPL 0.3 = 0.7 Technology against a 0.3 cap → both scaled to 0.15.
    expect(diversification.cappedSectors.map((c) => c.sector)).toEqual(["Technology"]);
    expect(diversification.cappedSectors[0]!.cap).toBe(0.3);
    expect(diversification.cappedSectors[0]!.exposure).toBeGreaterThan(0.3);
    expect(diversification.sectorExposure.Technology).toBeCloseTo(0.3, 3);
    // Two positions is below the required four: reported, not silently accepted.
    expect(diversification.positionCount).toBe(2);
    expect(diversification.belowMinPositions).toBe(true);

    const saved = await ports.allocationTargets.current();
    expect(saved.find((t) => t.ticker === "MSFT")!.weight).toBeLessThan(0.25);
    expect(saved.find((t) => t.ticker === "AAPL")!.weight).toBeLessThan(0.25);
  });
});
describe("CommitteeService — outcome feedback in the prompt (WP-P2.4)", () => {
  it("gives proposers the recent track record and tells them not to repeat a losing stance", async () => {
    const { ports, decisions, engine } = build();
    const users: string[] = [];
    const llms = new Map<string, LlmPort>();
    for (const agent of AGENTS) {
      const base = new ScriptedLlm(PROPOSALS[agent.id]!, "positive", (ids) => ids[0]!);
      llms.set(agent.id, {
        available: () => true,
        chat: async () => "",
        chatJson: async <T,>(opts: LlmChatOptions): Promise<T> => {
          if (opts.system.includes("propose YOUR")) users.push(opts.user);
          return base.chatJson<T>(opts);
        },
      });
    }
    const performance = {
      sessions: 12,
      navChangePct: -0.021,
      benchmarkChangePct: 0.034,
      alphaPct: -5.5,
      worstDrawdownPct: -0.031,
      windowContribution: -8.4,
      scorecards: [{ agentId: "a2", agentName: "Momentum Trader", acceptanceRate: 0.4, contribution: -12.5, positive: false }],
    };
    await new CommitteeService(ports, llms, CFG, decisions, engine).runSession("run1", {
      ...ctx(),
      performance,
    } as CommitteeRunContext);

    const body = users[0]!;
    expect(body).toContain('"trackRecord"');
    expect(body).toContain('"alphaPct": -5.5');
    expect(body).toContain('"contribution": -12.5');
    expect(body).toContain("do not repeat a stance that has been losing money");
  });
});

describe("CommitteeService — agent roles (WP-P2.5)", () => {
  /** Captures each seat's system prompt and context. */
  async function seated(roles: Record<string, string>) {
    const { ports, decisions, engine } = build();
    const captured = new Map<string, { system: string; user: string }>();
    const llms = new Map<string, LlmPort>();
    for (const agent of AGENTS) {
      const base = new ScriptedLlm(PROPOSALS[agent.id]!, "positive", (ids) => ids[0]!);
      llms.set(agent.id, {
        available: () => true,
        chat: async () => "",
        chatJson: async <T,>(opts: LlmChatOptions): Promise<T> => {
          if (opts.system.includes("propose YOUR") || opts.system.includes("Your seat on this committee")) {
            captured.set(agent.id, { system: opts.system, user: opts.user });
          }
          return base.chatJson<T>(opts);
        },
      });
    }
    const seats = AGENTS.map((a) => ({ ...a, ...(roles[a.id] ? { role: roles[a.id] as never } : {}) }));
    const svc = new CommitteeService(ports, llms, { ...CFG, agents: seats }, decisions, engine);
    await svc.runSession("run1", ctx());
    return captured;
  }

  it("states each seat's objective instead of the same question four times", async () => {
    const captured = await seated({ a1: "macro", a2: "momentum", a3: "valuation", a4: "risk-officer" });
    expect(captured.get("a1")!.system).toContain("MACRO view");
    expect(captured.get("a2")!.system).toContain("MOMENTUM");
    expect(captured.get("a3")!.system).toContain("VALUATION");
    expect(captured.get("a4")!.system).toContain("argue for LESS concentration");
    // Every seat still gets the gate constraints and the plan.
    for (const agent of AGENTS) {
      expect(captured.get(agent.id)!.system).toContain("<<<CONSTRAINTS");
      expect(captured.get(agent.id)!.user).toContain('"currentTargets"');
    }
  });

  it("gives each seat only the evidence its role is meant to weigh", async () => {
    const captured = await seated({ a1: "macro", a2: "momentum", a3: "valuation", a4: "risk-officer" });

    // The valuation seat sees the fundamentals analyst and not the sentiment one.
    const valuation = JSON.parse(captured.get("a3")!.user) as { analystResearch: { reports: { analyst: string }[] }[] };
    const valuationAnalysts = valuation.analystResearch.flatMap((t) => t.reports.map((r) => r.analyst));
    expect(valuationAnalysts).toContain("fundamentals");
    expect(valuationAnalysts).not.toContain("sentiment");

    // The momentum seat sees the tape-side analysts and not the fundamentals one.
    const momentum = JSON.parse(captured.get("a2")!.user) as { analystResearch: { reports: { analyst: string }[] }[] };
    const momentumAnalysts = momentum.analystResearch.flatMap((t) => t.reports.map((r) => r.analyst));
    expect(momentumAnalysts).toContain("market");
    expect(momentumAnalysts).not.toContain("fundamentals");

    // The risk seat sees the portfolio concentration and no analyst prose.
    const riskUser = captured.get("a4")!.user;
    expect(riskUser).not.toContain('"analystResearch"');
  });

  it("keeps today's behaviour when no role is configured", async () => {
    const captured = await seated({});
    expect(captured.get("a1")!.system).toContain("propose YOUR target asset allocation");
    expect(captured.get("a1")!.system).not.toContain("Your seat on this committee");
    // Generalists get every analyst report, as before.
    const body = JSON.parse(captured.get("a1")!.user) as { analystResearch: { reports: { analyst: string }[] }[] };
    const analysts = body.analystResearch.flatMap((t) => t.reports.map((r) => r.analyst));
    expect(new Set(analysts)).toEqual(new Set(["market", "fundamentals"]));
  });
});
