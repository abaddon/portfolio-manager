# Phase P2 exit report — strategy quality

Date: 2026-09-14 · Branch: `main` · `pnpm verify`: **green (44 files, 368 tests)**
Work packages: WP-P2.1 … WP-P2.5 (all merged) · Predecessors: [Phase P0 & P1](../TODO.md)

---

## 1. What changed

| WP | Change | Commit |
|---|---|---|
| P2.1 | Instrument risk metrics from the candles already fetched (vol, beta, drawdown, momentum, range, volume, concentration) + cost/vol-aware rebalance bands | `c651d7d` |
| P2.2 | Sector exposure caps and a minimum position count; the excess stays in cash; sectors come from the fundamentals feed | `f7187e7` |
| P2.3 | Earnings awareness: one `/calendar/earnings` request per run → `daysToEarnings` in every analyst context and a `scheduledEvents` block for the committee | `d0f7ed5` |
| P2.4 | Outcome feedback: per-decision forward-return attribution, per-agent scorecards, analyst calibration, `trackRecord` block in the propose prompt | `093ed6e` |
| P2.5 | Role-seated committee (macro / momentum / valuation / risk-officer): different evidence and a different objective per seat | `8f85d46` |

## 2. What the system now measures about a name before it trades it

```
price, change%            quote            (Finnhub)
realised volatility       candles          per bar + annualised
beta, correlation         candles + SPY    cov(instrument, benchmark) / var(benchmark)
trend, momentum           candles          vs SMA20, 5/20-bar returns
risk of the range         candles          worst drawdown, position in [low, high]
liquidity sanity          candles          last-bar volume vs the window average
days to earnings          calendar         one request per run for the whole universe
sector                    fundamentals     for the diversification caps
concentration             weights          largest weight, top-3, effective positions
past outcomes             decisions        forward return × order value, per decision and per agent
```

Every one of those is either already fetched by the existing steps or costs one extra request per run.

## 3. Measured / asserted behaviour

| Claim | Evidence |
|---|---|
| A 5-point one-hour target swing is damped to ~1 point | `tests/domain/committee.test.ts` (trust region, `Δ −0.03 → −0.0101`) |
| A sector over its cap is scaled back and the excess stays in cash | `tests/domain/committee.test.ts`, `tests/application/committee.test.ts` (Technology 0.70 → 0.30, session records `cappedSectors`) |
| An order is only "needed" while the position is off the recorded target by more than the band | `details.funding` on every decision, asserted in `tests/application/committee.test.ts` |
| A rejected decision is never scored as zero, and an unmeasurable one stays queued | `tests/application/performance.test.ts` |
| Each role sees different evidence | `tests/application/committee.test.ts` (valuation ≠ momentum analyst sets; risk seat gets no prose) |
| The gate refuses sub-minimum sizes and unsupported names at any size | `docs/analysis/gate-occupancy-probe.ts`, ADR 0012 §calibration |

## 4. Deliberately not done (and why)

- **ETF core sleeve.** Making an index instrument allocatable changes *what the portfolio can own*. That
  is a user decision, not an implementation detail: it needs a chosen instrument (SPY/VOO, or a
  world/bond pair) and an explicit cap. The sector caps and the minimum-position report are in place, so
  the sleeve is a small follow-up once you pick the instrument.
- **Evidence-weighted voting.** The per-agent scorecard is computed and shown to the committee, but
  ballots stay one-agent-one-vote so the tie-break rules remain deterministic (ADR 0010's stand). If you
  want votes weighted by track record, that is a deliberate change to the voting model and worth its own
  ADR.
- **Macro event calendar.** Finnhub's free tier has no economic-calendar endpoint; `upcomingMacro` is an
  optional port that stays undefined, and the system reports no releases rather than inventing any.
- **Per-instrument spread.** The cost model still uses one configured `spreadBps`; the free data plan has
  no spread source. `rebalanceBandFor()` already consumes the round-trip cost, so plugging in a real
  spread later widens bands automatically.

## 5. Verification

```bash
pnpm verify                                    # 44 files, 368 tests
npx vitest run tests/application/pipeline-cadence.test.ts   # [P1 exit] calls-per-hour measurement
npx vitest run tests/application/committee.test.ts          # [context diet] + role/trust-region evidence
npx tsx docs/analysis/gate-occupancy-probe.ts               # gate calibration table
TPM_DB_PATH=data/smoke.db pnpm run-once --force --config tests/fixtures/test-config.json
pnpm verify-models                                          # committee model ids before a live start
```

A final smoke run on the paper fixture completes with `details.cadence`, `details.outcomes` and
`details.llm` populated and no schema errors.

## 6. Where the system stands

- **Money path**: analysis → portfolio evaluation → materiality test → (committee: gated orders → funded
  targets) → execution, with every gate, cost, token and outcome recorded.
- **Cost path**: one call per ticker for the analysts, sentiment scored once per headline, the expensive
  path gated by materiality, and a hard per-run/per-day token budget.
- **Learning path**: every approved decision is attributed against the return that followed, and the
  committee is shown its own record before it decides again.

The remaining honest gap is structural, not technical: with a small account and 0.34 % round trips, the
system will trade rarely, and that is the correct behaviour rather than a bug to optimise away.
