# Text Read Badges Implementation Plan

**Goal:** Make completed first reads obvious beside every Library text title.
**Design:** Read (checkmark) when any completed reading session exists; otherwise
Unread. Starting/pausing does not count. Use actual completed sessions rather
than trusting first-read flags, consistent with Goals. Return this as
has_completed_read in both shelf lists and search summaries. No schema change.
Old cached summaries without this field show Status unknown until refreshed.
Local completed sessions awaiting sync override a server/cached Unread result;
finishing locally updates the cached shelf summary too. Use readable light/dark
tokens and wrapping title rows; retain existing offline/cache badges.

**Approach:** Compute the status in the existing indexed list query, avoiding
one history request per row. Reuse the existing local pending-session store and
navigation cache. The request is specific; no additional design gate is needed.
**Tech Stack:** Existing Rust/SQLite, TypeScript, CSS and Playwright.

## Review Focus

- Completed rereads/manual sessions count even if a first-read flag is stale.
- Active sessions do not count; deleting all completions restores Unread.
- Unknown legacy caches are never silently described as Unread.
- Pending completions remain Read if sync finishes during a list request.
- Status is cached on Finish, so closing/reopening offline keeps known progress.

### Task 1: Facts and UI

- [x] Write failing Rust and browser tests for Read/Unread/unknown and local completion.
- [x] Add the summary field and indexed EXISTS query to list and search.
- [x] Render title badges, merge pending reads, and update local completion cache.
- [x] Run Rust and complete browser suite; inspect layout and review the change.

### Task 2: Delivery

- [x] Build/test Linux server in isolated scratch, retain old binary/frontend.
- [x] SCP matching source/build, activate on chasmfiend, verify health/API/live badges.
- [x] Record results and commit.

## Validation and deployment

- All 57 browser/model tests passed, including cache updates, offline uploaded
  reads, uploads finishing during list requests, and shelf switches while Finish
  waits for IndexedDB. Local and Linux Rust suites passed: 77 library and 3
  server tests; one pre-existing documentation test remains ignored.
- Independent review found a mutable navigation/cache-key race during Finish.
  A failing/passing regression now verifies that completion updates the owning
  shelf cache, without changing another shelf's cached contents. Re-review clean.
- Visually checked desktop light/dark and mobile badges; drawer animations were
  completed before capturing the mobile layout.
- Deployed matching frontend/source and Linux binary to chasmfiend; health `ok`,
  service active. Live HTML, JS, CSS, service-worker and binary hashes matched.
- Retained `dist.before-read-badges-20261117` and
  `src-tauri/target/release/server.before-read-badges-20261117` for rollback;
  no schema migration or reading-history changes were needed.
- Live badge checks compared completed history and rendered statuses on shelf 24,
  including both Read and Unread texts. No live reading sessions were created.
- Linux server SHA-256:
  `446b80cf9c5350c838e4de16bb61dabf6061e8c33a48495cd37eee05dff70774`.
