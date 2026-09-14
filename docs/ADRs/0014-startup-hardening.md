# ADR 0014 — Startup hardening: orphaned runs and the model-id probe

- **Status:** Accepted
- **Date:** 2026-09-14
- **Decision maker:** User (Stefano) + AI agent
- **Work package:** `docs/IMPLEMENTATION_PLAN.md` WP-P0.5 (Phase P0)

## Context

Two failure modes reached production without anything noticing:

1. **A run is stuck `RUNNING` forever.** `data/trading.db` holds
   `run_…` started `2026-08-31T14:00:11Z` and never finished — the process died between
   `runs.save(RUNNING)` and the completion path. The hour guard treats a `RUNNING` row as an existing run, so the
   dashboard shows a live run that does not exist and the next scheduled pass is ambiguous. Orders already had a
   stale-`PENDING` reconciliation; runs had nothing.

2. **A retired model id kills a session after the money is spent.** The last live committee session failed with
   `LLM HTTP 404: proposal agent momentum-trader (moonshotai/kimi-k3) failed`, **after** the run had paid for the
   full four-analyst × five-ticker analysis step. The same class of failure had already been hit earlier with
   `deepseek/deepseek-v4-pro-0813`. Model ids drift (provider renames, OpenRouter guardrail changes), and the
   system discovered it at the most expensive possible moment.

The config itself also carried the retired ids (`config/committee-paper.json`,
`config/default.json`), so a fresh checkout would inherit them.

## Decision

**1. Close orphaned runs at startup.** `RunRepository.findRunning()` feeds a startup sweep that marks every
`RUNNING` row `FAILED` with `orphaned by an interrupted process — closed at startup`, persisted and published as
a `PipelineFailed` event (the append-only log keeps the truth). Failures are contained: a sweep error is logged,
never fatal.

**2. Probe every configured committee model id before a run can spend.** New adapter
`src/adapters/llm/model-probe.ts` lists the provider's models (free, no inference) and looks for the configured
id by exact match, vendor-suffixed match, or with the `~alias` prefix stripped — configs and OpenRouter disagree
about both. Verdicts:

| Verdict | Meaning | Effect |
|---|---|---|
| `ok` | the provider lists the model | start |
| `missing` | the provider answered, the id is not there | **fatal in `mode: live`**, loud warning in `paper` (a paper run wastes tokens, a live one wastes tokens *and* time against a market) |
| `unreachable` | no key, auth failure, network error, 5xx | warning only — an unreachable provider is not proof of a bad id |
| `unsupported` | the provider exposes no model list (404 / empty) | warning only |

The probe is a guard, never a new failure mode: only a definite "the provider says this id does not exist"
stops a live start.

**3. It runs before anything is triggered, and on demand.** `buildApp` starts the pass and exposes
`app.startupChecks()`; the CLI **awaits** it before `run-once`/`serve`, and a new `pnpm verify-models` command
prints the per-model verdicts and exits non-zero when any id is `missing`.

**4. The shipped configs use ids that exist.** `config/default.json` and `config/committee-paper.json` now carry
the three models the live profile actually runs (direct `deepseek-v4-flash`, OpenRouter
`google/gemini-3.8-flash`, `z-ai/glm-5.3-flash`), and their comments point at `pnpm verify-models`.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Prove the model with a 1-token chat completion instead of listing | Costs real money per check, needs thinking/max-tokens tuning to stay cheap, and can fail for reasons unrelated to the id (rate limits, content filters). The list is free and answers exactly the question asked. |
| Skip the probe and retry a failed session on a fallback model | Silent model substitution changes who decides; the operator should choose the replacement. (A future WP could add an explicit `fallbackModel`.) |
| Keep the retired ids and document them | They already cost a run; documentation cannot refuse to start. |
| Make `unreachable` fatal in live mode | An offline laptop or a transient 5xx would then brick a legitimate start — the wrong trade-off for a personal system. |
| Delete orphan `RUNNING` runs instead of failing them | The audit trail must show that the run existed and never finished; deletion also breaks event/run referential integrity in the dashboard. |

## Consequences

- Startup is now a checkpoint: the operator sees `model probe: OK …` per agent, and a live start refuses a
  definitively bad id with the reason.
- `pnpm verify-models` is the cheap pre-flight for a config change (documented in `AGENTS.md` and the README).
- One startup `GET /models` per committee agent (3 requests, ~10 s timeout each, in parallel with nothing else):
  negligible next to a run, and it removes a whole class of wasted runs.
- Tests inject `skipStartupChecks: true` where a probe would hit the network; the probe itself is contract-tested
  with a stubbed `fetch`.
