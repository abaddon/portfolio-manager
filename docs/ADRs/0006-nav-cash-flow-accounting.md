# ADR 0006 — Money-weighted NAV: external cash flows mint/redeem units

- **Status:** Accepted
- **Date:** 2026-08-28
- **Decision maker:** User (Stefano) + AI agent

## Context

The dashboard shows a unitized NAV (`nav_per_unit`, `nav_units` on `portfolio_snapshots`).
`PortfolioEvaluationService` kept the units fixed at 1000 forever, so a deposit or withdrawal
changed `navPerUnit` exactly like a market move — performance was unreadable after any cash
movement. The domain already had `NavLedger.applyCashFlow` (mint/redeem units at the current
NAV) with a unit test, but nothing in the pipeline called it. Found while reviewing
`docs/DECISION_PROCESS.md`.

## Decision

1. **New optional broker port method** `BrokerPort.cashFlows(sinceIso): Promise<CashFlow[]>`
   returning external cash movements (`DEPOSIT` positive, `WITHDRAWAL` negative, with currency,
   timestamp and reference). Optional so brokers without a transactions feed (paper) keep the
   fixed-units behaviour and fake ports in tests are unaffected.
2. **Trading212 adapter** implements it from `GET /api/v0/equity/history/transactions`
   (`limit=50`, `time=<since>`, follows `nextPagePath` up to 5 pages). Only `DEPOSIT` and
   `WITHDRAW` items are flows; `FEE`, `TRANSFER`, `INTEREST_ON_FREE_CASH`, `LENDING_INTEREST`
   are ignored (fees and interest are performance). Amounts are normalised by type because the
   docs do not state the sign convention. Rate limit is 6 req/min — one page per run.
3. **`PortfolioEvaluationService`** resumes the ledger from the previous snapshot
   (`NavLedger.resume`), applies every flow in `(previous snapshot asOf, now]` — FX-converted
   into the account currency when needed — then records the new valuation. So
   `units' = units + Σ flow / navPerUnit_prev`, `navPerUnit' = totalValue / units'`.
4. **Containment**: a failing feed or FX rate logs WARN and leaves units unchanged for that run
   (the movement then counts as performance, as before); a flow that would redeem all units is
   refused by the domain and logged. Applied flows are published as `NavCashFlowsApplied`
   (count, net amount, the flows, resulting units) into the event log.
5. NAV per unit is rounded to 4 dp (`PRICE_DP`), units to 4 dp (`WEIGHT_DP`).

## Consequences

- NAV now measures the manager's performance, not the user's funding decisions; the SPY alpha
  on the dashboard becomes meaningful across deposits.
- One extra Trading212 request per run (`/history/transactions`), far inside its 6/min limit.
- The first run after this change has no flow history applied retroactively: units continue
  from the persisted value; earlier deposits remain baked into the historical NAV series.
- New tests: `NavLedger.resume` (domain), transactions parsing (adapter contract), and
  `PortfolioEvaluationService` cases (deposit → units, FX-converted flow, feed failure
  contained, paper broker unchanged, fresh ledger).

## Alternatives considered

- **Infer flows from cash deltas minus known fills** — rejected: fill values in account
  currency are estimates (FX at fill time unknown), dividends and fees would be misread as
  flows, and a threshold would make the ledger heuristic. The broker's own transaction
  history is the source of truth, consistent with the "broker = source of truth" principle.
- **Document as accepted limitation** — rejected: the dashboard's NAV is the main performance
  readout and the user funds the account periodically.
