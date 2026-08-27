# Decision process — from market analysis to executed orders

This document explains, step by step, the full decision chain implemented in this system: **which assets are analysed**, **how the asset allocation is defined and reviewed**, and **which orders are executed** (and why others are rejected). It describes the code as it exists, not an aspiration — every formula below is implemented in `src/`. Where the code has a known simplification, it is called out explicitly (see §7.1 and the *Glossary* after §3).

Related decisions: [ADR 0001 — FRED macro integration](./ADRs/0001-fred-macro-integration.md), [ADR 0002 — single-flight execution](./ADRs/0002-single-flight-execution.md).

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
  2. Market analysis       → 4 analysts × every universe ticker
  3. Allocation review     → analyst-driven target adaptation (opt-in, §4.2)
  4. Portfolio evaluation  → snapshot, drift vs targets, heat, NAV, benchmark
  5. Decisions             → proposals + economic-correctness gate
  6. Execution             → two-phase orders, fill confirmation, realized costs
        │
        ▼
  Everything is persisted (runs, reports, snapshots, targets, decisions,
  orders, events) and shown on the dashboard.
```

**Hour guard (idempotency):** one run per market hour is enforced for scheduled/startup runs. Precisely: a run that already exists for the current market hour blocks a second one **unless it is `FAILED`** (a failed run may be retried in the same hour). A `SKIPPED` run (market closed) counts as existing. `pnpm run-once --force` bypasses the *market-open* check, not the hour guard. Manual runs (dashboard button) always execute a fresh cycle by design (`skipHourGuard`).

**Single-flight execution** ([ADR 0002](./ADRs/0002-single-flight-execution.md)): at most one pipeline executes at a time, whichever trigger started it (scheduler, startup or "Run now"). A manual trigger while a run is in flight is rejected with `409` (the dashboard tracks the in-flight run to completion instead of starting a second one); a scheduled trigger during an in-flight run records a `SKIPPED` run ("a run is already in progress") — it never queues. The RUNNING state is persisted to `runs` the moment a run starts, so refreshing the dashboard mid-run keeps the button in the "Running…" state and resumes polling until the run settles.

---

## 2. Which assets are analysed

The universe comes from configuration:

- `universe.tickers` — the list of instruments the system follows (plain symbols like `RTX`, `MSFT`; the Trading212 adapter resolves them to API instrument ids such as `UTX_US_EQ` via the metadata endpoint, and maps them back, e.g. `UTX_US_EQ → RTX`).
- `universe.benchmark` — an index (default `SPY`) used for relative performance, never traded.

> **Universe ≠ tradable set.** Every universe ticker is *analysed* each run, but decisions (§6) are made only for tickers that have an **allocation target** (§4). A ticker in `universe.tickers` without a target produces analysis reports every hour and never a decision or order. In bootstrap mode (§4.1) targets are derived from the broker once; adding a ticker to the universe later does **not** create a target for it — add it to `allocation.targets` (or hold it in the account before the first run).

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
  "confidence": 0..1,                // confidence in the conclusion (display only, see Glossary)
  "rationale": "2–4 sentences",
  "targetWeightAdjustment": -1..1,   // recommended Δ of the ticker's target weight
  "adjustmentConfidence": 0..1       // how confident this Δ improves the portfolio
}
```

Before aggregation `targetWeightAdjustment` is clamped: **±0.5** for LLM analysts (the prompt asks for |Δ| ≤ 0.15 unless the evidence is overwhelming), **±0.15** for the offline rule-based analysts.

| Analyst | Role | Primary inputs |
|---|---|---|
| `market` | price action, trend, momentum | candles, quote, benchmark, macro |
| `sentiment` | market mood | sentiment score (news-based) |
| `news` | materiality of recent news | headlines |
| `fundamentals` | valuation & financial health | P/E, growth, margins |

The four outputs are combined into a per-ticker **signal** with fixed weights
(market 0.25, sentiment 0.20, news 0.15, fundamentals 0.40):

```
signal        = Σ weight(a) × targetWeightAdjustment(a) / Σ weight(a)
conviction    = Σ weight(a) × adjustmentConfidence(a)   / Σ weight(a)
```

These two numbers drive both the allocation review (§4) and the trade decisions (§6).

### Glossary — the numbers that gate trades

| Term | Definition | Used by |
|---|---|---|
| **signal** | weighted mean of the four `targetWeightAdjustment`s (−1..1) | review delta (§4.2), actionability + direction veto + sizing (§6) |
| **conviction** = **aggregated confidence** | weighted mean of the four `adjustmentConfidence`s (0..1). *The same number* is called `conviction` in §4 (`minConviction`) and `confidence` in §6 (`minConfidence`, expected-benefit scaling). | `minConviction` gate, `minConfidence` gate, expected benefit |
| **conclusion confidence** | each analyst's `confidence` in its bullish/bearish/neutral call | display only — the `conf 0.xx` per analyst in the decision rationale and dashboard. **Not** a gate. |

---

## 4. Asset allocation: definition and review

### 4.1 Where the allocation comes from

Priority order at the start of every run (`AllocationBootstrapService`, then `currentTargets()`):

1. **Persisted review rows** (`allocation_targets` table) — the evolving allocation. When config seeds exist, repo rows override seeds **only for tickers still in the seeds**; rows for tickers removed from the seeds are ignored.
2. **Configured seeds** — `allocation.targets` in the config.
3. **Bootstrap from the broker** — only when the config list is **empty and no review rows exist**: the existing portfolio *is* the allocation. The current position weights (in account currency) become the initial targets, persisted as review rows with the rationale `"bootstrapped from the existing broker portfolio"` (event `TargetsBootstrapped`). Bootstrap happens once; afterwards the repo rows are the complete target set (see the note in §2).

If there are no targets AND no positions, the run fails with a clear configuration error.

### 4.2 The review (adaptation) — opt-in

**Adaptation is OFF by default** (`allocation.adaptation.enabled` defaults to `false`; `config/default.json` does not set an `adaptation` block). With it off, targets are frozen at the seeds (or the bootstrap rows) and this step returns without changes — note that review rows persisted while it *was* enabled still apply until cleared. Enable it in `config/local.json`:

```json
"allocation": { "adaptation": { "enabled": true } }
```

When enabled, the review runs after analysis and re-examines each *target* ticker using the analysts' signal, with hard guardrails (values are the schema defaults):

| Guardrail | Default | Meaning |
|---|---|---|
| Conviction gate | `minConviction` 0.4 | no change without analyst agreement (a ticker with no reports is also skipped) |
| Per-run delta bound | `maxDeltaPerRun` ±0.02 | smooth evolution, no jumps |
| Per-name cap | `maxTarget` 0.25 | no single name above 25% |
| Cash floor | `minCashBuffer` 0.05 | total invested targets ≤ 95% |

```
delta      = clamp(signal, −maxDeltaPerRun, +maxDeltaPerRun)
proposed   = clamp(currentTarget + delta, 0, maxTarget)
if Σ proposed > 1 − minCashBuffer  →  scale ALL weights by (1 − minCashBuffer)/Σ
```

Every accepted change is persisted with its **rationale** (the analysts' own words) and conviction, and displayed in the dashboard's *Allocation review* panel. Weights scaled only by the cash floor get the rationale `"cash-floor rebalancing (scaled to preserve the cash buffer)"`.

---

## 5. Portfolio evaluation (broker = source of truth)

Each run reads the Trading212 account and positions, enriches prices with live quotes (falling back to the broker price), converts every instrument value into the account currency via FX (falling back to 1), and computes:

- **Snapshot** — cash, positions, market values, weights, unrealized P&L, total value.
- **Drift** — per target ticker: `drift = currentWeight − targetWeight`; `|drift| ≤ rebalanceBand` ⇒ inside band (`hold` hint), otherwise `buy` (underweight) or `sell` (overweight).
- **Heat** — `Σ weight × (1 − stopDistancePct)`: risk capital at stake, checked against `maxHeatPct` in the BUY gate (§6.4).
  > **Read this before tuning `maxHeatPct`.** With `stopDistancePct = 0.1`, heat ≈ 0.9 × *invested fraction of NAV*, and the gate is `heat + orderValue/NAV ≤ maxHeatPct`. So `maxHeatPct` is effectively a **cap on the total invested fraction**: at `maxHeatPct = 0.3` every BUY is rejected (`RISK_LIMIT_EXCEEDED`) once ~33% of NAV is invested; at `0.12` once ~13% is invested. `stopDistancePct` is only a parameter of this formula — **no stop-loss order is ever placed**. To make the heat gate coincide with the allocation cash floor (never stricter, never looser) set `maxHeatPct = (1 − minCashBuffer) × (1 − stopDistancePct)` — 0.855 with the defaults ([ADR 0004](./ADRs/0004-max-heat-pct-semantics.md)).
- **NAV** — unitized net asset value: **1000 units, fixed**; `navPerUnit = totalValue / units`. Units are **not** adjusted for deposits/withdrawals (the `NavLedger.applyCashFlow` logic exists in the domain but is not wired into the pipeline), so cash flows show up as performance. Known limitation.
- **Benchmark** — SPY day change for relative performance (α shown on the dashboard).

---

## 6. Decisions: which trades are proposed and which pass the gate

```
for each target ticker (drift row):
  signal, confidence ← §3 aggregation
  actionable?  ──no──▶ nothing recorded
      │yes
  action ← hint "buy" ⇒ BUY | hint "sell" ⇒ SELL | hint "hold" ⇒ sign(signal)
  SELL without position ─────────────────▶ INSTRUMENT_UNAVAILABLE
  direction veto (signal opposes action) ─▶ NO_CONVICTION
  size (6.2) → costs (6.3) → gate (6.4) ──▶ approved | rejected(reason)
```

### 6.1 Candidate selection (per ticker)

A decision is considered when:

```
actionable = NOT insideBand   OR   |signal| ≥ signalThreshold
```

- Not actionable ⇒ no decision is recorded (silence keeps the trail readable).
- **Action**: outside the band the drift hint decides (`buy` ⇒ BUY, `sell` ⇒ SELL). Inside the band the hint is `hold`, so the ticker is actionable only because of a strong signal and **the signal's sign decides**: bullish ⇒ BUY (open or add), bearish ⇒ SELL (trim). Both are sized by the signal alone when drift is ~0 (§6.2) and still pass every gate in §6.4 ([ADR 0003](./ADRs/0003-inside-band-signal-direction.md)).
- **Direction veto**: if the analysts strongly disagree with the rebalance direction
  (`direction × signal < −signalThreshold`, where direction = +1 for BUY, −1 for SELL),
  the move is blocked with reason `NO_CONVICTION`.
- SELL without a held position ⇒ `INSTRUMENT_UNAVAILABLE`. BUY of a new ticker is priced live (quote + FX); if pricing fails ⇒ `INSTRUMENT_UNAVAILABLE`.

### 6.2 Sizing

```
baseValue     = |drift| × totalValue
signalBoost   = (BUY ? +signal : −signal) × totalValue × 0.5   (analysts nudge the size)
proposedValue = clamp(round(baseValue + signalBoost), minTradeValue, maxOrderValue)
                // minTradeValue is FIXED at 10 (account currency), not configurable
quantity      = round(proposedValue / (price × fxRate), 4)
              // SELL: capped at the held quantity
              // quantity 0 ⇒ OPPORTUNITY_TOO_SMALL (rejected before the gate)
              // if order value exceeds maxOrderValue: rescaled down (partial rebalance)
```

`signalBoost` is negative when the signal opposes the drift but is weaker than the veto threshold; the order is then *smaller* than the drift alone would suggest, floored at `minTradeValue`.

### 6.3 Cost estimation (Trading212 Invest model)

For every non-HOLD proposal, in account currency:

```
spread     = spreadBps / 10 000 × orderValue
fxFee      = 0.15% × orderValue                    (only when instrument currency ≠ account currency)
stampDuty  = 0.5% × orderValue                     (only for BUYs of UK-listed ".L" tickers)
platformFee= 0%
total      = spread + fxFee + stampDuty + platformFee
```

### 6.4 The economic-correctness gate (in order)

`DecisionEngine.evaluate` checks, in this exact order, and rejects with the corresponding reason:

| # | Check | Rejection reason |
|---|---|---|
| 1 | action is HOLD | (always approved — the service never produces HOLD proposals, so this is a domain no-op) |
| 2 | quantity > 0 | `OPPORTUNITY_TOO_SMALL` (also raised earlier by the service, §6.2) |
| 3 | aggregated confidence ≥ `minConfidence` | `NO_CONVICTION` |
| 4 | order value ≤ `maxOrderValue` | `RISK_LIMIT_EXCEEDED` |
| 5 | ticker outside the cooldown window (`tickerCooldownDays`, any order on that ticker) | `COOLDOWN_ACTIVE` |
| 6 | expectedBenefit ≥ `minExpectedBenefitPct` × orderValue | `OPPORTUNITY_TOO_SMALL` |
| 7 | expectedBenefit ≥ total costs × `costBenefitMultiplier` | `COST_EXCEEDS_BENEFIT` |
| 8 | BUY only: orderValue ≤ cash; heat + orderValue/NAV ≤ `maxHeatPct` | `INSUFFICIENT_CASH` / `RISK_LIMIT_EXCEEDED` |

SELLs have no cash or heat check. The **expected benefit** is the assumed return the trade unlocks:

```
expectedBenefit = orderValue × expectedReturnPerTradePct/100 × (0.5 + 0.5 × confidence)
```

Every decision — approved or rejected — is persisted with its full rationale (drift numbers, analyst summary, cost breakdown) and the exact reason. That is what the dashboard's *Decisions* table shows.

---

## 7. Execution: which orders are placed

Approved non-HOLD decisions become orders:

1. **Ranking & cap** — sorted by expected benefit (best first), limited to `maxOrdersPerRun`.
2. **Two-phase reservation** — the order is persisted as `PENDING` **before** anything is sent (Trading212 order placement is not idempotent; a crash can never lose or double an intent).
3. **Submission** — market order via the Trading212 API (negative quantity = sell; plain symbol resolved to the instrument id).
   - `quantity-precision-mismatch` errors are parsed from the response detail and retried with progressively lower precision; the accepted quantity is written back to the local order.
4. **Fill confirmation**
   - immediate `FILLED` → confirmed at once;
   - still open (`NEW`) → polled once after ~1.5 s; if still open, left `SUBMITTED`;
   - the **sweep** (start of every run) re-polls open orders; filled orders that 404 from the active-orders endpoint are looked up in `/history/orders` and confirmed with the actual fill price.
5. **Realized costs** — recomputed with the §6.3 model on the estimated order value scaled by `fillPrice / estimatedPrice` (not on the broker-reported filled value) and persisted on the fill (spread, FX, stamp duty).
6. **Crash recovery** — stale `PENDING` orders (older than 15 min) are matched against the broker's open orders (ticker, side, quantity, ±15 min): match ⇒ adopt the broker id; no match ⇒ `FAILED` (never blind re-submission). Orders that failed only on quantity-precision within the last 24 h are re-submitted automatically on the next run (safe: a 400 means the broker never created the order).

Events emitted along the way: `OrderRequested`, `OrderRetried`, `OrderFilled`, `OrderRejected`, `OrderFailed` — all persisted.

### 7.1 Known simplifications (not implemented)

- **Partial fills are recorded as full fills** — `filledQuantity` is set to the requested quantity regardless of `PARTIALLY_FILLED`.
- **No stop-loss / limit orders** — only market orders; `stopDistancePct` feeds the heat formula (§5) and nothing else.
- **No cash-flow adjustment of NAV** (§5).
- **SELLs are not gated on cash or heat** (§6.4).
- **Cooldown is per ticker, any side** — a SELL puts the ticker in cooldown for a later BUY too.

---

## 8. Persistence (the audit trail)

| Step | Persisted as |
|---|---|
| Run | `runs` (status, market open, error, summary counts) |
| Raw inputs | `market_snapshots`, `news_items` (deduplicated), `sentiment_scores`, `macro_snapshots` (FRED, one per run) |
| Analysis | `analysis_reports` (conclusion, confidence, Δ, rationale, engine) |
| Allocation | `allocation_targets` (weight, original seed, rationale, conviction) |
| Portfolio | `portfolio_snapshots` (incl. `nav_units`, `nav_per_unit`) + `position_snapshots` (FX-converted) |
| Decisions | `decisions` (proposal, expected benefit, estimated costs, reason) |
| Orders | `orders` (lifecycle, broker id, fill, realized costs, errors) — costs have no table of their own |
| Everything | `events` (append-only domain event log) |

---

## 9. Config knobs that change these decisions

| Decision point | Knobs |
|---|---|
| Which assets | `universe.tickers` (analysed), `allocation.targets` (tradable — §2), `universe.benchmark` |
| Allocation | `allocation.targets` (empty ⇒ bootstrap), `allocation.adaptation.{enabled (default false),maxDeltaPerRun,minConviction,maxTarget,minCashBuffer}`, `allocation.rebalanceBand` |
| Signal weighting | fixed analyst weights (market .25 / sentiment .2 / news .15 / fundamentals .4) — not configurable |
| Actionability / veto | `risk.signalThreshold`, `allocation.rebalanceBand` |
| Sizing | `risk.maxOrderValue`, `risk.maxOrdersPerRun` (`minTradeValue` fixed at 10) |
| Cost model | `costs.{spreadBps,fxFeePct,stampDutyPct,platformFeePct}` |
| Gate | `risk.{minConfidence,minExpectedBenefitPct,costBenefitMultiplier,maxHeatPct,tickerCooldownDays,stopDistancePct,expectedReturnPerTradePct}` |

The only cash floor in force is `adaptation.minCashBuffer` (a former `allocation.cashBuffer` key was never read and has been removed from the schema).

## 10. Worked example (from a live practice run)

Values below were produced under the user's `config/local.json` of the time (in particular `risk.minConfidence` was 0.5 — the `default.json` value is 0.2), so compare against those knobs, not the defaults.

- **NVDA** target 20%, account held 0% → drift −20% → proposed buy ≈ £100 (capped by `maxOrderValue`), estimated costs ≈ £0.17 (spread £0.02 + 0.15% FX £0.15), expected benefit ≈ £0.38 ≥ costs × 1.5 ⇒ **approved** → `BUY 0.6399 NVDA_US_EQ` → filled at the market open ($212.71) with realized costs £0.17 recorded.
- A later run re-evaluated the same ticker and rejected it with `NO_CONVICTION` (aggregated confidence 0.485 < `minConfidence` 0.5) — same math, different analyst conviction, fully traceable on the dashboard.
