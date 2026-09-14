# Decision-process review — costs, allocation, instruments, research

**Scope:** the whole chain `analysis → committee → gate → execution`, reviewed against the code as it stands
(commit `84765f1`) and against the evidence in `data/trading.db` (live mirror, 36 runs, 22 committee sessions,
50 decisions, **0 orders**) and `data_demo/trading.db` (paper, 6 filled orders).

**Goal of the review (user's words):** better cost management (AI tokens + trading costs), better allocation
decisions, better instrument evaluation, better market research/news — to produce a better strategy and a
higher return.

**How to read it:** §1 is the headline finding. §2 is the evidence table. §3–§7 answer the four questions in
order (costs, allocation, instruments, research). §8 is the prioritised plan. §9 lists what *not* to do.
Every claim below is traceable to a file/line or to a SQL-reproducible number.

> **Status 2026-09-14 — Phase P0 is implemented and merged.** The findings below are kept verbatim as the
> record of what was wrong; each P0 item is now resolved by an ADR:
>
> | Finding | Resolution |
> |---|---|
> | §1/§3.7 gate measured size, not edge; costs were one-way | **ADR 0012** — edge derived from the analysts, round-trip costs, size window, net-benefit floor, inference-cost coverage; calibration table in the ADR |
> | §1/§4.1 the plan moved ahead of the money | **ADR 0013** — orders are gated first; targets carry `ACTIVE`/`UNFUNDED` + the reason and are carried as a residual |
> | §4.6 agents proposed intents the gate refuses | **WP-P0.3** — a `CONSTRAINTS` block (cash, caps, per-ticker `minOrderValue`, `notActionableTickers`) is in every propose prompt |
> | §3.1 tokens unmeasured and uncapped | **ADR 0011** — per-call usage/cost in `llm_usage` + `runs.details.llm`, `llm.budget` guards, Activity-page spend tile |
> | §3.4 sentiment paid twice | **WP-P0.6** — one call per ticker, headline-level memoisation, permanent 403 remembered |
> | §3.6 stale model ids / config landmines | **ADR 0014** — model-id probe (refuses a live start), `pnpm verify-models`, orphaned runs closed, `maxHeatPct` landmine removed |
>
> Phases P1 (cost & decision quality) and P2 (strategy quality) remain open — see `docs/IMPLEMENTATION_PLAN.md`.

---

## 1. Headline: the loop that was supposed to make money has never traded

Three facts, all verifiable:

1. **The live account has placed zero orders.** `select count(*) from orders` → **0**. 50 decisions, **0 approved**,
   22 committee sessions, 13 target changes, over 36 runs and ~9 trading days.
2. **Every decision was rejected `OPPORTUNITY_TOO_SMALL`** — and not marginally, but structurally.
   Reproduced with the *old* live configuration (`expectedReturnPerTradePct 0.5`, `minExpectedBenefitPct 0.006`,
   `costBenefitMultiplier 1.5`): the gate rejects **every** order value from £5 to £200
   (`docs` probe, §2). The two thresholds can never be satisfied together, because
   `minExpectedBenefitPct (0.006) > expectedReturnPerTradePct × (0.5 + 0.5 × conf) (≤ 0.005)`.
3. **The gate was "fixed" by changing the assumptions, not the model.** Today's config
   (`expectedReturnPerTradePct 2.0`, floor `0.001`, multiplier `1.0`) approves **everything from £5 up** —
   because the expected benefit is `orderValue × 2% × confidence`, i.e. 2% of whatever you trade,
   invented by configuration.

So the system moved from *"can never trade"* to *"can always trade, for a made-up 2% edge"* —
the same defect seen from both sides. **The economic gate currently measures order size and agent confidence, not
edge.** Nothing else in this review matters as much as fixing that, because every other improvement is
multiplied by whatever the gate lets through.

**And the cost of that non-trading is measurable:** the account returned **−0.65%** while SPY returned **+3.51%**
over the same 8 sessions (sum of daily changes: portfolio −0.63%, SPY +3.51% ⇒ **≈ −4.1 pp of alpha**).
The portfolio holds 23.5% cash, so at an invested weight of ~76% a passive tracking of SPY would have produced
~+2.7%; the names picked gave ~−0.65%.

Two structural consequences that make this *permanent*, not a one-off:

- **Targets move even when no order executes.** `CommitteeService.runSession` calls `applyWinnerTargets()`
  (line ~172) **before** `DecisionService.decide()` (line ~173). Each run the plan drifts further from the
  holdings while the portfolio stays where it is: current targets sum to **0.8928** with MSFT at 0.25, but the
  actual MSFT weight is 0.1563. The system is permanently "off plan" with no mechanism to converge.
- **Target churn is real money even when invisible.** XOM went 0.05 → 0.08 → 0.10 → 0.12 → 0.1551 in a week
  (`allocation_targets` history) with **zero shares traded**. If and when the gate opens, the first thing that
  happens is a large rebalance that pays spread + FX to reach a plan that was never funded.

---

## 2. Evidence table (what I measured, not what I assume)

| Measurement | Value | Source |
|---|---|---|
| Runs / completed / failed | 36 / 33 / 2 (+1 stuck `RUNNING`) | `runs` |
| Committee sessions / failed | 22 / **4** (2 timeouts of 16 and 11 min) | `committee_sessions` |
| Decisions / approved / orders | 50 / **0** / **0** | `decisions`, `orders` |
| Rejection reasons (live) | `OPPORTUNITY_TOO_SMALL` 49, `INSTRUMENT_UNAVAILABLE` 1 | `decisions.reason` |
| Rejection reasons (paper) | `NO_CONVICTION` 52, `INSUFFICIENT_CASH` 8, `RISK_LIMIT_EXCEEDED` 3, `OPPORTUNITY_TOO_SMALL` 3, `COOLDOWN_ACTIVE` 2, viable 6 | `data_demo` |
| Gate probe, old live cfg | rejects £5…£200 — **all sizes** | §1 probe |
| Gate probe, current live cfg | approves £5…£100 (`INSUFFICIENT_CASH` at £200) | §1 probe |
| Portfolio vs SPY, 8 sessions | −0.65% vs +3.51% (≈ −4.1 pp) | `portfolio_snapshots` |
| Cash weight | 23.5% (£183.89 / £780.09), no target, no policy | `portfolio_snapshots` |
| Target sum vs invested | targets 0.8928; biggest target MSFT 0.25 vs actual weight 0.1563 | `allocation_targets`, `position_snapshots` |
| Analyst reports per run | 20 (4 × 5 tickers) — every run, every hour | `analysis_reports` |
| Avg report text carried into the committee | ~470–1060 chars (rationale 452–555 + details 585–690) | `analysis_reports` |
| Committee context blob re-sent per call | ~2.5–3 k tokens (20 reports + positions + drift) | `buildContext` |
| LLM calls per run (3 agents) | ~20 analysts + 12 committee + 5 sentiment = **~37** | code + `sentiment` source |
| Est. token load per run | ≈ 60 k in / 10 k out | computed from the above |
| Est. AI spend | ≈ **$0.02–0.03 per run**, ≈ $0.15–0.25/trading day, **≈ $40–70/year** | provider list prices |
| AI spend vs NAV | **≈ 5–9 % of the £780 NAV per year**, unbudgeted and invisible | derived |
| Trading cost of one round trip | 0.20% (2× spread 2 bp + 2× FX 15 bp) + 0.5% stamp on the buy leg if `.L` | `costs` block |
| News rows stored | 361; avg analyst rationale 460–560 chars; news sent as headline+source+time only | `news_items`, `analysts.ts` |
| `pnpm verify` baseline | green (217 tests) at session start | repo |

---

## 3. Cost management

### 3.1 AI tokens: nothing is measured, nothing is capped

*(`src/adapters/llm/http-llm-client.ts`)*

`request()` reads `data.choices[0].message.content` and **discards `data.usage`** (prompt/completion/cached
tokens), which every supported provider returns. Consequences:

- No per-run, per-agent or per-day token/cost figure exists anywhere — not in `runs.details`, not in `events`,
  not on the dashboard. You cannot manage a cost you do not record.
- The budget is bounded only by `llm.maxTokens` per call (2000 in `default.json`, **8000 in `local.json`**) ×
  ~37 calls × 7 runs/day. There is no `maxCallsPerRun`, no `maxSpendPerDay`, no kill switch.
- Because `local.json` sets `thinking: "enabled"` (needed by gemini/glm on OpenRouter per ADR/TODO history),
  proposal calls can burn most of an 8000-token budget on reasoning that is never stored. Two failed sessions
  ran **989 s and 682 s** — that is reasoning + retries, billed.

### 3.2 The same context is rebuilt and re-sent ~37 times per run

- `CommitteeService.buildContext()` is called **four** times per session (`collectProposals`, `collectFeedback`,
  `runVoting`, plus the proposal loop) and the resulting blob is re-sent to *every* agent: 3 proposals + 6
  feedback + 3–9 votes.
- `collectFeedback` re-sends the **entire** portfolio + research context to review a proposal whose own JSON is
  already in the system prompt. The agent needs the account state, not 20 analyst rationales.
- `runVoting` re-sends the full context to emit `{"choice": "<id>"}`.
- `buildContext` ships `rationale` (2–4 sentences, avg ~490 chars) for all 20 reports; the vote call uses none
  of it.

### 3.3 Four LLM calls per ticker where one would do

*(`analysts.ts`)* `buildAnalysts()` returns 4 `LlmAnalyst` instances; `MarketAnalysisService.analyze()` loops
`for ticker → for analyst`, so 5 tickers = **20 calls, each carrying the same ticker payload** (candles, news,
fundamentals, macro). One call per ticker returning all four roles
(`{market:{…}, sentiment:{…}, news:{…}, fundamentals:{…}}`) is the same information at ¼ the cost and ¼ the
latency, and it removes 15 of 20 identical input prefixes.

### 3.4 Sentiment can be paid for twice, per ticker, per run

*(`market-analysis.ts` lines 71–80, `news-sentiment.ts`)* The sentiment port is
`FallbackSentimentPort([finnhub, NewsSentimentPort(llm)])`. Finnhub's social-sentiment endpoint returns **403 on
the free plan** (documented in AGENTS.md), so the chain falls through to `NewsSentimentPort` → **an LLM call per
ticker** (`source: "news-llm"`). Then, because `gather()` requested sentiment with `{ news: [] }` and the port
fetched its own news, the code *also* calls `sentiment(ticker, { news })` again when the first attempt failed.
That is up to **2 LLM sentiment calls per ticker per run (10/run)** for a number the keyword heuristic produces
for free. The 403 is also re-attempted forever instead of being remembered.

### 3.5 Every run pays the full analysis cost even when the session cannot use it

4 of 22 sessions failed (bad model id 404, 20-minute timeouts). In those runs the 20 analyst calls were bought
and thrown away. Conversely, on runs where nothing material changed, the same 20+12 calls are bought to
re-derive a target the committee barely moves (MSFT 0.25 → 0.25, XOM 0.05 → 0.08 → …).

### 3.6 Model/config hygiene is a direct cost and a hard failure

- `config/committee-paper.json` still points at models that **do not resolve**: the last live session failed with
  `LLM HTTP 404: proposal agent momentum-trader (moonshotai/kimi-k3)`. `default.json`'s committee block uses
  `~deepseek/deepseek-v4-flash-latest` on OpenRouter while `local.json` overrides to direct DeepSeek — the
  defaults are stale copy from a retired guardrail era.
- A dead model id costs a whole run (plus all upstream analysis) and returns a 404 only at session time.
  **A 3-second startup probe of `/models` per configured agent would prevent every one of those failures.**
- `default.json` still ships `maxHeatPct: 0.3` with a comment about a "~£12k portfolio"; that value blocks every
  BUY once ~33% of NAV is invested (ADR 0004). It is overridden in `local.json` to 0.855, so today it is only a
  landmine for the next profile.

### 3.7 Trading costs: modelled per-order, never per-decision-lifecycle

- **The gate compares one-way costs against one-way benefit.** FX is charged twice in reality (buy the
  instrument, and the eventual sale converts back), but `estimateCosts` charges it once per order. A rebalance
  is a *round trip*: 2 bp spread + 15 bp FX on the buy **and** on the sell ≈ **0.34% of notional destroyed per
  round trip** (plus 0.5% stamp on `.L` buys). At `expectedReturnPerTradePct 2.0` the gate cannot notice.
- **The AI cost is not in the cost model at all.** `CostEstimate` has spread/fxFee/stampDuty/platformFee.
  A run that spends ~$0.02–0.03 on tokens to authorise a £50 trade whose entire 2% "edge" is £1.00 is not
  economically evaluated end-to-end.
- **Spread is a global constant** (`spreadBps: 2`) for a mega-cap and for anything thinner. Per-instrument
  spread (or a conservative default per liquidity bucket) is a prerequisite for trusting small-trade economics.
- **No minimum viable order size is derived or shown.** From the probe: at an honest 10 bp edge with a 2×
  margin, *no* order under £200 clears costs. The agents are never told this, so they propose £22 and £48
  intents (`decisions.details`) that are rejected by construction — you pay tokens for orders that cannot exist.
- **`maxOrderValue` is disconnected from the account.** `local.json` sets £2000 against £183 of cash and a £780
  NAV; the binding constraint is cash, not policy. Sizing should derive from NAV (e.g. `maxOrderValue =
  min(config, 5–10% × NAV)`) and the committee should be told the *investable* amount (`cash − cash floor`).
- **`minCashBuffer` is a floor, not a policy.** The account sits at 23.5% cash with no target, no rationale and
  no opportunity-cost accounting; `minCashBuffer: 0.05` permits up to 95% invested, so nothing forces the
  question "why is a quarter of the book idle in a rising market?".

---

## 4. Allocation decisions

### 4.1 The target is applied before the orders are gated (ordering bug with permanent effect)

`applyWinnerTargets()` runs first; the orders that would implement the target are gated afterwards and can all be
rejected. Effect measured: MSFT target 0.25 vs actual weight 0.1563, targets summing 0.8928 — the book has been
off-plan for days. **Fix: make the plan and its funding atomic.** Either (a) gate first and only persist target
changes that the approved orders can actually reach, or (b) persist the target but mark it `UNFUNDED` and let the
next run carry the residual order (a standing rebalance queue) instead of re-deriving a new target each hour.
The current design guarantees divergence.

### 4.2 The winner is applied verbatim — no trust region, no smoothing, no confidence shrinkage

A three-agent vote (2/1 in the sampled sessions) hands **100%** of the decision to one agent's opinion, clamped
only by `maxTarget` and the cash floor. There is no blend with the incumbent target, no minimum evidence bar for
a weight change, and no scaling by `winner.confidence` (0.62–0.72 in the data). One-hour, 5-point weight swings
(AMZN 0.15 → 0.12 → 0.15 within 24 h) are normal. Recommended: a trust region —
`w_new = w_old + k × conf × (w_proposed − w_old)` with `k ≈ 0.25–0.5` and a per-session cap on total weight moved
(e.g. ≤ 10% of NAV of turnover), so a single session cannot re-shape the book.

### 4.3 Voting has near-zero information content — and it is the most expensive phase

Every proposal in the data is a *small perturbation of the current targets*: the agents all see the same
account, the same drift and the same research, and none of them is asked for a differentiated view. The vote
then picks the perturbation with the most agreeable tone. That is 6 feedback calls + 3–9 vote calls per session
(≈ 50% of committee spend) to select between near-identical proposals. Options, in order of value:

1. Give the agents **different objectives/inputs** (e.g. one sees only macro + valuation, one only
   momentum/volatility, one acts as a risk officer whose job is to argue for less concentration) so the vote
   aggregates genuinely different information rather than tone.
2. Make voting **conditional**: skip feedback/votes when the proposals agree within a tolerance, and apply the
   consensus (that alone removes ~9 calls on most runs).
3. **Weight votes by track record** (§6.3) instead of one-agent-one-vote.

### 4.4 The risk model is a proxy that does not measure risk

`computeHeat()` = `Σ weight × (1 − stopDistancePct)` — with `stopDistancePct` a *constant*, this is just
"invested fraction × 0.9" (ADR 0004 says so explicitly). It contains no volatility, no correlation, no drawdown,
no concentration. Consequences visible in the data: 5 names, all large-cap, MSFT capped at 25%, sector overlap
(tech + industrials + energy) unlimited, and a 23.5% cash position justified by nothing. Concrete upgrades, all
cheap because the data is already fetched:

- **Volatility** from the 40 hourly candles already retrieved per ticker (`src/adapters/marketdata/yahoo.ts`) →
  risk-weighted sizing (equal-risk-contribution instead of equal-weight-ish).
- **Correlation/beta** from the same candles (and SPY candles, one extra call per run) → cap portfolio
  correlation exposure, not just per-name weight.
- **Sector caps** using `fundamentals.sector` (already fetched) — e.g. ≤ 35% per sector, ≥ 6 names or ≥ 30%
  in a broad ETF core.
- **Real risk budgeting**: position risk = `weight × vol`, and cap the *sum*, instead of `weight × 0.9`.

### 4.5 Cash is unmanaged, and it is the single biggest measured drag

23.5% idle cash in a market that rose 3.5% over the sample is ≈ −0.8 pp of return for the period, with no
target, no policy and no discussion in the committee context (`buildContext` sends `cash` but no
"cash target / cash drag" framing). Minimum viable fix: an explicit `allocation.cashTarget` with a band and a
cash-drag figure computed per run (`cash × benchmark daily change`) shown to the agents and on the dashboard.

### 4.6 Agents are asked for an allocation they cannot reason about

`proposeSystemPrompt()` tells agents to output targets and orders, but never states: the account currency, the
available cash, the per-name cap in force, the cash floor, the minimum order that survives the gate, the cooldown
state, or the turnover budget. The measured result is a stream of intents (£22, £26, £48) rejected by rules the
agent never saw. **Put the constraints in the prompt** (they are all known at call time) — this improves
allocation quality *and* removes wasted tokens.

### 4.7 No outcome feedback: nothing learns

- No per-decision attribution: you cannot answer "did the committee's MSFT overweight make or lose money?"
  `portfolio_snapshots` + `allocation_targets` + `position_snapshots` contain everything needed; nothing joins
  them.
- No per-agent scorecard: `committee_proposals` stores agent, targets, orders, confidence and outcome
  (`accepted | defeated`). Scoring each agent's proposal against subsequent NAV/price moves is a small job with
  a large payoff: it turns one-agent-one-vote into evidence-weighted voting and exposes a chronically wrong agent.
- The committee is never shown the **NAV history, alpha vs SPY, or hit rate** — agents allocate without knowing
  whether their process has been working. Passing a compact performance block (NAV trend, alpha, worst drawdown,
  last session's outcome) costs ~50 tokens and is the cheapest quality upgrade available.

### 4.8 State-integrity leftovers that distort the plan

- **Stuck run:** one `runs` row is left `RUNNING` since 2026-08-31 (`started_at 2026-08-31T14:00:11`). Start-up
  recovery should mark orphaned `RUNNING` rows `FAILED` (it already does this for orders).
- **Failed sessions are invisible to the plan** in the sense that `notes` is `null` on the 4 failed sessions and
  `[]` elsewhere; failure reasons are good, but the *effect* (no target change, no orders) is not surfaced as a
  run-level warning count.
- **Cooldown is per ticker and side-agnostic** (§7.1 of the decision doc): a SELL blocks a later BUY on the same
  name; and the agent is not told which names are cooled, so it proposes into a wall.

---

## 5. Instrument evaluation

| What exists today | Gap | Suggested addition (data already available) |
|---|---|---|
| Quote (price, prevClose, changePct), 40 hourly candles, P/E, P/B, EPS, revenue growth, margin, D/E, dividend yield, marketCap, sector | No volatility, no beta, no drawdown, no liquidity/volume profile, no relative strength, no earnings or event dates, no spread per instrument | From the **already-fetched** 40 candles: realised vol (1 h and daily-scaled), max drawdown, 20/50-bar trend, volume z-score, distance to 20-bar high/low, momentum 1/5/20-bar. From SPY candles (1 call/run): beta and relative strength. From `volume`: a crude liquidity floor. |
| `computeDrift` marks `buy/sell/hold` vs a 4% band | Band is uniform across instruments and ignores both cost and volatility; the committee sees a `hint`, the analysts' `targetWeightAdjustment` is ±0.15 by clamp | Cost- and vol-aware band: `band_i = max(rebalanceBand, roundTripCost_i / expectedEdge, k × σ_i)`. A 4% band on a 15% position with a 0.34% round trip means "trade on noise". |
| Instrument selection limited to `universe.tickers` (5 mega-caps) | No ETF core, no diversification instrument, no asset-class breadth: the book can only express a 5-name large-cap view. RTX/XOM/MSFT/SHW/AMZN are not a diversifier set | Allow an allocatable ETF core (SPY/VOO, or a world/bond pair) in `allocation.targets`, let the committee allocate to it, and enforce a minimum number of effective positions. This is the single highest-leverage change to the *strategy*'s return/risk profile. |
| `news` + `fundamentals` + sentiment per ticker | No earnings date, no guidance/revision data, no filings, no economic calendar (FOMC next session with CPI tomorrow is invisible; agents only get VIX from FRED) | Add an event feed (earnings date + economic calendar) and pass "days to earnings" per ticker into both analysts and committee — the cheapest way to stop the system from rebalancing *into* an earnings print. |

Also note the **analysis-bias pattern in the data**: bullish conclusions outnumber bearish ones ~84 to 65 across
market/news/sentiment while the portfolio underperformed SPY by 4 pp. Whatever the cause (LLM positivity bias,
news selection), it is measurable and should be tracked as a calibration metric per analyst
(e.g. "bullish calls vs realised 1-day forward return"), which also gives you a reason to trust or discount each
analyst's `targetWeightAdjustment`.

---

## 6. Market research & news feed

### 6.1 Hourly is the wrong cadence, and it is the largest single cost lever

Nothing in this system is an intraday strategy: there are no stops, no limit orders, no intraday exits, the
cooldown is measured in days, and the drift band is 4%. Running 37 LLM calls an hour to re-decide a
multi-week allocation is where 100% of the AI spend goes. The data confirms the marginal information is ~zero:
of 36 runs, most produced no decision at all, and the target moves that did happen were ±1–5 pp oscillations.

**Recommended cadence:** drive the expensive path by *events*, not by the clock.
- Every hour (cheap, no LLM): quotes, snapshot, NAV, drift, risk checks, open-order sweep, materiality test.
- Run analysts + committee only when the materiality test fires: `|drift| > band` for any target, new news since
  the last run marked material, `NAV move > x%` intraday, earnings within N days, or a daily planning slot
  (e.g. 30 min after the open + 30 min before the close).
- Expected effect: 37 calls × 7 → 37 calls × 1–3, i.e. **a 60–80% cost reduction with no loss of decision
  quality**, and a cleaner audit trail (each session justified by a trigger).

### 6.2 The research payload is thin in the ways that matter, and fat where it doesn't

- Analysts receive only `headline`, `source`, `publishedAt` (`analysts.ts` `DATA_DUMP_KEYS` → `news` mapping);
  `NewsItem.summary` and `url` exist in the domain (`analysis.ts`) and are never sent. The news analyst is
  judging 10 headlines and writing 465 chars of rationale about them.
- No news-vs-last-run delta: the same headlines are re-scored every hour at full price. A `firstSeenAt`-based
  "new since last run" filter, plus storing the sentiment score per `(ticker, headline)` (the table already
  dedupes news by `(ticker, headline, source)`), makes repeat scoring free.
- No deduplication across sources of the same story (the display view dedupes; the analyst payload does not).
- `news_items` are truncated to 10 per ticker per run and never aged out — fine for now, but the research value
  per token would rise sharply with (a) a one-line LLM summary cached per headline, (b) materiality tags, and
  (c) only-new-items in the prompt.
- **Analyst rationales are the token hog and the least used field.** `buildContext` sends 20 × ~490 chars of
  prose to the committee; the committee's own prompts then reduce proposals/feedback to ~240 chars before
  voting. Truncate analyst rationale to a structured, comparable form (conclusion, confidence, Δ, one sentence)
  and keep the full prose in the database for the audit trail — same information for the decision, ~60% fewer
  input tokens.

### 6.3 Research quality upgrades that are cheap and non-speculative

1. **Earnings-date awareness** (§5) — prevents the worst class of accidental event risk.
2. **Performance feedback block** (§4.7) — agents see NAV trend/alpha so they can stop repeating a losing stance.
3. **Analyst calibration metrics** — store `(analyst, conclusion, confidence)` against forward returns; the
   dashboard already has the machinery, and it converts 4 opinion streams into 4 measurable ones.
4. **Macro is fetched once per run but never trended** — `macro_snapshots` exists; passing 5-day/1-month deltas
   (rates, VIX, spread) is nearly free and is the kind of context a "Macro Strategist" agent should actually have.

---

## 7. Cost-model & gate redesign (the core of "better strategy")

The gate is the only thing standing between an LLM opinion and your money, so its arithmetic must be honest.
Proposed replacement for §6.1–6.4 of `DECISION_PROCESS.md`:

```
roundTripCost_i = 2 × (spread_i/2) + 2 × fxFee  (+ stampDuty on the buy leg)     // not one-way
edge_i          = orderValue × expectedEdgePct_i × (0.5 + 0.5 × confidence)      // expectedEdgePct_i from
                                                                                 // signal strength / vol / drift
benefit_i       = edge_i × horizonFactor_i                                       // drift-reduction portion is
                                                                                 // proportional to |drift|/target
require:
  orderValue ≥ minViableOrder_i         where minViableOrder_i solves
                                        edge_i(orderValue) ≥ roundTripCost_i × multiplier
  benefit_i  ≥ roundTripCost_i × costBenefitMultiplier
  benefit_i  ≥ llmCostPerRun (amortised)         // the AI spend must be inside the same equation
  turnover_this_session ≤ turnoverBudget × NAV
  weight_i ≤ maxTarget, Σsectors ≤ sectorCap, positions ≥ minPositions
```

Two properties this buys you, both currently missing: (a) the gate can no longer be satisfied by *any* size
(§1), and (b) `expectedEdgePct` becomes a **measured** quantity (from the analyst signals, drift and volatility
that the system already computes) rather than a config constant that silently sets the strategy's aggressiveness.

`minExpectedBenefitPct` should be deleted or reinterpreted as `minEdgePct` (a floor on the *assumed* edge, not
on a `orderValue × constant` identity), because as written it is algebraically equivalent to a floor on
confidence — which is exactly what `minConfidence` already does.

---

## 8. Prioritised plan

Ordered by (impact ÷ effort). P0 is what I would do before letting this system near real money again.

### P0 — correctness (days, small diffs)
1. **Make the gate size-aware and edge-honest**: two-way costs, `expectedEdgePct` derived from signal strength
   (or at minimum a per-run, evidence-driven value instead of a global 2%), a computed `minViableOrder`, and the
   AI cost per run inside the same comparison. (§3.7, §7)
2. **Fix the ordering bug**: do not persist a target the run could not fund; adopt a standing residual-order
   queue (§4.1). Verify with a test that "target changed ⇒ either an order cleared the gate or the target is
   marked unfunded".
3. **Tell the agents the rules**: available cash, per-name cap, cash floor, cooldown names, minimum viable order,
   turnover budget, and the account currency in `proposeSystemPrompt` (§4.6). Cheap, immediately reduces rejected
   intents and wasted tokens.
4. **Record token usage and cost per run** (`usage` from the provider response → `runs.details.llm` + an event +
   dashboard tile), plus `llm.maxCallsPerRun` / `maxSpendPerDay` guardrails (§3.1).
5. **Startup model probe** for every committee agent (3 cheap `GET /models` calls at boot; refuse to start on a
   dead model id) and delete the stale ids from `default.json` / `committee-paper.json` (§3.6).
6. **Sentiment: stop paying twice** — score headlines once per ticker per run from the news already gathered,
   cache the 403 from the Finnhub endpoint, and reuse the score for `(ticker, headline)` pairs (§3.4).
7. **Kill the `default.json` landmines**: `maxHeatPct 0.3` (→ the ADR-0004-consistent value), stale committee
   model ids, and a startup warning when `maxOrderValue > cash` or `expectedReturnPerTradePct` makes the gate a
   rubber stamp (§3.6, §7).
8. **Mark orphaned `RUNNING` runs `FAILED` on startup** (one row is currently stuck since 2026-08-31) (§4.8).

### P1 — cost & quality (weeks)
9. **Event-driven cadence** with a materiality test (§6.1) — the 60–80% token saving, and it makes sessions
   explainable ("why did the committee meet at 14:00?").
10. **One LLM call per ticker** covering all four analyst roles; keep per-role zod validation (§3.3).
11. **Context diet**: build the committee context once per session, send role-specific slices (reviewers don't
    need the full research prose), truncate analyst rationale to structured fields, cap candles/news sent, and
    enable provider prompt-caching where supported (§3.2, §6.2).
12. **Disable thinking mode for feedback/vote/sentiment calls**, keep it for proposals only (per-call override —
    `HttpLlmClient` already accepts `thinking` per client, so this means per-call config) (§3.1).
13. **Trust region + turnover budget** on applied targets, with confidence-weighted shrinkage (§4.2).
14. **Cash policy**: `cashTarget` + band, cash-drag metric per run, and cash shown to the agents as a decision
    variable (§4.5).

### P2 — strategy quality (month+)
15. **Risk-aware instrument metrics** (vol, beta, drawdown, relative strength, liquidity) from data already
    fetched, plus cost/vol-aware rebalance bands (§4.4, §5).
16. **Diversification instruments**: ETF core allocatable, sector caps, minimum effective positions (§5).
17. **Event feeds**: earnings dates + economic calendar in analyst and committee context (§5, §6.3).
18. **Outcome feedback loop**: per-decision P&L attribution, per-agent scorecards, evidence-weighted voting,
    analyst calibration metrics, performance block in the committee prompt (§4.7, §6.3).
19. **Fair agent differentiation** (distinct objectives/inputs per agent) so feedback and votes aggregate
    information rather than tone (§4.3).

---

## 9. Deliberately not recommended

- **Widening the universe for its own sake.** More tickers multiply per-run analyst cost linearly; with an
  event-driven cadence and an ETF core you get diversification far cheaper than 20 more names.
- **Removing the economic gate or the two-phase order flow.** The gate's *formula* is broken; its existence and
  the PENDING→submit→confirm discipline are the reason this system has never double-traded or lost an intent.
- **Auto-switching anything to live.** The configuration landmines above are arguments for more startup
  validation, not for loosening the practice/live separation.
- **Adding leverage, options or shorting** before §8 P0/P1 lands: the current book cannot even convert its
  analysis into one filled order, and the measured alpha is negative.

---

## 10. Reproducing the numbers

```bash
# zero orders, all rejections (live mirror)
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/trading.db',{readOnly:true});
console.log(db.prepare('select count(*) orders from orders').get(),
            db.prepare('select reason,count(*) c from decisions group by reason').all());"

# gate occupancy probe (old vs current config arithmetic)
npx tsx docs/analysis/gate-occupancy-probe.ts

# portfolio vs SPY over the sample
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/trading.db',{readOnly:true});
const r=db.prepare('select day_change_pct p,benchmark_change_pct b from portfolio_snapshots where day_change_pct is not null').all();
console.log('portfolio',r.reduce((s,x)=>s+x.p,0).toFixed(2),'SPY',r.reduce((s,x)=>s+x.b,0).toFixed(2));"
```

*Review produced by reading `src/domain/{decision,portfolio,committee,analysis}.ts`,
`src/application/services/{committee,decisions,analysts,market-analysis,news-sentiment,portfolio-evaluation,pipeline,execution,target-bootstrap}.ts`,
`src/adapters/llm/http-llm-client.ts`, `src/composition/root.ts`, `src/config.ts`, `config/*.json`,
`docs/DECISION_PROCESS.md`, `docs/ADRs/*`, plus the two SQLite databases. No files were modified.*
