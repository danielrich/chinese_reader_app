# Chinese Reader

A local-first Chinese reading and vocabulary app. The current app is a Vite
browser frontend served by a Rust/Axum backend with SQLite storage. It supports
dictionary lookup, hierarchical text shelves, text analysis, known/learning
vocabulary tracking, reading-speed history, manual offline read logs, and early
PWA/offline reading support.

## Current Architecture

```text
Browser or installed PWA
  -> Axum HTTP server in src-tauri/src/bin/server.rs
  -> SQLite database
```

The Rust crate still lives under `src-tauri/`, but the main runtime path is now
the standalone HTTP server. The frontend uses `fetch()` against the same origin;
most calls go through a Tauri-compatible `/api/invoke/:command` wrapper, with a
few explicit PWA routes for text content, vocab cache, and session sync.

More detail:

- [Current architecture](docs/architecture/current-architecture.md)
- [Engineering notes and concerns](docs/engineering-notes.md)
- [AppArmor/bubblewrap sandbox note](docs/operations/apparmor-bwrap-sandbox.md)
- [Cross-device design spec](docs/superpowers/specs/2026-04-25-cross-device-reader-design.md)

## Features

- Multi-source Chinese dictionary lookup.
- User dictionaries for book/domain-specific terms.
- Hierarchical shelves and text library management.
- Jieba-based text segmentation and character/word frequency analysis.
- Known and learning vocabulary states.
- Shelf aggregate analysis and unread-count badges.
- Reading sessions, speed statistics, and reading history.
- Manual offline read logging for physical books or other reading surfaces.
- Linux HTTP server for browser access from other devices.
- PWA manifest, service worker, IndexedDB caches, and queued session upload.

Offline support is still in progress. Text/nav/vocab caching and session upload
exist; offline vocabulary-change sync is not yet fully wired end to end.

## Repository Layout

```text
src/                         TypeScript frontend
src/views/                   DOM-rendered app views
src/lib/                     API clients, IndexedDB, sync helpers
src/sw.ts                    Service worker
public/                      PWA manifest and icons
src-tauri/src/bin/server.rs  Axum HTTP server
src-tauri/src/bin/import.rs  Dictionary import binary
src-tauri/src/dictionary/    Dictionary schema, lookup, import sources
src-tauri/src/library/       Shelves, texts, analysis, vocab, speed tracking
scripts/                     Import/download/maintenance scripts
docs/                        Architecture, operations, and implementation plans
```

## Prerequisites

- Node.js 18+
- Rust 1.77+
- `uv` for Python import scripts
- Optional: `mkcert` for trusted LAN HTTPS
- Optional: Calibre for AZW3 ebook imports

## Setup

Install frontend dependencies:

```bash
npm install
```

Download dictionary source data:

```bash
node scripts/download-dictionaries.js --all
```

Import dictionaries into SQLite:

```bash
cd src-tauri
cargo run --bin import
```

The default Linux app database path is:

```text
~/.local/share/com.chinesereader.ChineseReader/dictionary.db
```

## Development

Run the frontend dev server:

```bash
npm run dev
```

Build the frontend:

```bash
npm run build
```

Run the Rust server against the built frontend:

```bash
cd src-tauri
cargo run --bin server -- \
  --db-path "$HOME/.local/share/com.chinesereader.ChineseReader/dictionary.db" \
  --dist ../dist \
  --port 3000
```

Run Rust tests:

```bash
cd src-tauri
cargo test --lib
```

## Linux Service

Build and install the systemd service:

```bash
cd src-tauri && cargo build --release && cd ..
npm run build
sudo bash scripts/install-service.sh
```

Manage the service:

```bash
sudo systemctl status chinese-reader
sudo systemctl restart chinese-reader
sudo journalctl -u chinese-reader -f
```

For PWA/offline use from Android or another LAN device, serve over HTTPS.
The server supports mkcert-generated certificates:

```bash
mkcert chasmfiend.local

src-tauri/target/release/server \
  --db-path "$HOME/.local/share/com.chinesereader.ChineseReader/dictionary.db" \
  --dist dist \
  --cert chasmfiend.local.pem \
  --key chasmfiend.local-key.pem
```

## Importing Texts

The `scripts/` directory contains importers for PDFs, ebooks, and several
domain-specific sources. Most scripts need a parent shelf ID:

```bash
sqlite3 ~/.local/share/com.chinesereader.ChineseReader/dictionary.db \
  "SELECT id, name FROM shelves;"
```

EPUB/AZW3:

```bash
cd scripts
uv run python import_ebook.py /path/to/book.epub <parent_shelf_id> --dry-run
uv run python import_ebook.py /path/to/book.epub <parent_shelf_id>
```

PDF:

```bash
cd scripts
uv run python import_pdf.py /path/to/book.pdf <parent_shelf_id> --dry-run
uv run python import_pdf.py /path/to/book.pdf <parent_shelf_id>
```

Chinese Book of Mormon:

```bash
cd scripts
uv run python import_bofm.py <parent_shelf_id> --dry-run
uv run python import_bofm.py <parent_shelf_id>
```

See [scripts/README.md](scripts/README.md) for script details.

## Dictionary Sources

Supported sources include:

- CC-CEDICT
- MOE Dict
- Kangxi Dictionary data
- Word frequency data
- HanDeDict-derived data
- MakeMeaHanzi character data
- User dictionaries

## Offline/PWA Notes

- `src/sw.ts` caches the app shell and text/vocab API responses.
- `src/lib/idb.ts` stores navigation cache, per-term vocab cache, local
  sessions, and a vocabulary queue.
- `src/lib/sync.ts` uploads completed local sessions to `/api/sync/sessions`.
- The "Cache for Offline" shelf action walks descendant shelves and caches
  shelf lists, analysis, text content, and vocab entries.

Current gap: vocabulary-change queueing exists in IndexedDB, but the server
does not yet expose a complete vocab-change sync endpoint.

## License

MIT
