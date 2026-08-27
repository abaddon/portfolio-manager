# Decision process — from market analysis to executed orders

This document explains, step by step, the full decision chain implemented in this system: **which assets are analysed**, **how the asset allocation is defined and reviewed**, and **which orders are executed** (and why others are rejected). It describes the code as it exists, not an aspiration — every formula below is implemented in `src/`.

---

## 1. The hourly cycle (pipeline overview)

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Trigger: every hour at minute 0 while the market is open (scheduler),     │
│           or "▶ Run now" on the dashboard (manual runs skip the hour guard)│
└────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
  0. Housekeeping (live broker only, BEFORE anything else)
     • reconcile stale PENDING orders against broker open orders
     • sweep SUBMITTED orders for late fills
     • re-submit orders that failed on quantity-precision-mismatch
        │
        ▼
  1. Market analysis        → 4 analysts × every universe ticker
  2. Allocation bootstrap / review → targets from holdings (bootstrap) or
                                      analyst-driven target adaptation (review)
  3. Portfolio evaluation   → snapshot, drift vs targets, heat, NAV, benchmark
  4. Decisions              → proposals + economic-correctness gate
  5. Execution              → two-phase orders, fill confirmation, realized costs
        │
        ▼
  Everything is persisted (runs, reports, snapshots, targets, decisions,
  orders, costs, events) and shown on the dashboard.
```

One run per market hour is enforced for scheduled/startup runs (idempotency guard); manual runs always execute a fresh cycle by design.

---

## 2. Which assets are analysed

The universe comes from configuration:

- `universe.tickers` — the list of instruments the system follows (plain symbols like `RTX`, `MSFT`; the Trading212 adapter resolves them to API instrument ids such as `UTX_US_EQ` via the metadata endpoint, and maps them back, e.g. `UTX_US_EQ → RTX`).
- `universe.benchmark` — an index (default `SPY`) used for relative performance, never traded.

Each run, per ticker, the analysis step gathers:

| Input | Source | If unavailable |
|---|---|---|
| Quote (price, prev close, change %) | Finnhub (or demo) | contained: `null`, run continues |
| Hourly candles | Yahoo Finance (free; Finnhub free tier has no `/stock/candle`) | contained |
| News (last ~10 items) | Finnhub | contained |
| Fundamentals (P/E, P/B, growth, margins…) | Finnhub | contained |
| Sentiment | Finnhub social-sentiment → falls back to **news scoring** (DeepSeek; keyword heuristic offline) | contained |
| Macro regime | **FRED** (fed funds, 10Y/2Y yields, 10Y–2Y spread, VIX, CPI YoY, unemployment, S&P 500) — fetched **once per run** and shared by all analysts | contained: `macro=null`, run continues |

One failing source never kills the run — the affected analyst works with what exists and says so in its rationale. FRED series are daily/monthly (not intraday) and lag publication; analysts treat them as macro regime context, not tick-level signals.

One failing source never kills the run — the affected analyst works with what exists and says so in its rationale.

---

## 3. The four analysts

Each of the four roles is a separate LLM call (or deterministic offline rule-set when no API key is configured), producing a **structured output**:

```json
{
  "conclusion": "bullish | bearish | neutral",
  "confidence": 0..1,
  "rationale": "2–4 sentences",
  "targetWeightAdjustment": -1..1,   // recommended Δ of the ticker's target weight
  "adjustmentConfidence": 0..1       // how confident this Δ improves the portfolio
}
```

| Analyst | Role | Primary inputs |
|---|---|---|
| `market` | price action, trend, momentum | candles, quote, benchmark |
| `sentiment` | market mood | sentiment score (news-based fallback) |
| `news` | materiality of recent news | headlines |
| `fundamentals` | valuation & financial health | P/E, growth, margins |

The four outputs are combined into a per-ticker **signal** with fixed weights
(market 0.25, sentiment 0.20, news 0.15, fundamentals 0.40):

```
signal        = Σ weight(a) × targetWeightAdjustment(a) / Σ weight(a)
conviction    = Σ weight(a) × adjustmentConfidence(a) / Σ weight(a)
```

These two numbers drive both the allocation review (§4) and the trade decisions (§6).

---

## 4. Asset allocation: definition and review

### 4.1 Where the allocation comes from

Priority order at the start of every run:

1. **Persisted review rows** (`allocation_targets` table) — the evolving allocation.
2. **Configured seeds** — `allocation.targets` in the config.
3. **Bootstrap from the broker** — if the config list is **empty**, the existing portfolio *is* the allocation: the current position weights (in account currency) become the initial targets, persisted as review rows with the rationale `"bootstrapped from the existing broker portfolio"` (event `TargetsBootstrapped`).

If there are no targets AND no positions, the run fails with a clear configuration error.

### 4.2 The review (adaptation), every run after analysis

The review re-examines each ticker's target using the analysts' signal, with hard guardrails:

| Guardrail | Value (configurable) | Meaning |
|---|---|---|
| Conviction gate | `minConviction` ≥ 0.4 | no change without analyst agreement |
| Per-run delta bound | `maxDeltaPerRun` ±0.02 | smooth evolution, no jumps |
| Per-name cap | `maxTarget` 0.25 | no single name above 25% |
| Cash floor | `minCashBuffer` 0.05 | total invested targets ≤ 95% |

```
delta      = clamp(signal, −maxDeltaPerRun, +maxDeltaPerRun)
proposed   = clamp(currentTarget + delta, 0, maxTarget)
if Σ proposed > 1 − minCashBuffer  →  scale ALL weights by (1 − minCashBuffer)/Σ
```

Every accepted change is persisted with its **rationale** (the analysts' own words) and conviction, and displayed in the dashboard's *Allocation review* panel. `adaptation.enabled: false` freezes the allocation at the seeds (note: already-persisted review rows still apply until cleared).

---

## 5. Portfolio evaluation (broker = source of truth)

Each run reads the Trading212 account and positions, enriches prices with live quotes, converts every instrument value into the account currency via FX, and computes:

- **Snapshot** — cash, positions, market values, weights, unrealized P&L, total value.
- **Drift** — per target ticker: `drift = currentWeight − targetWeight`; `|drift| ≤ rebalanceBand` ⇒ inside band (`hold`), otherwise `buy` (underweight) or `sell` (overweight).
- **Heat** — `Σ weight × (1 − stopDistancePct)`: risk capital at stake, checked against `maxHeatPct`.
- **NAV** — unitized net asset value (money-weighted, 1000 units baseline).
- **Benchmark** — SPY day change for relative performance (α shown on the dashboard).

---

## 6. Decisions: which trades are proposed and which pass the gate

### 6.1 Candidate selection (per ticker)

A decision is considered when:

```
actionable = NOT insideBand   OR   |signal| ≥ signalThreshold
```

- Not actionable ⇒ no decision is recorded (silence keeps the trail readable).
- **Direction veto**: if the analysts strongly disagree with the rebalance direction
  (`direction × signal < −signalThreshold`, where direction = +1 for a buy hint, −1 for a sell hint),
  the move is blocked with reason `NO_CONVICTION`.
- SELL without a held position ⇒ `INSTRUMENT_UNAVAILABLE`. BUY of a new ticker is priced live.

### 6.2 Sizing

```
baseValue     = |drift| × totalValue
signalBoost   = ± signal × totalValue × 0.5        (analysts nudge the size)
proposedValue = clamp(round(baseValue + signalBoost), minTradeValue, maxOrderValue)
quantity      = round(proposedValue / (price × fxRate), 4)
              // SELL: capped at the held quantity
              // if order value exceeds maxOrderValue: rescaled down (partial rebalance)
```

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
| 1 | action is HOLD | (always approved) |
| 2 | quantity > 0 | `OPPORTUNITY_TOO_SMALL` |
| 3 | aggregated confidence ≥ `minConfidence` | `NO_CONVICTION` |
| 4 | order value ≤ `maxOrderValue` | `RISK_LIMIT_EXCEEDED` |
| 5 | ticker outside the cooldown window (`tickerCooldownDays`) | `COOLDOWN_ACTIVE` |
| 6 | expectedBenefit ≥ `minExpectedBenefitPct` × orderValue | `OPPORTUNITY_TOO_SMALL` |
| 7 | expectedBenefit ≥ total costs × `costBenefitMultiplier` | `COST_EXCEEDS_BENEFIT` |
| 8 | BUY: cash available; heat + valueFraction ≤ `maxHeatPct` | `INSUFFICIENT_CASH` / `RISK_LIMIT_EXCEEDED` |

where the **expected benefit** is the assumed return the trade unlocks:

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
   - still open (`NEW`) → polled once, left `SUBMITTED`;
   - the **sweep** (start of every run) re-polls open orders; filled orders that 404 from the active-orders endpoint are looked up in `/history/orders` and confirmed with the actual fill price.
5. **Realized costs** — recomputed on the actual fill value and persisted on the fill (spread, FX, stamp duty).
6. **Crash recovery** — stale `PENDING` orders are matched against the broker's open orders (ticker, side, quantity, ±15 min): match ⇒ adopt the broker id; no match ⇒ `FAILED` (never blind re-submission). Orders that failed only on quantity-precision are re-submitted automatically on the next run (safe: a 400 means the broker never created the order).

Events emitted along the way: `OrderRequested`, `OrderRetried`, `OrderFilled`, `OrderRejected`, `OrderFailed` — all persisted.

---

## 8. Persistence (the audit trail)

| Step | Persisted as |
|---|---|
| Run | `runs` (status, market open, error, summary counts) |
| Raw inputs | `market_snapshots`, `news_items` (deduplicated), `sentiment_scores`, `macro_snapshots` (FRED, one per run) |
| Analysis | `analysis_reports` (conclusion, confidence, Δ, rationale, engine) |
| Allocation | `allocation_targets` (weight, original seed, rationale, conviction) |
| Portfolio | `portfolio_snapshots` + `position_snapshots` (FX-converted) + NAV |
| Decisions | `decisions` (proposal, expected benefit, estimated costs, reason) |
| Orders | `orders` (lifecycle, broker id, fill, realized costs, errors) |
| Everything | `events` (append-only domain event log) |

---

## 9. Config knobs that change these decisions

| Decision point | Knobs |
|---|---|
| Which assets | `universe.tickers`, `universe.benchmark` |
| Allocation | `allocation.targets` (empty ⇒ bootstrap), `adaptation.{enabled,maxDeltaPerRun,minConviction,maxTarget,minCashBuffer}`, `rebalanceBand`, `cashBuffer` |
| Signal weighting | fixed analyst weights (market .25 / sentiment .2 / news .15 / fundamentals .4), `signalThreshold` |
| Sizing | `risk.maxOrderValue`, `risk.maxOrdersPerRun` |
| Cost model | `costs.{spreadBps,fxFeePct,stampDutyPct,platformFeePct}` |
| Gate | `risk.{minConfidence,minExpectedBenefitPct,costBenefitMultiplier,maxHeatPct,tickerCooldownDays,stopDistancePct,expectedReturnPerTradePct}` |

## 10. Worked example (from a live practice run)

- **NVDA** target 20%, account held 0% → drift −20% → proposed buy ≈ £100 (capped by `maxOrderValue`), estimated costs ≈ £0.17 (spread £0.02 + 0.15% FX £0.15), expected benefit ≈ £0.38 ≥ costs × 1.5 ⇒ **approved** → `BUY 0.6399 NVDA_US_EQ` → filled at the market open ($212.71) with realized costs £0.17 recorded.
- A later run re-evaluated the same ticker and rejected it with `NO_CONVICTION` (conviction 0.485 < 0.5) — same math, different analyst conviction, fully traceable on the dashboard.
