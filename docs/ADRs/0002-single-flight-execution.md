# ADR 0002 — Single-flight pipeline execution and run-state recovery on the dashboard

- **Status:** Accepted
- **Date:** 2026-08-27
- **Decision maker:** User (Stefano) + AI agent

## Context

Two related defects were reported:

1. **Refresh loses the RUNNING state.** Clicking "Run now" disables the button and shows
   "⏳ Running…" only in the page's local state. `POST /api/run` awaits the whole pipeline
   (minutes), so a page refresh mid-run re-loaded a fresh page: the button re-enabled and the
   user could click again — getting a bare `409` alert — while the status was no longer tracked.
   (The run row itself is already persisted as `RUNNING` the moment the run starts, so the
   server always had the truth; the client just never re-read it.)
2. **Concurrency gap.** The web layer's in-flight flag only covered manual-vs-manual requests
   in one process. A manual run (which skips the per-hour idempotency guard) could overlap a
   **scheduled or startup** run — two pipelines executing simultaneously, double-writing
   analysis/decisions/orders on a live-money account.

## Decision

1. **Orchestrator-level single-flight guard** (`PipelineOrchestrator.runOnce`), authoritative
   for every trigger:
   - A run is in flight from the first synchronous check until the run settles (`finally`).
   - Manual triggers (`skipHourGuard`) during an in-flight run throw `RunInProgressError`
     carrying the in-flight run id; the web layer maps it to `409 { error, runId }`.
   - Scheduled/startup triggers during an in-flight run record a `SKIPPED` run
     ("a run is already in progress (…)") — persisted, with a `PipelineSkipped` event. Never queued.
   - The guard clears on success, failure and skip paths alike (outer `try/finally`).
2. **Client recovers run state from the server.** On every `load()`, if the latest run is
   `RUNNING`, the dashboard disables the button ("⏳ Running…"), remembers the run id
   (`activeRunId`) and resumes polling `/api/overview` every 5 s until that run settles, then
   re-renders and re-enables. A `409` on POST resumes tracking the in-flight run instead of
   starting a second one. Clicking while tracking is a no-op.
3. The existing web-server in-flight flag and the scheduler's own `running` flag stay as
   fast-path layers; the orchestrator guard is the single source of truth.

## Consequences

- A second manual execution is impossible while any run is executing (manual or scheduled);
  scheduled triggers degrade to explanatory SKIPPED rows instead of queueing.
- Refreshing the dashboard mid-run keeps the RUNNING state visible and self-resolving —
  no stuck buttons, no stray second runs.
- Reconciliation/sweep work that ran before the hour guard now also runs inside the
  single-flight section (it can no longer overlap another run's execution).
- New tests: orchestrator single-flight (manual rejection, scheduled SKIP, guard recovery
  after failure) and web 409 mapping.

## Alternatives considered

- **Web-layer flag only** — rejected: does not cover scheduled/startup overlap and is
  per-instance state.
- **Queueing concurrent runs** — rejected: hourly cadence makes late runs stale; SKIPPED
  with a reason is more honest and visible on the dashboard.
- **Client-only fix** — rejected: the UI would look right while two pipelines could still
  execute concurrently.
