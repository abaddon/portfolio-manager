# ADR 0009 — Unified decision flow: the committee manages everything

**Date:** 2026-09-02 · **Status:** Accepted (partially supersedes ADR 0007)

## Context

ADR 0007 introduced the Asset Allocation Committee as an *alternative*
decision flow living next to the classic one: a `committee.enabled` config
flag plus a dashboard toggle chose, run by run, between

- the **classic flow** — analyst signals aggregated into a per-ticker
  signal/conviction, an opt-in allocation review adapting target weights, and
  drift-sized trade proposals; and
- the **committee flow** — N≥3 AI asset managers propose, review and vote;
  the winning proposal's targets and orders are applied through the same
  economic gate.

Maintaining two parallel decision paths duplicated intent (two ways to change
a target, two ways to propose an order), doubled the test surface, and made
the system's behavior depend on a runtime toggle. The user asked to merge the
two flows into one: **the new unique flow manages everything as committee.**

## Decisions

1. **The committee is the only decision flow.** Every run executes: analysis
   (4 analysts × universe) → portfolio evaluation → **committee session** →
   economic gate → execution. The classic allocation review
   (`AllocationReviewService.review`) and the analyst-signal decision path
   (`DecisionService.decide` with drift sizing, signal boost and direction
   veto) are removed.

2. **No toggle.** `committee.enabled` (config), the `settings`-table runtime
   override, `POST /api/committee/enable` and the dashboard switch are
   removed. `loadConfig` always requires ≥3 `committee.agents`. The dashboard
   chip becomes a static indicator.

3. **Guardrails move to the committee block.** `maxTarget` and
   `minCashBuffer` (formerly `allocation.adaptation.*`, shared with the old
   review) are now `committee.maxTarget` / `committee.minCashBuffer`
   (defaults 0.25 / 0.05) and still bound every applied target. The
   review-only knobs (`adaptation.enabled`, `maxDeltaPerRun`, `minConviction`)
   and `risk.signalThreshold` are removed. Existing configs that still carry
   the old keys parse cleanly (zod strips unknown keys) — the keys are dead.

4. **Analysts feed the committee, they no longer gate trades.** The four
   analysts still run unchanged and their `targetWeightAdjustment` /
   `adjustmentConfidence` outputs are now passed to every agent in the
   session context as recommendations. Nothing aggregates them into a signal
   anymore; the committee weighs them itself.

5. **Safety gates untouched.** The winning proposal's orders still go through
   `DecisionService.decide` (the former `decideFromOrders`) →
   `DecisionEngine.evaluate` — the exact same economic-correctness gate, in
   the exact same order. Execution (two-phase orders, reconciliation, sweep)
   is unchanged. **No gate was weakened or bypassed.**

6. **Failure containment unchanged.** If a committee session fails (missing
   API keys, agent error, unresolvable vote), the session is persisted
   `FAILED`, the run still completes — with no target changes and no orders
   that run. Consequence accepted: without working committee LLMs the system
   analyzes but never trades (the offline rule-based path no longer produces
   orders).

7. **Service renames/shapes.**
   - `AllocationReviewService` → `AllocationTargetsService`
     (`src/application/services/allocation-targets.ts`), keeping only
     `currentTargets()` (seeds overridden by persisted committee updates).
   - `DecisionService.decideFromOrders` → `decide` — the one decision method.
   - `PipelineDependencies` drops `allocationReview`/`decisions`/`analysts`,
     gains `targets`; run details always carry
     `decisionProcess: "committee"`.
   - `buildApp` accepts an optional `committeeLlms` map so tests inject
     scripted agents (used by the e2e fixtures).

## Consequences

- One decision path to reason about, test and audit; the pipeline branch is
  gone (`PipelineOrchestrator.runOnce` is linear again).
- Every allocation change is debated by the committee and fully traceable on
  the dashboard (proposals, feedback, votes, winner) — there is no silent
  target adaptation anymore.
- Runs depend on committee LLMs being configured: `config/local.json` must
  define ≥3 agents with working provider keys, otherwise runs complete with
  zero orders (visible as a FAILED session).
- Removed config keys (`committee.enabled`, `allocation.adaptation.*`,
  `risk.signalThreshold`) are ignored if still present in user configs.
- The `settings` port stays (unused for now) rather than churning AppPorts.
