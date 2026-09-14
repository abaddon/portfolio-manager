# Phase P1 exit report — cost & decision quality

Date: 2026-09-14 · Branch: `main` · `pnpm verify`: **green (39 files, 321 tests)**
Work packages: WP-P1.1 … WP-P1.5 (all merged) · Predecessor: [Phase P0](../TODO.md) (ADRs 0011–0014)

---

## 1. What changed

| WP | Change | Commit |
|---|---|---|
| P1.1 | Event-driven cadence: the hourly pass always snapshots/evaluates/sweeps; analysts + committee run only on a trigger (unfunded target, drift beyond band, NAV move, new headlines, planning slot, manual/force) | `b63a918` |
| P1.2 | One LLM call per ticker for all four analyst roles (`chatJsonMulti` + `MultiRoleLlmAnalyst`), per-role offline fallback | `a04246d` |
| P1.3 | Phase-sliced committee context (propose full / review summary-only / vote account-only) + thinking disabled for feedback and votes | `d4af7fc` |
| P1.4 | Trust region (k 0.4 × confidence damping), 50 bp dead zone, 10%-of-NAV turnover budget per session, applied **before** the orders are gated | `a3f4974` |
| P1.5 | Cash as a managed position: target (derived or configured), band, `CashPolicyBreached`, drag vs the benchmark, committee context + dashboard | `82f383b` |

## 2. Measured effect

### Inference calls per market hour

Measured by `tests/application/pipeline-cadence.test.ts` on a simulated 7-hour US session with a real
pipeline, a real (in-memory) database and metered committee clients:

```
[P1 exit] 7 market hours: 1 material run(s), 14 calls per full run → 2.0 calls/hour with the
          materiality gate vs 14.0 calls/hour if every hour ran the full path (86% fewer)
```

| | Before (review baseline) | After |
|---|---|---|
| Analyst calls per full run (5 tickers) | 20 (4 per ticker) | **5** (1 per ticker) |
| Sentiment calls per ticker per run | up to 2 (news re-score + retry) | **≤ 1**, memoised per `(ticker, headline)` |
| Committee calls per session (3 agents) | ~12, each carrying the full research blob | ~12, deliberately sliced by phase |
| Full-path runs per 7-hour day | 7 | **1** (triggers only) |
| Calls per market hour (5-ticker universe) | ~50 | **~2** on stats-only hours, ~25 on a material hour |

Context characters per session (4-agent fixture, `tests/application/committee.test.ts`):

```
[context diet] per-call user chars: propose 1292 · review 686 · vote 467
[context diet] session context chars: 15268 vs 25840 if every phase sent the propose context (41% less)
```

### Decision quality

| Behaviour | Before | After |
|---|---|---|
| A 5-point one-hour target swing (observed live: AMZN 0.15 → 0.12 and back) | applied verbatim | damped to ~1 point (`Δ −0.03 → −0.0101`) |
| One 2/1 vote re-shaping the book | yes, unbounded per session | ≤ 40 % of any requested change, ≤ 10 % of NAV of turnover per session |
| Target changes too small to pay for an order | applied (and then re-applied the other way) | dropped by the 50 bp dead zone |
| "Why is 23.5 % of the book idle?" | invisible | `cashPolicy` in the committee context, `CashPolicyBreached` event, drag in £/day on the dashboard |
| Session cost vs trade benefit | not comparable | run inference cost is inside the gate (WP-P0.1), and the run must be material to happen at all |

## 3. What Phase P1 did **not** do

- **No risk model yet.** Volatility, beta, correlation, sector caps and the ETF core are Phase P2
  (the gate still assumes an edge from analyst deltas and a flat spread of 2 bp).
- **No outcome feedback loop yet.** Nothing yet scores whether a session's decisions made money; that is
  WP-P2.4.
- **No earnings or economic-calendar awareness** (WP-P2.3).
- **The committee's voting is still one-agent-one-vote** with no track record weighting (WP-P2.4/P2.5).
- Cadence defaults are conservative but untuned on live data: `navMovePct` 1 %, `driftPct` 5 %,
  `planningIntervalHours` 20, `driftCooldownHours` 3. They are config, and the first weeks of live
  `runs.details.cadence` data are what should tune them.

## 4. Verification evidence

```bash
pnpm verify                        # tsc --noEmit + vitest → 39 files, 321 tests
npx vitest run tests/application/pipeline-cadence.test.ts   # prints the [P1 exit] measurement
npx vitest run tests/application/committee.test.ts          # prints the [context diet] measurement
npx tsx docs/analysis/gate-occupancy-probe.ts               # gate calibration table (Phase P0 evidence)
pnpm verify-models                                          # committee model ids
```

## 5. Next: Phase P2 (strategy quality)

WP-P2.1 instrument risk metrics · WP-P2.2 diversification (ETF core, sector caps, minimum positions) ·
WP-P2.3 earnings dates + economic calendar · WP-P2.4 outcome feedback (attribution, scorecards,
calibration) · WP-P2.5 agent differentiation. See `docs/IMPLEMENTATION_PLAN.md`.
