# Performance and Nightly Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make common reader operations fast and move shelf analysis to durable, conditional nightly maintenance.

**Architecture:** SQLite records dirty analysis jobs while retaining the last good cache. The Axum daemon schedules catch-up/nightly maintenance on a dedicated connection, and HTTP requests only read cached analysis or enqueue a future job. Indexed queries, bulk shelf loading, explicit offline-cache generation, compressed payloads, and client-side history caching remove the measured foreground bottlenecks.

**Tech Stack:** Rust 1.77.2, Axum 0.8, Tokio, rusqlite/SQLite WAL, TypeScript 5.9, Vite 7, IndexedDB, service worker, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-20-performance-and-nightly-analysis-design.md`

## Global Constraints

- Use local server time and a daily 00:05 cutoff.
- Retain stale shelf-analysis JSON until a replacement commits successfully.
- Refresh only previously cached or explicitly requested shelves, never all shelves automatically.
- Never hold the HTTP write semaphore during analysis computation.
- Mutations after a maintenance cutoff remain dirty for the next run.
- Do not include text content or lookup terms in timing logs.
- Back up the production database before migration or daemon restart.

---

### Task 1: Durable analysis-maintenance state

**Files:**
- Modify: `src-tauri/src/dictionary/schema.rs`
- Create: `src-tauri/src/library/maintenance.rs`
- Modify: `src-tauri/src/library/mod.rs`

**Interfaces:**
- Produces: `mark_analysis_dirty(conn: &Connection, shelf_ids: &[i64], at: DateTime<Utc>) -> Result<()>`
- Produces: `request_shelf_analysis(conn: &Connection, shelf_id: i64, at: DateTime<Utc>) -> Result<()>`
- Produces: `maintenance_snapshot(conn: &Connection) -> Result<MaintenanceSnapshot>`
- Produces: `claim_due_jobs(conn: &Connection, cutoff: DateTime<Utc>) -> Result<Vec<i64>>`
- Produces: `complete_shelf_job(...)` and `fail_shelf_job(...)`

- [ ] **Step 1: Write migration and state-machine tests**

Add tests in `maintenance.rs` using an in-memory database. Cover table creation, preserving an earlier `dirty_at`, registering an uncached requested shelf, selecting only jobs dirty at or before the cutoff, retaining a post-cutoff mutation, and recording failures without clearing dirty state. Use fixed RFC3339 timestamps such as `2026-08-20T05:05:00Z`.

```rust
#[test]
fn mutations_after_cutoff_remain_dirty() {
    let conn = setup_test_db();
    mark_analysis_dirty(&conn, &[7], utc("2026-08-20T04:00:00Z")).unwrap();
    let jobs = claim_due_jobs(&conn, utc("2026-08-20T05:05:00Z")).unwrap();
    assert_eq!(jobs, vec![7]);
    mark_analysis_dirty(&conn, &[7], utc("2026-08-20T06:00:00Z")).unwrap();
    complete_shelf_job(&conn, 7, utc("2026-08-20T05:05:00Z")).unwrap();
    assert!(maintenance_snapshot(&conn).unwrap().dirty_at.is_some());
}
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `cd src-tauri && cargo test library::maintenance -- --nocapture`

Expected: compilation fails because the module and schema do not exist.

- [ ] **Step 3: Add additive schema and maintenance implementation**

Create `analysis_maintenance` and `analysis_shelf_jobs` with foreign keys and an index on `analysis_shelf_jobs(dirty_at)`. Insert the singleton row with `INSERT OR IGNORE`. Implement cutoff-safe completion with SQL that clears only dirty timestamps `<= cutoff`; use transactions for task/job state updates.

- [ ] **Step 4: Run maintenance and migration tests**

Run: `cd src-tauri && cargo test library::maintenance dictionary::schema -- --nocapture`

Expected: all focused tests pass, including idempotent migration.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/dictionary/schema.rs src-tauri/src/library/maintenance.rs src-tauri/src/library/mod.rs
git commit -m "feat: track durable shelf analysis maintenance"
```

### Task 2: Cached-only analysis API and maintenance runner

**Files:**
- Modify: `src-tauri/src/library/analysis.rs`
- Modify: `src-tauri/src/library/maintenance.rs`
- Modify: `src-tauri/src/library/models.rs`
- Modify: `src-tauri/src/bin/server.rs`

**Interfaces:**
- Consumes: maintenance state functions from Task 1.
- Produces: `get_shelf_analysis_status(conn, shelf_id, now) -> Result<ShelfAnalysisStatus>` where status is `Ready { analysis, cached_at, is_stale, last_error }` or `Pending { requested_at, last_error }`.
- Produces: `run_due_analysis_maintenance(db_path, cutoff) -> MaintenanceRunReport`.
- Produces: `next_maintenance_cutoff(now: DateTime<Local>) -> DateTime<Local>`.

- [ ] **Step 1: Write failing cached-state and scheduler tests**

Test that an HTTP-style cache read never invokes `analyze_text`, that a missing cache creates a pending job, that stale data is returned while dirty, that a failed rebuild preserves old JSON, and that an injected time at 00:06 selects the just-passed cutoff while 23:00 selects tomorrow's cutoff.

```rust
#[test]
fn stale_cache_is_returned_without_recomputation() {
    let conn = setup_test_db();
    seed_cached_analysis(&conn, 4, "2026-08-19 00:05:00");
    mark_analysis_dirty(&conn, &[4], utc("2026-08-20T01:00:00Z")).unwrap();
    let status = get_shelf_analysis_status(&conn, 4, utc("2026-08-20T02:00:00Z")).unwrap();
    assert!(matches!(status, ShelfAnalysisStatus::Ready { is_stale: true, .. }));
}
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd src-tauri && cargo test shelf_analysis_status -- --nocapture`

Expected: missing status/runner interfaces.

- [ ] **Step 3: Separate computation from publication**

Refactor analysis into `compute_shelf_analysis(&Connection, shelf_id) -> ShelfAnalysis` with no cache write and `publish_shelf_analysis(&mut Connection, shelf_id, &ShelfAnalysis, cutoff)` using a short transaction. Ensure `get_shelf_analysis_status` only reads cache/job rows and enqueues a missing request.

- [ ] **Step 4: Add the internal scheduler**

At server startup, spawn a Tokio task that calculates the next 00:05 local cutoff, performs an immediate missed-run check, and sleeps until the next cutoff. Execute maintenance through `spawn_blocking` with a dedicated connection opened from the configured database path. Process jobs sequentially; record per-job failure and continue.

- [ ] **Step 5: Remove request-time write serialization**

Remove `get_shelf_analysis` from `is_write_command`. Dispatch it to cached status only. Do not expose the maintenance runner through `/api/invoke`; retain a Rust-callable runner for tests and a server CLI flag `--run-analysis-maintenance` for explicit administration.

- [ ] **Step 6: Verify concurrency tests**

Run: `cd src-tauri && cargo test analysis maintenance server -- --nocapture`

Expected: cached reads complete while a maintenance computation is running, stale cache survives a forced failure, and post-cutoff dirtiness remains.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/library/analysis.rs src-tauri/src/library/maintenance.rs src-tauri/src/library/models.rs src-tauri/src/bin/server.rs
git commit -m "feat: refresh shelf analysis in nightly maintenance"
```

### Task 3: Mark analysis dirty from relevant mutations

**Files:**
- Modify: `src-tauri/src/bin/server.rs`
- Modify: `src-tauri/src/library/maintenance.rs`
- Modify: `src-tauri/src/library/shelf.rs`
- Modify: `src-tauri/src/library/text.rs`
- Modify: `src-tauri/src/library/speed.rs`
- Modify: `src-tauri/src/library/known_words.rs`

**Interfaces:**
- Consumes: `mark_analysis_dirty` from Task 1.
- Produces: `cached_or_requested_ancestor_ids(conn, shelf_ids) -> Result<Vec<i64>>`.

- [ ] **Step 1: Add mutation coverage tests**

Write table-driven tests that complete/upload/delete a reading session, change known-word state, create/delete/move a text, and move a shelf. Assert the correct cached/requested shelf jobs become dirty and unrelated uncached shelves do not receive jobs.

- [ ] **Step 2: Run the tests and confirm failure**

Run: `cd src-tauri && cargo test marks_analysis_dirty -- --nocapture`

Expected: assertions fail because current handlers delete all cache rows or do not mark jobs.

- [ ] **Step 3: Replace destructive invalidation**

Replace calls to `invalidate_shelf_analysis_cache` with dirty markers. Capture old shelf/ancestor IDs before moves or deletes and new IDs afterward. Global vocabulary changes mark every existing cache/job; text-local changes mark only cached/requested ancestors.

- [ ] **Step 4: Verify mutation tests and existing library tests**

Run: `cd src-tauri && cargo test library -- --nocapture`

Expected: all library tests pass; cache rows remain present after invalidation.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/bin/server.rs src-tauri/src/library/maintenance.rs src-tauri/src/library/shelf.rs src-tauri/src/library/text.rs src-tauri/src/library/speed.rs src-tauri/src/library/known_words.rs
git commit -m "fix: retain analysis caches when library state changes"
```

### Task 4: Indexed dictionary lookup

**Files:**
- Modify: `src-tauri/src/dictionary/schema.rs`
- Modify: `src-tauri/src/dictionary/lookup.rs`

**Interfaces:**
- Produces: `contains_han(query: &str) -> bool`.
- Preserves: `lookup(conn, query, options) -> LookupResult` response contract.

- [ ] **Step 1: Write result and query-plan tests**

Seed traditional, simplified, and mixed-case pinyin entries. Assert exact Han matches and case-insensitive pinyin prefix results are unchanged. Use `EXPLAIN QUERY PLAN` and assert Han lookup mentions `idx_entries_traditional`/`idx_entries_simplified` while pinyin lookup mentions `idx_entries_pinyin_nocase` and neither contains `SCAN dictionary_entries`.

- [ ] **Step 2: Run the lookup tests and confirm the full-scan assertion fails**

Run: `cd src-tauri && cargo test dictionary::lookup -- --nocapture`

- [ ] **Step 3: Add the index and split SQL paths**

Migrate `CREATE INDEX IF NOT EXISTS idx_entries_pinyin_nocase ON dictionary_entries(pinyin COLLATE NOCASE)`. Use the exact OR query only for Han-containing input and `pinyin LIKE (? || '%') COLLATE NOCASE` only for Latin input. Preserve ordering, source filters, limits, definitions, examples, character information, and user dictionaries.

- [ ] **Step 4: Run lookup/schema tests**

Run: `cd src-tauri && cargo test dictionary -- --nocapture`

Expected: all tests pass and query plans use indexes.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/dictionary/schema.rs src-tauri/src/dictionary/lookup.rs
git commit -m "perf: use indexed dictionary lookup paths"
```

### Task 5: Bulk shelf-tree construction

**Files:**
- Modify: `src-tauri/src/library/shelf.rs`

**Interfaces:**
- Preserves: `get_shelf_tree(conn) -> Result<Vec<ShelfTree>>`.

- [ ] **Step 1: Add hierarchy/result tests and a query-count test hook**

Seed multiple roots, grandchildren, direct text counts, completed/unread sessions, and empty shelves. Assert ordering and rolled-up `text_count`/`unread_count` match existing behavior. Under `cfg(test)`, count prepared bulk stages and assert the total does not grow with shelf count.

- [ ] **Step 2: Run the shelf tests and establish existing behavior**

Run: `cd src-tauri && cargo test library::shelf -- --nocapture`

- [ ] **Step 3: Implement three bulk reads plus Rust assembly**

Read ordered shelves once, grouped direct text counts once, and grouped unread counts once. Build `HashMap<Option<i64>, Vec<Shelf>>`, recursively assemble nodes without further SQL, then roll counts upward. Detect orphan/cyclic data defensively and return `LibraryError` instead of recursing forever.

- [ ] **Step 4: Run shelf and server tests**

Run: `cd src-tauri && cargo test shelf -- --nocapture`

Expected: results match and query count remains constant for 1 or 500 shelves.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/library/shelf.rs
git commit -m "perf: build shelf tree from bulk queries"
```

### Task 6: Response compression, ETags, and slow-request timing

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/bin/server.rs`
- Modify: `src-tauri/src/library/analysis.rs`

**Interfaces:**
- Produces: vocabulary response `ETag` and `304 Not Modified` handling.
- Produces: structured stderr timing lines for requests over 250 ms.

- [ ] **Step 1: Add handler tests**

Test `Accept-Encoding: gzip` produces compressed JSON, matching `If-None-Match` returns 304 with no body, and a fake 251 ms timing sample logs command and timing fields without request contents.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd src-tauri && cargo test server -- --nocapture`

- [ ] **Step 3: Enable compression and conditional vocabulary responses**

Enable Tower HTTP's `compression-gzip` feature and add `CompressionLayer`. Derive vocabulary ETags from text ID plus the latest relevant analysis/text update timestamp, quote them per HTTP syntax, and compare weakly against `If-None-Match`.

- [ ] **Step 4: Instrument handler phases**

Measure pool wait, write-lane wait, blocking execution, and total handler duration. Emit one line only above 250 ms. Add nightly summary/per-shelf timings and serialized byte counts.

- [ ] **Step 5: Run Rust tests**

Run: `cd src-tauri && cargo test --all-targets -- --nocapture`

Expected: all targets pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/bin/server.rs src-tauri/src/library/analysis.rs
git commit -m "perf: compress large responses and log slow requests"
```

### Task 7: Lazy shelf analysis and explicit vocabulary caching UI

**Files:**
- Modify: `src/lib/library.ts`
- Modify: `src/views/library-view.ts`
- Modify: `src/style.css`
- Modify: `tests/offline-reliability.spec.ts`

**Interfaces:**
- Consumes: cached analysis status from Task 2.
- Produces: `ShelfAnalysisStatus` TypeScript discriminated union matching Rust JSON.

- [ ] **Step 1: Add browser tests**

Assert selecting a shelf makes no analysis request, opening analysis details makes exactly one cached-status request, pending status renders the nightly message, stale status renders cached data with its timestamp, and opening a text makes no vocab-cache request. Preserve the test that “Cache for Offline” fetches the vocabulary bundle.

- [ ] **Step 2: Run Playwright and confirm failures**

Run: `npm run test:offline -- --grep "lazy analysis|vocab prefetch"`

- [ ] **Step 3: Remove navigation-time analysis and text-time prefetch**

Delete `pendingShelfAnalysisTimer` and the automatic `getTextVocabCache` call in `loadTextView`. Fetch status only from the analysis `<details>` toggle when it first opens. Render ready/stale/pending/failed states and keep explicit offline-cache controls unchanged.

- [ ] **Step 4: Run frontend tests and build**

Run: `npm run build && npm run test:offline`

Expected: TypeScript build and all Playwright tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/library.ts src/views/library-view.ts src/style.css tests/offline-reliability.spec.ts
git commit -m "perf: lazy-load shelf analysis and offline vocabulary"
```

### Task 8: Stale-while-revalidate reading history

**Files:**
- Modify: `src/lib/idb.ts`
- Modify: `src/lib/speed.ts`
- Modify: `src/lib/sync.ts`
- Modify: `src/views/library-view.ts`
- Modify: `tests/offline-reliability.spec.ts`

**Interfaces:**
- Produces: `getCachedReadingHistory(textId)`, `saveCachedReadingHistory(textId, sessions)`, and `invalidateCachedReadingHistory(textId)`.
- Produces: `getTextReadingHistoryFresh(textId)` for network retrieval; UI orchestrates cache-first rendering and background refresh.

- [ ] **Step 1: Add IndexedDB and browser behavior tests**

Test immediate cached rendering, subsequent network replacement, offline stale labeling, first-load spinner without cache, and invalidation after session deletion/manual logging/sync completion.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm run test:offline -- --grep "reading history"`

- [ ] **Step 3: Add history cache records and refresh flow**

Use the existing navigation cache store with key `reading_history:${textId}` and a value `{ savedAt, sessions }`; do not add an IndexedDB version migration. Render cached sessions before awaiting network, then save and rerender fresh results if the selected text is unchanged. On network failure retain cached content and show stale/offline state.

- [ ] **Step 4: Invalidate after all local/server session mutations**

Invalidate affected keys after delete/manual-log responses and after successful queued-session upload. When a newly completed local session is already available, merge it into the cached array before sync so history updates immediately.

- [ ] **Step 5: Run frontend verification**

Run: `npm run build && npm run test:offline`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/idb.ts src/lib/speed.ts src/lib/sync.ts src/views/library-view.ts tests/offline-reliability.spec.ts
git commit -m "perf: render reading history from local cache"
```

### Task 9: Full verification, production backup, deployment, and benchmark

**Files:**
- Modify: `docs/operations/systemd-service.md`
- Modify: `docs/engineering-notes.md`

**Interfaces:**
- Consumes all prior tasks.
- Produces operational documentation and measured production results.

- [ ] **Step 1: Run complete local verification**

Run: `npm run build && npm run test:offline`

Run: `cd src-tauri && cargo fmt --check && cargo test --all-targets && cargo build --release --bin server`

Expected: every command exits 0.

- [ ] **Step 2: Document maintenance operations**

Document the 00:05 schedule, startup catch-up, dirty/job tables, `--run-analysis-maintenance`, expected logs, status SQL, and rollback procedure. Record baseline and post-change timing commands without embedding credentials.

- [ ] **Step 3: Commit documentation**

```bash
git add docs/operations/systemd-service.md docs/engineering-notes.md
git commit -m "docs: operate nightly shelf analysis maintenance"
```

- [ ] **Step 4: Create a consistent production database backup**

Stop only long enough to obtain a SQLite-consistent backup, or use SQLite's online `.backup` while the service remains available. Store it under `/home/daniel/backups/chinese-reader/` with a UTC timestamp and verify `PRAGMA integrity_check` on the backup before migration.

- [ ] **Step 5: Build and test in the authoritative Linux checkout**

Run the full Rust/frontend suites on Linux. Build frontend into a temporary directory and the release server binary without replacing production files.

- [ ] **Step 6: Deploy atomically and restart**

Preserve the prior binary and `dist` directory in the timestamped backup directory. Atomically replace them, restart `chinese-reader.service`, and verify `/health`, PID/start timestamp, schema tables/index, and scheduler startup log.

- [ ] **Step 7: Benchmark the measured paths**

Measure repeated server-local and Mac-to-server timings for Han lookup, pinyin lookup, shelf tree, text body, cached analysis status, vocabulary cache with gzip/ETag, and reading history. Confirm ordinary shelf/text navigation makes neither analysis nor vocab-cache requests.

- [ ] **Step 8: Perform Android acceptance checks**

Verify shelf/text/history responsiveness, explicit offline caching, cached dictionary lookup offline, reconnection sync, and old-client retained-asset behavior. Keep the database and deployment backup until these checks pass.

- [ ] **Step 9: Push main after acceptance**

Confirm a clean worktree and that local `main` contains all task commits, then push `main` to `origin`. Verify local HEAD equals `origin/main`.
