/**
 * Gate calibration table (WP-P0.1 acceptance evidence).
 *
 * Prints the verdict of `DecisionEngine.evaluate` for realistic order sizes
 * under four configurations, using the cost model and price/currency mix of the
 * live account (GBP account, USD instruments, Trading212 Invest costs).
 *
 * The point of the table: the pre-rewrite gate could not distinguish sizes at
 * all (it rejected every size under one config and approved every size under the
 * next). The rewritten gate must approve the sizes that can pay for their own
 * round trip and reject the ones that cannot.
 *
 * Run: npx tsx docs/analysis/gate-occupancy-probe.ts
 */
import { DecisionEngine, type CostModel, type RiskLimits, type TradeProposal } from "../../src/domain/decision.js";

const costModel: CostModel = { spreadBps: 2, fxFeePct: 0.0015, stampDutyPct: 0.005, platformFeePct: 0 };

const base: Omit<RiskLimits, "baseEdgePct" | "minNetBenefitPct" | "minOrderValue" | "maxOrderValuePct" | "costBenefitMultiplier"> = {
  maxOrderValue: 2000,
  maxHeatPct: 0.855,
  maxEdgePct: 0.02,
  llmCostBenefitMultiplier: 1,
  maxOrdersPerRun: 5,
  tickerCooldownDays: 1,
  minConfidence: 0.3,
};

const NAV = 780;
const CASH = 183;

/** Signal strength of a committee winner with 0.68 confidence and no analyst coverage. */
const SIGNAL_NO_RESEARCH = 0.34;
/** Signal strength with analysts recommending a 15% weight change at 0.7 confidence. */
const SIGNAL_WITH_RESEARCH = 0.5 * 0.7 + 0.5 * 0.68;

function probe(label: string, risk: RiskLimits, signal: number, llmCostPerRun: number): void {
  const engine = new DecisionEngine(costModel, risk);
  const edgePct = engine.computeEdgePct(signal);
  const costRatio = engine.roundTripCostRatio({
    accountCurrency: "GBP",
    instrumentCurrency: "USD",
    action: "BUY",
    ticker: "MSFT",
  });
  console.log(`\n--- ${label} ---`);
  console.log(
    `  signal ${signal.toFixed(2)} -> edge ${(edgePct * 100).toFixed(3)}%   round-trip cost ${(costRatio * 100).toFixed(3)}%` +
      `   required edge ${(costRatio * risk.costBenefitMultiplier * 100).toFixed(3)}%   LLM/run $${llmCostPerRun.toFixed(3)}`,
  );
  for (const value of [10, 25, 50, 100, 150, 200, 250]) {
    const costs = engine.estimateCosts({
      orderValue: value,
      accountCurrency: "GBP",
      instrumentCurrency: "USD",
      action: "BUY",
      ticker: "MSFT",
    });
    const benefit = engine.expectedBenefit(value, edgePct);
    const proposal: TradeProposal = {
      ticker: "MSFT",
      action: "BUY",
      quantity: 1,
      estimatedPrice: 1,
      estimatedValue: value,
      currency: "USD",
      expectedBenefit: benefit,
      costEstimate: costs,
      edgePct,
      rationale: "calibration probe",
      confidence: 0.68,
    };
    const verdict = engine.evaluate(
      proposal,
      { portfolioHeat: 0.69, portfolioTotalValue: NAV, availableCash: CASH, cooledTickers: new Set() },
      { llmCostPerRun, sessionNetBenefit: 0 },
    );
    console.log(
      `  £${String(value).padStart(4)}: costs £${costs.total.toFixed(3).padStart(6)}  net £${(benefit - costs.total)
        .toFixed(3)
        .padStart(7)}  -> ${verdict.approved ? "APPROVED" : verdict.reason}`,
    );
  }
}

// 1. The configuration that produced a month of zero orders (before the review).
probe(
  "OLD live cfg (flat 0.5%/trade return, 0.6% benefit floor, ×1.5)",
  { ...base, baseEdgePct: 0.005, minNetBenefitPct: 0.006, minOrderValue: 0, maxOrderValuePct: 0, costBenefitMultiplier: 1.5 },
  SIGNAL_WITH_RESEARCH,
  0.02,
);

// 2. The config that replaced it: a flat 2% edge assumed on every order.
probe(
  "INTERIM cfg (flat 2% edge, 0.1% floor, ×1.0)",
  { ...base, baseEdgePct: 0.02, minNetBenefitPct: 0.001, minOrderValue: 0, maxOrderValuePct: 0, costBenefitMultiplier: 1 },
  SIGNAL_WITH_RESEARCH,
  0.02,
);

// 3. The rewritten gate: edge from the research, round-trip costs, size bounds.
//    Mirrors config/default.json (baseEdgePct 1.5%, ×2 costs, £25 floor, 25% NAV cap).
const NEW_DEFAULTS: RiskLimits = {
  ...base,
  baseEdgePct: 0.015,
  minNetBenefitPct: 0.0005,
  minOrderValue: 25,
  maxOrderValuePct: 0.25,
  costBenefitMultiplier: 2,
};
probe("NEW defaults, research-backed name", NEW_DEFAULTS, SIGNAL_WITH_RESEARCH, 0.02);

// 4. The same gate when the research says nothing about the name (no analyst coverage).
probe("NEW defaults, NO analyst coverage for the name", NEW_DEFAULTS, SIGNAL_NO_RESEARCH, 0.02);

/* ── Prompt feasibility (WP-P0.3): the size window the agents are told about ── */
console.log("\n=== Prompt feasibility block (what the committee is told, same engine) ===");
const engine = new DecisionEngine(costModel, NEW_DEFAULTS);
const scenarios: { label: string; signal: number; currency: string }[] = [
  { label: "research-backed (Δ15% @ 0.9 conf)", signal: 1 * 0.5 + 0.5 * 0.8, currency: "USD" },
  { label: "mildly supported (Δ8% @ 0.6 conf)", signal: 0.53 * 0.5 + 0.5 * 0.65, currency: "USD" },
  { label: "no analyst coverage", signal: 0.5 * 0.65, currency: "USD" },
  { label: "research-backed, UK-listed (stamp duty)", signal: 1 * 0.5 + 0.5 * 0.8, currency: "GBP" },
];
for (const s of scenarios) {
  const edgePct = engine.computeEdgePct(s.signal);
  const ratio = engine.roundTripCostRatio({ accountCurrency: "GBP", instrumentCurrency: s.currency, action: "BUY", ticker: "MSFT" });
  const min = engine.minViableOrder({ edgePct, costRatio: ratio, portfolioTotalValue: NAV });
  const max = engine.maxViableOrder(NAV);
  console.log(
    `  ${s.label.padEnd(40)} signal ${s.signal.toFixed(2)}  edge ${(edgePct * 100).toFixed(3)}%  ` +
      `round trip ${(ratio * 100).toFixed(3)}%  orderable ${min === null ? "NONE (would be refused at any size)" : `£${min.toFixed(2)} … £${max.toFixed(2)}`}`,
  );
}
