# AGENTS.md — guidance for AI agents working on this repository

## What this project is

A personal stock-portfolio manager. Every hour while the US market is open it runs a pipeline:

1. **Market analysis** — four analysts per ticker (Market, Sentiment, News, Fundamentals), LLM-backed (DeepSeek default; OpenAI/Anthropic/OpenRouter supported) with an offline rule-based fallback.
2. **Allocation review + evaluation** — analysts propose bounded target-weight adjustments (conviction-gated, per-run capped, per-name capped, cash-floor enforced); then broker positions → snapshot, drift vs targets, heat, NAV, benchmark (SPY) alpha.
3. **Cost-gated decisions + execution** — every trade proposal passes an economic gate (expected benefit ≥ costs × multiplier, order-size/heat/cash/conviction/cooldown limits) before orders are placed on the **Trading212 REST API** (practice account in the current config; real money only if the user deliberately switches).

Everything is persisted in SQLite and shown on a dashboard (`pnpm serve` → http://127.0.0.1:8790) with a manual "Run now" button.

**This system can place real orders. Never weaken the safety gates, never commit secrets, never auto-switch to live mode.**

## Other resources
*  [AI Rules](docs/AI_RULES.md): Rules to read and follow on each AI request
*  [Decision process](./docs/DECISION_PROCESS.md): it contains the decision process
*  [ADRs](./docs/ADRs): Folder contains all technical decision taken, read them if you need more architectural details.

## Rules
1. MUST Always read `AI Rules` before any AI request.
2. MUST Create or update existing ADR based on the decision taken

## Commands

```bash
pnpm install
pnpm verify            # tsc --noEmit + vitest (must stay green )
pnpm test              # vitest only
pnpm typecheck         # tsc --noEmit only
pnpm run-once --force  # one pipeline cycle now (force = even if market closed)
pnpm serve             # scheduler + dashboard
pnpm status            # latest snapshot/runs/decisions/orders as JSON
```

- `.env` is auto-loaded by all npm scripts (`--env-file-if-exists=.env`). Never commit `.env` or `config/local.json` (both gitignored).
- Profile overlays: `pnpm run-once --force --config config/paper-real-data.json` (real data + LLM, simulated fills). CLI `--config` is an **overlay** merged over `default.json` + `local.json` (overlay wins). Tests pass `configPath` to `buildApp`, which **replaces** the base config entirely.

## Architecture (hexagonal, layered inward)

```
src/domain/          pure business logic, NO I/O: analysis, portfolio (snapshot/drift/heat/NAV),
                     decision (cost model + economic gate), execution (order lifecycle),
                     calendar (market hours incl. DST/holidays/early closes), run
src/application/     ports.ts (all interfaces: LLM, market data, FX, broker, repos) and services
                     (market-analysis, allocation-review, portfolio-evaluation, decisions,
                     execution, pipeline)
src/adapters/        llm/http-llm-client, marketdata/{finnhub,demo,yahoo,fx}, broker/{paper,trading212},
                     persistence/{sqlite,repositories,market-data,allocation-targets},
                     scheduler, web/server
src/composition/     root.ts — everything is wired here
web/public/          dashboard (static HTML/JS/CSS, Chart.js; no build step)
tests/               domain units, adapter contracts, application + live e2e (stubbed API)
config/              default.json (example), local.json (user, gitignored), *.example.json profiles
```

Rules:
- Domain depends on nothing; application depends on domain; adapters implement ports. New integrations go behind a port.
- Money: use helpers from `src/shared/money.ts` (`roundValue`, `roundTo`, `WEIGHT_DP`). Weights are 4dp; never float-compare without tolerance.
- Errors: `AdapterError(kind, cause)` for adapter failures (kinds: no-data, auth, rate-limit, http, parse, unsupported); `DomainError` for domain rule violations; `ConfigurationError` for config problems. Per-source failures in analysis are **contained** (log WARN, continue with null) — one failing feed must never kill a run.
- Events: in-process `EventBus` + persisted event log (append-only audit trail). No message broker — deliberate: single-user hourly system.

## Persistence

SQLite via built-in `node:sqlite` (`DatabaseSync`), zero native deps. Schema in `src/adapters/persistence/sqlite.ts`; migrations are numbered rows in `schema_migrations` applied in `openDatabase()`.

Migration rules (learned the hard way):
- `CREATE TABLE IF NOT EXISTS` in the static SCHEMA is for **fresh** DBs only. Anything that can fail on existing data (e.g. a UNIQUE index over duplicate rows) belongs in a guarded migration step **after** the cleanup it depends on — never in the static SCHEMA.
- Run dedup/cleanup DML **before** creating unique indexes.
- Wrap best-effort migration statements in try/catch so a bad migration never bricks startup; the migration row insert must still run.

Key tables: runs, events, analysis_reports, portfolio_snapshots/position_snapshots, decisions, orders, market_snapshots, news_items, sentiment_scores, allocation_targets, settings.

## Trading212 broker — gotchas that matter

- **Instrument ids**: the API uses `AAPL_US_EQ`-style tickers, not plain symbols. `Trading212Broker` resolves plain symbols via `/equity/metadata/instruments` (cached 10 min) and maps positions back. Keep the universe config in plain symbols.
- **Sell = negative quantity** on `/equity/orders/market`.
- **Order placement is NOT idempotent.** Two-phase flow: persist PENDING → submit → confirm. After a crash, `reconcileStalePending()` matches stale PENDING orders against broker open orders (ticker, side, quantity, ±15 min) and either adopts the broker id or fails the order — **never blind re-submission**.
- **Filled orders 404 from `GET /equity/orders/{id}`** — they move to `/equity/history/orders`. `orderStatus()` falls back to history and derives fill price from `filledValue/filledQuantity`.
- **Quantity precision**: instruments reject some decimal precisions with `/api-errors/quantity-precision-mismatch` ("invalid quantity precision N"). `submitOrder()` parses the detail and retries with N−1 decimals (floor 0), returning the accepted `submittedQuantity`; `ExecutionService` aligns the local order, and `retryPrecisionFailures()` re-submits precision-failed orders at the next pipeline start (safe: 400 means the order was never created).
- **Rate limits are per-account and tight** (e.g. orders/positions ~1/s). The broker serializes requests with 600 ms spacing; treat new 429s as transient — the sweep retries on the next run.
- Auth: key-pair Basic (`API_KEY:API_SECRET`), legacy single-key header fallback. `TRADING212_ACCOUNT_DEMO=1` selects the practice account.
- Cost model (matches T212 Invest): 0% commission, **0.15% FX** when instrument ≠ account currency, **0.5% UK stamp duty** on `.L` buys, configurable spread bps.

## Data providers (free tiers)

- **Finnhub**: quotes/news/fundamentals OK. **No** `/stock/candle`, **no** `/forex/rates`, **no** `/stock/social-sentiment` on the free plan (403). Candles come from **Yahoo** (`yahoo.ts`, free, keyless; interval format `60m` not `60`), FX from **er-api** (free, keyless, `fx.ts` with demo fallback), sentiment falls back to **news scoring** (`news-sentiment.ts`: DeepSeek when available, keyword heuristic offline).
- Finnhub requests are serialized with 800 ms spacing + one retry on 429. Its percentage fields (`revenueGrowthTTMYoy` etc.) are already percentages — do not multiply by 100.


- **Allocation bootstrap**: `allocation.targets` may be EMPTY — the pipeline then derives targets from the broker's current position weights on its first run (persisted as initial review rows, event `TargetsBootstrapped`) and proceeds with the normal workflow. Empty targets AND empty broker → clear ConfigurationError.

## Pipeline invariants (do not break)

- One run per market hour for **scheduled/startup** runs (idempotency guard). **Manual runs** (dashboard button) intentionally skip the guard (`skipHourGuard`). Reconciliation + sweep + precision-retries run BEFORE the guard so skipped runs still close out fills.
- Decision gates live in `DecisionEngine` (domain) and are config-driven (`risk` block). The button/API never bypasses gates.
- Allocation targets are a **list** in config (lists replace on merge — records merge, which once summed example+user targets to >1). Review updates persist in `allocation_targets`; `currentTargets()` merges repo rows over seeds but **ignores repo rows for tickers no longer in the seeds**. Cash-floor scaling applies to **all** weights when the invested cap would be breached.
- News rows are unique per `(ticker, headline, source)` (INSERT OR IGNORE); the display view dedupes across tickers.
- Every run emits domain events (PipelineStarted, AnalysisCompleted, TargetsReviewed, PortfolioEvaluated, DecisionsTaken, OrderRequested/Filled/Rejected/Retried, PipelineCompleted/Failed) persisted to the event log.

## LLM notes

- DeepSeek v4 model names: `deepseek-v4-flash` (default) / `deepseek-v4-pro`. The old `deepseek-chat` name was retired July 2026.
- Thinking mode is ON by default on v4; config sets `llm.thinking: "disabled"` (OpenAI-format `thinking: {type}` / Anthropic `reasoning: {effort: "none"}`) for cheap deterministic JSON.
- Structured output = prompt JSON + zod validation + one repair retry (`HttpLlmClient.chatJson`). Provider profiles in `PROVIDER_PROFILES`; fallback `UnavailableLlmClient` → offline analysts.

## Testing conventions

- Pure domain logic: unit tests without mocks (`tests/domain/`).
- Adapters: contract tests with stubbed `globalThis.fetch` (`tests/adapters/`); always `vi.unstubAllGlobals()`.
- Application: services with in-memory SQLite (`:memory:`) + fake ports (`tests/application/`); e2e runs the full pipeline via `buildApp` with fixture configs + `FixedClock` (fixtures in `tests/fixtures/`).
- Web: Fastify `instance.inject()` contract tests.
- Any change to ports (new methods) must update the fake ports in `tests/application/*.test.ts` and `tests/adapters/web.test.ts`.
- Keep `pnpm verify` green before committing; commit messages summarize intent.

## Config system

`config/default.json` (base) ← `config/local.json` (user overrides, deep-merged) ← CLI `--config` overlay (wins). Env keys: `DEEPSEEK_API_KEY`, `FINNHUB_API_KEY`, `TRADING212_API_KEY`(+`_SECRET`), `TRADING212_ACCOUNT_DEMO`. Key risk knobs: `risk.{maxOrderValue,maxHeatPct,minExpectedBenefitPct,costBenefitMultiplier,maxOrdersPerRun,tickerCooldownDays,minConfidence,stopDistancePct,expectedReturnPerTradePct,signalThreshold}` and `allocation.adaptation.{enabled,maxDeltaPerRun,minConviction,maxTarget,minCashBuffer}`.

## When changing trading behavior

Re-check these before touching anything order-related: the economic gate in `DecisionEngine.evaluate`, the two-phase order flow in `ExecutionService`, reconciliation idempotency, cooldowns, the heat cap, and the practice/live mode switch in `config/local.json`. When in doubt about intent, ask the user instead of assuming.
