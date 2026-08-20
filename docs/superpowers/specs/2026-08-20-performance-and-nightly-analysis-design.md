# Chinese Reader Performance and Nightly Analysis Design

**Date:** 2026-08-20
**Status:** Approved for implementation planning

## Goal

Make ordinary dictionary, shelf, text, and reading-history interactions feel immediate on the local network. Move expensive shelf analysis out of navigation and into durable, conditional nightly maintenance.

## Scope and measured baseline

The production database contains roughly 705,000 dictionary entries, 4,900 texts, and 483 shelves. Current measurements identified these costs:

- Chinese dictionary lookup scans `dictionary_entries` because an indexed exact lookup is combined with `pinyin LIKE`; typical server time is 80–250 ms.
- Shelf-tree construction recursively issues count and child queries for each shelf.
- A large uncached shelf analysis takes about 19 seconds and returns about 1 MB of JSON.
- Opening a text automatically prefetches a vocabulary payload as large as 569 KB even when offline caching was not requested.
- Text reading-history SQL is fast, but every view waits for a network round trip.

This change addresses those paths without changing reading, vocabulary, or dictionary results.

## Nightly shelf-analysis maintenance

### Durable state

Add an `analysis_maintenance` table with a singleton task row containing:

- `task` primary key (`shelf_analysis`)
- `dirty_at`, nullable
- `last_started_at`, nullable
- `last_completed_at`, nullable
- `last_error`, nullable

Add an `analysis_shelf_jobs` table keyed by `shelf_id`, containing `dirty_at`, `requested_at`, `last_completed_at`, and `last_error`.

An analysis-affecting mutation marks the singleton dirty. It also marks relevant already-materialized or explicitly requested shelf analyses dirty:

- Vocabulary/status changes affect every shelf with an existing cache or job.
- Text creation, deletion, movement, reanalysis, and segmentation changes affect the text's shelf and cached/job ancestors.
- Shelf hierarchy changes affect the moved shelf's old and new cached/job ancestor chains.
- Completed, uploaded, manual, or deleted reading sessions mark analysis dirty. Reading history itself does not currently alter shelf-frequency results, but it is included because it is the user's requested activity signal and future analysis fields may depend on it.

Dirtying retains the last successful cached JSON. It does not delete it.

### Scheduler

The server owns a lightweight scheduler using local server time. At 00:05 each day it checks durable maintenance state. It runs only when `dirty_at` is set and predates that night's cutoff. If the daemon was down at the cutoff, startup performs the missed run at the first opportunity.

Jobs run sequentially in a blocking worker with a dedicated SQLite connection. Analysis computation does not acquire the HTTP global write semaphore. Each completed shelf is committed with a short transaction that replaces its cache row and updates its job row. A failure records the error, leaves the old cache intact, and leaves the task dirty for the next nightly attempt. One failed shelf does not prevent later shelf jobs from running.

Only shelves that have previously produced a cache or have been explicitly requested are refreshed. The daemon does not proactively generate analyses for all 483 shelves.

When every eligible job succeeds, the singleton dirty marker is cleared and `last_completed_at` is recorded. Mutations arriving during a run have a later `dirty_at` and remain pending for the next night.

### API and UI behavior

Ordinary shelf navigation never requests analysis.

Opening the shelf-analysis details asks for cached state only:

- Fresh or stale cache present: return it immediately, including `cached_at` and `is_stale` metadata.
- No cache present: create/update the shelf job and return `pending`; the UI explains that analysis will be prepared during nightly maintenance.
- Failed last attempt: continue returning the last good cache when available and expose a compact failure status.

The API never computes shelf analysis in a request handler. `get_shelf_analysis` is therefore removed from the write-command classification. A manual maintenance command remains available for tests and explicit administration, but is not exposed as a normal browser action.

## Dictionary lookup

Classify queries by content:

- Queries containing Han characters use only indexed exact matches on `traditional` and `simplified`.
- Latin/pinyin queries use a prefix lookup on a `pinyin COLLATE NOCASE` index added by migration.
- Mixed/unsupported input uses the exact indexed path first and the pinyin path only when applicable.

Definitions and examples retain their existing indexed entry-ID lookups and result limits. Tests assert both result equivalence and `EXPLAIN QUERY PLAN` index use so a full scan cannot silently return.

## Shelf tree and text listing

Load all shelves once, load direct text and unread counts with grouped queries, then assemble and roll up the hierarchy in Rust. Shelf-tree cost becomes a fixed small number of SQL statements rather than queries proportional to shelf count.

Text listing retains its summary-only response. Existing shelf and analysis indexes are verified in migrations/tests.

## Text vocabulary cache

Opening an online text no longer calls `/api/texts/:id/vocab-cache`. The vocabulary bundle is generated only when the user explicitly chooses “Cache for Offline,” or when repairing an incomplete offline bundle. Existing service-worker and IndexedDB storage semantics remain unchanged.

The endpoint gains `ETag` support based on the text analysis/cache version. A matching `If-None-Match` returns `304`. HTTP response compression is enabled for JSON responses, including vocabulary and analysis payloads.

## Reading history

Store the most recently received per-text reading history in IndexedDB. The history view renders cached data immediately, then refreshes from the server in the background while online. Successful session creation, completion, synchronization, manual logging, or deletion updates or invalidates the affected local history entry so the next rendering cannot remain stale.

When no cached value exists, the current loading state remains until the first network response. Offline mode displays cached history with an offline/stale indicator.

## Observability

Log requests whose total handler time exceeds 250 ms. Each line includes command/path, connection-pool wait, write-lane wait where applicable, blocking execution time, response serialization time where measurable, and total duration. Nightly maintenance logs its cutoff, number of jobs, per-shelf duration, output size, success/failure count, and final dirty state. Logs contain IDs and timings but no text content or dictionary queries.

## Correctness and concurrency

- SQLite remains in WAL mode.
- HTTP database work stays inside `spawn_blocking`.
- The write semaphore protects user-facing multi-step writes, but never long analysis computation.
- Cache publication uses a short transaction and old cache data remains readable until replacement commits.
- A scheduler run observes a fixed cutoff timestamp. New dirty events after that cutoff cannot be cleared by the running job.
- Nightly work must not delay health checks, dictionary lookup, text reads, shelf reads, or history reads.

## Testing

Rust tests cover migrations, durable dirty/cutoff semantics, catch-up scheduling, mutation marking, partial failures, stale-cache reads, short cache publication, indexed lookup plans, and constant-query shelf-tree construction. Scheduler timing is tested through an injected clock; tests do not wait for wall-clock midnight.

TypeScript tests cover no analysis request during shelf navigation, lazy analysis status behavior, no vocabulary prefetch during text opening, explicit offline bundle generation, and stale-while-revalidate reading history.

Integration tests run a maintenance cycle against a temporary SQLite database while concurrent lookups and history reads continue. Existing Rust, frontend, service-worker, and browser tests must pass. Deployment verification measures the same production endpoints used for the baseline and confirms the daemon's nightly status in logs.

## Deployment and rollback

Back up the production database before applying the schema migration. Build and test on the Linux host, deploy frontend assets atomically, then restart the daemon so the scheduler and migrations activate. Verify health, migration tables, lookup plans, shelf/tree timings, text opening, history behavior, and Android offline caching.

Rollback restores the previous binary/frontend. The new maintenance tables and pinyin index are additive and can remain safely in the database; the pre-deployment database backup is retained until production and Android checks pass.
