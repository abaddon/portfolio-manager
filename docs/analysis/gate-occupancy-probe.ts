import { DecisionEngine } from "../../src/domain/decision.js";
const mk = (minBenefitPct: number, mult: number) =>
  new DecisionEngine(
    { spreadBps: 2, fxFeePct: 0.0015, stampDutyPct: 0.005, platformFeePct: 0 },
    { maxOrderValue: 2000, maxHeatPct: 0.855, minExpectedBenefitPct: minBenefitPct, costBenefitMultiplier: mult, maxOrdersPerRun: 5, tickerCooldownDays: 1, minConfidence: 0.3 },
  );
const probe = (label: string, engine: DecisionEngine, ret: number) => {
  const out: string[] = [];
  for (const v of [5, 10, 20, 50, 100, 200]) {
    const costs = engine.estimateCosts({ orderValue: v, accountCurrency: "GBP", instrumentCurrency: "USD", action: "BUY", ticker: "MSFT" });
    const benefit = v * ret * (0.5 + 0.5 * 0.68);
    const r = engine.evaluate({ ticker: "MSFT", action: "BUY", quantity: 1, estimatedPrice: 1, estimatedValue: v, currency: "USD", expectedBenefit: benefit, costEstimate: costs, rationale: "x", confidence: 0.68 }, { portfolioHeat: 0.69, portfolioTotalValue: 780, cash: 183, cooledTickers: new Set() });
    out.push(`  £${String(v).padStart(4)}: benefit £${benefit.toFixed(3)} costs £${costs.total.toFixed(3)} -> ${r.approved ? "APPROVED" : r.reason}`);
  }
  console.log(`--- ${label} ---\n${out.join("\n")}`);
};
probe("old live cfg (ret 0.5%, floor 0.60%, x1.5)", mk(0.006, 1.5), 0.005);
probe("current live cfg (ret 2%, floor 0.10%, x1.0)", mk(0.001, 1.0), 0.02);
probe("same cfg, honest edge 0.10% (floor x2)", mk(0.001, 2.0), 0.001);
