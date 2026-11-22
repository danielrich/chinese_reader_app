# Reading Goals Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Implementation is authorized; proceed without another approval gate.

**Goal:** Durable multi-shelf goals with live browser-side completion scenarios.
**Architecture:** A read-only Rust summary supplies facts; saved JSON uses existing settings. Pure TypeScript integrates changing speed against experience; a dedicated DOM/SVG view presents and edits goals.
**Tech Stack:** Rust/rusqlite/serde, TypeScript, CSS, SVG, Playwright.
**Spec:** docs/superpowers/specs/2026-11-16-reading-goals-design.md

## Global Constraints

- Deadline 2035-07-23; 30 minutes/day; default 6M/200 CPM and 12M/250 CPM.
- Multiple shelves form a recursive union. All reading builds experience; only first completions advance the goal.
- Browser-only what-if edits; explicit Save assumptions; no reading-history mutation.
- No new dependencies or schema migration. Keep existing reader/offline behavior.
- Today's forecast subtracts already logged global minutes; saved goal start remains stable.

## Review Focus

- Repeated/missing/nested shelf selections: backend union test and UI missing-shelf warning.
- Rereads and stale first-read flags: backend derives earliest completion from timestamps.
- Zero minutes, no speed, past milestones, DST and late completion: pure model tests.
- Invalid input and failed saves: UI retains draft and valid saved settings.
- Goal switching or refresh during requests: ignore stale async results; browser regression.

### Task 1: Reading facts endpoint

**Files:** src-tauri/src/library/goals.rs, library/mod.rs, bin/server.rs.
**Interfaces:** command get_goal_reading_data {shelf_ids:number[]} returns
`{texts: {id:number, character_count:number, first_completed_at:string|null}[], activity:{finished_at:string, duration_seconds:number|null, character_count:number, in_scope:boolean}[], lifetime_characters:number, recent_speeds:number[], missing_shelf_ids:number[]}`.
Use earliest actual completed timestamp per text, deduplicated roots, positive valid recent first-read speeds, and global activity. Empty roots return no scoped texts, never all texts. Missing roots are reported.

- [x] Write failing Rust tests for overlaps, missing/empty scopes, rereads and global experience.
- [x] Implement parameterized recursive queries and typed serde models; wire command.
- [x] Run Rust tests and review backend changes.

### Task 2: Frontend facts, persistence and projection model

**Files:** src/lib/goals.ts, src/lib/goal-projection.ts, tests/goal-projection.spec.ts.
**Interfaces:** Goal `{id,name,shelfIds,startDate,deadline,timeZone,assumptions}`; assumptions `{dailyMinutes,startingCpm:number|null,milestones:{characters,cpm}[]}`; API types match Task 1.
Model exports `projectReading({remaining,experience,cpm,dailyMinutes,todayMinutes,today,milestones})` returning dated cumulative future increments and finishDate/null, sampled daily within a 100-year limit; `localDate(instant,timeZone)`, calendar helpers, validation, and `goalProgress(goal,data,now)` supply immutable chart facts.
Use analytic exponential/logarithmic integration within linear speed segments, split at milestones; skip passed milestones, positive speeds only, plateau after last future milestone. Persist `{version:1,goals:Goal[]}` through reading_goals_v1.

- [x] Write failing model tests for constant and changing speed, thresholds, zero/no speed, dates, today's budget and actual history.
- [x] Implement and pass model tests. Reject invalid saved JSON safely without overwriting it.

### Task 3: Goals UI and browser coverage

**Files:** src/views/goals-view.ts, src/views/goal-chart.ts, src/main.ts, src/style.css, tests/goals.spec.ts.
**Interfaces:** `loadGoalsView():Promise<void>`; render chart from factual history and Task 2 scenarios.
Provide create/edit/delete, multi-shelf search, deadline, saved timezone, sliders/numeric what-if controls, Save assumptions/Reset/Refresh, facts/status, accessible SVG and table. Start with the user's suggested shelf-name matches and default goal inputs; user creates the goal explicitly. No request on scenario input. Guard async view loads and retain unsaved draft on failures.

- [x] Write failing browser tests for goal creation, multi-shelf selection, frontend-only edits, persistence/reset, errors and mobile.
- [x] Implement, run production build and complete Playwright suite, visually inspect light/mobile/dark states.
- [x] Obtain independent review and address important findings.

### Task 4: Deployment and commit

- [x] Test/build the Linux backend, retain prior binary/frontend and existing hashed assets.
- [x] SCP the matching sources and build to chasmfiend, restart the existing service, verify endpoint/asset hashes and live Goals UI.
- [x] Record validation and commit the feature; do not push unless requested.

## Validation record

- 43 Playwright/browser-model tests passed, including the existing offline and
  reader suite. Production TypeScript/Vite build passed without build warnings.
- Local and isolated Linux Rust suites passed: 76 library tests and 3 server
  tests; one pre-existing documentation test remains ignored. No dependencies
  or schema migrations were added.
- Linux release candidate SHA-256:
  `e1e3ebaf9f8a3864324ee4657be8fab829988252765af6bb9796cf88cf551b3a`.
- Task reviews pass after red/green regressions for required saved timezone,
  resetting to the latest saved assumptions, chart horizon bounds, refresh
  during deletion, and cached facts after a scope change on another device.
- Visually inspected desktop light/dark and mobile layouts. Forecast controls
  sit alongside the chart on desktop and stack on mobile.
- Final whole-feature review found no remaining important issues. A final
  quoted-name round-trip check additionally caught attribute escaping, fixed
  with a failing/passing regression and scoped review. All 43 tests passed
  again on the exact deployed frontend build.

## Deployment record

- Deployed to `/home/daniel/exper/chinese_reader_app` on chasmfiend via scp and
  activated the matching Linux server. Health is `ok`; service active/running.
- Retained previous frontend as `dist.before-goals-20261116` and previous server
  as `src-tauri/target/release/server.before-goals-20261116`. Existing hashed
  assets remain served for older clients. No database migration was needed.
- Live HTML, CSS, JavaScript, service-worker and Linux binary hashes match the
  tested build. Existing pending systemd unit changes were left untouched.
- Live endpoint verified 2,066 texts / 10,321,007 characters for the requested
  shelf union, with 173,404 lifetime characters at verification. Duplicate roots
  did not change totals, and empty scope returned no scoped texts.
- Live browser smoke check used a disposable configuration response with real
  server reading facts. Changing daily minutes immediately changed the forecast
  with zero API requests; Reset restored the saved scenario. At verification,
  default growth forecast finished November 30, 2031. No goal or reading history
  was persisted by the smoke check; the initial goal remains an explicit user
  save with the requested defaults prefilled.
