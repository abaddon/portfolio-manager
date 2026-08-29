# Trading portfolio manager
Asset Allocation Committee (AAC): an alternative decision flow where N≥3 AI asset managers (each on its own OpenRouter model) propose allocations → review each other → vote → the winning proposal is applied (targets persisted, orders gated + executed). Old flow stays intact when the committee is disabled. Toggle from the dashboard; everything visible there. 2026-08-28

Previous items (DECISION_PROCESS audit) — all resolved.

### Backlog
- [ ] Optional: if more model choice is wanted, relax the OpenRouter guardrail at openrouter.ai/settings/privacy (not needed — the committee runs on the three guardrail-permitted models) 2026-08-28  

### Completed ✓
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
