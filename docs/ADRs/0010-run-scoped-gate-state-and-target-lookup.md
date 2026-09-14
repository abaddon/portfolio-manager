# ADR 0010 — Bug-review fixes: run-scoped gate state, deterministic target lookup, and the fail-open `--config`

- **Status:** Accepted
- **Date:** 2026-09-14
- **Decision maker:** User (Stefano) + AI agent

## Context

A bug-review pass over the whole trading path (domain → application → adapters) found defects in
three areas: the economic gate, the allocation-target read, and configuration loading. Each one
let the system's persisted state or its behaviour disagree with what the code and the docs say
it does.

### 1. The economic gate saw a frozen snapshot, not a running portfolio

`DecisionService.decide` evaluated every order intent of the run against the same pre-run
values: `portfolioHeat = heat` and `cash = snapshot.cash`, both read once before the loop
(`src/application/services/decisions.ts`). `maxOrdersPerRun` allows up to 3 orders per run, so
a run's BUYs were each checked against the untouched starting point and could **collectively**
breach both caps the gate exists to enforce:

- `maxHeatPct` (ADR 0004): three 500 order values on a 10 000 NAV add 0.05 heat each. Starting
  from heat 0.54 with a 0.6 cap, all three passed — ending at 0.69 heat, well over the cap;
- the cash check: two 400 orders against 500 of cash both passed — 800 committed from 500.

The same loop also made a sell-funded rebalance impossible: the proceeds of an approved SELL
were invisible to a BUY later in the same session, which was rejected `INSUFFICIENT_CASH`.

### 2. `allocationTargets.current()` returned several rows per ticker

The query was
`WHERE updated_at = (SELECT MAX(updated_at) ... WHERE b.ticker = a.ticker)`.
`updated_at` is a millisecond ISO timestamp and `applyWinnerTargets` writes **every** target
update of a session with one `now`, so all rows of the latest batch share a timestamp and the
equality matched all of them. `current()` then returned duplicate tickers with different
weights. Downstream `computeDrift` produced duplicate drift rows, and its
`sum > 1` invariant could throw on a duplicated target set.

### 3. A mistyped `--config` silently fell back to the live account

`loadConfig` guarded the CLI overlay with `if (args.overlayPath && existsSync(args.overlayPath))`
(`src/config.ts`), so a typo or a renamed profile was **ignored without a word**. Because
`config/local.json` is `mode: "live"` with live Trading212 credentials, a user asking for the
paper profile (`--config config/paper-real-data.json`) silently traded real money instead —
the exact scenario AGENTS.md forbids ("never auto-switch to live mode").

## Decision

1. **Thread the running gate state through the intent loop.** `decide` keeps
   `availableCash` and `runningHeat`, updates them for every **approved** intent, and evaluates
   each intent against that state:
   - approved BUY → `availableCash -= orderValue`, `runningHeat += orderValue / totalValue`;
   - approved SELL → `availableCash += orderValue`,
     `runningHeat -= position.weight` (floored at 0).
   Intents are evaluated in the order the winning committee proposal listed them, so the
   agent's own ordering decides whether a SELL funds a later BUY. The values are estimates of
   the post-execution portfolio — the gate sizes the *next* intent, it never relaxes one
   already approved, and a broker rejection after the gate does not re-open the earlier
   approvals (the next run sees real broker cash).
2. **Rank the target lookup deterministically.** `current()` is now
   `ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY updated_at DESC, rowid DESC) = 1`, and
   `recentUpdates` breaks its ties on `rowid` too (the previous `id DESC` tie-break compared
   random UUIDs, i.e. no ordering at all). One row per ticker, and the last write of a batch
   wins.
3. **Refuse a missing `--config` overlay.** `loadConfig` throws `ConfigurationError` when
   `overlayPath` was given but the file does not exist, and the CLI throws when `--config` has
   no value or its value looks like another flag. A configuration request that cannot be
   honoured is never silently downgraded to another configuration.

### Also fixed in the same pass

Smaller, self-contained defects found by the same review and fixed alongside (each with a
regression test):

| Area | Defect | Fix |
|---|---|---|
| `scheduler.ts` | `check()` is fire-and-forget with no `catch`, so any rejection from the orchestrator's prologue (reconcile/sweep/DB) became an **unhandled rejection** and Node terminated `pnpm serve` — killing the scheduler and the dashboard | catch and log; the interval survives |
| `sqlite.ts` | no `busy_timeout`, so the documented `pnpm run-once` alongside `pnpm serve` failed instantly with "database is locked" | `PRAGMA busy_timeout = 5000` |
| `trading212.ts` | precision retry used half-**up** rounding, sending the broker a size **larger** than the gate approved (12.5 → 13 at integer precision; 0.4 → 0, an impossible order) | floor toward zero; fail `unsupported` when the size floors to 0 |
| `trading212.ts` | a 429 on order submission permanently FAILED the order although nothing retries a rate-limit failure (AGENTS.md claimed the sweep does) | retry the POST once (safe: a 429 never creates an order) |
| `trading212.ts` | the order-history fallback hard-coded `status: "FILLED"`, hiding a partially-filled-then-CANCELLED order from the audit trail | report the broker's own status |
| `trading212.ts` | `toPlainTicker` guessed `UTX_US_EQ → UTX` silently when metadata was missing — a reconciliation miss that can double-execute | warn with the apiTicker and the guess |
| `trading212.ts` | `cashFlows` could re-fetch the same page (identical `nextPagePath`) and count every flow up to 5× | track visited paths and stop |
| `trading212.ts` | `account()` uses `availableToTrade`, which excludes cash reserved by a pending order and so feeds an understated NAV/heat | **kept** (it is the broker's own pairing with `investments.currentValue`, verified live: 9.29 + 771.39 = 780.68) and documented in code — it is also the cash a new order may actually spend |
| `finnhub.ts` | `debtToEquity` read `totalDebtTotalEquityQuarterly`; the API returns `"totalDebt/totalEquityQuarterly"`, so leverage was **always null** | read the slash-keyed fields, annual as fallback |
| `finnhub.ts` | `marketCap` was in **millions** from Finnhub but in units from the demo adapter — the analyst prompt read a $4.85T company as a $4.85M micro-cap | normalise to units (`× 1e6`) |
| `yahoo.ts` | `Number("1wk") \|\| 60` treated every non-numeric interval as 60 minutes; `candles(count: 0)` returned the whole series (`slice(-0)`) | explicit interval→minutes map; `count: 0` returns `[]` without a request |
| `demo.ts` | `now` was captured at construction, so a long-running `pnpm serve` stamped every run with its boot time (frozen `as_of`, candles, news) | take the clock as a function and resolve per call |
| `config.ts` | `TPM_PORT=abc` produced `web.port = NaN` (validation runs before the env override) and `TPM_PORT=0` listened on a random port | validate the override and throw `ConfigurationError` |
| `money.ts` | `Math.round` breaks ties toward +∞, so negative money rounded toward zero (`roundTo(-0.125, 2) = -0.12`) and could return `-0` | round half away from zero, normalise `-0` |
| `paper-broker.ts` | the simulated ledger never charged UK stamp duty although its own recorded realized costs did | add `stampDutyPct`, wired from `costs.stampDutyPct` |
| `web/server.ts` | `/api/targets` re-added repo rows for tickers no longer in the seeds, showing a target the pipeline ignores | return them under `retired` instead |

## Consequences

- A run can no longer invest past `maxHeatPct` or commit more cash than the account holds by
  stacking approvals inside one session — the two invariants ADR 0004 derived become true for
  the whole run, not just for a single order.
- A sell-then-buy rebalance within one session now clears the cash gate; the reverse order
  does not (the SELL has to come first, as the committee listed it).
- `allocation_targets.current()` returns exactly one target per ticker, so drift, the
  dashboard's allocation view and `CommitteeService.applyWinnerTargets` all read a single
  consistent weight. No migration: the fix is in the query, the stored rows are untouched.
- Tests: `tests/application/decisions.test.ts` (+3: cumulative heat, cumulative cash,
  sell-funded buy), `tests/application/allocation-targets.test.ts` (+1: one row per ticker when
  a batch shares a timestamp), `tests/adapters/config-and-mapping.test.ts` (+11: overlay
  refusal, TPM_PORT, Finnhub field mapping, Yahoo ranges, demo clock),
  `tests/domain/money.test.ts` (+4: sign symmetry), `tests/adapters/scheduler.test.ts` (+1:
  rejected run is contained), `tests/adapters/trading212.test.ts` (+4: no overshoot, sub-precision
  size, 429 retry, degraded mapping warning). Every behaviour change was confirmed to fail
  against the pre-fix code.
- `docs/DECISION_PROCESS.md` §6.4 documents the running-state semantics.

## Alternatives considered

- **Reject a run whose intents would jointly breach the caps** — rejected: it throws away
  orders that are individually sound; walking the state down keeps as many valid orders as the
  caps allow.
- **Re-derive cash/heat from the broker between intents** — rejected: it adds a broker round
  trip per intent (T212 is rate limited to ~1 req/s) for a value the loop can track exactly.
- **Sort the intents by expected benefit so the best order gets the remaining risk budget** —
  not implemented: `ExecutionService` already ranks approved orders by expected benefit for the
  `maxOrdersPerRun` cut, and re-sorting inside the gate would silently reorder the committee's
  own plan.
- **Add a UNIQUE index on `allocation_targets(ticker)`** — rejected: the table is an
  append-only history of target changes (every row is an audit record); uniqueness belongs in
  the read, not in the table.
- **Include cash reserved by in-flight orders in `account().cash`** — rejected: it would raise
  the portfolio NAV correctly but also let the next run's gate re-spend cash that is already
  committed to a pending order. `availableToTrade` is the conservative choice and matches the
  broker's own `investedValue + cash = totalValue` identity.

## Known, deliberately not changed

Reported by the review, understood, and left alone because changing them needs a product
decision rather than a bug fix:

- **`recentByTicker` (cooldown) covers `FILLED`/`PARTIALLY_FILLED`/`SUBMITTED`, not the port's
  words "non-pending orders".** The narrower set is the sane rule: `REJECTED` never reached the
  market, and `FAILED` precision errors must stay retryable. The port docblock is what
  disagrees and should be corrected if this is confirmed.
- **`orderStatus`'s history fallback reads only the newest 50 rows.** An order that filled long
  ago and fell off page 1 stays `SUBMITTED` and is re-polled each run (no corruption, just a
  stale row). Following `nextPagePath` is the fix if it ever bites.
- **Cross-process single-flight.** ADR 0002's guard is per-process, so `pnpm run-once` can
  overlap `pnpm serve`. The `busy_timeout` above removes the instant failure; a lock file or a
  DB lease is the real fix.

