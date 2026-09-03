# ADR 0003 — Inside the rebalance band, the analyst signal decides the trade direction

- **Status:** Accepted — superseded by [ADR 0009](./0009-unified-committee-decision-flow.md) (2026-09-02): the inside-band signal rule belonged to the classic decision flow, which was removed. The committee now decides every trade; the directional veto described here no longer exists. Kept for the historical record.
- **Date:** 2026-08-28
- **Decision maker:** User (Stefano) + AI agent

## Context

`DecisionService.decide` considers a ticker actionable when it is outside its rebalance band
**or** the aggregated analyst signal is strong (`|signal| ≥ risk.signalThreshold`). The trade
action was derived from the drift hint alone (`hint === "buy" ? BUY : SELL`). Inside the band the
hint is `hold`, so every inside-band candidate became a **SELL** proposal:

- a strong bearish signal produced a SELL sized by the signal (a trim) — fine;
- a strong bullish signal produced a SELL whose direction (−1) opposed the signal, which the
  direction veto then rejected as `NO_CONVICTION` — every time.

Net effect: analyst signals could only ever trim a position; opening or adding happened solely
through allocation drift. This was not a deliberate rule — the review of
`docs/DECISION_PROCESS.md` surfaced it as an asymmetry nobody had chosen.

## Decision

When the drift hint is `hold`, the action follows the sign of the aggregated signal:

```
action = hint "buy"  ⇒ BUY
       | hint "sell" ⇒ SELL
       | hint "hold" ⇒ signal > 0 ? BUY : SELL
```

The direction veto and the size boost (`signalBoost`) are derived from the resulting **action**,
not from the hint, so they stay consistent with it. Nothing else changes: an inside-band BUY is
sized by the signal alone (`|drift| ≈ 0`), floored at `minTradeValue`, capped at
`maxOrderValue`, and must pass the full economic gate (`minConfidence`, cooldown, min benefit,
cost multiplier, cash, heat) exactly like a drift-driven BUY.

## Consequences

- Bullish analyst consensus inside the band can now **add** to (or open) a position, bounded by
  the same gates and by `signalThreshold`; with `adaptation.enabled` the allocation review
  moves the target in the same direction, so the two paths agree.
- Slightly more BUY candidates per run than before; `maxOrdersPerRun`, cooldown and heat still
  cap actual orders. Users who preferred "signals only trim" can raise `risk.signalThreshold`.
- Tests: two new cases in `tests/application/decisions.test.ts` (inside-band bullish ⇒ BUY,
  inside-band bearish ⇒ SELL). `docs/DECISION_PROCESS.md` §6 updated.

## Alternatives considered

- **Keep SELL-only inside the band (document it as a rule)** — rejected: it silently disables
  the analysts' ability to increase exposure, which contradicts the purpose of
  `targetWeightAdjustment`.
- **Drop the "strong signal" actionability clause entirely** — rejected: the allocation review is
  opt-in and bounded to ±`maxDeltaPerRun`, so without this path a strong signal would take many
  hours to become a trade.
