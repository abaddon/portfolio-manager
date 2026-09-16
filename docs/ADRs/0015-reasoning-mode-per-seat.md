# ADR 0015 — Reasoning mode is a per-seat property, not a global one

- **Status:** Accepted
- **Date:** 2026-09-16
- **Supersedes (in part):** WP-P1.3's blanket `thinking: "disabled"` for non-propose phases

## Context

WP-P0.6/P1.3 made cheap phases pay nothing for reasoning: proposals may think,
while review, feedback and vote calls force `thinking: "disabled"`
(`CommitteeService.agentChat`). The live configuration additionally ran every
committee seat with `llm.thinking: "enabled"`.

Two independent failures came out of that on the live server (`hermes`,
2026-09-15/16), both verified against the providers:

1. **`deepseek-flash` spent its whole output budget on reasoning.** A raw call
   with thinking on returned `reasoning_content` of 10 297 chars and
   **2 925 of 3 036 completion tokens** consumed by reasoning; the answer itself
   was truncated. A real committee propose prompt therefore produced no parseable
   JSON, the one repair retry failed the same way, and the session died with
   `LLM returned non-JSON output twice`. This was the actual production failure —
   **every committee session after the 2026-09-15 07:50 restart failed**.
   With thinking off the same call returned valid JSON in ~1.3 s and 139 tokens.

2. **Two seats cannot be asked to think off at all.** OpenRouter publishes
   `"reasoning": {"mandatory": true}` for both `google/gemini-3.8-flash` and
   `z-ai/glm-5.3-flash`. Sending the blanket `thinking: "disabled"` (and
   OpenRouter's unified `reasoning: {enabled: false}`) for review/feedback/vote
   is answered with **HTTP 400 `Reasoning is mandatory for this endpoint and
   cannot be disabled.`** Reproduced in 4 of 5 paper sessions; the fifth failed
   on a glm timeout. Production had not yet hit it only because sessions died in
   `propose` first — fixing (1) alone would have exposed it immediately.

So "thinking is a global config knob plus a phase-based override" is wrong: the
provider's contract makes it a property of the individual endpoint.

## Decision

1. `llm.thinking` returns to `disabled` in the live config — the cheap,
   deterministic structured-output mode, and the only one `deepseek-flash` can
   complete a large JSON answer in.
2. A committee seat may declare **`committee.agents[].requiresReasoning: true`**.
   Such a seat's client is pinned to `thinking: "enabled"` at construction
   (`composition/root.ts`), so it is *impossible* to misconfigure it into the
   400 — independent of the global setting.
3. `agentChat` skips the phase override for those seats
   (`if (phase !== "propose" && !agent.requiresReasoning)`), so the agent's own
   thinking setting stands for review/feedback/vote.

Agents that do not set the flag keep WP-P1.3's cost behaviour exactly: proposals
think per config, cheap phases never do.

## Consequences

- The live committee can complete a full session again: propose (deepseek, no
  thinking) → review/feedback/vote (both OpenRouter seats reasoning as their
  endpoints require).
- Cost: the two OpenRouter seats now pay for reasoning on feedback and votes,
  which WP-P1.3 deliberately avoided. This is forced by the provider — it is not
  a tuning choice — and it is confined to seats that opt in via the flag.
- A reasoning-mandatory endpoint cannot be used for cheap classification calls.
  `news-sentiment` still requests `thinking: "disabled"` on the analyst seat
  (DeepSeek), which is unaffected.
- Adding a future seat whose endpoint mandates reasoning requires setting the
  flag; the default (`false`) preserves today's cheaper behaviour.

## Alternatives considered

- **Hard-code the two OpenRouter model ids** as reasoning-mandatory. Rejected:
  silently wrong the moment a model is swapped (which is exactly how the
  2026-09-09 and 2026-09-15 outages started), and it hides a real endpoint
  property from the operator.
- **Query OpenRouter's `reasoning.mandatory` at startup** from `/api/v1/models`
  and set the flag automatically. Attractive, but it adds a second source of
  truth to the startup probe and a network dependency on the request path; the
  explicit flag is inspectable in `config/local.json` and covered by a test.
- **Force `thinking: "enabled"` globally again.** Rejected: that is failure (1).
- **Drop thinking control entirely** and let providers default. Rejected: it
  gives up the deterministic, cheap JSON path that the analysts and the
  sentiment classifier rely on.

## Verification

- Raw provider probe (recorded in `docs/TODO.md`): thinking on ⇒ 2 925/3 036
  reasoning tokens and truncated content; thinking off ⇒ valid JSON, 139 tokens.
- OpenRouter catalogue declares `reasoning.mandatory: true` for both seats.
- 5× `run-once --force --config config/committee-paper.json` on `hermes`
  reproduced 4× the mandatory-reasoning 400 before the fix.
- New unit test *"does not ask a reasoning-mandatory seat to think off"* fails
  against the pre-fix code (`expected false to be true`) and passes after.
- `pnpm verify` green: 45 files, 384 tests.
