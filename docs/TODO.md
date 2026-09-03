# Trading portfolio manager
Unified committee decision flow (ADR 0009): the two decision flows (classic analyst-signal vs Asset Allocation Committee) are merged into ONE — the committee manages every allocation change and every order; the classic review/decision path, the `committee.enabled` toggle and the dashboard switch are removed; the economic gate is untouched. 2026-09-02

### Unified committee flow — Completed ✓
- [x] Config: committee always on (≥3 agents), guardrails `maxTarget`/`minCashBuffer` move to the committee block; drop `allocation.adaptation` + `risk.signalThreshold` 2026-09-02  
- [x] Services: `AllocationTargetsService` (currentTargets) replaces AllocationReviewService; DecisionService classic `decide()` removed (`decideFromOrders` → `decide`); CommitteeService loses the toggle; analysts' adjustments added to the committee context 2026-09-02  
- [x] Pipeline: single flow (analysis → evaluation → committee session → gate → execution) 2026-09-02  
- [x] Web + dashboard: drop toggle endpoint/chip (static chip instead); `/api/committee` + `/api/targets` shapes updated 2026-09-02  
- [x] Fixtures + config files: committee block everywhere; dead keys removed (default/local/committee-paper + 3 test fixtures) 2026-09-02  
- [x] Tests: e2e (paper + live-T212-stub) rewritten around scripted committees (`tests/helpers/scripted-committee.ts`, `buildApp({ committeeLlms })` seam); decisions/allocation-targets/pipeline/web tests updated; `pnpm verify` green — 29 files, 191 tests 2026-09-02  
- [x] Docs: ADR 0009 (+ 0003/0004/0007 status notes), DECISION_PROCESS.md rewritten for the single flow, flowchart merged, AGENTS.md/CLAUDE.md + README.md updated 2026-09-02  
- [x] Smoke: `pnpm status` boots the real merged config (committee agents wired, trading212 live env) — read-only 2026-09-02  
- [x] User action: restart `pnpm serve` to pick up the new code (dashboard now shows the static Committee chip; the toggle is gone) — restarted 23:06, verified the running instance loaded the new src (static assets re-read per request) 2026-09-02  

Asset Allocation Committee (AAC): N≥3 AI asset managers (each on its own model) propose allocations → review each other → vote → the winning proposal is applied (targets persisted, orders gated + executed). Since ADR 0009 (2026-09-02) it is the ONLY decision flow — the classic flow and the toggle were removed. Everything visible on the dashboard. 2026-08-28

Dashboard redesign (ADR 0008): ported the OpenDesign prototype (1585202e-1236-4fae-93da-3e46395c97df) onto the live dashboard — 4 vanilla pages (Portfolio / Activity / Committee session / Data), new design system, real API data. Trading logic untouched. 2026-08-29

Previous items (DECISION_PROCESS audit) — all resolved.

### Dashboard redesign — Completed ✓
- [x] Server: `/api/overview` also returns `risk: config.risk` (additive, read-only) so Activity can render the real gate checklist 2026-08-29  
- [x] `web/public/dashboard.css` — prototype design system ported verbatim + live additions (statusline, checkchips, data-page panels, extra pill states) 2026-08-29  
- [x] `web/public/app.js` — shared core: helpers, topbar (account chip, run status, Run now w/ confirm + force + 409 + run-watching, committee toggle), SVG value trend, ribbons, drift bars, pills, gate checklist, execution block 2026-08-29  
- [x] `index.html` + `portfolio.js` — value hero (total/Δ/alpha, invested/cash/unrealised), value-per-run trend, composition (current vs target ribbons, sortable drift table), rebalance pressure + gate note 2026-08-29  
- [x] `activity.html` + `activity.js` — summary strip, run log grouped by run, expandable decision panels (gate checklist / execution), All/Executed/Blocked filter (persisted) 2026-08-29  
- [x] `decision-detail.html` + `session.js` — latest committee session deep-dive: vote outcome + matrix, proposals, peer review, applied targets, orders at the gate 2026-08-29  
- [x] `data.html` + `data.js` — preserved panels restyled: macro snapshot/trend, price history, news, sentiment, orders, targets + review, runs-analysis (expandable), event log 2026-08-29  
- [x] Removed superseded `styles.css` (replaced by `dashboard.css`) 2026-08-29  
- [x] Verified: `pnpm verify` green (194 tests); headless-Chrome smoke of all 4 pages (no JS exceptions; sort/expand/filter interactions; gate table = 3 orders £120 0.43% 0 cleared) 2026-08-29  
- [ ] Restart `pnpm serve` once to pick up the `risk` field in `/api/overview` (static files re-read per request; only the API needs the restart) 2026-08-29  

### Backlog
- [ ] Optional: if more model choice is wanted, relax the OpenRouter guardrail at openrouter.ai/settings/privacy (not needed — the committee runs on the three guardrail-permitted models) 2026-08-28  

### Completed ✓
- [x] Docs: investment decision flowchart — `docs/investment-decision-flowchart.md`, 3 Mermaid charts (hourly pipeline, economic gate, execution) verified against `src/domain/decision.ts` + DECISION_PROCESS.md 2026-09-02  
- [x] Fixed Trading212 cash-flows 400 ("Both or none of cursorId and time"): first page unfiltered + local filter, cursor pages keep time paired — verified live against the demo API 2026-08-28  
- [x] Fixed LLM "openai-format response had no text content": accept content-parts arrays (llama-4 via OpenRouter) + shape diagnostic on missing text 2026-08-28  
- [x] Fixed dashboard committee panel stuck on "loading…" (renderCommittee never called) 2026-08-28  
- [x] Live verification: real run with 3 agents via OpenRouter (`config/committee-paper.json`) — session COMPLETED: 3 proposals (deepseek-v4-pro / deepseek-v4-flash / llama-4-maverick, all through OpenRouter), 6 feedback, votes 4/3/2 → winner accepted (4 pts) → MSFT target 0.2→0.25 applied + BUY order gated (rescaled to maxOrderValue) and FILLED; dashboard API + toggle verified. Model slugs set to the ones permitted by the account's OpenRouter privacy guardrails at the time (anthropic/openai/google blocked) 2026-08-28  
- [x] Explored codebase (pipeline, decisions, LLM client, persistence, web, config) 2026-08-28  
- [x] Domain: `src/domain/committee.ts` — types + pure voting/tie-break logic (`rankVotes`, `coerceRanking`, `resolveVoteRound`) 2026-08-28  
- [x] Config: `committee` block in `src/config.ts` + `config/default.json` (3 OpenRouter agents, disabled by default) 2026-08-28  
- [x] Ports: `settings` in `AppPorts` + `CommitteeRepository` 2026-08-28  
- [x] Persistence: committee tables in `sqlite.ts` + `SqliteCommitteeRepository` 2026-08-28  
- [x] Decisions: `DecisionService.decideFromOrders()` — committee order intents priced + passed through the existing economic gate 2026-08-28  
- [x] Application: `CommitteeService` (propose → feedback → vote rounds with run-off → winner applied) 2026-08-28  
- [x] Pipeline: branches committee vs classic flow when enabled; run details carry `decisionProcess` 2026-08-28  
- [x] Composition: settings repo, per-agent LLM clients (OpenRouter), committee service wired 2026-08-28  
- [x] Web: `GET /api/committee`, `POST /api/committee/enable` + dashboard panel (proposals, feedback, votes/points, winner) + toggle 2026-08-28  
- [x] Tests: domain voting, committee session e2e (scripted LLMs, tie run-off + exclusion), repository, web endpoints, pipeline branch; AppPorts fakes updated 2026-08-28  
- [x] Docs: ADR 0007 + DECISION_PROCESS.md §11 + this TODO 2026-08-28  
- [x] Verify: `pnpm verify` green — 29 files, 186 tests (classic flow unchanged) 2026-08-28  
- [x] Live smoke run with 3 real LLM agents on the paper profile (`config/committee-paper.json`, DeepSeek agents because no OpenRouter key) — see job output 2026-08-28  

- [x] OpenRouter guardrail (ZDR data policy + model allowlist on the key) resolved by using the three permitted models: deepseek/deepseek-v4-pro-0813, moonshotai/kimi-k3, ~moonshotai/kimi-latest — all verified live 2026-08-28  
- [x] LLM client: send OpenRouter's unified `reasoning: {enabled: false}` alongside `thinking: disabled` — these endpoints ignore `thinking` and burned the whole output budget on reasoning (null content) 2026-08-28  
- [x] LLM client: accept single content-part objects; error diagnostics now include the message shape + content snippet 2026-08-28  
- [x] Committee: per-agent error wrapping (proposal/feedback/vote) so failures name the agent + model 2026-08-28  
- [x] Live verification with guardrail-compliant models: session COMPLETED with a tie → re-vote (round 2), Macro Strategist accepted with 7 pts, 2 BUY orders gated and FILLED 2026-08-28  

- [x] Committee: over-long LLM text (kimi's 1200+ char feedback comment) no longer fails the session — zod maxes dropped, fields truncated at persistence (title 140 / rationale 3000 / reason 600 / comment 1200); live-verified (1100-char comment stored, session COMPLETED) 2026-08-28  
- [x] Committee voting: each agent now casts exactly ONE vote per round (was ranked ballots k,k−1,…,1) — domain `castVote`/`coerceChoice` replace `rankVotes`/`coerceRanking`, vote prompt/schema now `{"choice": "<id>"}`, tie run-off unchanged on vote counts; tests + ADR 0007 + DECISION_PROCESS §11 updated 2026-08-28  
