# ADR 0013 — Target funding status: the plan may not move ahead of the money

- **Status:** Accepted
- **Date:** 2026-09-14
- **Decision maker:** User (Stefano) + AI agent
- **Work package:** `docs/IMPLEMENTATION_PLAN.md` WP-P0.2 (Phase P0)
- **Related:** ADR 0007/0009 (the committee is the only producer of targets), ADR 0012 (the gate)

## Context

`CommitteeService.runSession` applied the winning proposal's targets **before** its orders were
priced and gated:

```ts
await this.applyWinnerTargets(runId, winner, ctx.targets);   // plan moves here
const decisions = await this.decisions.decide({ … });        // orders may all be rejected
```

The gate can reject every intent of a session — and in the live account it rejected **all 50** of them
over 36 runs (ADR 0012 documents why). The result was measured directly on the account:

| Quantity | Value |
|---|---|
| Target updates persisted | 13 (XOM 0.05 → 0.1551 in a week) |
| Approved orders | **0** |
| MSFT target vs actual weight | 0.25 vs **0.1563** |
| Sum of targets | 0.8928 |

So the system held a plan it had never funded, moved that plan every hour, and had no mechanism to
converge: nothing distinguished "the plan says 25% MSFT and we are buying toward it" from "the plan
says 25% MSFT and we have bought nothing". Every session re-derived a fresh set of target changes from
the same drift, which is why the plan oscillated ±1–5 pp per hour instead of executing.

## Decision

**1. Gating comes first, persistence second.** The session order is now: proposals → feedback → votes
→ **gate the winner's orders** → apply the winner's targets. A target can no longer be recorded before
the run has decided whether it can pay for it.

**2. Every persisted target carries a funding status** (`allocation_targets.status`, migration v7,
default `ACTIVE` so pre-existing rows read correctly):

| Status | Meaning |
|---|---|
| `ACTIVE` | an order approved in this run moves the position toward the target, **or** the current weight is already within `allocation.rebalanceBand` of it (no order is needed at that size) |
| `UNFUNDED` | the plan moved and nothing paid for it: the order was rejected/scaled away, or none was proposed. `funding_note` carries the gate's reason (`no funding order: COST_EXCEEDS_BENEFIT`, …) |

**3. An unfunded target is the plan, not a mistake.** It is kept (the allocation must not silently
revert) and reported:

- the **next** session's context gains an `unfundedTargets` block (`ticker`, `targetWeight`, `why`) and
  the propose prompt instructs the agents to fund those weights before proposing new ones — the
  structural fix for "the plan moves, the book does not";
- event `CommitteeTargetsUnfunded` (with the reasons) whenever a session leaves a plan unfunded, plus
  `funded`/`unfunded` in `committee_sessions.details.funding`;
- `GET /api/targets` returns `status`/`unfundedReason` per target and the Portfolio page labels such a
  target `unfunded` (tooltip = the reason) so the number is never read as "already done".

**4. Re-stating a funded target.** A row that was `UNFUNDED` and becomes funded is rewritten even when
its weight did not change, so the status always reflects the latest session.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Gate first and only persist targets that the approved orders can reach | Drops the plan whenever cash/heat/`maxOrdersPerRun` stops a run mid-rebalance — the committee would lose the destination and re-invent it next hour (the same churn, from the other side). |
| Revert the target when its order is rejected | Same problem: the plan would be erased by a transient (cash, cooldown) rather than by the research changing its mind. |
| Recompute drift against funded targets only | Hides the unexecuted part of the plan from the agents, which is exactly the information they need to prioritise funding. |
| Require an order for every target change (reject the proposal otherwise) | The committee legitimately re-states a plan it already holds; forcing an order would manufacture churn. |
| Emit the residual as a synthetic proposal in the next session | Adds a code path with its own failure modes for something the drift + `unfundedTargets` context already conveys. |

## Consequences

- The dashboard can now distinguish plan (all targets), execution (funded ones) and drift, which is
  what makes "0 orders in 36 runs" visible instead of looking like a healthy plan.
- `AllocationTarget`/`AllocationTargetUpdate` gained optional `status`/`unfundedReason`/`fundingNote`;
  the repository round-trips them; `GET /api/targets` exposes them.
- The invariant "a changed target is funded by an approved order **or** marked UNFUNDED" is asserted in
  the committee unit tests, in the two new pipeline e2e tests (funded and unfunded paths), and by the
  `CommitteeTargetsUnfunded` event.
- Residual funding competes with new ideas for `maxOrdersPerRun` slots: a session that must fund two
  positions has one slot left for a new target change. That is the intended trade-off until the
  turnover budget lands (WP-P1.4).
- Migration is additive and defensive (`ALTER TABLE` inside try/catch, default `ACTIVE`), verified
  against a copy of the live database.
