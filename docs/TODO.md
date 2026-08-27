# Trading portfolio manager
Open items surfaced while reviewing `docs/DECISION_PROCESS.md` against the code (2026-08-28). Doc-only fixes were applied; the items below need a user decision before any code changes.

### Open questions (from the decision-process review)
- [ ] NAV is not cash-flow adjusted #portfolio 2026-08-28  
  - `PortfolioEvaluationService` fixes units at 1000; `NavLedger.applyCashFlow` is unused. Deposits/withdrawals show as performance. Wire the ledger (detect cash flows from broker cash deltas) or document as accepted.  

### Completed ✓
- [x] Partial fills: orders settle only on terminal broker states, fills carry the broker's filled quantity, cancelled remainders keep the filled part (ADR 0005) 2026-08-28  
- [x] Dead code / dead config removed: `AnalysisReport.isActionable`, `allocation.cashBuffer` (schema, default.json, fixtures); `NavLedger` kept — wired by the NAV cash-flow item 2026-08-28  
- [x] `DecisionEngine.evaluate` docstring now lists the gates in code order 2026-08-28  
- [x] `maxHeatPct` kept as invested-fraction cap; `local.json` raised 0.12 → 0.855 = (1 − minCashBuffer) × (1 − stopDistancePct) (ADR 0004) 2026-08-28  
- [x] Inside-band strong bullish signal was always vetoed — action now follows `sign(signal)` when the hint is `hold` (ADR 0003) 2026-08-28  
- [x] Evaluate `docs/DECISION_PROCESS.md` against `src/` and fix inaccuracies/omissions 2026-08-28  
