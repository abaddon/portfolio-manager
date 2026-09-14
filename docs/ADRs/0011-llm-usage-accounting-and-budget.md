# ADR 0011 — LLM usage accounting and the per-run / per-day spend budget

- **Status:** Accepted
- **Date:** 2026-09-14
- **Decision maker:** User (Stefano) + AI agent
- **Work package:** `docs/IMPLEMENTATION_PLAN.md` WP-P0.4 (Phase P0)

## Context

The decision process spends real money on inference — four analysts per ticker every run, plus a
committee session of 3 proposals + 6 feedback + 3 votes — and produced **no record of that spend
anywhere**. `HttpLlmClient.request()` read `data.choices[0].message.content` and discarded the
`usage` block that every supported provider returns, so:

- no per-run, per-agent or per-day token/cost figure existed (`runs.details`, `events` and the
  dashboard all had nothing);
- the only bound on spend was `llm.maxTokens` (2 000 in `default.json`, **8 000 in `local.json`**)
  multiplied by however many calls a session happened to make, with no cap and no kill switch;
- cost could not be compared against the trades it authorises — the review estimated
  **$40–70/year on a £780 account (~5–9 % of NAV)**, invisible;
- the review's P0 gate redesign needs the run's inference cost as an input (the AI spend has to sit
  inside the same economic comparison as spread/FX/stamp), and there was no value to feed it.

A second, smaller problem: the modelling config was unverifiable. A retired model id
(`moonshotai/kimi-k3`) killed a live committee session with HTTP 404 *after* the run had already
paid for the full analysis step.

## Decision

**1. Price every call where it happens, attribute it to the active run.**
`HttpLlmClient` parses provider usage into `{promptTokens, completionTokens, cachedTokens}` via
`extractUsage()` — OpenAI/OpenRouter (`usage.prompt_tokens`, `completion_tokens`,
`prompt_tokens_details.cached_tokens`), Anthropic (`input_tokens`, `output_tokens`,
`cache_read_input_tokens`) and DeepSeek's cache hit/miss pair. `estimateUsageCostUsd()` prices it
with a model price table; `resolveModelPrice()` matches a model id exactly or by the longest table
key contained in it, so one `deepseek-v4-flash` entry prices
`~deepseek/deepseek-v4-flash-latest`. An unpriced model records **tokens with cost 0** rather than
guessing a price — visibly honest on the dashboard. Prices are estimates for budget accounting only;
they never enter trading decisions.

**2. One recorder, run-scoped attribution.** `LlmBudget` (`src/application/services/llm-budget.ts`)
implements the optional `AppPorts.llmBudget` port. The pipeline calls `setActiveRun(runId)` when a
run starts and `setActiveRun(null)` in its `finally`, so the long-lived per-agent clients need no
run knowledge: an empty `runId` on a usage report is attributed to the active run. Every call is
appended to the `llm_usage` table (migration v6) and totalled per run.

**3. Budget guards, with containment rather than a crash.**
`llm.budget.maxCallsPerRun` (default 200) and `llm.budget.maxSpendPerDayUsd` over a trailing
`spendWindowHours` window (default 24, with a 2 % reserve). The window spend is **primed from the
store** at the start of every run, so a restarted service cannot spend the same day's budget twice.
When a cap is hit, `LlmBudgetExceededError` is raised; `MarketAnalysisService` keeps the reports
already produced, stops, and returns; `CommitteeService` marks the session `FAILED` with the reason
and `budgetStop: true`; the pipeline skips the expensive phases it has not started and records
`llmBudgetStop` plus the run's `llm` totals in `runs.details`. A stopped budget never fails a run
and never places a partial order.

**4. Per-call thinking override.** `LlmChatOptions.thinking` overrides the client default, because
the cheap calls (sentiment, feedback, votes) should not pay for reasoning even when the configured
proposal models need it. Wiring for that lives in WP-P1.3; the client capability lands here.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Read spend from the provider's billing API | Not available on the free/consumer tiers used, lags by hours, and gives no per-run attribution. |
| Return usage from `LlmPort.chat` (change the signature) | Every analyst, committee and test call site changes shape; the callback keeps the port's contract and the plumbing local to composition. |
| Wrap the clients in a metering decorator instead of a callback in the client | The decorator cannot see provider usage without re-parsing the response, so it would duplicate the wire-format knowledge the adapter already owns. |
| Hard-stop the process when the budget is exhausted | One unlucky day (a retry storm, a provider bug) would take the scheduler and dashboard down with it; containment keeps the audit trail and the dashboard alive. |
| Price only known models and reject unknown ones | New models are added by config (`committee.agents[].model`); refusing to run would make experimentation impossible. Tokens-without-cost is the honest degradation. |
| Include the AI cost in every individual order's cost estimate | A single £20 order would then be charged the whole session's inference cost and be rejected `COST_EXCEEDS_BENEFIT`; the correct place for it is the session-level aggregate (implemented in WP-P0.1 as `llmCostPerRun`). |

## Consequences

- `runs.details.llm = {calls, promptTokens, completionTokens, usdCost}` on every run that made a
  call; event `LlmUsageRecorded` (with `daySpendUsd`) in the append-only log; `GET /api/overview.llm`
  exposes the last run's totals, the trailing-window spend and the configured budget; the Activity
  page shows a spend tile.
- The gate redesign (WP-P0.1) can consume `llmCostPerRun` — the missing input from the review's §3.7.
- Spend is now capped by configuration, and the failure mode is a recorded, contained stop.
- Cost figures are estimates from a static price table: a provider price change silently drifts the
  estimate until the table is updated. Acceptable for budget accounting; not acceptable as an
  accounting-of-record, which is why nothing downstream of the budget consumes it.
- Budget stops are visible but not retried automatically: the next run starts a fresh per-run budget,
  and the day cap continues to apply.
