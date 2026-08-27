# Trading portfolio manager
Open items surfaced while reviewing `docs/DECISION_PROCESS.md` against the code (2026-08-28). Doc-only fixes were applied; the items below need a user decision before any code changes.

### Open questions (from the decision-process review)
- [ ] NAV is not cash-flow adjusted #portfolio 2026-08-28  
  - `PortfolioEvaluationService` fixes units at 1000; `NavLedger.applyCashFlow` is unused. Deposits/withdrawals show as performance. Wire the ledger (detect cash flows from broker cash deltas) or document as accepted.  
- [ ] Dead code / dead config #cleanup 2026-08-28  
  - `NavLedger` (`src/domain/portfolio.ts`) and `AnalysisReport.isActionable` (`src/domain/analysis.ts`) are only referenced from tests.  
  - `allocation.cashBuffer` is in the config schema but never read; the only cash floor is `adaptation.minCashBuffer`.  
- [ ] `DecisionEngine.evaluate` docstring lists the gates in the wrong order #comment 2026-08-28  
  - Code order: HOLD → quantity → confidence → maxOrderValue → cooldown → min benefit → cost multiplier → cash/heat.  
- [ ] Partial fills are recorded as full fills #execution 2026-08-28  
  - `confirmFill` sets `filledQuantity = order.quantity` even for `PARTIALLY_FILLED`.  

### Completed ✓
- [x] `maxHeatPct` kept as invested-fraction cap; `local.json` raised 0.12 → 0.855 = (1 − minCashBuffer) × (1 − stopDistancePct) (ADR 0004) 2026-08-28  
- [x] Inside-band strong bullish signal was always vetoed — action now follows `sign(signal)` when the hint is `hold` (ADR 0003) 2026-08-28  
- [x] Evaluate `docs/DECISION_PROCESS.md` against `src/` and fix inaccuracies/omissions 2026-08-28  
