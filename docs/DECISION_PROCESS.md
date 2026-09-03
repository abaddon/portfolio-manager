# Decision process — from market analysis to executed orders

This document explains, step by step, the full decision chain implemented in this system: **which assets are analysed**, **how the asset allocation is defined and evolved**, and **which orders are executed** (and why others are rejected). It describes the code as it exists, not an aspiration — every formula below is implemented in `src/`. Where the code has a known simplification, it is called out explicitly (see §7.1).

Since [ADR 0009](./ADRs/0009-unified-committee-decision-flow.md) there is exactly **one** decision flow: the **Asset Allocation Committee** manages every allocation change and every order. The former classic flow (analyst-signal review + drift-sized decisions) and its toggle are gone.

Related decisions: [ADR 0001 — FRED macro integration](./ADRs/0001-fred-macro-integration.md), [ADR 0002 — single-flight execution](./ADRs/0002-single-flight-execution.md), [ADR 0007 — asset allocation committee](./ADRs/0007-asset-allocation-committee.md), [ADR 0009 — unified committee decision flow](./ADRs/0009-unified-committee-decision-flow.md).

---

## 1. The hourly cycle (pipeline overview)

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Trigger: every hour at minute 0 while the market is open (scheduler),     │
│           or "▶ Run now" on the dashboard (manual runs skip the hour guard)│
└────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
  0. Housekeeping (Trading212 broker only — practice OR live; skipped for the
     paper broker — BEFORE anything else, even before the hour guard)
     • reconcile stale PENDING orders against broker open orders
     • sweep SUBMITTED orders for late fills
     • re-submit orders that failed on quantity-precision-mismatch
        │
        ▼
  1. Allocation bootstrap  → only when no targets exist anywhere (§4.1)
  2. Market analysis       → 4 analysts × every universe ticker (§3)
  3. Portfolio evaluation  → snapshot, drift vs targets, heat, NAV, benchmark (§5)
  4. Committee session     → propose → feedback → vote → apply winner (§6)
  5. Execution             → two-phase orders, fill confirmation, realized costs (§7)
        │
        ▼
  Everything is persisted (runs, reports, snapshots, targets, sessions,
  decisions, orders, events) and shown on the dashboard.
```

**Hour guard (idempotency):** one run per market hour is enforced for scheduled/startup runs. Precisely: a run that already exists for the current market hour blocks a second one **unless it is `FAILED`** (a failed run may be retried in the same hour). A `SKIPPED` run (market closed) counts as existing. `pnpm run-once --force` bypasses the *market-open* check, not the hour guard. Manual runs (dashboard button) always execute a fresh cycle by design (`skipHourGuard`).

**Single-flight execution** ([ADR 0002](./ADRs/0002-single-flight-execution.md)): at most one pipeline executes at a time, whichever trigger started it (scheduler, startup or "Run now"). A manual trigger while a run is in flight is rejected with `409` (the dashboard tracks the in-flight run to completion instead of starting a second one); a scheduled trigger during an in-flight run records a `SKIPPED` run ("a run is already in progress") — it never queues. The RUNNING state is persisted to `runs` the moment a run starts, so refreshing the dashboard mid-run keeps the button in the "Running…" state and resumes polling until the run settles.

---

## 2. Which assets are analysed

The universe comes from configuration:

- `universe.tickers` — the list of instruments the system follows (plain symbols like `RTX`, `MSFT`; the Trading212 adapter resolves them to API instrument ids such as `UTX_US_EQ` via the metadata endpoint, and maps them back, e.g. `UTX_US_EQ → RTX`).
- `universe.benchmark` — an index (default `SPY`) used for relative performance, never traded.

> **Universe ≠ allocatable set.** Every universe ticker is *analysed* each run, but the committee may only allocate and order tickers that have an **allocation target** (§4): proposals touching other tickers are dropped with a note in the session details. A ticker in `universe.tickers` without a target produces analysis reports every hour and never a target change or order. In bootstrap mode (§4.1) targets are derived from the broker once; adding a ticker to the universe later does **not** create a target for it — add it to `allocation.targets` (or hold it in the account before the first run).

Each run, per ticker, the analysis step gathers:

| Input | Source | If unavailable |
|---|---|---|
| Quote (price, prev close, change %) | Finnhub (or demo) | contained: `null`, run continues |
| Hourly candles (last 40) | Yahoo Finance (free; Finnhub free tier has no `/stock/candle`) | contained |
| News (last 10 items) | Finnhub | contained |
| Fundamentals (P/E, P/B, growth, margins…) | Finnhub | contained |
| Sentiment | **news scoring** (DeepSeek when available, keyword heuristic offline). The Finnhub social-sentiment endpoint is tried first but returns 403 on the free plan, so news scoring is the effective path. | contained |
| Macro regime | **FRED** (fed funds, 10Y/2Y yields, 10Y–2Y spread, VIX, CPI YoY, unemployment, S&P 500) — fetched **once per run** and shared by all analysts ([ADR 0001](./ADRs/0001-fred-macro-integration.md)) | contained: `macro=null`, run continues |

One failing source never kills the run — the affected analyst works with what exists and says so in its rationale. FRED series are daily/monthly (not intraday) and lag publication; analysts treat them as macro regime context, not tick-level signals.

---

## 3. The four analysts

Each of the four roles is a separate LLM call (or deterministic offline rule-set when no API key is configured), producing a **structured output**:

```json
{
  "conclusion": "bullish | bearish | neutral",
  "confidence": 0..1,                // confidence in the conclusion (display only)
  "rationale": "2–4 sentences",
  "targetWeightAdjustment": -1..1,   // the analyst's recommended Δ of the target weight
  "adjustmentConfidence": 0..1       // how confident it is that the Δ helps the portfolio
}
```

Before aggregation `targetWeightAdjustment` is clamped: **±0.5** for LLM analysts (the prompt asks for |Δ| ≤ 0.15 unless the evidence is overwhelming), **±0.15** for the offline rule-based analysts.

| Analyst        | Role                          | Primary inputs                   |
|----------------|-------------------------------|----------------------------------|
| `market`       | price action, trend, momentum | candles, quote, benchmark, macro |
| `sentiment`    | market mood                   | sentiment score (news-based)     |
| `news`         | materiality of recent news.   | headlines                        |
| `fundamentals` | valuation & financial health  | P/E, growth, margins             |

**The analysts no longer gate trades.** Their reports — conclusion, rationale, `targetWeightAdjustment` and `adjustmentConfidence` — are handed to every committee agent as per-ticker research (§6); the committee weighs them itself. Nothing aggregates the adjustments into a signal anymore.

### Glossary — the numbers that gate trades

| Term | Definition | Used by |
|---|---|---|
| **winner confidence** | the winning proposal's self-assessed `confidence` (0..1), carried onto each of its order intents | `minConfidence` gate, expected-benefit scaling (§6.4) |
| **conclusion confidence** | each analyst's `confidence` in its bullish/bearish/neutral call | display only — the `conf 0.xx` per analyst on the dashboard. **Not** a gate. |

---

## 4. Asset allocation: definition and evolution

### 4.1 Where the allocation comes from

Priority order at the start of every run (`AllocationBootstrapService`, then `AllocationTargetsService.currentTargets()`):

1. **Persisted committee rows** (`allocation_targets` table) — the evolving allocation. When config seeds exist, repo rows override seeds **only for tickers still in the seeds**; rows for tickers removed from the seeds are ignored.
2. **Configured seeds** — `allocation.targets` in the config.
3. **Bootstrap from the broker** — only when the config list is **empty and no repo rows exist**: the existing portfolio *is* the allocation. The current position weights (in account currency) become the initial targets, persisted with the rationale `"bootstrapped from the existing broker portfolio"` (event `TargetsBootstrapped`). Bootstrap happens once; afterwards the repo rows are the complete target set (see the note in §2).

If there are no targets AND no positions, the run fails with a clear configuration error.

### 4.2 How the allocation evolves — the committee, with guardrails

The only producer of target updates is the winning committee proposal (§6). Applied targets are bounded by two guardrails ([ADR 0009](./ADRs/0009-unified-committee-decision-flow.md)):

| Guardrail | Default | Meaning |
|---|---|---|
| Per-name cap | `committee.maxTarget` 0.25 | no single name above 25% |
| Cash floor | `committee.minCashBuffer` 0.05 | total invested targets ≤ 95% — if the winner's allocation would breach it, **all** weights are scaled by `(1 − minCashBuffer)/Σ` |

Every accepted change is persisted with its **rationale** (the winning agent's words + vote points) and confidence, and displayed in the dashboard's *Allocation* and *Committee session* panels. Tickers the winner does not mention keep their current target.

---

## 5. Portfolio evaluation (broker = source of truth)

Each run reads the Trading212 account and positions, enriches prices with live quotes (falling back to the broker price), converts every instrument value into the account currency via FX (falling back to 1), and computes:

- **Snapshot** — cash, positions, market values, weights, unrealized P&L, total value.
- **Drift** — per target ticker: `drift = currentWeight − targetWeight`; `|drift| ≤ rebalanceBand` ⇒ inside band (`hold` hint), otherwise `buy` (underweight) or `sell` (overweight). Drift and hints are part of the committee's context.
- **Heat** — `Σ weight × (1 − stopDistancePct)`: risk capital at stake, checked against `maxHeatPct` in the BUY gate (§6.4).
  > **Read this before tuning `maxHeatPct`.** With `stopDistancePct = 0.1`, heat ≈ 0.9 × *invested fraction of NAV*, and the gate is `heat + orderValue/NAV ≤ maxHeatPct`. So `maxHeatPct` is effectively a **cap on the total invested fraction**: at `maxHeatPct = 0.3` every BUY is rejected (`RISK_LIMIT_EXCEEDED`) once ~33% of NAV is invested; at `0.12` once ~13% is invested. `stopDistancePct` is only a parameter of this formula — **no stop-loss order is ever placed**. To make the heat gate coincide with the allocation cash floor (never stricter, never looser) set `maxHeatPct = (1 − minCashBuffer) × (1 − stopDistancePct)` — 0.855 with the defaults ([ADR 0004](./ADRs/0004-max-heat-pct-semantics.md)).
- **NAV** — money-weighted unitized net asset value (`NavLedger`, [ADR 0006](./ADRs/0006-nav-cash-flow-accounting.md)): the first snapshot mints **1000 units**; every later run first applies the **external cash flows** since the previous snapshot (deposits/withdrawals from the Trading212 transactions history, FX-converted to the account currency) by minting/redeeming units at the *previous* NAV, then `navPerUnit = totalValue / units`. A deposit therefore raises units, not NAV. Contained: if the transactions feed fails, units stay unchanged for that run (WARN) and the change counts as performance; the paper broker has no feed (units fixed at 1000). Applied flows are recorded in the `NavCashFlowsApplied` event.
- **Benchmark** — SPY day change for relative performance (α shown on the dashboard).

---

## 6. Decisions: the Asset Allocation Committee

One session per run ([ADR 0007](./ADRs/0007-asset-allocation-committee.md), now the only flow per [ADR 0009](./ADRs/0009-unified-committee-decision-flow.md)). Inputs: the snapshot, drift + hints, heat, the current targets and every analyst report (conclusion, rationale, recommended adjustment + its confidence).

```
1. PROPOSE    every agent proposes {title, rationale, confidence,
              targets, orders} on its own model (OpenRouter by default)
2. FEEDBACK   every agent reviews every OTHER proposal
              (verdict positive/negative + comment)
3. VOTE       every agent casts ONE vote for the other proposal it
              favours most (1 point per vote; cumulative across rounds)
   tie at the top → the proposal(s) with the fewest votes are
   EXCLUDED and the agents vote again (run-off); all-tied → re-vote;
   cap = committee.maxVoteRounds, then deterministic fallback
   (most positive feedback, then earliest proposal)
4. APPLY      the winner's targets are persisted under the §4.2 guardrails;
              its orders are priced and pass the SAME economic gate (§6.4)
              before execution (§7)
```

Details:

- **Agents & models** — `committee.agents[]` (≥ 3, validated at startup): `{id, name, provider, model, temperature?}`. Each agent gets its own LLM client; OpenRouter models need `OPENROUTER_API_KEY` in `.env`. With exactly 3 agents and one vote each, a round is either decisive (2/1/0) or a three-way tie (1/1/1), so the exclusion tie-break only triggers with 4+ agents — the rule is implemented for any N.
- **Sanitization** — targets/orders for tickers outside the allocation are ignored (noted in the session details); weights clamp to 0..1; oversized text fields are truncated at persistence, never rejected.
- **Safety** — committee orders never bypass the gates: they become `Decision` rows via `DecisionService.decide` → the same `DecisionEngine.evaluate` checks (quantity, confidence ≥ `minConfidence`, `maxOrderValue`, cooldown, expected benefit, costs, cash/heat for BUYs). Sizing: `quantity = orderValue / (price × FX)`, SELLs capped at the held quantity, values rescaled down to `maxOrderValue` when they overshoot it.
- **Failure containment** — a failing agent call fails the session (status `FAILED`, visible on the dashboard); the run completes with **no target changes and no orders** that run. With no working committee LLMs the system therefore analyses but never trades.
- **Timing** — the winner's targets take effect from the next run's evaluation.
- **Costs** — a 3-agent session makes ~12 LLM calls (3 proposals + 6 feedback + 3 votes), more with extra vote rounds or agents.
- **Audit trail** — tables `committee_sessions`, `committee_proposals` (points, status `active|excluded|accepted|defeated`, excluded round), `committee_feedback`, `committee_votes` + events `CommitteeSessionStarted`, `CommitteeProposalsReady`, `CommitteeFeedbackCompleted`, `CommitteeVoteRoundCompleted`, `CommitteeProposalExcluded`, `CommitteeWinnerAccepted`, `CommitteeTargetsApplied`, `CommitteeSessionCompleted`, `CommitteeSessionFailed`. The dashboard committee page shows every proposal (targets, orders, rationale, points, status), the feedback each received, every vote round's points, and the accepted proposal.

### 6.1–6.3 Pricing, costs, benefit (per order intent)

```
price      = held position price, or live quote for a new BUY (else rejected INSTRUMENT_UNAVAILABLE)
quantity   = round(orderValue / (price × fxRate), 4)   // SELL capped at held; 0 ⇒ OPPORTUNITY_TOO_SMALL
             rescaled down when value would exceed maxOrderValue
spread     = spreadBps / 10 000 × orderValue
fxFee      = fxFeePct × orderValue                (only when instrument currency ≠ account currency)
stampDuty  = stampDutyPct × orderValue            (only for BUYs of UK-listed ".L" tickers)
platformFee= platformFeePct × orderValue
expectedBenefit = orderValue × expectedReturnPerTradePct/100 × (0.5 + 0.5 × confidence)
```

### 6.4 The economic-correctness gate (in order)

`DecisionEngine.evaluate` checks, in this exact order, and rejects with the corresponding reason:

| # | Check | Rejection reason |
|---|---|---|
| 1 | action is HOLD | (always approved — a domain no-op; the service never produces HOLD proposals) |
| 2 | quantity > 0 | `OPPORTUNITY_TOO_SMALL` |
| 3 | intent confidence ≥ `minConfidence` | `NO_CONVICTION` |
| 4 | order value ≤ `maxOrderValue` | `RISK_LIMIT_EXCEEDED` |
| 5 | ticker outside the cooldown window (`tickerCooldownDays`, any order on that ticker) | `COOLDOWN_ACTIVE` |
| 6 | expectedBenefit ≥ `minExpectedBenefitPct` × orderValue | `OPPORTUNITY_TOO_SMALL` |
| 7 | expectedBenefit ≥ total costs × `costBenefitMultiplier` | `COST_EXCEEDS_BENEFIT` |
| 8 | BUY only: orderValue ≤ cash; heat + orderValue/NAV ≤ `maxHeatPct` | `INSUFFICIENT_CASH` / `RISK_LIMIT_EXCEEDED` |

SELLs have no cash or heat check. Every decision — approved or rejected — is persisted with its full rationale (agent, order reason, cost breakdown) and the exact reason. That is what the dashboard's *Decisions* panels show.

---

## 7. Execution: which orders are placed

Approved non-HOLD decisions become orders:

1. **Ranking & cap** — sorted by expected benefit (best first), limited to `maxOrdersPerRun`.
2. **Two-phase reservation** — the order is persisted as `PENDING` **before** anything is sent (Trading212 order placement is not idempotent; a crash can never lose or double an intent).
3. **Submission** — market order via the Trading212 API (negative quantity = sell; plain symbol resolved to the instrument id).
   - `quantity-precision-mismatch` errors are parsed from the response detail and retried with progressively lower precision; the accepted quantity is written back to the local order.
4. **Fill confirmation** — only a **terminal** broker state settles an order ([ADR 0005](./ADRs/0005-partial-fill-settlement.md)):
   - immediate `FILLED` → confirmed at once;
   - still open (`NEW`, `PARTIALLY_FILLED`) → polled once after ~1.5 s; if still not terminal, left `SUBMITTED`;
   - the **sweep** (start of every run) re-polls open orders; filled orders that 404 from the active-orders endpoint are looked up in `/history/orders` and confirmed with the actual fill price;
   - the recorded fill carries the **broker's filled quantity**: if it is smaller than requested (partial fill, or the remainder `CANCELLED`) the local order quantity is aligned to it and `details.partialFill = {requestedQuantity, filledQuantity, brokerStatus}` is stored; `REJECTED`/`CANCELLED` with nothing filled ⇒ `REJECTED`.
5. **Realized costs** — recomputed with the §6.3 model on the estimated order value scaled by `fillPrice / estimatedPrice` (not on the broker-reported filled value) and persisted on the fill (spread, FX, stamp duty).
6. **Crash recovery** — stale `PENDING` orders (older than 15 min) are matched against the broker's open orders (ticker, side, quantity, ±15 min): match ⇒ adopt the broker id; no match ⇒ `FAILED` (never blind re-submission). Orders that failed only on quantity-precision within the last 24 h are re-submitted automatically on the next run (safe: a 400 means the broker never created the order).

Events emitted along the way: `OrderRequested`, `OrderRetried`, `OrderFilled`, `OrderRejected`, `OrderFailed` — all persisted.

### 7.1 Known simplifications (not implemented)

- **No stop-loss / limit orders** — only market orders; `stopDistancePct` feeds the heat formula (§5) and nothing else.
- **SELLs are not gated on cash or heat** (§6.4).
- **Cooldown is per ticker, any side** — a SELL puts the ticker in cooldown for a later BUY too.

---

## 8. Persistence (the audit trail)

| Step | Persisted as |
|---|---|
| Run | `runs` (status, market open, error, summary counts; `details.decisionProcess` is always `committee`) |
| Raw inputs | `market_snapshots`, `news_items` (deduplicated), `sentiment_scores`, `macro_snapshots` (FRED, one per run) |
| Analysis | `analysis_reports` (conclusion, confidence, Δ, rationale, engine) |
| Allocation | `allocation_targets` (weight, original seed, rationale, conviction) |
| Portfolio | `portfolio_snapshots` (incl. `nav_units`, `nav_per_unit` — units adjusted for cash flows) + `position_snapshots` (FX-converted) |
| Committee | `committee_sessions`, `committee_proposals`, `committee_feedback`, `committee_votes` |
| Decisions | `decisions` (proposal, expected benefit, estimated costs, reason, committee source meta) |
| Orders | `orders` (lifecycle, broker id, fill, realized costs, errors) — costs have no table of their own |
| Everything | `events` (append-only domain event log) |

---

## 9. Config knobs that change these decisions

| Decision point | Knobs |
|---|---|
| Which assets | `universe.tickers` (analysed), `allocation.targets` (allocatable — §2), `universe.benchmark` |
| Allocation | `allocation.targets` (empty ⇒ bootstrap), `allocation.rebalanceBand` (context for the committee), `committee.{maxTarget,minCashBuffer}` (§4.2 guardrails) |
| Committee | `committee.agents[]` (≥ 3 required), `committee.maxVoteRounds` |
| Cost model | `costs.{spreadBps,fxFeePct,stampDutyPct,platformFeePct}` |
| Gate | `risk.{minConfidence,minExpectedBenefitPct,costBenefitMultiplier,maxOrderValue,maxHeatPct,tickerCooldownDays,stopDistancePct,expectedReturnPerTradePct}` |
| Execution | `risk.maxOrdersPerRun` |

The only cash floor in force is `committee.minCashBuffer` (the former `allocation.adaptation` block and `risk.signalThreshold` belonged to the removed classic flow and are ignored if still present).

## 10. Worked example (from a live practice run)

Values below were produced under the committee flow with the user's practice-account knobs (`risk.minConfidence` 0.4, `costBenefitMultiplier` 1.5):

- A 3-agent session ended 2/1 in round 1; the winner proposed raising **MSFT** from 0.20 to 0.25 and buying ~£120 of it. The target was persisted under the per-name cap (0.25 is exactly the cap) with the rationale `"committee <agent> (2 pts): …"`.
- The BUY intent was priced live, estimated costs ≈ £0.19 (spread + 0.15% FX), expected benefit (orderValue × 0.5% × (0.5 + 0.5 × winner confidence)) cleared both `minExpectedBenefitPct` and costs × 1.5 ⇒ **approved** (`ECONOMICALLY_VIABLE`) → market order filled with realized costs recorded.
- A later session whose winner confidence was below `minConfidence` saw its order rejected with `NO_CONVICTION` — same gate math, fully traceable on the dashboard.
