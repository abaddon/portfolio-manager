# ADR 0005 — Orders settle only on terminal broker states; fills carry the broker's filled quantity

- **Status:** Accepted
- **Date:** 2026-08-28
- **Decision maker:** User (Stefano) + AI agent

## Context

`ExecutionService` confirmed a fill whenever the broker reported `FILLED` **or**
`PARTIALLY_FILLED`, and `confirmFill` always wrote `filledQuantity = order.quantity` (the
requested amount). The Trading212 adapter additionally mapped a `PARTIALLY_FILLED` submission
response to `FILLED`. Consequences:

- a partial fill was recorded as a full fill at the requested quantity — the local ledger,
  realized costs and `OrderFilled` event overstated the position;
- because the order left the open set (`FILLED`), the remainder was never tracked; if the
  broker later cancelled it, nothing was recorded;
- a `CANCELLED` order with a filled part was marked `REJECTED`, losing the fill entirely.

Trading212 market orders normally fill in full, so this was rare — but on a live account
"rare" still corrupts the audit trail when it happens. Found while reviewing
`docs/DECISION_PROCESS.md`.

## Decision

A single `ExecutionService.settle(order, remoteStatus)` step, used by both the post-submit
poll and the start-of-run sweep:

1. **Only terminal states settle** an order: `FILLED`, `REJECTED`, `CANCELLED`.
   `PARTIALLY_FILLED` (and `NEW`, `CONFIRMED`, …) leave it `SUBMITTED` for the next sweep, so a
   fill is recorded exactly once, with its final quantity.
2. **The fill carries the broker's filled quantity.** When it is smaller than requested
   (partial fill, or remainder cancelled) the local order quantity is aligned to it and
   `details.partialFill = { requestedQuantity, filledQuantity, brokerStatus }` is stored.
   Realized costs are computed on the filled share of the estimated account value, scaled by
   `fillPrice / estimatedPrice`.
3. `REJECTED` / `CANCELLED` **with** a filled part ⇒ that part is confirmed as the fill (the
   order ends `FILLED` with the aligned quantity); **without** one ⇒ `REJECTED`.
4. The Trading212 adapter reports a `PARTIALLY_FILLED` submission response as `SUBMITTED`
   (not `FILLED`), so it flows through the poll/sweep path above.
5. A `FILLED` status with no reported quantity (some history rows) still means fully filled.
   In the sweep a terminal fill without a reported price waits for the next sweep, as before.

## Consequences

- Positions, realized costs and events reflect what actually executed; cooldown and
  reconciliation see the true quantity.
- A partially filled order keeps being swept every run until terminal; the dashboard shows it
  `SUBMITTED` meanwhile.
- Legacy rows already in `PARTIALLY_FILLED` status (from before this change) are still in the
  open set; a later terminal status settles them the same way.
- Tests: three new sweep cases (`tests/application/execution-sweep.test.ts`) and one adapter
  case (`tests/adapters/trading212.test.ts`). `docs/DECISION_PROCESS.md` §7 updated.

## Alternatives considered

- **Record the partial fill immediately and keep the order open** — rejected: `markFilled`
  is single-shot; recording twice (partial then final) would double-count costs and events.
- **Cancel the remainder ourselves on partial fill** — rejected: it adds an order-mutating API
  call to a path that must stay idempotent; the broker's own settlement is sufficient for
  hourly market orders.
