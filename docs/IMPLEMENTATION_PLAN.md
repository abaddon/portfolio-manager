# Implementation plan — P0 → P1 → P2

Executable plan for the findings in [`DECISION_PROCESS_REVIEW.md`](./DECISION_PROCESS_REVIEW.md).
Three phases, **strictly sequential**. Each work package (WP) is a self-contained unit:
branch → implement → test → commit → merge to `main` → **gate check** → next WP.

- **Status:** Phase P0 complete (WP-P0.1…P0.6, ADRs 0011–0014) and Phase P1 started (WP-P1.1 merged).
- **Baseline:** `main` @ `84765f1`, `pnpm verify` green (217 tests, 31 files).
- **Numbering:** `WP-P0.n`, `WP-P1.n`, `WP-P2.n`. One WP = one branch = one (or a few logically atomic) commits.

### Execution order

The gate work (WP-P0.1) consumes the run's LLM cost, so the accounting work package is executed
**first**: `P0.4 → P0.1 → P0.2 → P0.3 → P0.6 → P0.5`, then P1.1…P1.5, then P2.1…P2.5. Numbering is
kept as designed so the review's references stay valid. 2026-09-14

| WP | Status | Branch |
|---|---|---|
| P0.4 LLM cost accounting + budget | **merged** (ADR 0011) | `phase/p0.4-llm-cost-accounting` |
| P0.1 Honest, size-aware gate | **merged** (ADR 0012) | `phase/p0.1-gate-honesty` |
| P0.2 Atomic plan/funding | **merged** (ADR 0013) | `phase/p0.2-atomic-plan-funding` |
| P0.3 Constraints in the prompt | **merged** | `phase/p0.3-prompt-constraints` |
| P0.6 Sentiment once | **merged** | `phase/p0.6-sentiment-once` |
| P0.5 Config hardening | **merged** (ADR 0014) | `phase/p0.5-config-hardening` |

---

## 0. Execution rules (apply to every WP)

| Rule | Detail |
|---|---|
| Branching | `phase/p0.1-gate-honesty` … branched from an up-to-date `main`. Never stack two in-flight WPs. |
| Merge gate | A WP is merged **only** when all four hold: (1) `pnpm verify` green (`tsc --noEmit` + vitest); (2) every new behaviour has a test that **fails against the pre-change code** (the repo's existing standard — `tests/` currently does this explicitly); (3) docs updated (ADR for any decision-semantics change, `DECISION_PROCESS.md` §-anchored, `docs/TODO.md` ticked); (4) the WP's **acceptance criterion** below is demonstrated with pasted command output, not asserted. |
| Stop rule | If the gate check fails → **stay on the WP**, fix on the same branch, re-run the gate. The phase does not advance on a red or partial WP. |
| Safety invariants (never weakened in any WP) | The economic gate never gets bypassed (all committee orders still go through `DecisionEngine.evaluate`); the two-phase `PENDING → submit → confirm` flow, `reconcileStalePending` non-idempotency discipline, and the practice/live switch in `config/local.json` are untouched. No secrets committed. |
| Tests | Domain units without mocks; adapters with stubbed `fetch`; application with `:memory:` SQLite + fake ports; any `ports.ts` change updates the fakes in `tests/application/*.test.ts` and `tests/adapters/web.test.ts` (AGENTS.md). |
| Databases | `data/trading.db` and `data_demo/trading.db` are **read-only** evidence. All smoke runs use a scratch DB (`TPM_DB_PATH=data/scratch-<wp>.db`) and either `mode: paper` or a stub. Never `pnpm run-once` against the live config. |
| Phase exit | All WPs merged, `pnpm verify` green, `docs/DECISION_PROCESS_REVIEW.md` findings for that phase marked resolved, and a written phase report (what changed, measured effect, what was deferred). |

### Confirmation items (defaults I will use unless you say otherwise)

| # | Decision | Default I propose |
|---|---|---|
| C1 | Edge model in the rewritten gate | **Derived** from the analyst composite (`targetWeightAdjustment × adjustmentConfidence`, vol-capped), with a config ceiling — not a global 2% constant. |
| C2 | Minimum net benefit ratio (new gate constant, replaces `minExpectedBenefitPct`) | `minNetBenefitPct = 0.0005` (5 bp of order value after round-trip costs) |
| C3 | AI cost inside the gate | Amortised per-run LLM spend counted as a **per-run overhead** the session's total benefit must cover (not per-order, to avoid killing small orders). |
| C4 | `allocation.cashTarget` | `0.05` with band `±0.03` (replaces the "floor only" semantics; `minCashBuffer` stays as the hard guardrail) |
| C5 | Cadence (P1) | Hourly cheap pass always; LLM session only on a materiality trigger; `dailyPlanning` = 1 forced session per trading day at market open + 30 min |
| C6 | ETF core (P2) | Make `SPY` allocatable as a core sleeve with its own cap — **off by default** in config, enabled in the paper profile first |

---

## Phase P0 — correctness (must land before any live trading)

Target: the gate measures edge instead of size; the plan can no longer drift away from the book; agents know
the rules; token spend is recorded and capped; the config landmines are gone.

### WP-P0.1 — Honest, size-aware economic gate

**Why:** reproduced structural defect — the old config rejected every size (£5…£200), the current one approves
every size from £5 (`docs/analysis/gate-occupancy-probe.ts`). A gate that cannot distinguish is not a gate.

**Files:** `src/domain/decision.ts`, `src/application/services/decisions.ts`, `src/config.ts`,
`src/composition/root.ts`, `web/public/app.js` (gate checklist), `docs/ADRs/0011-*.md` (new),
`docs/DECISION_PROCESS.md` §6.1–6.4.

**Design (concrete):**

```
pricing(price, fx):                     // both derived from the instrument's currency + .L suffix
  spreadBps_i   = costs.spreadBps                 (per-instrument override deferred to P2)
  fxRoundTrip   = (instrumentCcy ≠ accountCcy) ? costs.fxFeePct : 0        // charged on buy AND sell
  stamp         = ukListed && side=BUY ? costs.stampDutyPct : 0
  platformRoundTrip = costs.platformFeePct × 2
  costRatio C   = spreadBps_i/10_000 + 2×fxRoundTrip + stamp + platformRoundTrip

expectedEdgePct E = clamp(
    signalStrength × baseEdgePct ,                      // signalStrength ∈ [0,1]: composite of the
    0, maxEdgePct)                                      // winning proposal's confidence and the analysts'
                                                        // agreement; baseEdgePct from config
netBenefitRatio   = E − C

minViableOrder = max(costs.minOrderValue, llmOverheadPerRun / max(netBenefitRatio, ε))
maxViableOrder = min(risk.maxOrderValue, risk.maxOrderValuePct × NAV)
⇒ reject INSTRUMENT_UNECONOMIC when minViableOrder > maxViableOrder    // the ticker is untradeable at this size

gate (order value V):
  V ≥ minViableOrder
  V ≤ maxViableOrder
  E ≥ C × costBenefitMultiplier
  sessionNetBenefit = Σ (E − C) × V  ≥  llmCostPerRun × llmCostBenefitMultiplier
  … then the existing confidence / cooldown / cash / heat / maxOrdersPerRun checks, unchanged
```

`minExpectedBenefitPct` is **removed** (it is algebraically a second confidence floor) and `expectedReturnPerTradePct`
is replaced by `baseEdgePct` + `maxEdgePct`. Dashboard gate checklist renders the new inputs from `decision.details`
(`edgePct`, `costRatioPct`, `minViableOrder`, `netBenefit`).

**Calibration obligation (part of the WP, not optional):** using the distributions observed in
`data/trading.db` (`analysis_reports.signals`, `portfolio_snapshots`), pick the constants so that on the sample
**some but not all** intents clear. Deliverable: a table in the ADR showing intents at £20/£50/£100/£200 →
verdict, for the chosen constants. If no realistic intent clears, the constants are wrong (that is exactly the
month-of-zero-trades failure being fixed).

**Tests:** `tests/domain/decision.test.ts` (round-trip cost, `min/maxViableOrder`, `INSTRUMENT_UNECONOMIC`,
edge floor, LLM overhead, HOLD/no-conviction paths unchanged), `tests/application/decisions.test.ts`
(running cash/heat state still threads; new rejections persisted with full detail maths).
**Acceptance:** `npx tsx docs/analysis/gate-occupancy-probe.ts` extended into a calibration table showing
≥1 approved and ≥1 rejected realistic intent; `pnpm verify` green.

### WP-P0.2 — Plan and funding become atomic (no more unfunded drift)

**Why:** `applyWinnerTargets()` persists targets before the orders are gated, so the book is permanently off-plan
(measured: targets sum 0.8928, MSFT target 0.25 vs actual weight 0.1563 across 9 days).

**Files:** `src/application/services/committee.ts`, `src/domain/portfolio.ts`,
`src/adapters/persistence/{sqlite.ts,allocation-targets.ts,repositories.ts}` (+ migration),
`src/application/ports.ts` (+ fakes), `web/public/*` targets panel.

**Design:** add `allocation_targets.status ∈ {ACTIVE, UNFUNDED}` (+ `funded_by_order_id` nullable) via a guarded
migration (per the repo's migration rules). Order inside the session becomes: gate the winner's orders →
persist targets as `ACTIVE` when an approved order in this run moves the ticker toward them, else `UNFUNDED`.
`currentTargets()` keeps returning every target (drift maths unchanged), but `UNFUNDED` rows are surfaced:
(a) in the committee context as a standing residual (`target − current` with the reason), (b) on the dashboard,
(c) in a `CommitteeTargetsUnfunded` event. A later run that funds them flips them to `ACTIVE`.

**Tests:** committee session unit (target changed with no approved order ⇒ `UNFUNDED` + event; with an approved
order ⇒ `ACTIVE`); repository round-trip incl. the migration on a pre-existing DB fixture; e2e pipeline asserts
the invariant **"target changed ⇒ funded by an approved order, or marked UNFUNDED"**.
**Acceptance:** that invariant asserted in `tests/application/pipeline*.test.ts`; migration verified against a
copy of `data/trading.db` opened read-only → copied to scratch (never the original).

### WP-P0.3 — Constraints in the committee prompt

**Why:** agents proposed £22/£26/£48 intents against rules they were never shown (all rejected by construction),
burning tokens for impossible orders.

**Files:** `src/application/services/committee.ts` (`proposeSystemPrompt`), `docs/DECISION_PROCESS.md` §6.

**Design:** a `constraints` block built at prompt time from live state: account currency, `availableCash`
(`cash − cashTarget × NAV`), per-name cap `maxTarget`, cash floor, `minViableOrder` / `maxViableOrder` for each
allocatable ticker, cooled tickers, current targets + status, and the session turnover budget (P1 uses it).
Prompt additionally requires agents to keep intents within those bounds and to say what they would do with idle
cash.

**Tests:** committee unit asserting the prompt contains each constraint and the computed min viable order.
**Acceptance:** a scripted-committee e2e run whose scripted agent *reads* the injected constraint and proposes a
compliant order → approved; a deliberately sub-minimum intent → rejected with the new reason, both visible in the
test assertions.

### WP-P0.4 — Token/cost accounting + spend guardrails

**Why:** `HttpLlmClient.request()` discards the provider `usage` field; there is no per-run or per-day budget.

**Files:** `src/adapters/llm/http-llm-client.ts` (parse `usage`), `src/application/ports.ts`
(`LlmUsage` + optional `onUsage`), new `src/application/services/llm-budget.ts`, `src/adapters/persistence/sqlite.ts`
(`llm_usage` table + migration), `src/application/services/pipeline.ts` + `root.ts` (wire + run details),
`web/public/*` (spend tile), `src/config.ts` (`llm.maxCallsPerRun`, `llm.maxSpendPerDayUsd`, rate table).

**Design:** per call record `{runId, agentId, provider, model, promptTokens, completionTokens, cachedTokens,
usdCost}`; `runs.details.llm = {calls, promptTokens, completionTokens, usdCost}`; event `LlmUsageRecorded`;
soft stop when the budget is hit (remaining optional phases are skipped, the run completes with a clear reason —
never a crash). `DecisionService` receives `llmCostPerRun` for WP-P0.1's overhead term.

**Tests:** LLM client parses usage for both wire formats (stubbed `fetch`); budget service enforces call and
spend caps; repository round-trip; pipeline test asserting `runs.details.llm.usdCost > 0` with scripted LLMs.
**Acceptance:** `pnpm run-once --force --config config/paper-real-data.json` on a scratch DB prints a real
per-run cost line and the dashboard tile shows it (or, with no keys, the scripted e2e proves the plumbing).

### WP-P0.5 — Config hardening: model probe, dead ids, landmines, orphan runs

**Why:** a dead model id (`moonshotai/kimi-k3` → HTTP 404) killed a live session after paying for all upstream
analysis; `default.json` still ships `maxHeatPct 0.3`; one run is stuck `RUNNING` since 2026-08-31.

**Files:** `src/adapters/llm/{model-probe.ts (new)}`, `src/main.ts`/`src/cli.ts` (startup probe + `verify-models`
command), `src/config.ts` (startup validation warnings), `src/adapters/persistence/repositories.ts`
(`failOrphanedRunning`), `config/default.json`, `config/committee-paper.json`, `docs/ADRs/0012-*.md`.

**Design:** probe each configured `committee.agents[].provider/model` against the provider's models endpoint
(skipped with a WARN when the provider exposes none); startup validation refuses to boot on a definitely-dead id
in `mode: live`, warns in `paper`; `default.json` gets the ADR-0004-consistent `maxHeatPct`, a valid committee
block, and the new gate keys; orphan `RUNNING` runs are marked `FAILED` with an event.

**Tests:** probe adapter (stubbed `fetch`, hit/miss/skip); config validation cases; repository orphan-sweep.
**Acceptance:** `pnpm verify-models` output pasted; booting with a deliberately bogus model id fails fast with a
clear message; a scratch copy of `data/trading.db` shows the stuck run flipped to `FAILED`.

### WP-P0.6 — Sentiment paid once, not twice

**Why:** per ticker per run the chain attempts Finnhub social sentiment (permanent 403 on the free plan) and can
call the LLM twice for a number the keyword heuristic produces free.

**Files:** `src/application/services/news-sentiment.ts`, `src/application/services/market-analysis.ts`,
`src/composition/root.ts`.

**Design:** score the already-gathered headlines exactly once per ticker; memoise scores by
`(ticker, normalized headline)` (the `news_items` table already dedupes on that key); remember a permanent
`auth`-kind failure from a sentiment source for the process lifetime; remove the second `sentiment(…, {news})`
call in `gather()`.

**Tests:** port unit (403 cached ⇒ single attempt; repeated headlines ⇒ one LLM call; heuristic fallback offline);
`market-analysis` unit asserting ≤ 1 sentiment call per ticker per run.
**Acceptance:** a counted-calls test proving the reduction (before/after counts in the commit message).

### Phase P0 exit report
`pnpm verify` green; the live-DB probe re-run; a table "what the gate now rejects and why"; `DECISION_PROCESS.md`
§6.1–6.4 and the new ADRs linked; findings P0 in `DECISION_PROCESS_REVIEW.md` marked resolved.
**Only then does P1 start.**

---

## Phase P1 — cost & decision quality

Target: stop paying the hourly price for a weekly decision; make the surviving calls cheap and role-appropriate;
stop a single session from re-shaping the book; give cash a policy.

| WP | Status | Branch |
|---|---|---|
| P1.1 Event-driven cadence | **merged** | `phase/p1.1-event-driven-cadence` |
| P1.2 One call per ticker (all four roles) | **merged** | `phase/p1.2-single-call-analysts` |
| P1.3 Context diet + per-call thinking | **merged** | `phase/p1.3-context-diet` |
| P1.4 Trust region + turnover budget | **merged** | `phase/p1.4-trust-region` |
| P1.5 Cash as a managed position | next | `phase/p1.5-cash-policy` |

### WP-P1.1 — Event-driven cadence with a materiality test
**Files:** new `src/domain/cadence.ts` (pure), `src/application/services/pipeline.ts`, `src/config.ts`
(`schedule.materiality.*`, `schedule.dailyPlanning`), `src/adapters/scheduler/*`, `web/public/*` (why-now chip).
**Design:** an hourly `stats` pass (quotes, snapshot, NAV, drift, risk, order sweep — **zero LLM calls**) always
runs; the LLM path (`analysis` + `committee`) runs only when a trigger fires: any `|drift| > band`, new material
news since the last run, `|NAV move| ≥ triggerNavMovePct`, an open `UNFUNDED` target, or the once-per-day planning
slot. The run records `details.trigger` (`{kind, values}`) and the dashboard shows *why* the committee met.
**Tests:** pure cadence decisions (each trigger, plus the negative case); pipeline test with a stub clock proving
no LLM call on a non-material hour and one on a material hour.
**Acceptance:** measured call count over a replayed trading day (scripted/fixture data) dropping by ≥ 50% with
the material hour still producing a session.

### WP-P1.2 — One LLM call per ticker for all four analyst roles
**Files:** `src/application/services/analysts.ts`, `src/application/services/market-analysis.ts`, `ports.ts`
(+ fakes), `docs/ADRs/0013-*.md`.
**Design:** `chatJsonMulti` (or a per-role schema map) returning `{market, sentiment, news, fundamentals}` in one
call; per-role zod validation with the existing one-repair-retry; the offline analysts stay as-is (fallback path).
**Tests:** validation of partial/invalid role blocks (missing role ⇒ that role falls back to its offline analyst,
the run continues); call-count assertion (1 per ticker, not 4).
**Acceptance:** 20 → 5 calls per run proven in a test; a paper smoke run producing 20 reports from 5 calls.

### WP-P1.3 — Context diet and per-call thinking override
**Files:** `src/application/services/committee.ts` (`buildContext(profile)`), `src/adapters/llm/http-llm-client.ts`
(per-call `thinking`), `src/application/ports.ts`, `src/config.ts` (`llm.thinkingByPhase`).
**Design:** build the context **once per session**; three slices — `propose` (full research), `review` (account +
drift + proposal JSON + one-line analyst summary), `vote` (proposal list + feedback verdicts). Analyst rationale
truncated to a structured form for prompts (full prose stays in the DB for the audit trail). Feedback/vote calls
run with thinking disabled, proposals keep the configured mode.
**Tests:** prompt-size assertions (character budget per slice), thinking flag forwarded per call, session still
completes with the slices.
**Acceptance:** measured input-token reduction per session ≥ 40% (scripted-LLM char/token counter in the test).

### WP-P1.4 — Trust region and turnover budget on applied targets
**Files:** `src/domain/portfolio.ts` (pure shrinker) or `src/domain/committee.ts`, `committee.ts` apply step,
`src/config.ts` (`committee.trustRegion`, `committee.maxTurnoverPctPerSession`, `committee.minWeightChange`).
**Design:** `w_new = w_old + k × confidence × (w_proposed − w_old)`, per-ticker dead-zone
(`|Δ| < minWeightChange` ⇒ no change), and a session cap: total `Σ|Δ| × NAV ≤ maxTurnoverPctPerSession × NAV`,
scaled down proportionally when exceeded (the same rescale idiom the cash floor already uses).
**Tests:** domain shrinker (shrinks toward incumbent; dead-zone; cap scales all deltas), committee apply test.
**Acceptance:** a scripted session proposing a 5-point swing applies a materially smaller, bounded change.

### WP-P1.5 — Cash is a managed position
**Files:** `src/domain/portfolio.ts` (`computeCashDrag`), `portfolio-evaluation.ts`, `src/config.ts`
(`allocation.cashTarget`, `allocation.cashBand`), `committee.ts` (prompt + context), `web/public/*`.
**Design:** target cash weight with a band; `cashDragPct` per run = `cash × benchmarkDailyChange` (opportunity
cost) and `cashDrift` vs target; both surfaced to the committee and on the dashboard; a `CashPolicyBreached`
event when outside the band. No new gate: the committee decides, but now with the number in front of it.
**Tests:** domain cash-drag/drift maths; evaluation event; prompt contains the cash policy.
**Acceptance:** dashboard shows target/actual cash and drag; committee prompt test asserts the block.

### Phase P1 exit report
Replay the sample period with fixtures: sessions run, tokens/run, calls/run, cost/day (before vs after).
**Only then does P2 start.**

---

## Phase P2 — strategy quality

Target: replace proxy risk with measured risk; broaden the opportunity set coherently; know about events; and
learn from outcomes.

### WP-P2.1 — Instrument risk metrics from data already fetched
**Files:** new `src/domain/risk.ts` (realised vol, trend, momentum, drawdown, volume z-score, distance to
20-bar high/low, beta vs benchmark), new `src/application/services/instrument-metrics.ts`,
`portfolio-evaluation.ts` / `committee.ts` context, `web/public/*` (per-name risk panel).
**Design:** pure functions over the 40 candles already retrieved (SPY candles +1 call/run for beta); metrics are
persisted per name per run and injected into the committee context (a compact table, ~40 tokens/name).
**Tests:** domain maths against hand-computed fixtures (incl. degenerate series: <14 bars, zero variance) and the
spread/vol-aware band formula.
**Acceptance:** metrics present for every universe ticker in a paper run; dashboard panel populated.

### WP-P2.2 — Diversification: ETF core, sector caps, minimum effective positions
**Files:** `src/application/services/committee.ts` (guardrails), `src/application/services/allocation-targets.ts`,
`src/config.ts` (`committee.sectorCaps`, `committee.minPositions`, `allocation.coreSleeve`), `config/*.json`,
`web/public/*`.
**Design:** optional allocatable core sleeve (default **off**, enabled in the paper profile); sector exposure
computed from `fundamentals.sector` (already fetched) with per-sector caps applied in the same guardrail pass as
`maxTarget`/`minCashBuffer`; a minimum effective number of positions warned on the dashboard and asserted in the
session details. Guardrail pass extracted into a pure function so the policy is unit-testable.
**Tests:** pure guardrail pass (cap breach rescales; sector cap across names; core sleeve end-to-end in paper).
**Acceptance:** a paper run where a proposed 60% tech allocation is rescaled to the sector cap, shown in the
session details, and the book keeps ≥ minPositions.

### WP-P2.3 — Earnings dates and economic calendar
**Files:** new `src/adapters/marketdata/calendar.ts` (provider-backed, contained failure), `ports.ts`
(`EventCalendarPort`, optional), `analysts.ts` / `committee.ts` context (`daysToEarnings`), `src/config.ts`.
**Design:** earnings date per ticker + macro event dates; failures contained (null ⇒ feature silently off);
context gains `daysToEarnings` and `upcomingMacroEvents`; an `EarningsWindow` flag tells the committee when a name
is inside N days of a print so it can size down or wait.
**Tests:** adapter contract (stubbed `fetch`, unavailable ⇒ null path); context includes the fields when present
and is unchanged when absent.
**Acceptance:** paper run showing `daysToEarnings` for each name; graceful degradation test when the source 403s.

### WP-P2.4 — Outcome feedback loop
**Files:** new `src/application/services/performance.ts` + `src/domain/performance.ts` (pure attribution),
`src/adapters/persistence/sqlite.ts` (+ tables/migrations: `decision_outcomes`, `agent_scorecards`),
`web/public/*` (scorecard + attribution panels), `committee.ts` (performance block in the prompt).
**Design:** each run, price the previous N decisions/sessions with the new snapshot (already stored: prices,
weights, NAV): per-decision realisation (target weight now vs then, NAV contribution, realised costs), per-agent
scorecard (hit rate, average realised ΔNAV contribution, calibration of confidence), and an analyst calibration
metric stored on `analysis_reports.details` against forward returns. A compact performance block (NAV trend,
alpha, drawdown, last session's outcome, each agent's hit rate) goes into the committee prompt.
**Tests:** pure attribution maths on fixtures; scorecard aggregation; repository round-trips; prompt contains the
block; e2e asserting outcomes are recorded for a filled order.
**Acceptance:** after a scripted multi-run e2e, an agent scorecard and a decision attribution row exist and the
dashboard renders them.

### WP-P2.5 — Differentiate the agents (information, not tone)
**Files:** `src/application/services/committee.ts` (per-agent context views + role-specific prompts),
`src/config.ts` (`committee.agents[].role`), `config/*.json`, `docs/ADRs/0014-*.md`.
**Design:** optional `role` per agent (`macro` | `momentum` | `valuation` | `risk-officer`) selecting which
context slices that agent receives and which objective its prompt states (the risk officer is explicitly asked to
argue for less concentration). Absent `role` ⇒ today's behaviour (backwards compatible).
**Tests:** per-role context view (fields present/absent), prompt objective, session still completes with mixed
roles, backwards-compatible path.
**Acceptance:** a paper session with one agent per role producing visibly different proposals (evidence pasted in
the phase report), votes now aggregating different information.

### Phase P2 exit report
Full re-read of `DECISION_PROCESS.md` against the code, ADRs for every semantics change, dashboard verified,
`pnpm verify` green. Deferred items explicitly listed.

---

## Risk register / what could go wrong

| Risk | Mitigation baked into the plan |
|---|---|
| The rewritten P0 gate is too strict again → another month of zero trades | WP-P0.1 calibration obligation (some-but-not-all clearing) is a merge gate, not a nicety |
| Gate semantics churn breaks existing tests silently | Same-commit test updates + ADR + `DECISION_PROCESS.md` update; every behaviour change must fail first against pre-change code |
| `UNFUNDED` targets visibly "wrong" on the dashboard confuse rather than inform | WP-P0.2 surfaces status + reason in the same panel; event trail records every transition |
| Cost optimisations change decision quality invisibly | WP-P1.1–P1.3 acceptance criteria measure calls/tokens *and* require a completed session with the same inputs; P2.4 adds the outcome check |
| Migration damage to the real DB | Migrations only ever exercised on scratch copies; `data/*.db` treated read-only; guarded migrations per AGENTS.md |
| Token budget guardrail silently truncating a session | Soft stop records an explicit reason on the run and an event; never a crash, never a silent no-op |

## Deliverables per phase

1. Merged WP branches on `main` (one per WP, conventional commit messages summarising intent).
2. New ADRs: `0011` gate redesign (P0), `0012` startup validation (P0), `0013` single-call analysts (P1),
   `0014` agent roles (P2) — each with alternatives considered and the calibration/measurement evidence.
3. Updated `docs/DECISION_PROCESS.md` (gate maths, cadence, guardrails, feedback loop) and `docs/TODO.md`
   (findings ticked as they land).
4. Phase reports with pasted command output: gate calibration table (P0), cost-per-run before/after (P1),
   metrics/scorecard evidence (P2).
