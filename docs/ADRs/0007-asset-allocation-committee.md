# ADR 0007 — Asset Allocation Committee (alternative decision flow)

**Date:** 2026-08-28 · **Status:** Accepted

## Context

The user asked for an *alternative* decision flow: an asset allocation
committee of 3+ AI asset managers, each assigned its own model via
OpenRouter, which proposes allocation decisions, reviews the other members'
proposals, votes, and whose winning proposal is applied to the portfolio.
The committee must be toggleable from the dashboard, and everything it
produces (analysis, proposals, feedback, vote points, accepted proposal) must
be visible there. The existing decision process must keep working unchanged.

## Decisions

1. **Alternative flow, not a replacement.** The committee is opt-in
   (`committee.enabled`, default `false`, plus a runtime override persisted in
   the `settings` table via the dashboard toggle). When enabled for a run, it
   **replaces** the allocation-review step and the analyst-signal decisions
   step. Market analysis and portfolio evaluation still run — they are the
   committee's inputs. When disabled, the classic flow runs byte-for-byte as
   before (verified by the unchanged e2e suite).

2. **Per-agent LLM clients.** Each agent (`committee.agents[]`) declares
   `{id, name, provider, model, temperature?}` and gets its own
   `HttpLlmClient` built with `makeLlmClient` — provider `openrouter` by
   default (key `OPENROUTER_API_KEY`, already supported by the LLM adapter).
   A missing key does not crash the app: the agent gets an unavailable client
   and the session fails with a visible error.

3. **Session protocol** (one per run, persisted in `committee_sessions`):
   - **Propose** — every agent proposes `{title, rationale, confidence,
     targets[], orders[]}` over the shared context (portfolio snapshot, drift,
     current targets, per-ticker analyst reports, heat).
   - **Feedback** — every agent reviews every *other* agent's proposal with
     `{verdict: positive|negative, comment}`.
   - **Vote** — every agent casts exactly **one vote** for the *other* (still
     active) proposal it favours most; each vote is 1 point. Points (vote
     counts) are cumulative across rounds and shown per proposal.
   - **Tie-break (run-off)** — the proposal(s) with the most votes win. On a
     tie at the top: the proposal(s) with the **fewest** votes are
     `excluded` from the next vote round and the agents vote again (the
     user's rule). When all remaining proposals are tied there is nothing to
     exclude, so the round is simply re-voted. Rounds are capped at
     `committee.maxVoteRounds` (default 3); a tie that survives the cap is
     settled deterministically (most positive feedback, then earliest
     proposal). Note: with exactly 3 agents and one vote each, a round is
     either decisive ({2,1,0}) or a three-way tie ({1,1,1}) — the latter
     re-votes, so the exclusion path only triggers with 4+ agents; the rule
     is implemented and unit-tested for any N.
   - **Apply** — the winner's targets are persisted as allocation-target
     updates under the *same* guardrails as the review (per-name
     `maxTarget`, cash-floor scaling, weights clamped/rounded); its orders
     are priced and passed through the *same* economic gate
     (`DecisionService.decideFromOrders` → `DecisionEngine.evaluate`) before
     execution. Committee mode therefore never weakens the safety gates.
     Tickers outside the target set are ignored and noted in the session
     details.

4. **Failure containment.** Any agent LLM failure fails the *session* (status
   `FAILED`, error persisted, event emitted) — the pipeline run continues with
   no target changes and no orders that run. Partial artifacts (proposals,
   feedback) are persisted as they are produced, so failures are still fully
   auditable on the dashboard.

5. **Persistence & dashboard.** New tables `committee_sessions`,
   `committee_proposals` (with points/status/excluded-round),
   `committee_feedback`, `committee_votes`; events
   `CommitteeSessionStarted/ProposalsReady/FeedbackCompleted/
   VoteRoundCompleted/ProposalExcluded/WinnerAccepted/TargetsApplied/
   SessionCompleted/SessionFailed`. The dashboard gets a dedicated panel with
   the enable/disable toggle (`POST /api/committee/enable`), every proposal
   (targets, orders, rationale, points, status), the feedback it received,
   every vote round's points, and the accepted proposal.

## Consequences

- Old flow unchanged when disabled (config default and toggle default off).
- 3–15 LLM calls per committee run (propose N + feedback N×(N−1) + votes
  N×rounds), so committee runs are more expensive than the classic flow.
- The winning proposal's targets take effect from the **next** run's
  evaluation (the current run's drift/decisions use the pre-session targets)
  — consistent with the review flow, which also evaluates against persisted
  targets.
- Rejected/partial artifacts are permanent audit rows; nothing is deleted.
