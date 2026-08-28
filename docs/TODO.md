# Trading portfolio manager
Asset Allocation Committee (AAC): an alternative decision flow where N≥3 AI asset managers (each on its own OpenRouter model) propose allocations → review each other → vote → the winning proposal is applied (targets persisted, orders gated + executed). Old flow stays intact when the committee is disabled. Toggle from the dashboard; everything visible there. 2026-08-28

Previous items (DECISION_PROCESS audit) — all resolved.

### Backlog
- [x] Live verification: real run with 3 agents on the paper profile (`config/committee-paper.json`) — session COMPLETED: 3 proposals (deepseek-v4-pro/flash), 6 feedback, votes 4/3/2 → winner accepted → 2 BUY orders gated (rescaled to maxOrderValue) and FILLED; dashboard API + toggle verified on port 8791 (DeepSeek agents because `OPENROUTER_API_KEY` is not in `.env` — ask user for the key to run the canonical OpenRouter agents) 2026-08-28  

### Completed ✓
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
