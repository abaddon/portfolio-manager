# Decision process — from market analysis to executed orders

This document explains, step by step, the full decision chain implemented in this system: **which assets are analysed**, **how the asset allocation is defined and evolved**, and **which orders are executed** (and why others are rejected). It describes the code as it exists, not an aspiration — every formula below is implemented in `src/`. Where the code has a known simplification, it is called out explicitly (see §7.1).

Since [ADR 0009](./ADRs/0009-unified-committee-decision-flow.md) there is exactly **one** decision flow: the **Asset Allocation Committee** manages every allocation change and every order. The former classic flow (analyst-signal review + drift-sized decisions) and its toggle are gone.

Related decisions: [ADR 0001 — FRED macro integration](./ADRs/0001-fred-macro-integration.md), [ADR 0002 — single-flight execution](./ADRs/0002-single-flight-execution.md), [ADR 0007 — asset allocation committee](./ADRs/0007-asset-allocation-committee.md), [ADR 0009 — unified committee decision flow](./ADRs/0009-unified-committee-decision-flow.md), [ADR 0011 — LLM usage accounting and budget](./ADRs/0011-llm-usage-accounting-and-budget.md), [ADR 0012 — edge-honest, size-aware gate](./ADRs/0012-edge-honest-size-aware-gate.md).

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

**Cadence — the expensive path is event-driven (WP-P1.1).** By default
(`schedule.triggerMode: "material"`) every market hour still runs the *cheap* pass: it reads the broker,
snapshots the portfolio, computes drift/heat/NAV and sweeps open orders. The **analysts and the committee
run only when something material changed** ([`src/domain/cadence.ts`](../src/domain/cadence.ts)), with the
triggers evaluated from data the cheap pass already has:

| Trigger | Condition |
|---|---|
| `unfunded-target` | a previous session left a target marked `UNFUNDED` (ADR 0013) |
| `drift` | any target outside `allocation.rebalanceBand` and at least `schedule.materiality.driftPct` away from its weight |
| `nav-move` | `\|NAV change since the previous run\| ≥ schedule.materiality.navMovePct` |
| `new-news` | headlines gathered since the previous session within `newsLookbackHours` |
| `planning-slot` | `planningIntervalHours` (default 20 h) since the last completed session, or no session on record |
| `manual` / `always` | the dashboard button / `pnpm run-once --force` (`skipHourGuard`), or `triggerMode: "always"` |

A run records its decision in `runs.details.cadence` (`{material, triggers, reason, mode}`), emits it on
`AnalysisCompleted`, and the Activity page shows stats-only hours as such (with the reason) instead of
hiding them. After a session that spent, the **drift trigger** is suppressed for
`schedule.materiality.driftCooldownHours` (default 3 h): a position 8 points off target is still 8 points
off an hour later unless something else moved, and re-deciding it every hour is what the cadence exists
to stop. NAV moves, unfunded targets, fresh news, the planning slot and manual runs all ignore the
cooldown. The reason this exists: the review measured ~37 inference calls per run and most runs
changing nothing — the hourly LLM cycle was the single largest cost in the system
(`docs/DECISION_PROCESS_REVIEW.md` §3.5, §6.1).

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
| Sentiment | **news scoring** (DeepSeek when available, keyword heuristic offline). The Finnhub social-sentiment endpoint is tried first but returns 403 on the free plan, so news scoring is the effective path. **Exactly one sentiment call per ticker per run**, and a headline is scored only once per process (`(ticker, headline)` memo); a source that fails permanently (`unsupported`, i.e. the free-plan 403) is disabled for the process instead of re-tried per ticker per run. | contained |
| Macro regime | **FRED** (fed funds, 10Y/2Y yields, 10Y–2Y spread, VIX, CPI YoY, unemployment, S&P 500) — fetched **once per run** and shared by all analysts ([ADR 0001](./ADRs/0001-fred-macro-integration.md)) | contained: `macro=null`, run continues |
| Days to earnings | **Finnhub `/calendar/earnings`** — one request per run for the whole universe (WP-P2.3); the analysts and the committee are told how many days until each name reports and treat a print inside a few days as event risk | contained: `daysToEarnings=null` (unknown, not "no report") |
| Upcoming macro releases | Optional provider feed (`EventCalendarPort.upcomingMacro`); Finnhub's free tier does not cover it, so the field is absent and nothing is reported rather than invented | contained: no releases |

One failing source never kills the run — the affected analyst works with what exists and says so in its rationale. FRED series are daily/monthly (not intraday) and lag publication; analysts treat them as macro regime context, not tick-level signals.

---

## 3. The four analysts

Since WP-P1.2 the four roles are produced by **one LLM call per ticker** (the four prompts and payloads overlap almost completely), each role validated against its own schema; a role whose object is missing or invalid after the client's repair retry falls back to that role's deterministic offline rule-set for that ticker, and the report records which engine produced it. The offline path (no API key) still runs the four rule-based analysts separately. Each role produces a **structured output**:

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
| *(one call)*   | all four roles below          | the ticker's full payload once    |
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
| **Trust region** | `committee.trustRegion` 0.4 (+ `trustRegionConfidenceWeight` 0.5) | the session applies `w + k × damp(conf) × (w' − w)` with `damp = (1 − cw) + cw × confidence` — one 2/1 vote may not re-shape the book |
| **Turnover budget** | `committee.maxTurnoverPctPerSession` 0.1 | Σ\|Δweight\| per session ≤ 10% of NAV; when exceeded, every move is scaled by the same factor (never one name silently dropped) |
| **Dead zone** | `committee.minWeightChange` 0.005 | a \|Δweight\| below 50 bp is not worth an order |
| **Sector caps** | `committee.sectorCaps` (default cap 0.4 in `default.json`) | exposure to any one sector is capped: a sector above its cap is scaled back proportionally and the excess stays **in cash** rather than being pushed into another sector ([WP-P2.2](../docs/IMPLEMENTATION_PLAN.md)). Only names whose sector is known (Finnhub fundamentals, fetched by the metrics step) are capped |
| **Minimum positions** | `committee.minPositions` 0 | the allocation should hold at least this many funded positions (weight ≥ 1%); falling below it is recorded on the session (`details.trustRegion.diversification.belowMinPositions`) instead of being silently accepted |
| Cash floor | `committee.minCashBuffer` 0.05 | total invested targets ≤ 95% — if the winner's allocation would breach it, **all** weights are scaled by `(1 − minCashBuffer)/Σ` |
| Funding status | — | each persisted target is `ACTIVE` (funded by an approved order of the run, or already within `allocation.rebalanceBand`) or `UNFUNDED` ([ADR 0013](./ADRs/0013-target-funding-status.md)) |

The trust region, the dead zone and the turnover budget are applied **before** the orders are priced, so the gate
judges the weights the run will actually hold (`CommitteeService.shapeWinnerTargets` →
`applyTargetTrustRegion` in `src/domain/committee.ts`). The winner's raw request always stays visible:
`committee_sessions.details.trustRegion.requested` records `{ticker, current, requested, applied, skipped}`, and a
scaled target's rationale carries the `[turnover budget: …]` / `[dead zone]` note. Because the shaped weight is what
gets recorded, the funding check (ADR 0013) compares the approved orders against the damped target.

Every accepted change is persisted with its **rationale** (the winning agent's words + vote points) and confidence, and displayed in the dashboard's *Allocation* and *Committee session* panels. Tickers the winner does not mention keep their current target.

**The plan never moves ahead of the money.** The orders are priced and gated *before* the targets are
persisted (ADR 0013): a target the run could not fund is stored as `UNFUNDED` with the gate's reason,
raised as `CommitteeTargetsUnfunded`, and handed to the next session as an `unfundedTargets` residual
that the agents are told to fund before proposing anything new. Without this, the live account held a
plan it had never executed — targets moving every hour (XOM 0.05 → 0.1551 in a week) while 50 of 50
decisions were rejected, leaving MSFT at a 0.1563 weight against a 0.25 target.

---

## 5. Portfolio evaluation (broker = source of truth)

Each run reads the Trading212 account and positions, enriches prices with live quotes (falling back to the broker price), converts every instrument value into the account currency via FX (falling back to 1), and computes:

- **Snapshot** — cash, positions, market values, weights, unrealized P&L, total value.
- **Drift** — per target ticker: `drift = currentWeight − targetWeight`; `|drift| ≤ rebalanceBand` ⇒ inside band (`hold` hint), otherwise `buy` (underweight) or `sell` (overweight). Drift and hints are part of the committee's context.
- **Instrument risk metrics** (WP-P2.1) — from the same hourly candles the analysts use (plus **one** benchmark series per run): realised volatility (per bar and annualised), **beta** and correlation vs the benchmark, trend vs the 20-bar average, 5/20-bar momentum, the window's worst drawdown, where the price sits in its recent range, and an unusual-volume flag. The portfolio's concentration (`largestWeight`, `effectivePositions`, `top3Weight`) is computed alongside. They reach the committee as an `instrumentRisk` block, and every failure is contained (a name without candles gets null metrics, a missing benchmark leaves beta null and everything else intact) — an event `RiskMetricsCollected` records what was gathered.
- **Heat** — `Σ weight × (1 − stopDistancePct)`: risk capital at stake, checked against `maxHeatPct` in the BUY gate (§6.4).
  > **Read this before tuning `maxHeatPct`.** With `stopDistancePct = 0.1`, heat ≈ 0.9 × *invested fraction of NAV*, and the gate is `heat + orderValue/NAV ≤ maxHeatPct`. So `maxHeatPct` is effectively a **cap on the total invested fraction**: at `maxHeatPct = 0.3` every BUY is rejected (`RISK_LIMIT_EXCEEDED`) once ~33% of NAV is invested; at `0.12` once ~13% is invested. `stopDistancePct` is only a parameter of this formula — **no stop-loss order is ever placed**. To make the heat gate coincide with the allocation cash floor (never stricter, never looser) set `maxHeatPct = (1 − minCashBuffer) × (1 − stopDistancePct)` — 0.855 with the defaults ([ADR 0004](./ADRs/0004-max-heat-pct-semantics.md)).
- **NAV** — money-weighted unitized net asset value (`NavLedger`, [ADR 0006](./ADRs/0006-nav-cash-flow-accounting.md)): the first snapshot mints **1000 units**; every later run first applies the **external cash flows** since the previous snapshot (deposits/withdrawals from the Trading212 transactions history, FX-converted to the account currency) by minting/redeeming units at the *previous* NAV, then `navPerUnit = totalValue / units`. A deposit therefore raises units, not NAV. Contained: if the transactions feed fails, units stay unchanged for that run (WARN) and the change counts as performance; the paper broker has no feed (units fixed at 1000). Applied flows are recorded in the `NavCashFlowsApplied` event.
- **Benchmark** — SPY day change for relative performance (α shown on the dashboard).
- **Cash as a managed position** (WP-P1.5) — cash has a *target* (`allocation.cashTarget`, or derived as `1 − Σtargets` floored at `committee.minCashBuffer`), a *band* (`allocation.cashBand`) and a *measured cost*: `cashDrag = cash × benchmark day change` (what the idle cash missed, or avoided). A breach emits `CashPolicyBreached` and reaches the committee context as `cashPolicy` (`targetWeight`, `currentWeight`, `drift`, `hint: invest-cash | raise-cash | hold`, `uninvested`, `dailyDragPct`, `annualisedDragPct`), so "why is a quarter of the book idle" is a question the system asks itself instead of one the operator has to notice.

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

- **Agents & models** — `committee.agents[]` (≥ 3, validated at startup): `{id, name, provider, model, temperature?, role?}`. **Roles** (WP-P2.5) are what make the vote aggregate information instead of tone: `macro` (rates/curve/inflation/regime; sees macro + events + cash and the market/news views), `momentum` (tape; sees risk metrics + events and the market/sentiment/news views), `valuation` (sees the fundamentals view + cash), `risk-officer` (concentration/sizing; sees the risk table + cash and **no analyst prose** — its job is to argue for less concentration), and `generalist` (absent role; today's behaviour, every view). Each seat still receives the account, the plan, the drift and the full `CONSTRAINTS` block. Each agent gets its own LLM client; OpenRouter models need `OPENROUTER_API_KEY` in `.env`. With exactly 3 agents and one vote each, a round is either decisive (2/1/0) or a three-way tie (1/1/1), so the exclusion tie-break only triggers with 4+ agents — the rule is implemented for any N.
- **Constraints are given to the agents, not discovered by them** — every propose prompt carries a delimited `CONSTRAINTS` JSON block built from live state and from the engine's own maths (`DecisionEngine.minViableOrder`/`maxViableOrder`): account currency, NAV, cash, the **investable cash** (`cash − cash floor × NAV`), the per-name cap, the cash floor, the invested cap, the max order value, and a per-ticker entry (`currentWeight`, `targetWeight`, `driftPp`, `hint`, `unfunded` flag, `minOrderValue`). Tickers whose assumed edge cannot beat their round-trip cost at any size are listed under `notActionableTickers` **with the arithmetic**, so the agents spend their tokens on orders the gate can actually approve instead of writing intents that are refused by construction.
- **Sanitization** — targets/orders for tickers outside the allocation are ignored (noted in the session details); weights clamp to 0..1; oversized text fields are truncated at persistence, never rejected.
- **Safety** — committee orders never bypass the gates: they become `Decision` rows via `DecisionService.decide` → the same `DecisionEngine.evaluate` checks (§6.4). Sizing: `quantity = orderValue / (price × FX)`, SELLs capped at the held quantity, values rescaled down to `min(maxOrderValue, maxOrderValuePct × NAV)` when they overshoot it. The targets are persisted **after** this step and marked with whether the run funded them (ADR 0013).
- **Failure containment** — a failing agent call fails the session (status `FAILED`, visible on the dashboard); the run completes with **no target changes and no orders** that run. With no working committee LLMs the system therefore analyses but never trades.
- **Timing** — the winner's targets take effect from the next run's evaluation.
- **Costs** — a 3-agent session makes ~12 LLM calls (3 proposals + 6 feedback + 3 votes), more with extra vote rounds or agents. Every call's tokens and estimated USD cost are recorded ([ADR 0011](./ADRs/0011-llm-usage-accounting-and-budget.md)), and the gate requires the session's net benefit to cover them.
- **Context is sliced by phase** (WP-P1.3): `propose` carries the full research, `review` carries the account state + a one-line per-analyst view (no research prose, no position book — current targets and drift already describe the book), and `vote` carries the account state alone, because the ballot and every piece of feedback are already in its system prompt. Feedback and votes also run with **thinking disabled** regardless of the configured mode (classification calls must not pay for reasoning). The session records `details.llmPhases = {phase: {calls, promptChars}}`, and on the reference fixture the sliced session sends ~41 % fewer context characters than sending the propose context in every phase.
- **Audit trail** — tables `committee_sessions` (incl. `details.funding`), `committee_proposals` (points, status `active|excluded|accepted|defeated`, excluded round), `committee_feedback`, `committee_votes` + events `CommitteeSessionStarted`, `CommitteeProposalsReady`, `CommitteeFeedbackCompleted`, `CommitteeVoteRoundCompleted`, `CommitteeProposalExcluded`, `CommitteeWinnerAccepted`, `CommitteeTargetsApplied` (with each target's status), `CommitteeTargetsUnfunded`, `CommitteeSessionCompleted`, `CommitteeSessionFailed`. The dashboard committee page shows every proposal (targets, orders, rationale, points, status), the feedback each received, every vote round's points, and the accepted proposal.

### 6.1–6.3 Pricing, costs, benefit (per order intent)

Since [ADR 0012](./ADRs/0012-edge-honest-size-aware-gate.md) the benefit is **derived from the
research**, not assumed per trade, and the cost side is the position's **round trip**:

```
price      = held position price, or live quote for a new BUY (else rejected INSTRUMENT_UNAVAILABLE)
quantity   = round(orderValue / (price × fxRate), 4)   // SELL capped at held; 0 ⇒ OPPORTUNITY_TOO_SMALL
             rescaled down when value would exceed min(maxOrderValue, maxOrderValuePct × NAV)

# the assumed edge, from the evidence the run actually gathered
signalStrength = (1 − w) × analystStrength + w × winnerConfidence        // w = 0.5
                 analystStrength = Σ(|Δweight|/0.15 capped at 1 × adjustmentConfidence) / Σ(adjustmentConfidence)
                 (0 when the analysts produced no report for that ticker)
edgePct        = min(signalStrength × baseEdgePct, maxEdgePct)
expectedBenefit= orderValue × edgePct

# the cost of owning and later selling the position (fractions of order value)
spread     = spreadBps / 10 000
fxFee      = fxFeePct                     (only when instrument currency ≠ account currency)
stampDuty  = stampDutyPct                 (only for BUYs of UK-listed ".L" tickers)
platformFee= platformFeePct
costRatio  = 2×spread + 2×fxFee + stampDuty + 2×platformFee      // entry AND exit
costs      = costRatio × orderValue
netBenefit = expectedBenefit − costs
```

### 6.4 The economic-correctness gate (in order)

`DecisionEngine.evaluate` checks, in this exact order, and rejects with the corresponding reason:

| # | Check | Rejection reason |
|---|---|---|
| 1 | action is HOLD | (always approved — a domain no-op; the service never produces HOLD proposals) |
| 2 | quantity > 0 | `OPPORTUNITY_TOO_SMALL` |
| 3 | intent confidence ≥ `minConfidence` | `NO_CONVICTION` |
| 4 | orderValue ≤ min(`maxOrderValue`, `maxOrderValuePct` × NAV) | `RISK_LIMIT_EXCEEDED` |
| 5 | orderValue ≥ `minOrderValue` | `INSTRUMENT_UNECONOMIC` |
| 6 | netBenefit ≥ `minNetBenefitPct` × orderValue | `OPPORTUNITY_TOO_SMALL` |
| 7 | edgePct ≥ costRatio × `costBenefitMultiplier` | `COST_EXCEEDS_BENEFIT` |
| 8 | ticker outside the cooldown window (`tickerCooldownDays`, any order on that ticker) | `COOLDOWN_ACTIVE` |
| 9 | BUY only: orderValue ≤ cash; heat + orderValue/NAV ≤ `maxHeatPct` | `INSUFFICIENT_CASH` / `RISK_LIMIT_EXCEEDED` |
| 10 | the run's session net benefit ≥ `llmCostPerRun` × `llmCostBenefitMultiplier` | `COST_EXCEEDS_BENEFIT` |

Checks 4–7 are size- and ratio-aware: a trade too small to repay its costs is refused at any evidence
level, and a trade whose assumed edge cannot beat the round trip is refused at any size. Check 10 puts
the run's own inference spend (ADR 0011, converted at the live FX rate) inside the same economics as
spread and FX: the decisions a session produces must pay for the analysis that produced them.

SELLs have no cash or heat check. Every decision — approved or rejected — is persisted with its full rationale (agent, order reason, cost breakdown) and the exact reason, plus the gate's own inputs (`signalStrength`, `edgePct`, `costRatioPct`, `netBenefit`, `sessionNetBenefit`, `llmCostPerRun`). That is what the dashboard's *Decisions* panels show.

**Check 9 is evaluated against the RUNNING portfolio, not the pre-run snapshot** ([ADR 0010](./ADRs/0010-run-scoped-gate-state-and-target-lookup.md)): the service walks `availableCash` and `runningHeat` as it approves intents (`BUY` → cash −= orderValue, heat += orderValue/NAV; `SELL` → cash += orderValue, heat −= that position's weight, floored at 0) and shows each intent the state left by the ones before it. Intents are taken in the order the winning proposal listed them, so a SELL listed before a BUY funds it. These are estimates of the post-execution portfolio: the gate sizes the *next* intent, it never relaxes one already approved. Check 10 accumulates the same way: a rejected order contributes nothing.

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

### 6.5 Outcome feedback: does any of this make money? (WP-P2.4)

Nothing used to close the loop, so the committee could neither learn nor be held to account. Now:

- **Every run** (material or stats-only, because it costs no inference) `PerformanceService.score()`
  attributes the approved decisions of previous runs that have no outcome yet: the instrument's
  close-to-close return over `performance.scoringHorizonHours` (default 24 h) × the order value, signed by
  the direction taken — a BUY into a fall and a SELL before a rise are both negative. Rows land in
  `decision_outcomes`; a decision whose series is unavailable stays queued for the next run instead of
  being scored as zero, and event `DecisionOutcomesScored` reports the batch and its net contribution.
- **The committee is shown the result** as a `trackRecord` block in the propose context: sessions scored,
  NAV change, benchmark change, **alpha**, worst drawdown, the window's contribution in account currency,
  and a **scorecard per agent** (acceptance rate, attribution, profitable or not) built from
  `committee_proposals` × `decision_outcomes`. The prompt rule: *do not repeat a stance that has been
  losing money*.
- **Analyst calibration** (`calibrateAnalysts`) measures each role's hit rate, mean forward return and
  directional edge from bullish/bearish calls against the return that followed; it is a domain function
  used for analysis and reporting (the per-report scoring is read from `analysis_reports` + candle
  history rather than stored twice).

Every failure is contained: no outcome data simply means no track-record block, never a failed run.

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
| Allocation | `allocation_targets` (weight, original seed, rationale, conviction, **funding status + note** — ADR 0013) |
| Portfolio | `portfolio_snapshots` (incl. `nav_units`, `nav_per_unit` — units adjusted for cash flows) + `position_snapshots` (FX-converted) |
| Committee | `committee_sessions`, `committee_proposals`, `committee_feedback`, `committee_votes` |
| Decisions | `decisions` (proposal, expected benefit, estimated costs, reason, committee source meta) |
| Orders | `orders` (lifecycle, broker id, fill, realized costs, errors) — costs have no table of their own |
| LLM spend | `llm_usage` (one row per successful call: run, agent, provider/model, prompt/completion/cached tokens, estimated USD) + `runs.details.llm` totals + event `LlmUsageRecorded` ([ADR 0011](./ADRs/0011-llm-usage-accounting-and-budget.md)) |
| Everything | `events` (append-only domain event log) |

### 8.1 LLM cost accounting and budget (ADR 0011)

Every successful LLM call reports its provider usage, which is priced with the model price table
(`llm.pricing` overrides the built-in `DEFAULT_MODEL_PRICES`; an unpriced model records tokens with
cost 0) and attributed to the run that is active at the time. Two guards bound the spend, and both
fail **contained**, never as a crash:

| Guard | Default | Effect when hit |
|---|---|---|
| `llm.budget.maxCallsPerRun` | 200 | analysis stops with the reports already produced; the committee session is skipped |
| `llm.budget.maxSpendPerDayUsd` over `llm.budget.spendWindowHours` | $5 / 24 h | same, checked before the analysis step and before the session |

The window spend is primed from `llm_usage` at the start of every run, so a restarted service keeps
counting the same window. A stop is recorded as `runs.details.llmBudgetStop` (+ `budgetStop: true` on
the failed committee session) and exposed on the dashboard's Activity page (spend tile) and
`GET /api/overview.llm`. The AI cost is an input to the economic gate from WP-P0.1 onwards (session-level
`llmCostPerRun`, not a per-order charge).

---

## 9. Config knobs that change these decisions

| Decision point | Knobs |
|---|---|
| Which assets | `universe.tickers` (analysed), `allocation.targets` (allocatable — §2), `universe.benchmark` |
| Allocation | `allocation.targets` (empty ⇒ bootstrap), `allocation.rebalanceBand` (context for the committee), `allocation.{cashTarget,cashBand}` (cash policy, §5), `committee.{maxTarget,minCashBuffer,trustRegion,trustRegionConfidenceWeight,maxTurnoverPctPerSession,minWeightChange}` (§4.2 guardrails) |
| Committee | `committee.agents[]` (≥ 3 required), `committee.maxVoteRounds` |
| Cost model | `costs.{spreadBps,fxFeePct,stampDutyPct,platformFeePct}` (all charged round-trip except stamp duty) |
| Gate | `risk.{minConfidence,costBenefitMultiplier,baseEdgePct,maxEdgePct,minNetBenefitPct,minOrderValue,maxOrderValue,maxOrderValuePct,llmCostBenefitMultiplier,maxHeatPct,tickerCooldownDays,stopDistancePct}` |
| Execution | `risk.maxOrdersPerRun` |
| LLM spend | `llm.budget.{maxCallsPerRun,maxSpendPerDayUsd,spendWindowHours}`, `llm.pricing` (USD per 1M tokens per model) — §8.1 |

The only cash floor in force is `committee.minCashBuffer` (the former `allocation.adaptation` block and `risk.signalThreshold` belonged to the removed classic flow and are ignored if still present).

## 10. Worked example (from a live practice run)

Values below were produced under the committee flow with the user's practice-account knobs (`risk.minConfidence` 0.4, `costBenefitMultiplier` 1.5, flat 0.5%-per-trade benefit model — the arithmetic ADR 0012 replaced):

- A 3-agent session ended 2/1 in round 1; the winner proposed raising **MSFT** from 0.20 to 0.25 and buying ~£120 of it. The target was persisted under the per-name cap (0.25 is exactly the cap) with the rationale `"committee <agent> (2 pts): …"`.
- The BUY intent was priced live, estimated costs ≈ £0.19 (one-way spread + 0.15% FX), expected benefit (£120 × 0.5% × (0.5 + 0.5 × winner confidence)) cleared the two thresholds in force at the time ⇒ **approved** (`ECONOMICALLY_VIABLE`) → market order filled with realized costs recorded.
- A later session whose winner confidence was below `minConfidence` saw its order rejected with `NO_CONVICTION` — same gate math, fully traceable on the dashboard.

**This example no longer describes the gate.** Under [ADR 0012](./ADRs/0012-edge-honest-size-aware-gate.md) the same intent is judged on evidence instead of a flat return assumption: the edge comes from the analysts' recommended weight changes and the winner's confidence (`signalStrength`), the cost side is the **round trip** (≈ £0.41 on £120, not £0.19), and the trade is refused if the evidence-backed edge cannot beat that, if the net benefit misses `minNetBenefitPct`, if the size is below `minOrderValue`, or if the run's inference cost is not covered. The calibration table in the ADR shows which sizes clear under the current defaults.
