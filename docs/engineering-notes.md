# Engineering Notes And Concerns

This document records current implementation concerns found during the repo
review. It is not a bug list for a release; it is a map of places to tighten
before relying on the app across devices.

## Offline Sync Is Partial

Reading-session upload exists end to end:

- Client sessions are stored in IndexedDB.
- Completed sessions become `completed_pending_upload`.
- `src/lib/sync.ts` posts to `/api/sync/sessions`.
- The server inserts idempotently by `client_local_id`.

Vocabulary-change sync is not complete:

- `src/lib/idb.ts` has a `vocab_queue` store and helpers.
- The Phase 3 plan calls for `/api/sync/vocab-changes`.
- The current server only exposes `/api/sync/sessions`.
- Many vocabulary actions still call server commands directly.

This means offline reading can queue session completion, but offline vocabulary
changes are not yet a full reliable workflow.

## Service Worker Cache Invalidation Is Coarse

`src/sw.ts` uses fixed cache names:

- `shell-v1`
- `api-v1`
- `text-v1`

Text content and vocab cache entries are cache-first and effectively permanent
until the cache version changes. Text edits, dictionary imports, vocabulary
changes, and re-analysis do not currently produce per-text cache busting.

Recommendation: add text/version metadata and include it in cache keys, or add
an explicit "refresh offline cache" path that deletes stale text/vocab entries.

## Offline Dictionary Cache Is Term-Keyed, Not Text-Keyed

`src/lib/idb.ts` stores `vocab_cache` entries by `term`. This is simple and
useful, but it means:

- Later text caches overwrite/merge by term without source text metadata.
- There is no way to evict vocab cache entries for only one text.
- Simplified lookup misses are expected because backend entries are keyed by
  traditional form.

If storage grows or per-text invalidation matters, store `text_id + term` or add
a join store that maps text IDs to terms.

## Client Session Snapshots Differ From The Original Plan

The design spec says the client computes a complete session record, including
known-count snapshots and text-known percentages. The current upload path only
sends:

- `local_id`
- `text_id`
- `started_at_ms`
- `finished_at_ms`

The server computes vocabulary snapshots at upload time. That is simpler, but
it can differ from the actual start-time state if vocabulary changes while the
device is offline.

This may be acceptable for short offline windows. If not, extend
`UploadSession` and `src/lib/sync.ts` to send the client snapshots already
available on `LocalSession`.

## API Shape Is Transitional

The frontend emulates Tauri `invoke()` over HTTP with:

```text
POST /api/invoke/:command
```

That kept the migration small, but it centralizes route behavior in a large
`dispatch_sync` match and makes API discoverability weaker. Explicit routes
exist only for PWA/offline needs.

Recommendation: keep `invoke` for compatibility, but move stable browser APIs
toward typed REST handlers as they settle.

## UI State And Rendering Are Fragile At Scale

The frontend is direct DOM rendering with shared mutable state in `src/state.ts`.
This works for the current app, but complex flows such as reading sessions,
offline cache status, dictionary sidebars, and shelf analysis all share one
large `library-view.ts` file.

Risks:

- Event handlers are rebound after full `innerHTML` replacement.
- Long view files make regression review harder.
- Abort/caching/session state can become inconsistent across fast navigation.

Recommendation: split `library-view.ts` into focused modules before adding more
offline controls.

## Shelf Analysis Is Deferred And Durable

Shelf analysis no longer runs during shelf navigation or deletes the last good
cache when related data changes. Mutations atomically mark affected cached or
requested shelf jobs dirty. Global vocabulary changes intentionally mark all
existing analysis jobs; text-local changes mark the text's cached/requested
shelf ancestors.

The daemon processes jobs sequentially at 00:05 local time, catches up at
startup, and preserves post-cutoff dirtiness for the next run. Computation uses
a dedicated SQLite connection, while each result is published in a short
transaction. A failed rebuild retains the previous cache and records its error.
See `docs/operations/systemd-service.md` for status queries and manual operation.

Operational caveat: a shelf that has never requested analysis has no job and is
not proactively computed. Opening its analysis UI creates the durable request;
the UI reports it pending until maintenance produces the first cache.

## Performance Baseline And Release Checks

Before the nightly-analysis performance release, measured symptoms included a
full dictionary-table scan for mixed exact/pinyin lookup, recursive shelf-tree
N+1 queries, automatic full vocabulary-cache fetches when opening a text, and
on-demand shelf analysis taking many seconds for a large shelf. Reading-history
SQL itself was generally fast, but every view waited on a fresh network result.

The release separates indexed Han and pinyin lookup paths, bulk-loads the shelf
tree, makes vocabulary caching explicit, serves only cached analysis status,
and renders cached reading history before refreshing it. Deployment acceptance
must capture repeated server-local and client-to-server timings for Han/pinyin
lookup, shelf tree, text body, analysis status, compressed vocabulary cache,
and reading history. It must also verify via browser networking that ordinary
navigation triggers neither analysis nor vocabulary-cache requests.

## Concurrency Model Is Mostly Good, With Boundaries

The Axum server uses a fixed SQLite connection pool, WAL mode, and
`spawn_blocking` for synchronous rusqlite work. That is a reasonable local
server model.

Watch points:

- Some library functions use global jieba state behind a `Mutex`.
- `load_user_segmentation_words` runs once at server startup; adding custom
  segmentation words later may require reload or explicit runtime insertion.
- Bulk import paths that need `&mut Connection` are intentionally not available
  through browser HTTP.

## Security Posture Is Local-Network Trust

The server binds to `0.0.0.0` and CORS allows any origin. The design spec says
there is no authentication and this is intended for a trusted home network.

That is coherent for a personal LAN tool, but important to preserve as an
explicit deployment assumption. If exposed beyond a trusted LAN, add
authentication, tighter CORS, CSRF protection for write routes, and TLS.

## Documentation Drift

The project has several implementation plans under `docs/superpowers/plans/`.
They are useful history, but some tasks describe intended behavior that is only
partially implemented. Prefer `docs/architecture/current-architecture.md` for
current state and use the plan files as design background.
# Offline reliability handoff (2026-08-08)

The observed update failure was consistent with shell release metadata being removed during activation: the content cache and metadata cache shared the `shell-release-` cleanup prefix. The worker now uses a disjoint content-cache namespace, stages and verifies critical build assets before readiness, selects a verified release before cleanup, and retains older ready releases.

Production headers observed before deployment on `chasmfiend.local`:

| Path | Content-Type | Cache-Control |
| --- | --- | --- |
| `/sw.js` | `text/javascript` | absent |
| `/index.html` | `text/html` | absent |
| `/assets/main-BIQSKHwV.js` | `text/javascript` | absent |

The server header policy test verifies the post-change values: `no-cache` for `/sw.js` and HTML/SPA fallback responses, and `public, max-age=31536000, immutable` for `/assets/*`. Capture deployed headers again after explicit deployment approval.

Automated browser coverage now contains 19 passing production-build cases: verified readiness; cold offline and query launch; connection refusal and a hung navigation bounded to two seconds; optional icon failure; no service-worker caching for text APIs; copyable recovery diagnostics; IndexedDB-first text opening without `/api/texts/:id`; partial and interrupted bundle handling; failed-text identification; bad, interrupted, mixed, and corrupted release rejection/fallback; cleanup safety; retry preservation of IndexedDB; eviction recovery; diagnostic HTML fallback; offline API failure; and storage-persistence reporting. Physical Android force-stop, reboot, and real deployment interruption acceptance remain manual gates and must not be reported as passed until run on the original device.

Storage limitations remain: uninstalling the PWA, clearing site data, or browser/OS eviction can remove shell caches and downloaded text bundles. The app requests persistent storage after a completed shelf download and reports the browser decision, but persistence is not an absolute guarantee.
