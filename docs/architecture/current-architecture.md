# Chinese Reader Architecture

## Overview

Chinese Reader is a local-first reading and vocabulary tool for Chinese texts.
It is currently organized as:

- A TypeScript/Vite browser UI in `src/`.
- A Rust library crate in `src-tauri/src/` for dictionary lookup, library
  management, text analysis, speed tracking, and SQLite schema management.
- A standalone Axum HTTP server in `src-tauri/src/bin/server.rs`.
- Import and maintenance scripts in `scripts/`.

The current runtime direction is browser/PWA plus local Linux HTTP server. The
Rust crate name still lives under `src-tauri/`, but the active server path does
not require a Tauri desktop shell.

## Runtime Shape

```text
Browser or installed PWA
  |
  | same-origin fetch()
  v
Axum server: src-tauri/src/bin/server.rs
  |
  | pooled rusqlite connections, WAL mode
  v
SQLite database
```

The server serves `dist/` static files and exposes API routes under `/api`.
Most frontend calls go through `POST /api/invoke/:command`, which dispatches to
the same Rust library functions used by the rest of the backend. A few PWA and
offline-focused routes are explicit REST endpoints:

- `GET /api/texts/:id`
- `GET /api/texts/:id/vocab-cache`
- `POST /api/sync/sessions`

The server opens a small SQLite connection pool and enables WAL/busy timeout so
read-heavy UI work can run concurrently while SQLite still serializes writes.

## Frontend Structure

Important frontend files:

- `src/main.ts` builds the app shell, registers the service worker, sets up tab
  navigation, and flushes pending sessions on startup and `online`.
- `src/lib/api.ts` wraps HTTP calls and emulates Tauri-style `invoke()` command
  calls by converting camelCase arguments to snake_case JSON.
- `src/lib/library.ts`, `src/lib/dictionary.ts`, `src/lib/speed.ts`, and
  `src/lib/learning.ts` are typed API modules.
- `src/lib/idb.ts` owns IndexedDB stores for offline vocab, navigation cache,
  text metadata, reading sessions, and vocabulary queue entries.
- `src/lib/sync.ts` uploads completed local sessions to the server.
- `src/sw.ts` implements the service worker.
- `src/views/*` contain view-level DOM rendering and event binding.

The UI is mostly direct DOM string rendering rather than a component framework.
Shared mutable state lives in `src/state.ts`.

## Backend Structure

Important backend modules:

- `dictionary/schema.rs` owns SQLite schema creation and migrations.
- `dictionary/lookup.rs`, `dictionary/user.rs`, and `dictionary/sources/*`
  implement dictionary search, user dictionaries, and parsers/importers.
- `library/shelf.rs` manages hierarchical shelves, text counts, and unread
  counts.
- `library/text.rs` creates, imports, splits, searches, and deletes texts.
- `library/analysis.rs` performs jieba segmentation, frequency analysis,
  shelf-analysis caching, prestudy/context helpers, and per-text vocab-cache
  generation.
- `library/known_words.rs` manages known/learning vocabulary.
- `library/speed.rs` manages reading sessions, manual offline logs, speed
  statistics, and client-uploaded completed sessions.
- `library/settings.rs` stores app-level settings such as auto-mark behavior.

Schema migrations currently run during `dictionary::init_connection()`, which
the server calls at startup.

## Data Model Highlights

Core tables include:

- `shelves`: hierarchical library organization.
- `texts`: imported/pasted Chinese text content and metadata.
- `text_analyses`, `text_character_freq`, `text_word_freq`: cached per-text
  analysis outputs.
- `shelf_analyses_cache`: JSON cache for aggregate shelf analysis.
- `known_words`: user vocabulary with `known` and `learning` statuses.
- `reading_sessions`: completed and historical reading records, including
  manual logs and client-uploaded sessions.
- `dictionary_entries` plus definitions/example/character tables.
- `user_dictionaries` and user dictionary entries.
- `user_segmentation_words`: custom words loaded into jieba at server startup.

Text analysis treats `learning` words as not known. Only `known` contributes to
known-character and known-word rates.

## Offline And Caching

There are two client-side caching layers:

- The service worker uses cache-first for the shell and `/api/texts/*` requests,
  and network-first with cache fallback for other `/api/*` GET requests.
- IndexedDB stores structured data that the UI needs offline.

IndexedDB stores:

- `vocab_cache`: dictionary entries keyed by term.
- `sessions`: local reading sessions keyed by `local_id`.
- `vocab_queue`: vocabulary changes intended for offline sync.
- `text_meta`: reserved for text cache metadata.
- `nav_cache`: shelf tree, shelf text lists, and shelf-analysis snapshots.

The "Cache for Offline" button walks the selected shelf and descendants, caches
navigation data, shelf analysis, text content, and per-text vocab caches.

Reading sessions are client-first: starting a session writes to IndexedDB,
finishing marks it `completed_pending_upload`, and sync uploads to
`POST /api/sync/sessions`. The server makes the upload idempotent with
`reading_sessions.client_local_id`.

Vocabulary queue support exists in IndexedDB, but there is no complete
server-side `/api/sync/vocab-changes` route wired in the current implementation.
Many vocabulary UI actions still call server commands directly.

## Import Flow

Dictionary data is downloaded with `scripts/download-dictionaries.js` and
loaded through the Rust `import` binary.

Content import is mostly script-driven:

- `scripts/import_pdf.py`
- `scripts/import_ebook.py`
- `scripts/import_bofm.py`
- Several domain-specific import scripts.

The browser app can create and edit texts, but filesystem-oriented bulk import
commands are intentionally kept out of the HTTP browser API.

## Deployment

Typical Linux deployment:

1. Build frontend with `npm run build`.
2. Build server with `cd src-tauri && cargo build --release`.
3. Run `src-tauri/target/release/server --db-path ... --dist dist`.
4. Optionally pass `--cert` and `--key` to serve HTTPS.

Service-worker/PWA behavior requires HTTPS except on localhost. For LAN use,
the project already supports mkcert-generated certs through the server's
`--cert` and `--key` flags.
