import { describe, expect, it } from "vitest";
import { evaluateCadence, type CadenceConfig, type CadenceInput } from "../../src/domain/cadence.js";
import type { AllocationDrift } from "../../src/domain/portfolio.js";

const CFG: CadenceConfig = {
  triggerMode: "material",
  navMovePct: 0.01,
  driftPct: 0.05,
  planningIntervalHours: 20,
  newsLookbackHours: 6,
  driftCooldownHours: 0,
};

function drift(over: Partial<AllocationDrift> = {}): AllocationDrift {
  return { ticker: "MSFT", targetWeight: 0.25, currentWeight: 0.24, drift: -0.01, insideBand: true, hint: "hold", ...over };
}

function input(over: Partial<CadenceInput> = {}): CadenceInput {
  return {
    drift: [drift()],
    navMovePct: 0.001,
    hoursSinceLastRun: 1,
    hasUnfundedTargets: false,
    newHeadlines: [],
    ...over,
  };
}

describe("evaluateCadence (WP-P1.1)", () => {
  it("stays stats-only when nothing material changed", () => {
    const decision = evaluateCadence(input(), CFG);
    expect(decision.material).toBe(false);
    expect(decision.triggers).toEqual([]);
    expect(decision.reason).toContain("no LLM spend");
  });

  it("triggers on a target outside the rebalance band, with the worst name named", () => {
    const decision = evaluateCadence(
      input({
        drift: [
          drift(),
          drift({ ticker: "XOM", drift: 0.09, insideBand: false, hint: "sell" }),
          drift({ ticker: "AMZN", drift: -0.06, insideBand: false, hint: "buy" }),
        ],
      }),
      CFG,
    );
    expect(decision.material).toBe(true);
    expect(decision.triggers).toContain("drift");
    expect(decision.reason).toContain("XOM 9.0pp");
    expect(decision.reason).toContain("2 target(s)");
  });

  it("ignores drift inside the band even when the configured threshold is tiny", () => {
    expect(evaluateCadence(input({ drift: [drift({ drift: 0.049, insideBand: true })] }), CFG).material).toBe(false);
  });

  it("triggers on a NAV move beyond the configured threshold, in either direction", () => {
    expect(evaluateCadence(input({ navMovePct: 0.015 }), CFG).triggers).toContain("nav-move");
    expect(evaluateCadence(input({ navMovePct: -0.04 }), CFG).triggers).toContain("nav-move");
    expect(evaluateCadence(input({ navMovePct: 0.009 }), CFG).triggers).not.toContain("nav-move");
    // No previous valuation (first run of a fresh DB) is not a NAV move.
    expect(evaluateCadence(input({ navMovePct: null }), CFG).triggers).not.toContain("nav-move");
  });

  it("triggers on an unfunded target: the plan is already asking for money", () => {
    const decision = evaluateCadence(input({ hasUnfundedTargets: true }), CFG);
    expect(decision.triggers).toContain("unfunded-target");
    expect(decision.reason).toContain("unfunded target");
  });

  it("triggers on headlines gathered since the previous session", () => {
    const decision = evaluateCadence(input({ newHeadlines: ["MSFT beats estimates", "XOM downgraded"] }), CFG);
    expect(decision.triggers).toContain("new-news");
    expect(decision.reason).toContain("2 new headline(s)");
  });

  it("triggers the planning slot when no session ran recently (or ever)", () => {
    expect(evaluateCadence(input({ hoursSinceLastRun: 21 }), CFG).triggers).toContain("planning-slot");
    expect(evaluateCadence(input({ hoursSinceLastRun: 19.9 }), CFG).triggers).not.toContain("planning-slot");
    const first = evaluateCadence(input({ hoursSinceLastRun: null }), CFG);
    expect(first.material).toBe(true);
    expect(first.reason).toContain("no previous session");
  });

  it("suppresses the drift trigger while the drift cooldown is running", () => {
    const input = {
      drift: [drift({ ticker: "XOM", drift: 0.12, insideBand: false, hint: "sell" as const })],
      navMovePct: 0.001,
      hoursSinceLastRun: 1,
      hoursSinceLastMaterialRun: 1,
      hasUnfundedTargets: false,
      newHeadlines: [],
    };
    const cfg = { ...CFG, driftCooldownHours: 3 };
    const cooling = evaluateCadence(input, cfg);
    expect(cooling.material).toBe(false);
    expect(cooling.triggers).not.toContain("drift");
    expect(cooling.reason).toContain("drift ignored: reviewed 1.0h ago");

    // After the cooldown the same drift triggers again.
    expect(evaluateCadence({ ...input, hoursSinceLastMaterialRun: 4 }, cfg).triggers).toContain("drift");
    // No material-run history → no cooldown.
    expect(evaluateCadence({ ...input, hoursSinceLastMaterialRun: null }, cfg).triggers).toContain("drift");
    // Other triggers are unaffected by the cooldown.
    expect(evaluateCadence({ ...input, hasUnfundedTargets: true }, cfg).triggers).toContain("unfunded-target");
  });

  it("bypasses the test for forced runs and for triggerMode=always", () => {
    const forced = evaluateCadence(input(), CFG, { force: true });
    expect(forced.material).toBe(true);
    expect(forced.triggers).toEqual(["manual"]);

    const always = evaluateCadence(input(), { ...CFG, triggerMode: "always" });
    expect(always.material).toBe(true);
    expect(always.triggers).toEqual(["always"]);
    expect(always.reason).toContain("every market hour");
  });

  it("collects every firing trigger, not just the first", () => {
    const decision = evaluateCadence(
      input({
        drift: [drift({ ticker: "SHW", drift: 0.08, insideBand: false, hint: "sell" })],
        navMovePct: 0.03,
        hasUnfundedTargets: true,
        newHeadlines: ["something happened"],
        hoursSinceLastRun: 30,
      }),
      CFG,
    );
    expect(decision.triggers.sort()).toEqual(["drift", "nav-move", "new-news", "planning-slot", "unfunded-target"]);
  });
});
