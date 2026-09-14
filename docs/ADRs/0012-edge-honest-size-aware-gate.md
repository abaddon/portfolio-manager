# ADR 0012 — Edge-honest, size-aware economic gate

- **Status:** Accepted
- **Date:** 2026-09-14
- **Decision maker:** User (Stefano) + AI agent
- **Work package:** `docs/IMPLEMENTATION_PLAN.md` WP-P0.1 (Phase P0)
- **Supersedes:** the cost/benefit arithmetic of `DECISION_PROCESS.md` §6.1–6.4 (the gate *order* and
  the running-state semantics of ADR 0010 are preserved)

## Context

`DecisionEngine.evaluate` was supposed to be the last line of defence between an LLM opinion and real
money. It was not measuring anything:

```
expectedBenefit = orderValue × expectedReturnPerTradePct/100 × (0.5 + 0.5 × confidence)
gate:            expectedBenefit ≥ minExpectedBenefitPct × orderValue
                 expectedBenefit ≥ costs × costBenefitMultiplier
```

Three defects, all reproduced against the real account data (`docs/analysis/gate-occupancy-probe.ts`):

1. **The benefit was an assumption, not a measurement.** `expectedReturnPerTradePct` (0.5% in the
   shipped config, 2.0% after the "fix") was multiplied by *every* order value regardless of what the
   research said. The gate therefore tested order size and agent confidence, never edge.
2. **The two thresholds were mutually unsatisfiable in the first configuration.**
   `minExpectedBenefitPct (0.006) > expectedReturnPerTradePct × (0.5 + 0.5 × conf) (≤ 0.005)`: **no**
   order value could ever pass. The live account shows the consequence: 36 runs, 50 decisions,
   **0 approved, 0 orders**, while targets kept moving (13 target updates, targets summing to 0.8928
   against an actual MSFT weight of 0.1563). The "fix" flipped to the opposite failure — with a flat
   2% edge the gate approved every size from £5 up.
3. **Costs were one-way.** `estimateCosts` charged the spread, the FX fee and the platform fee once,
   although a rebalance pays them on entry *and* exit (only UK stamp duty is buy-only). A round trip
   in the live account costs ~0.34% of notional; the gate compared it against a benefit that assumed
   2% — a 6× blind spot on churn.

## Decision

**1. The edge is derived from the research, not configured per trade.**
`DecisionService` computes a per-ticker **signal strength** in [0,1] from two evidence sources: the
analysts' recommended target-weight changes weighted by their own `adjustmentConfidence` (a 15% weight
change counts as full strength), and the winning proposal's confidence, blended 50/50. The engine then
applies `baseEdgePct` at full strength, capped by `maxEdgePct`:

```
signalStrength = (1 − w) × analystStrength + w × proposalConfidence          // w = 0.5
edgePct        = min(signalStrength × baseEdgePct, maxEdgePct)
```

The proposal's confidence is a weaker input than analyst coverage: a name the research never looked at
carries half the edge of a name the analysts back. `expectedReturnPerTradePct` is **removed**; a config
still carrying it (or `minExpectedBenefitPct`) gets a startup warning naming the replacement, because
schema validation silently drops unknown keys and a stale `local.json` would otherwise keep looking
like it configures the gate.

**2. The cost side is the round trip.** `CostEstimate` gains `costRatio` =
`2×spread + 2×fxFee + stampDuty + 2×platformFee` (fractions, computed exactly — not from the 2 dp
display amounts, which would turn a 2 bp spread into 0 at a £25 order). The gate compares the assumed
edge against `costRatio × costBenefitMultiplier`.

**3. Size matters, in both directions.** `minOrderValue` (default £25) refuses orders whose fixed
costs swamp the benefit (`INSTRUMENT_UNECONOMIC`); `maxOrderValuePct` (default 25% of NAV) bounds a
single order by portfolio size, alongside the absolute `maxOrderValue`.

**4. A net-benefit floor replaces the old benefit floor.** `netBenefit = benefit − roundTripCosts`
must reach `minNetBenefitPct × orderValue` (default 5 bp). This is the check that actually protects
small trades: at a £25 order, 2 dp rounding of the cost components used to erase the costs entirely
from the comparison.

**5. The run's inference cost is inside the same equation.** The session's accumulated net benefit
must reach `llmCostPerRun × llmCostBenefitMultiplier` (ADR 0011 supplies the cost, converted to the
account currency at the live FX rate). `RunEconomics` carries an explicit `coverageAmount` (this
trade's net plus what the run has already banked), so the gate stays a pure function of its inputs.

**6. Gate order** (rejection reason in brackets):

| # | Check | Reason |
|---|---|---|
| 1 | HOLD is a no-op | — |
| 2 | `quantity > 0` | `OPPORTUNITY_TOO_SMALL` |
| 3 | `confidence ≥ minConfidence` | `NO_CONVICTION` |
| 4 | `value ≤ min(maxOrderValue, maxOrderValuePct × NAV)` | `RISK_LIMIT_EXCEEDED` |
| 5 | `value ≥ minOrderValue` | `INSTRUMENT_UNECONOMIC` |
| 6 | `netBenefit ≥ minNetBenefitPct × value` | `OPPORTUNITY_TOO_SMALL` |
| 7 | `edgePct ≥ costRatio × costBenefitMultiplier` (ε = 1e-9) | `COST_EXCEEDS_BENEFIT` |
| 8 | cooldown, then (BUY only) cash and heat — run-scoped state per ADR 0010 | `COOLDOWN_ACTIVE` / `INSUFFICIENT_CASH` / `RISK_LIMIT_EXCEEDED` |
| 9 | `coverageAmount ≥ llmCostPerRun × llmCostBenefitMultiplier` | `COST_EXCEEDS_BENEFIT` |

Size checks precede the economic ones so an oversized or sub-minimum intent is reported as such.

## Calibration evidence (`npx tsx docs/analysis/gate-occupancy-probe.ts`)

Live cost model (2 bp spread, 0.15% FX, GBP account, USD instruments ⇒ 0.34% round trip), £780 NAV,
£183 cash, winner confidence 0.68 with analysts recommending a 15% change at 0.7 confidence:

| Config | £10 | £25 | £50 | £100 | £150 | £200 |
|---|---|---|---|---|---|---|
| OLD live (flat 0.5%, floor 0.6%, ×1.5) | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| INTERIM (flat 2%, floor 0.1%, ×1.0) | ✓ | ✓ | ✓ | ✓ | heat | cash |
| **NEW defaults** (1% at full signal, ×2 costs, £25 floor, 5 bp net) | ✕ size | ✓ | ✓ | ✓ | heat | heat |
| NEW defaults, no analyst coverage for the name | ✕ size | ✕ | ✕ | ✕ | ✕ | ✕ |

The rewrite does what the old gate could not: it distinguishes sizes and evidence. Under it, a trade
small enough to be eaten by costs is refused, a trade backed only by the winner's confidence is
refused, and a trade backed by research at a size that repays its round trip is approved.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep a configured flat edge, just set it lower (0.2%) | Honest but inert: with a 0.34% round trip nothing clears, so the system would never trade — the failure this ADR exists to fix, merely better documented. |
| Derive the edge from drift only (`|drift| × factor`) | Rebalance economics justify closing a gap, not opening a position, and it ignores the research the system pays for. Drift can be added as a third evidence source later. |
| Charge the whole run's LLM cost to every order | A £20 order would carry a whole session's inference bill and be rejected; the correct scope is the session aggregate. |
| Per-instrument spread and slippage now | Needs a spread source the free data plan does not provide; P2 (risk metrics) will add it, and `costs.spreadBps` stays configurable until then. |
| Delete `minNetBenefitPct` and rely on the ratio test alone | The ratio test is size-blind: it would approve a £5 order with a 0.7% edge, whose £0.02 of benefit is not worth acting on. |

## Consequences

- `RiskLimits` changes shape: `minExpectedBenefitPct` and `expectedReturnPerTradePct` are gone;
  `baseEdgePct`, `maxEdgePct`, `minNetBenefitPct`, `minOrderValue`, `maxOrderValuePct` and
  `llmCostBenefitMultiplier` replace them (`config/default.json`, `config/local.json`,
  `config/committee-paper.json` and the test fixtures are migrated).
- Every decision now persists `signalStrength`, `edgePct`, `costRatioPct`, `netBenefit`,
  `sessionNetBenefit` and `llmCostPerRun` in `details`, and the dashboard gate checklist renders the
  real comparison instead of the old ratio-of-a-constant.
- Gate semantics changed, so the pre-change calibration is documented here rather than silently
  rewritten: **the historical rejections and the historical approvals were both artifacts**.
- Stored decisions written before this change read back with `costRatio` derived from the persisted
  cost total, so the dashboard and any analysis of history keep working.
- Risk of the new gate being too strict is bounded by the calibration table above and by the
  `costBenefitMultiplier` knob (1.0 already trades; 2.0 is the default).
