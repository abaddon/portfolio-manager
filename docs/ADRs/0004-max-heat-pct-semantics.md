# ADR 0004 — `maxHeatPct` is a cap on the invested fraction; set it from the cash floor

- **Status:** Accepted
- **Date:** 2026-08-28
- **Decision maker:** User (Stefano) + AI agent

## Context

Portfolio heat is computed as `Σ weight × (1 − stopDistancePct)` (`computeHeat`,
`src/domain/portfolio.ts`) and the BUY gate in `DecisionEngine.evaluate` rejects with
`RISK_LIMIT_EXCEEDED` when `heat + orderValue/NAV > maxHeatPct`. With the default
`stopDistancePct = 0.1`, heat ≈ 0.9 × *invested fraction of NAV*, so `maxHeatPct` behaves as a
cap on how much of the portfolio may be invested at all — not as "capital at risk if every stop
is hit", which is what the name suggests.

The user's live `config/local.json` had `maxHeatPct: 0.12` (following the old `default.json`
comment "lower maxHeatPct toward 0.12 before going live"). Under the actual formula that
rejects every BUY once ~13% of NAV is invested — including the inside-band BUYs enabled by
ADR 0003. The mismatch was found while reviewing `docs/DECISION_PROCESS.md`.

## Decision

Keep the heat formula and the gate unchanged (option 2 of the two proposed); fix the
configuration and its guidance instead:

1. `config/local.json`: `risk.maxHeatPct` 0.12 → **0.855**, derived as
   `(1 − allocation.adaptation.minCashBuffer) × (1 − risk.stopDistancePct)` = 0.95 × 0.9.
   (The cash-floor knob moved to `committee.minCashBuffer` in [ADR 0009](./0009-unified-committee-decision-flow.md); the formula is unchanged.)
   With `heat = 0.9·w` and the gate `0.9·w + Δ ≤ 0.855`, the invested fraction after the trade
   satisfies `w + Δ ≤ 0.855 + 0.1·w ≤ 0.95` for every `w ≤ 0.95` — i.e. the heat gate coincides
   with the allocation cash floor: never stricter (no spurious `RISK_LIMIT_EXCEEDED`), never
   looser (cannot invest past the floor). The cash check (`orderValue ≤ cash`) still applies.
2. `config/default.json` `risk.$comment` now states this rule and no longer recommends 0.12.
3. `docs/DECISION_PROCESS.md` §5 documents the derivation.

## Consequences

- BUYs on the live account are no longer blocked by heat until the portfolio approaches the
  95% invested cap; the other gates (`minConfidence`, cooldown, min benefit, cost multiplier,
  cash, `maxOrderValue`, `maxOrdersPerRun`) are unchanged.
- `maxHeatPct` must be re-derived if `minCashBuffer` or `stopDistancePct` change; the rule is in
  the config comment and the doc.
- No code or test changes; `pnpm verify` unaffected.

## Alternatives considered

- **Redefine heat as `Σ weight × stopDistancePct`** ("loss if every stop hits") — rejected for
  now: it changes a safety gate's semantics in code on a live account and would make the
  existing 0.12 far looser than intended (heat would be ~0.1 × invested); the config-only fix is
  reversible and keeps the tested formula.
- **Leave 0.12** — rejected: it disables buying almost entirely, contradicting the allocation.
