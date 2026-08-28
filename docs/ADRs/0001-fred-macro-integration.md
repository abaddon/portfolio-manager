# ADR 0001 — FRED macro data as an additional analysis input

- **Status:** Accepted
- **Date:** 2026-08-26
- **Decision maker:** User (Stefano) + AI agent

## Context

The user asked whether the [FRED API](https://fred.stlouisfed.org/docs/api/fred/) could be used
"as an alternative to Finnhub". Finnhub currently supplies per-ticker quotes, company news and
fundamentals. FRED (Federal Reserve Economic Data) is a different data domain: it serves US
macroeconomic time series (fed funds rate, treasury yields, VIX, CPI, unemployment, S&P 500 level).
It has **no** company news, no company fundamentals and no intraday stock quotes — so it cannot
replace Finnhub for those inputs.

The Market analyst currently only sees price candles and the benchmark quote; it has no macro
context (rate environment, volatility regime, yield-curve shape). The user's stated goal is to
persist "any possible data useful to take better decisions", which macro data squarely serves.

## Decision

Integrate FRED as an **additional macro input alongside Finnhub** (not a replacement):

1. New driven port `MacroDataPort` → `FredAdapter` (`src/adapters/marketdata/fred.ts`).
2. One macro snapshot per pipeline run, fetched once (not per ticker) by `MarketAnalysisService`:
   - `DFF` fed funds rate (%),
   - `DGS10` / `DGS2` treasury yields (%), `T10Y2Y` 10Y–2Y spread (%),
   - `VIXCLS` volatility index,
   - `UNRATE` unemployment (%),
   - `SP500` S&P 500 index level,
   - `CPIAUCSL` CPI with a 12-month YoY % computed from 13 monthly observations.
3. The snapshot is passed to every analyst via `AnalystContext.macro` and dumped into the LLM
   prompt (all four analysts receive it; the Market role prompt explicitly uses it for regime
   judgement). Offline rule-based analysts ignore it (unchanged behaviour).
4. Persisted in a new `macro_snapshots` table (one row per run), exposed via `GET /api/macro`
   and a dashboard panel (latest values + VIX / 10Y–2Y trend per run).
5. Config: `dataProviders.macro: "fred" | "none"` (default `"fred"` in `default.json`, schema
   default `"none"` so fixture configs that replace the base stay offline). The env var is read
   under the exact name the user has in `.env`: `FREED_API_KEY` (sic — missing the "R"; kept
   as-is per user choice).
6. Failure containment like every other feed: FRED unavailable → logged WARN, macro is `null`,
   the run proceeds. A missing key does not fail startup, it disables macro context.

## Alternatives considered

- **Replace Finnhub entirely with FRED** — rejected: quotes, news and fundamentals would be lost;
  the News/Fundamentals analysts would be starved.
- **FRED only as benchmark provider (SP500 instead of SPY)** — partially rejected; the S&P 500
  level is captured in the macro snapshot and available to analysts, but the existing SPY quote
  benchmark flow (NAV alpha etc.) is left untouched.
- **Yahoo/other free macro sources** — rejected: FRED is the canonical, stable, documented free
  source for exactly this data, and the user already holds a key.

## Consequences

- +8 HTTP requests per run to FRED (one per series, `sort_order=desc`, limit 2; CPI uses limit
  13). Well inside the 120 req/min keyed rate limit; single retry on transient responses
  (429, 5xx — FRED intermittently 502s under load, observed live 2026-08-27).
- FRED series are daily/monthly — not intraday; values update with publication lag. Analysts are
  told to treat them as macro regime context, not tick-level signals.
- Missing observations (value `"."`) map to `null` per series.
- New persistence surface (`macro_snapshots`), new API route, new dashboard panel, new port —
  fake ports in tests updated accordingly.
- No change to trading gates, sizing, or execution flow.
