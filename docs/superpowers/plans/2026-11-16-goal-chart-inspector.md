# Goal Chart Inspector Implementation Plan

> Use superpowers:executing-plans. User supplied detailed behavior and delegated implementation choices; proceed without another approval gate.

**Goal:** Stack a useful three-month view below long goals and inspect daily values interactively.
**Spec:** docs/superpowers/specs/2026-11-16-goal-chart-inspector-design.md
**Architecture:** Shared pure chart-data helpers feed full and near windows. SVG rendering retains existing size. A local pointer/keyboard controller updates cursor and readout only; goal view retains selected dates per goal.
**Tech Stack:** Existing TypeScript, SVG, CSS and Playwright; no dependencies or backend changes.

## Global Constraints

- Full chart remains full width; near chart is below it at the same width and SVG height.
- Six/three calendar months, not approximate day counts; clamp month ends.
- Inspect unsampled daily data; no requests or persistence on hover/drag.
- Future actuals are unavailable; completed projections plateau; finite horizon stays explicit.

## Review Focus

- Near clipping must carry values at window boundaries and not include offscreen points.
- Pointer coordinates must account for SVG scaling and mobile scrolling.
- Cursor markers/readouts must agree with plotted series and selected calendar day.
- New charts need unique accessible IDs and no accumulating global listeners.
- Changing assumptions preserves selected date while recomputing values.

### Task 1: Chart data and calendar windows

Files: src/lib/goal-chart-data.ts; tests/goal-chart-data.spec.ts.
- [x] Add failing tests for months/thresholds, daily values, plateau/unavailable values and near Y bounds.
- [x] Implement shared window/value/clipping helpers and pass tests.

### Task 2: Rendering and interaction

Files: src/views/goal-chart.ts, src/views/goals-view.ts, src/style.css; tests/goals.spec.ts.
- [x] Add failing browser tests for stacked equal-size charts and hover/drag/date/keyboard interaction.
- [x] Render two independently scaled SVGs where appropriate and attach local interaction handlers.
- [x] Preserve cursor dates across what-if edits; verify no requests or curve DOM replacement during inspection.
- [x] Run full browser/model suite and inspect light/dark/mobile visuals; obtain review.

### Task 3: Delivery

- [x] SCP frontend and matching sources to chasmfiend with rollback assets, verify live UI and hashes.
- [x] Record results and commit the change.

## Validation and delivery record

- Production build passed; all 52 browser/model checks passed, including the
  existing offline, reading, projection and goal suites. Backend unchanged.
- Independent review passed. Additional red/green regressions fixed a queued
  hover update overriding an explicit date and preserved exact completion
  corners when sampling full-chart curves. Scoped re-review passed.
- Visually inspected full/near cursors, mobile and existing light/dark screenshots.
- Deployed frontend and matching sources via scp to chasmfiend. Retained
  `dist.before-chart-inspector-20261116` and previous hashed assets for rollback
  and old clients. Restarted the existing service; health returned `ok` and
  live HTML, JavaScript, CSS and service-worker hashes matched the tested build.
- Live browser smoke checked equal-width stacked charts, February 10 inspection,
  pointer drag clamping and unchanged curve DOM, with zero API requests during
  inspection. No saved goals or reading sessions were modified.
