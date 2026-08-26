# Trading Portfolio Manager

Personal stock-portfolio management system: **hourly market analysis → asset-allocation evaluation → cost-gated trade execution**, with everything persisted and a live dashboard.

- **Analysis** — four analysts per ticker each run: Market, Sentiment, News, Fundamentals. LLM-backed (DeepSeek by default; OpenAI / Anthropic / OpenRouter supported) with a deterministic offline fallback when no API key is present.
- **Allocation** — broker positions (source of truth) converted into the account currency, weights vs your target allocation, drift and portfolio heat computed every run.
- **Trades** — Trading212 REST API (beta API, key-pair auth) or a built-in **paper broker** that simulates fills with spread and FX fees. **Every trade passes an economic-correctness gate first**: expected benefit must cover the estimated costs (spread, 0.15% FX conversion, 0.5% UK stamp duty on LSE buys) by a configured margin, plus risk limits (max order size, portfolio heat cap, anti-churn cooldown, conviction threshold).
- **Persistence** — SQLite (`node:sqlite`, zero native deps): runs, analysis reports, portfolio snapshots, decisions with reasons, orders with realized costs, an append-only event log, **and the raw market inputs** (quotes incl. benchmark, news items, sentiment scores) so every decision is fully auditable and re-runnable.
- **Dashboard** — web UI (Fastify + Chart.js) at `http://127.0.0.1:8790`: NAV, value trend, allocation vs targets, benchmark day change + alpha, positions, decisions with rationale, orders with costs, analyst reports, latest news + sentiment, per-ticker price history, event trail, and a **"Run now" button** that triggers the full cycle manually — the same pipeline and cost/risk gates as the scheduler, never a bypass (GET endpoints remain read-only). Manual runs always execute a fresh cycle: the one-run-per-market-hour idempotency guard (which protects scheduled runs from duplicate analyses/orders) is intentionally skipped on manual requests.

> ⚠️ Not financial advice. Paper mode never touches a broker; live mode only activates with `mode: "live"` **and** Trading212 credentials.

## Quick start

```bash
pnpm install
pnpm run-once --force   # one full pipeline run now (force: even if market closed)
pnpm serve              # hourly scheduler + dashboard → http://127.0.0.1:8790
pnpm status             # latest snapshot / runs / decisions / orders as JSON
pnpm verify             # typecheck + full test suite
```

Without any API keys everything runs on deterministic **demo market data** with the **offline analysts** and the **paper broker** — the full loop executes but trades nothing real. This is the recommended first experience.

## Configuration

`config/default.json` is the example config; create `config/local.json` to override (deep-merged). Environment variables: see `.env.example`.

| Area | Key knobs |
| --- | --- |
| `mode` | `"paper"` (default) or `"live"` (requires Trading212 keys) |
| `universe` | tickers + benchmark |
| `allocation` | per-ticker target weights, cash buffer, rebalance band |
| `risk` | max order value, heat cap, min expected benefit, cost multiplier, conviction threshold, cooldown, orders-per-run cap |
| `costs` | spread bps, FX fee %, stamp duty %, platform fee % |
| `schedule.markets` | per-exchange session (timezone, open/close, holidays, **early-close half days**); runs fire at minute `runAtMinutePastHour` of every open hour |
| `llm` | provider (`deepseek` / `openai` / `anthropic` / `openrouter`), model, temperature. DeepSeek default model: `deepseek-v4-flash` (the `deepseek-chat` name was retired July 2026) |
| `dataProviders` | `finnhub` quotes/news/fundamentals (needs `FINNHUB_API_KEY`), `yahoo` candles (free, no key — Finnhub free tier has no /stock/candle), `erapi` FX (free, no key), or `demo`. Finnhub's social-sentiment endpoint is not on the free plan (403), so sentiment **falls back to scoring the news headlines** (DeepSeek when configured, keyword heuristic otherwise) |

### Real market data (optional)
Set `dataProviders.*` to `finnhub` and export `FINNHUB_API_KEY` — quotes, candles, news, fundamentals, sentiment and FX rates come from Finnhub (free tier is comfortably within the hourly cadence for a small universe).

### Real LLM analysis (recommended)
```bash
export DEEPSEEK_API_KEY=sk-...
```
The four analysts then run as structured-output LLM calls (zod-validated, one repair retry). Other keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` — the first key found is used.

### Trading212 (live / demo account)
1. Generate an API key (and secret) in the Trading212 app (demo or live).
2. `export TRADING212_API_KEY=... TRADING212_API_SECRET=...` (single legacy key also works) and `TRADING212_ACCOUNT_DEMO=1` for the practice account.
3. Copy `config/local.example.json` to `config/local.json`, set `"mode": "live"`, and tune the risk block.
4. Recommended path: **practice account first** — watch real API orders execute with real costs before any real-money setup.

The adapter is validated against the official OpenAPI spec (`docs.trading212.com/_bundle/api.yaml`): key-pair Basic auth, `/equity/account/summary`, `/equity/positions`, `/equity/orders/market` (negative quantity = sell), order status polling with fill price derived from `filledValue/filledQuantity`. **Instrument identifiers** (`AAPL_US_EQ`) are resolved from `/equity/metadata/instruments` (cached 10 min) and mapped back to plain symbols — the universe config stays readable (`AAPL`, `VUSA`, …).

## How a run works

One run per market hour while the exchange is open (idempotent — a second trigger in the same hour is a no-op; closed-market triggers record a `SKIPPED` run with the reason):

1. **Market analysis** — per ticker: quote, candles, news, fundamentals, sentiment gathered with per-source error containment; the four analysts each emit `{conclusion, confidence, rationale, targetWeightAdjustment}`.
2. **Allocation evaluation** — broker account + positions (enriched with live quotes and FX conversion) → portfolio snapshot, drift vs targets, portfolio heat, unitized NAV, **benchmark (SPY) day change for relative performance**; all persisted.
3. **Decisions** — drift + aggregated analyst signal → trade proposal (sized, capped), then the **economic gate**: benefit ≥ min %, benefit ≥ costs × multiplier, order ≤ max size, heat stays under cap, cash available, cooldown respected, conviction ≥ threshold. Rejections are recorded with the exact reason.
4. **Execution** — approved orders (best benefit first, capped per run) are **reserved locally (PENDING) before submission** (two-phase), submitted to the broker, confirmed and recorded with realized costs. Orders still open at the broker (e.g. Trading212 late confirmations) are **swept** at the start of each run and closed out with fills/rejections.
5. **Event trail** — every step publishes a domain event (PipelineStarted, AnalysisCompleted, PortfolioEvaluated, DecisionsTaken, OrderRequested/OrderFilled/OrderRejected, PipelineCompleted/Failed) persisted to the event log.

## Architecture

Hexagonal, layered inward: `domain` (pure, no I/O) ← `application` (services + ports) ← `adapters` (LLM HTTP client, Finnhub, paper/T212 brokers, SQLite, scheduler, Fastify) wired at the composition root (`src/composition/root.ts`). In-process event bus with persisted events — no message broker: for a single-user hourly system, Kafka/outbox would be overkill; the append-only event table still gives a full audit trail and replay surface.

```
src/
  domain/          analysis, portfolio (snapshot/drift/heat/NAV), decision (cost model + gate),
                   execution (order lifecycle), calendar (market hours), run
  application/     ports (LLM, market data, FX, broker, repos) + services
                   (analysis, portfolio-evaluation, decisions, execution, pipeline)
  adapters/        llm/http-llm-client, marketdata/{finnhub,demo}, broker/{paper,trading212},
                   persistence/sqlite+repositories, scheduler, web/server
  composition/     root.ts — everything is wired here
web/public/        dashboard (static, Chart.js)
tests/             domain units, adapter contracts, application + end-to-end pipeline (66 tests)
```

## Cost model (matches Trading212 Invest)

- Commission/custody: **0**
- **0.15% FX conversion fee** when the instrument currency differs from the account currency (each way)
- **0.5% UK stamp duty** on LSE (`.L`) buys
- Spread: configurable bps, applied to fills in the paper broker and to cost estimates

## Testing

```bash
pnpm verify   # tsc --noEmit + vitest (116 tests)
```

Coverage: market calendar (DST, holidays), cost estimation and every economic-gate rejection path, portfolio math (FX-converted weights, drift, heat, NAV ledger), order lifecycle state machine, paper-broker ledger (spread + FX), SQLite repository round-trips, LLM client wire formats + JSON repair, DecisionService veto/cooldown/cash, scheduler hour-boundary firing, and a full end-to-end pipeline asserting persisted reports, decisions, filled orders, realized costs and event trail.
