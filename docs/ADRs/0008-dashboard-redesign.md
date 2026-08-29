# ADR 0008 — Dashboard redesign driven by the OpenDesign prototype

**Date:** 2026-08-29 · **Status:** Accepted

## Context

The user produced a three-page visual redesign of the dashboard in an
OpenDesign project (`1585202e-1236-4fae-93da-3e46395c97df`): a modern-minimal
dark design system (`dashboard.css` — oklch tokens, no raw hex outside
`:root`) and three pages — Portfolio (value hero, value-per-run trend,
composition with allocation ribbons + diverging drift bars, rebalance
pressure), Activity (decision run log with expandable gate checklists), and
a committee-session deep-dive (vote outcome, proposals, peer review, applied
targets, orders at the gate). The task was to make the live dashboard look
and behave like the prototype while staying runnable vanilla HTML/CSS/JS
against the existing read-only API, and without touching any trading logic.

## Decisions

1. **The prototype is the driver; the API is untouched except one additive
   field.** The three prototype pages were ported to `web/public/` and wired
   to real data (`/api/overview`, `/api/portfolio/history`, `/api/targets`,
   `/api/decisions`, `/api/orders`, `/api/runs*`, `/api/committee`,
   `/api/macro`, `/api/news`, `/api/sentiment`, `/api/events`). The only
   server change is additive and read-only: `/api/overview` now also returns
   `risk: config.risk` so the Activity page can render the real economic-gate
   checklist (benefit floor, cost coverage, order size, heat, conviction)
   instead of hardcoded numbers. No port, domain, or persistence change.

2. **Four pages, not three — nothing is deleted.** The prototype dropped
   several operational panels (macro, price history, news, sentiment, event
   log, orders ledger, allocation targets/review, per-run analysis). Those
   are preserved on a fourth page, `data.html`, restyled on the new design
   tokens (same endpoints, same expandable run-detail behaviour). The
   topbar nav is Portfolio / Activity / Data.

3. **Safety behaviour is preserved byte-for-byte at the API boundary.** The
   Run-now button still POSTs `/api/run` with the same confirm dialog,
   force-run checkbox, 409 single-flight handling and run-watching polling —
   the pipeline and its cost/risk gates are untouched (the button never
   bypasses them). The Asset Allocation Committee enable toggle moved from
   the committee panel into the topbar and still POSTs
   `/api/committee/enable`.

4. **Data mapping notes** (the fields the UI derives, for future readers):
   - blocked intents persist as `action: "HOLD"`; the *intended* side lives
     on `proposal.action` — the UI shows the intent pill and the recorded
     HOLD side by side.
   - committee decisions carry `details.heat` and `details.agentName`/
     `details.points` (provenance on the Activity page).
   - a decision's gate verdict is `approved` + `reason`
     (`OPPORTUNITY_TOO_SMALL` = below benefit floor, etc.);
   - drift bars colour red outside `allocation.rebalanceBand` (half-track =
     10pp); ribbons use the prototype's descending fg-mix ramp; cash is the
     hatched segment.
   - value trend is a dependency-free SVG (hover tooltip), replacing
     Chart.js on the Portfolio page; Chart.js remains only on `data.html`.

## Consequences

- `web/public/` is now `dashboard.css` + `app.js` (shared core: helpers,
  topbar, run-now, trend/ribbon/drift/pill/gate builders) + per-page
  scripts (`portfolio.js`, `activity.js`, `session.js`, `data.js`); the old
  single-page `index.html`/`styles.css`/`app.js` are gone. Still vanilla,
  still no build step — the Fastify static handler serves everything.
- A dashboard restart is required once to pick up the `risk` field (static
  files are re-read per request, the API is not). Before the restart the
  UI degrades gracefully: gate checklists show "gate limits unavailable".
- Verified: `pnpm verify` green (194 tests); every page smoke-tested in
  headless Chrome against a live web-only instance (no JS exceptions, key
  markers render, sort/expand/filter interactions work).
