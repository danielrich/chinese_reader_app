# Phase 3: PWA + Offline Reading + Offline Session Sync

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Chinese Reader web app into an installable PWA with full offline reading on Android (and Mac), and queue session/vocab writes locally when offline so they sync to the Linux server when reconnected.

**Architecture:** A standard Vite-built service worker registers from the static frontend, served by the existing Axum HTTP server. The service worker uses cache-first for shell + per-text content, network-first for shelf/library structure. Per-text "vocab cache" (every dictionary entry needed for that text) is fetched from a new REST endpoint and stored in IndexedDB on first text load. Reading sessions and vocabulary changes write to IndexedDB first; a Background Sync registration drains the queue to the server when the device is online. Linux DB remains the single source of truth; client never reads stale write-queue items as authoritative.

**Tech Stack:** TypeScript, Vite (built-in service worker bundling via `import.meta.glob` / explicit entry), native IndexedDB API (no library), Background Sync API (with manual-trigger fallback for browsers that lack it), Rust/Axum for the new REST endpoints.

**Priority:** Android offline reading first. Tasks 1–5 produce a working offline reader (read-only). Tasks 6–9 add offline writes + sync. Task 10 is mobile polish.

---

## File Structure

**Created:**
- `public/manifest.webmanifest` — PWA manifest (name, icons, display, theme)
- `public/icon-192.png`, `public/icon-512.png`, `public/icon-maskable-512.png` — PWA icons
- `public/apple-touch-icon.png` — 180x180 for iOS home screen
- `src/sw.ts` — service worker source (Vite builds to `dist/sw.js`)
- `src/lib/idb.ts` — IndexedDB wrapper module
- `src/lib/sync.ts` — sync queue helpers + flush logic
- `vite.config.ts` — explicit config to emit `sw.js` to dist root

**Modified:**
- `index.html` — link manifest, add theme-color and apple-touch-icon meta tags
- `src/main.ts` — register service worker on load
- `src/lib/api.ts` — add cache-aware fetch helpers for text + vocab-cache endpoints
- `src/lib/speed.ts` — route start/finish session through IDB
- `src/lib/library.ts` — route known_word changes through IDB queue
- `src/views/library-view.ts` — show timer from `Date.now() - started_at`, show offline indicator when queue non-empty
- `src-tauri/src/bin/server.rs` — add REST routes: `GET /api/texts/:id`, `GET /api/texts/:id/vocab-cache`, `POST /api/sync/vocab-changes`, `POST /api/sync/sessions`
- `src-tauri/src/library/analysis.rs` — `get_text_vocab_cache(conn, text_id)` function
- `src-tauri/src/library/known_words.rs` — `apply_vocab_changes_batch(conn, changes)` with `last_write_wins` semantics by `changed_at`
- `src-tauri/src/library/speed.rs` — `upload_completed_session(conn, session)` accepting a fully-formed client session

---

## Pre-flight: Decide PWA scope routing

The PWA serves at the same origin as the API (Linux server, port 3000). Service worker scope = `/`. No subpaths needed.

For the rest of this plan, `<linux-ip>` means the IP/hostname your devices use today (e.g. `192.168.1.50` or `chinese.local`). The PWA will just be installed from `http://<linux-ip>:3000/`.

⚠️ **HTTP-only caveat:** Service workers normally require HTTPS, but Chrome makes one exception: `localhost`. They **also** work over plain HTTP if the host is `127.0.0.1`, but **not** for arbitrary LAN IPs over plain HTTP. Phase 3 acceptance test will confirm this for your specific home network. If your Android Chrome refuses to register the SW over plain HTTP, you have three options:
1. Use a reverse proxy with a self-signed cert (`mkcert` + nginx).
2. Bind the server's address to a `*.local.host` style domain that Chrome treats as secure.
3. Set up Chrome flag `chrome://flags/#unsafely-treat-insecure-origin-as-secure` per device — workable for personal-use only.

This is documented as a discovery step in Task 2; we won't pre-solve it.

---

## Task 1: PWA Manifest + Icons

**Files:**
- Create: `public/manifest.webmanifest`
- Create: `public/icon-192.png`, `public/icon-512.png`, `public/icon-maskable-512.png`, `public/apple-touch-icon.png`
- Modify: `index.html`

- [ ] **Step 1: Generate icons**

The simplest approach is to make a single 512x512 source PNG with the app name/glyph (e.g. a stylized 漢 / 字), then derive the smaller sizes. Recommended: ImageMagick. Source SVG can also work, but PWA needs PNG.

If you don't have a source icon yet, generate a placeholder with the character 字 on a coloured background:

```bash
sudo apt install -y imagemagick
mkdir -p public

# 512px source (purple background, white character)
convert -size 512x512 xc:'#646cff' \
  -fill white -gravity center -font 'DejaVu-Sans-Bold' -pointsize 360 \
  -annotate +0+10 '字' \
  public/icon-512.png

# 192px
convert public/icon-512.png -resize 192x192 public/icon-192.png

# 180px iOS apple-touch-icon
convert public/icon-512.png -resize 180x180 public/apple-touch-icon.png

# Maskable variant: same image but with 20% safe-zone padding
convert -size 512x512 xc:'#646cff' \
  -fill white -gravity center -font 'DejaVu-Sans-Bold' -pointsize 280 \
  -annotate +0+10 '字' \
  public/icon-maskable-512.png
```

Verify all four PNGs exist:
```bash
ls -la public/icon-*.png public/apple-touch-icon.png
```

- [ ] **Step 2: Create the manifest**

Create `public/manifest.webmanifest`:

```json
{
  "name": "Chinese Reader",
  "short_name": "中文",
  "description": "Chinese reading assistant with vocabulary tracking",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#242424",
  "theme_color": "#646cff",
  "icons": [
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icon-maskable-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ]
}
```

- [ ] **Step 3: Wire it up in index.html**

Open `index.html` and replace the `<head>` block:

```html
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#646cff" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <title>Chinese Reader</title>
  </head>
```

- [ ] **Step 4: Build and verify the manifest is served**

```bash
npm run build
cd /home/daniel/exper/chinese_reader_app
src-tauri/target/release/server \
  --db-path "$HOME/.local/share/com.chinesereader.ChineseReader/dictionary.db" \
  --dist dist --port 3000 &
SERVER_PID=$!
sleep 2
curl -s http://localhost:3000/manifest.webmanifest | head -5
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/icon-192.png
kill $SERVER_PID
```

Expected: manifest JSON, `200` for icon-192.png.

- [ ] **Step 5: Smoke-test installability in Chrome**

Open Chrome → `http://<linux-ip>:3000` → DevTools → Application → Manifest. Confirm "Installable" with no errors. Try the install button (⊕ in address bar on desktop, "Add to Home Screen" on Android).

- [ ] **Step 6: Commit**

```bash
git add public/ index.html
git commit -m "feat(pwa): add manifest, icons, and theme-color meta"
```

---

## Task 2: Service Worker — Shell Cache + Network-First API

**Files:**
- Create: `src/sw.ts`
- Modify: `vite.config.ts` (create if doesn't exist)
- Modify: `src/main.ts`

- [ ] **Step 1: Verify Vite config exists; create if missing**

```bash
ls /home/daniel/exper/chinese_reader_app/vite.config.* 2>&1
```

If no config: create `vite.config.ts` with:

```typescript
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        sw: "src/sw.ts",
      },
      output: {
        entryFileNames: (chunk) => {
          return chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js";
        },
      },
    },
  },
});
```

If it already exists, merge the `rollupOptions` block in.

- [ ] **Step 2: Create the service worker**

Create `src/sw.ts`:

```typescript
/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

const SHELL_CACHE = "shell-v1";
const API_CACHE = "api-v1";

const SHELL_FILES = ["/", "/index.html", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => ![SHELL_CACHE, API_CACHE].includes(k)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Same-origin only
  if (url.origin !== self.location.origin) return;

  // API: network-first, cache fallback
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Shell + assets: cache-first
  event.respondWith(cacheFirst(event.request));
});

async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok && request.method === "GET") {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Last resort: return cached index.html for SPA navigations
    if (request.mode === "navigate") {
      const fallback = await cache.match("/index.html");
      if (fallback) return fallback;
    }
    throw err;
  }
}

async function networkFirst(request: Request): Promise<Response> {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && request.method === "GET") {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}
```

- [ ] **Step 3: Register the service worker from the app**

Open `src/main.ts` and append (after the existing setup):

```typescript
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => console.log("SW registered:", reg.scope))
      .catch((err) => console.warn("SW registration failed:", err));
  });
}
```

- [ ] **Step 4: Build and verify the SW emits to dist root**

```bash
npm run build
ls -la dist/sw.js dist/manifest.webmanifest dist/icon-*.png
```

Expected: `dist/sw.js` exists at the root (not under `dist/assets/`).

- [ ] **Step 5: Smoke-test SW registration**

Restart the server, hit the page from a fresh-incognito window, then in DevTools → Application → Service Workers, confirm `sw.js` is "activated and running".

⚠️ **If the SW fails to register on Android over LAN HTTP**, log the exact error from Chrome's DevTools (`chrome://inspect` from your Mac to see the Android console). This is the HTTPS gotcha called out in Pre-flight. If it happens:

```bash
# Option A: use the reverse-proxy + mkcert path
sudo apt install -y mkcert nginx
mkcert -install
mkcert <linux-ip> chinese.local localhost 127.0.0.1
# Then configure nginx to proxy 443→localhost:3000 with the cert
```

Document the chosen workaround as a comment in `src/sw.ts` and continue.

- [ ] **Step 6: Test offline shell load**

With the SW active, in DevTools → Network → check "Offline", then refresh. The library page should still load. Click around — anything that isn't cached yet (API calls, untouched routes) will fail loudly. That's expected for now; Task 4 fixes per-text caching.

- [ ] **Step 7: Commit**

```bash
git add src/sw.ts vite.config.ts src/main.ts
git commit -m "feat(pwa): service worker with shell cache and network-first API"
```

---

## Task 3: Vocab-Cache REST Endpoint

**Files:**
- Modify: `src-tauri/src/library/analysis.rs`
- Modify: `src-tauri/src/library/mod.rs`
- Modify: `src-tauri/src/bin/server.rs`

- [ ] **Step 1: Define the response type**

Open `src-tauri/src/library/analysis.rs`. After the existing imports and types, add:

```rust
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct TextVocabCache {
    pub text_id: i64,
    pub words: Vec<VocabCacheEntry>,
    pub characters: Vec<VocabCacheEntry>,
}

#[derive(Debug, Serialize)]
pub struct VocabCacheEntry {
    pub term: String,
    pub pinyin: Option<String>,
    pub definitions: Vec<String>,
    pub source: String,
}
```

- [ ] **Step 2: Add the function**

In the same file, add (place after `get_word_context_all`):

```rust
/// Build the per-text vocabulary cache: every distinct word and character
/// that appears in the given text, with all dictionary entries currently
/// in the DB. This is what the PWA caches client-side for offline lookups.
pub fn get_text_vocab_cache(conn: &Connection, text_id: i64) -> Result<TextVocabCache> {
    // Distinct words used in this text
    let mut word_stmt = conn.prepare(
        "SELECT DISTINCT word FROM text_word_freq WHERE text_id = ?",
    )?;
    let words_in_text: Vec<String> = word_stmt
        .query_map([text_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;

    // Distinct characters used in this text
    let mut char_stmt = conn.prepare(
        "SELECT DISTINCT character FROM text_character_freq WHERE text_id = ?",
    )?;
    let chars_in_text: Vec<String> = char_stmt
        .query_map([text_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;

    let words = build_vocab_entries(conn, &words_in_text)?;
    let characters = build_vocab_entries(conn, &chars_in_text)?;

    Ok(TextVocabCache { text_id, words, characters })
}

fn build_vocab_entries(conn: &Connection, terms: &[String]) -> Result<Vec<VocabCacheEntry>> {
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = terms.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT traditional, pinyin, definition, source
         FROM dictionary_entries
         WHERE traditional IN ({})
         ORDER BY traditional, source",
        placeholders,
    );
    let params: Vec<&dyn rusqlite::ToSql> =
        terms.iter().map(|s| s as &dyn rusqlite::ToSql).collect();

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok((
            row.get::<_, String>(0)?,        // traditional
            row.get::<_, Option<String>>(1)?, // pinyin
            row.get::<_, String>(2)?,        // definition
            row.get::<_, String>(3)?,        // source
        ))
    })?;

    // Group by term so each VocabCacheEntry has all definitions for that term
    use std::collections::HashMap;
    let mut grouped: HashMap<String, VocabCacheEntry> = HashMap::new();
    for row in rows {
        let (term, pinyin, definition, source) = row?;
        let entry = grouped.entry(term.clone()).or_insert_with(|| VocabCacheEntry {
            term: term.clone(),
            pinyin: pinyin.clone(),
            definitions: Vec::new(),
            source: source.clone(),
        });
        entry.definitions.push(definition);
        if entry.pinyin.is_none() {
            entry.pinyin = pinyin;
        }
    }

    // Preserve input ordering
    Ok(terms.iter().filter_map(|t| grouped.remove(t)).collect())
}
```

- [ ] **Step 3: Re-export from library/mod.rs**

In `src-tauri/src/library/mod.rs`, find the `pub use analysis::...` line and add `TextVocabCache` and `VocabCacheEntry` to that re-export, OR just rely on `chinese_reader_lib::library::analysis::TextVocabCache` from the binary. Either is fine; do whichever matches the existing style.

- [ ] **Step 4: Add a unit test**

In the `#[cfg(test)] mod tests` block at the bottom of `src-tauri/src/library/analysis.rs`, add:

```rust
#[test]
fn test_text_vocab_cache_groups_definitions_per_term() {
    let conn = test_db_with_text("我喜歡讀書");
    // (use whatever existing test helper sets up text + dict entries)
    let cache = get_text_vocab_cache(&conn, 1).unwrap();
    assert!(!cache.words.is_empty(), "should have at least one word");
    assert!(!cache.characters.is_empty(), "should have at least one character");
    for entry in &cache.words {
        assert!(!entry.definitions.is_empty(), "every entry has at least one definition");
    }
}
```

If no existing test helper sets up text + dict entries, **skip this test step** — the smoke test in Step 6 covers it. Don't write a from-scratch test fixture; that's a much bigger task.

- [ ] **Step 5: Add the REST route to server.rs**

Open `src-tauri/src/bin/server.rs`. Locate the router builder block (the `let app = Router::new()...` block). Add a new route alongside the existing `/api/invoke/{command}`:

```rust
    let app = Router::new()
        .route("/health", get(health))
        .route("/api/invoke/{command}", post(dispatch))
        .route("/api/texts/{id}/vocab-cache", get(get_text_vocab_cache_handler))
        .fallback_service(serve_static)
        .with_state(db)
        .layer(cors);
```

Then add the handler function (place near `dispatch`):

```rust
use axum::extract::Path as PathExtract;

async fn get_text_vocab_cache_handler(
    State(db): State<Db>,
    PathExtract(id): PathExtract<i64>,
) -> Result<Json<Value>, AppError> {
    let result = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| ApiError::Internal(e.to_string()))?;
        let cache = library::analysis::get_text_vocab_cache(&conn, id).map_err(db_err)?;
        serialize(cache)
    })
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))??;

    Ok(Json(result))
}
```

(`PathExtract` alias is to avoid colliding with `std::path::Path`. If `axum::extract::Path` is already imported, use it directly.)

- [ ] **Step 6: Build, smoke-test**

```bash
source "$HOME/.cargo/env"
cd src-tauri && cargo build --release --bin server
# stop running server, restart it
src-tauri/target/release/server --db-path ... --dist dist --port 3000 &
sleep 2
# Pick any text_id you have, e.g. 1
curl -s http://localhost:3000/api/texts/1/vocab-cache | python3 -m json.tool | head -30
```

Expected: JSON with `text_id`, `words: [...]`, `characters: [...]` and each entry has `term`, `pinyin`, `definitions`, `source`.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/library/analysis.rs src-tauri/src/library/mod.rs src-tauri/src/bin/server.rs
git commit -m "feat(server): add /api/texts/:id/vocab-cache endpoint"
```

---

## Task 4: Per-Text Caching in Service Worker

**Files:**
- Modify: `src/sw.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/lib/library.ts`

The plan: when a text is loaded, the SW caches both the `get_text` POST response and the `/api/texts/:id/vocab-cache` GET response. On subsequent loads (offline or online), reads come from the cache.

POST responses are normally not cached by `caches`, but they can be. We sidestep complexity by switching `get_text` to a GET on a REST URL, mirroring the vocab-cache pattern.

- [ ] **Step 1: Add a REST route for `GET /api/texts/:id`**

In `src-tauri/src/bin/server.rs`, beside the new `/api/texts/{id}/vocab-cache` route, add:

```rust
        .route("/api/texts/{id}", get(get_text_handler))
```

And the handler:

```rust
async fn get_text_handler(
    State(db): State<Db>,
    PathExtract(id): PathExtract<i64>,
) -> Result<Json<Value>, AppError> {
    let result = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| ApiError::Internal(e.to_string()))?;
        let text = library::text::get_text(&conn, id)
            .map_err(db_err)?
            .ok_or_else(|| not_found(format!("Text {} not found", id)))?;
        serialize(text)
    })
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))??;

    Ok(Json(result))
}
```

Rebuild and smoke-test: `curl http://localhost:3000/api/texts/1 | head -c 200`.

- [ ] **Step 2: Update `src/lib/api.ts` to expose a GET helper**

Add to `src/lib/api.ts`:

```typescript
export async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { method: "GET" });
  if (!response.ok) {
    throw new Error(`GET ${path} failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}
```

- [ ] **Step 3: Wire the cache-aware text/vocab fetch**

In `src/lib/library.ts`, find `getText` (uses `invoke("get_text", ...)`) and update it to use the REST endpoint instead so the SW can cache it:

```typescript
export async function getText(id: number): Promise<Text> {
  return fetchJson<Text>(`/api/texts/${id}`);
}
```

Add (in same file):

```typescript
import { fetchJson } from "./api";

export async function getTextVocabCache(textId: number): Promise<TextVocabCache> {
  return fetchJson<TextVocabCache>(`/api/texts/${textId}/vocab-cache`);
}

export interface TextVocabCache {
  text_id: number;
  words: VocabCacheEntry[];
  characters: VocabCacheEntry[];
}

export interface VocabCacheEntry {
  term: string;
  pinyin: string | null;
  definitions: string[];
  source: string;
}
```

- [ ] **Step 4: Trigger vocab-cache fetch on text load**

In `src/views/library-view.ts`, find where a text is loaded for reading (the function that runs when the user clicks a text — look for `getText(textId)` calls). Right after the `getText` call returns successfully, kick off:

```typescript
// Pre-warm the per-text vocab cache (lets SW cache it for offline use)
library.getTextVocabCache(textId).catch((err) =>
  console.warn("vocab-cache prefetch failed:", err),
);
```

This is fire-and-forget. The SW network-first strategy will cache the response.

- [ ] **Step 5: Update SW to also cache the per-text endpoints permanently**

In `src/sw.ts`, change the API caching strategy: for `/api/texts/...` URLs, use cache-first (since text content rarely changes), keep network-first for `/api/invoke/...`.

Replace the fetch handler's API branch with:

```typescript
  if (url.pathname.startsWith("/api/texts/")) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(event.request));
    return;
  }
```

(`cacheFirst` already exists. The `cacheFirst` puts the response in `SHELL_CACHE` — that's wrong semantically; let's create a third cache. Update `cacheFirst` to take a cache name param, or split into two functions.)

Easiest: add a new constant + function:

```typescript
const TEXT_CACHE = "text-v1";

async function cacheFirstText(request: Request): Promise<Response> {
  const cache = await caches.open(TEXT_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && request.method === "GET") {
    cache.put(request, response.clone());
  }
  return response;
}
```

Then update the activate handler's allowlist:

```typescript
keys.filter((k) => ![SHELL_CACHE, API_CACHE, TEXT_CACHE].includes(k)).map((k) => caches.delete(k))
```

And the fetch handler:

```typescript
  if (url.pathname.startsWith("/api/texts/")) {
    event.respondWith(cacheFirstText(event.request));
    return;
  }
```

- [ ] **Step 6: Build, restart server, test**

```bash
npm run build
# (restart server)
# In Chrome: open the app, open a text, watch DevTools → Network. Confirm:
#   - GET /api/texts/1 returns 200 (from server first time)
#   - GET /api/texts/1/vocab-cache returns 200
# Reload — both should show "ServiceWorker" as the source.
# Toggle offline mode — text and lookups should still work for that text.
```

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/bin/server.rs src/sw.ts src/lib/api.ts src/lib/library.ts src/views/library-view.ts
git commit -m "feat(pwa): cache text content + vocab-cache for offline reading"
```

---

## Task 5: Use the Cached Vocab for Offline Lookups

**Files:**
- Create: `src/lib/vocab-cache.ts`
- Modify: `src/lib/dictionary.ts`

Right now, dictionary lookups hit `/api/invoke/dictionary_lookup` over the network. Offline, they fail. Here we add a fallback: if a lookup fails (offline), check IndexedDB for a cached entry from the per-text vocab cache.

- [ ] **Step 1: Create the cache module**

Create `src/lib/vocab-cache.ts`:

```typescript
import type { VocabCacheEntry, TextVocabCache } from "./library";

const DB_NAME = "chinese-reader";
const DB_VERSION = 1;
const STORE = "vocab_cache";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // key: term (string); value: VocabCacheEntry
        db.createObjectStore(STORE, { keyPath: "term" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function ingestTextVocabCache(cache: TextVocabCache): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  for (const e of cache.words) store.put(e);
  for (const e of cache.characters) store.put(e);
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}

export async function lookupOffline(term: string): Promise<VocabCacheEntry | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(term);
    req.onsuccess = () => {
      db.close();
      resolve(req.result ?? null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}
```

- [ ] **Step 2: Plumb the cache into library.ts vocab-cache prefetch**

In `src/lib/library.ts`, the prefetch from Task 4 was fire-and-forget. Update it to also write to IndexedDB:

```typescript
import { ingestTextVocabCache } from "./vocab-cache";

export async function getTextVocabCache(textId: number): Promise<TextVocabCache> {
  const cache = await fetchJson<TextVocabCache>(`/api/texts/${textId}/vocab-cache`);
  // Fire-and-forget: persist for offline lookup
  ingestTextVocabCache(cache).catch((err) =>
    console.warn("ingest vocab-cache failed:", err),
  );
  return cache;
}
```

- [ ] **Step 3: Add an offline-fallback lookup wrapper**

In `src/lib/dictionary.ts`, find the `lookup` function. Wrap its network call in a try/catch that falls back to IndexedDB:

```typescript
import { lookupOffline } from "./vocab-cache";

export async function lookup(query: string, options: LookupOptions): Promise<LookupResult> {
  try {
    return await invoke<LookupResult>("dictionary_lookup", {
      query,
      includeExamples: options.includeExamples ?? false,
      includeCharacterInfo: options.includeCharacterInfo ?? false,
      includeUserDictionaries: options.includeUserDictionaries ?? false,
      sources: options.sources ?? ["cc_cedict", "moe_dict", "kangxi", "user"],
    });
  } catch (err) {
    // Network/server failure — try the local IndexedDB cache built from
    // per-text vocab caches. Graceful degradation only; does NOT cover
    // arbitrary cross-text lookups.
    const cached = await lookupOffline(query);
    if (cached) {
      return {
        query,
        entries: [
          {
            traditional: cached.term,
            simplified: null,
            pinyin: cached.pinyin,
            definition: cached.definitions.join("; "),
            source: cached.source,
          } as any,
        ],
        related: [],
        character_info: null,
        user_entries: [],
      } as LookupResult;
    }
    throw err;
  }
}
```

(The exact `LookupResult` shape may differ — adapt to whatever `dictionary.ts` already exports. The point is: on failure, try the cache; if cache misses, re-throw.)

- [ ] **Step 3.5: Surface offline misses gently in the UI**

Find where `lookup` is called from `library-view.ts` (e.g. `lookupInSidebar`). Wrap the catch:

```typescript
} catch (error) {
  if (!navigator.onLine) {
    sidebarContent.innerHTML = `<p class="dict-sidebar-empty">"${escapeHtml(term)}" is not available offline. Reconnect to look it up.</p>`;
    return;
  }
  sidebarContent.innerHTML = `<p class="error">Lookup failed: ${error}</p>`;
}
```

- [ ] **Step 4: Manual test**

```bash
npm run build
# Restart server
# In Chrome: open the app, open a text (this populates IDB)
# DevTools → Application → IndexedDB → chinese-reader → vocab_cache: confirm entries
# Toggle offline. Click on a word that's in the text — definition appears (from IDB).
# Click on a word that ISN'T in the cached texts — see graceful "not available offline" message.
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/vocab-cache.ts src/lib/library.ts src/lib/dictionary.ts src/views/library-view.ts
git commit -m "feat(pwa): offline vocab lookups via IndexedDB cache"
```

🎉 **Milestone:** With Task 5 done you have a working offline reader on Android. Sessions and vocab changes still need network. Stop here if Task 6+ needs to wait.

---

## Task 6: IndexedDB Sessions + Vocab Queue Schema

**Files:**
- Modify: `src/lib/vocab-cache.ts` (consolidate into `src/lib/idb.ts`) — OR create `src/lib/idb.ts` separately and bump DB version

The existing `src/lib/vocab-cache.ts` opens DB at version 1 with one store. Now we add three more stores. Bump DB version to 2 and add upgrade logic.

- [ ] **Step 1: Move vocab-cache code into a unified idb.ts**

Create `src/lib/idb.ts`:

```typescript
const DB_NAME = "chinese-reader";
const DB_VERSION = 2;

export const STORE_VOCAB_CACHE = "vocab_cache";
export const STORE_SESSIONS = "sessions";
export const STORE_VOCAB_QUEUE = "vocab_queue";
export const STORE_TEXT_META = "text_meta";

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        db.createObjectStore(STORE_VOCAB_CACHE, { keyPath: "term" });
      }
      if (oldVersion < 2) {
        // sessions: keyPath = local_id (uuid). status: "in_progress" | "completed_pending_upload" | "uploaded"
        const sessions = db.createObjectStore(STORE_SESSIONS, { keyPath: "local_id" });
        sessions.createIndex("status", "status");
        sessions.createIndex("text_id", "text_id");

        // vocab_queue: keyPath = auto-incremented id. one row per change.
        const vocabQueue = db.createObjectStore(STORE_VOCAB_QUEUE, {
          keyPath: "id",
          autoIncrement: true,
        });
        vocabQueue.createIndex("status", "status");
        vocabQueue.createIndex("changed_at", "changed_at");

        // text_meta: keyPath = text_id. tracks last_cached_at etc
        db.createObjectStore(STORE_TEXT_META, { keyPath: "text_id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Vocab cache (formerly in vocab-cache.ts) ────────────────────────────
import type { TextVocabCache, VocabCacheEntry } from "./library";

export async function ingestTextVocabCache(cache: TextVocabCache): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_VOCAB_CACHE, "readwrite");
  const store = tx.objectStore(STORE_VOCAB_CACHE);
  for (const e of cache.words) store.put(e);
  for (const e of cache.characters) store.put(e);
  await txDone(tx);
  db.close();
}

export async function lookupOffline(term: string): Promise<VocabCacheEntry | null> {
  const db = await openDb();
  const result = await new Promise<VocabCacheEntry | null>((resolve, reject) => {
    const req = db.transaction(STORE_VOCAB_CACHE, "readonly").objectStore(STORE_VOCAB_CACHE).get(term);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

// ── Session lifecycle ──────────────────────────────────────────────────
export interface LocalSession {
  local_id: string;
  text_id: number;
  started_at: number;        // ms epoch
  finished_at: number | null;
  status: "in_progress" | "completed_pending_upload" | "uploaded";
  // snapshot fields filled at completion
  duration_seconds?: number;
  characters_per_minute?: number;
  known_characters_count?: number;
  text_known_char_percentage?: number;
  auto_marked_characters?: number;
  auto_marked_words?: number;
  source?: "in_app" | "offline";
}

export async function saveSession(session: LocalSession): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_SESSIONS, "readwrite");
  tx.objectStore(STORE_SESSIONS).put(session);
  await txDone(tx);
  db.close();
}

export async function getSession(localId: string): Promise<LocalSession | null> {
  const db = await openDb();
  const result = await new Promise<LocalSession | null>((resolve, reject) => {
    const req = db.transaction(STORE_SESSIONS, "readonly").objectStore(STORE_SESSIONS).get(localId);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

export async function getInProgressSessionForText(textId: number): Promise<LocalSession | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const idx = db.transaction(STORE_SESSIONS, "readonly").objectStore(STORE_SESSIONS).index("text_id");
    const req = idx.openCursor(IDBKeyRange.only(textId));
    req.onsuccess = () => {
      const cursor = req.result;
      while (cursor) {
        if ((cursor.value as LocalSession).status === "in_progress") {
          db.close();
          resolve(cursor.value);
          return;
        }
        cursor.continue();
        return;
      }
      db.close();
      resolve(null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function listPendingSessions(): Promise<LocalSession[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const idx = db.transaction(STORE_SESSIONS, "readonly").objectStore(STORE_SESSIONS).index("status");
    const req = idx.getAll(IDBKeyRange.only("completed_pending_upload"));
    req.onsuccess = () => {
      db.close();
      resolve(req.result as LocalSession[]);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

// ── Vocab queue ─────────────────────────────────────────────────────────
export interface VocabChange {
  id?: number;
  word: string;
  word_type: "word" | "character";
  status: "known" | "learning" | "removed";
  changed_at: number; // ms epoch
  status_in_idb: "pending" | "uploaded";
}

export async function enqueueVocabChange(change: Omit<VocabChange, "id" | "status_in_idb">): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_VOCAB_QUEUE, "readwrite");
  tx.objectStore(STORE_VOCAB_QUEUE).put({ ...change, status_in_idb: "pending" });
  await txDone(tx);
  db.close();
}

export async function listPendingVocabChanges(): Promise<VocabChange[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const idx = db.transaction(STORE_VOCAB_QUEUE, "readonly").objectStore(STORE_VOCAB_QUEUE).index("status");
    const req = idx.getAll(IDBKeyRange.only("pending"));
    req.onsuccess = () => {
      db.close();
      resolve(req.result as VocabChange[]);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function markVocabChangesUploaded(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(STORE_VOCAB_QUEUE, "readwrite");
  const store = tx.objectStore(STORE_VOCAB_QUEUE);
  for (const id of ids) {
    const req = store.get(id);
    await new Promise<void>((res, rej) => {
      req.onsuccess = () => {
        if (req.result) {
          req.result.status_in_idb = "uploaded";
          store.put(req.result);
        }
        res();
      };
      req.onerror = () => rej(req.error);
    });
  }
  await txDone(tx);
  db.close();
}
```

- [ ] **Step 2: Delete old vocab-cache.ts and update imports**

```bash
rm src/lib/vocab-cache.ts
grep -rln "from \"\\./vocab-cache\"" src/
grep -rln "from \"\\.\\./lib/vocab-cache\"" src/
```

Update each file from `from "./vocab-cache"` to `from "./idb"`.

- [ ] **Step 3: Build, manually verify upgrade**

```bash
npm run build
# In Chrome: open the app, DevTools → Application → IndexedDB → chinese-reader.
# Confirm DB version is 2 and the four object stores exist.
# Existing vocab_cache entries should be preserved across the upgrade.
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/idb.ts src/lib/library.ts src/lib/dictionary.ts
git rm src/lib/vocab-cache.ts
git commit -m "feat(pwa): IndexedDB schema for sessions and vocab queue"
```

---

## Task 7: Client-First Session Lifecycle

**Files:**
- Modify: `src/lib/speed.ts`
- Modify: `src/views/library-view.ts`

Replace network-bound `start_reading_session` / `finish_reading_session` with IDB-backed equivalents. The server upload happens in Task 8.

- [ ] **Step 1: Add a uuid helper**

Append to `src/utils.ts`:

```typescript
export function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Fallback for older browsers
  return "uuid-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}
```

- [ ] **Step 2: Rewrite speed.ts session functions**

Open `src/lib/speed.ts`. Replace `startReadingSession` and `finishReadingSession`:

```typescript
import { saveSession, getSession, getInProgressSessionForText, type LocalSession } from "./idb";
import { uuid } from "../utils";

// kept for compatibility with existing call sites
export async function startReadingSession(textId: number): Promise<LocalSession> {
  const existing = await getInProgressSessionForText(textId);
  if (existing) return existing;
  const session: LocalSession = {
    local_id: uuid(),
    text_id: textId,
    started_at: Date.now(),
    finished_at: null,
    status: "in_progress",
    source: "in_app",
  };
  await saveSession(session);
  return session;
}

export async function finishReadingSession(localId: string): Promise<LocalSession> {
  const session = await getSession(localId);
  if (!session) throw new Error(`Session ${localId} not found`);
  if (session.status !== "in_progress") return session;

  const finished_at = Date.now();
  const duration_seconds = Math.round((finished_at - session.started_at) / 1000);
  const completed: LocalSession = {
    ...session,
    finished_at,
    duration_seconds,
    // characters_per_minute filled by caller using known char_count + duration
    status: "completed_pending_upload",
  };
  await saveSession(completed);

  // Trigger sync (Task 8 will register the listener)
  if ("serviceWorker" in navigator && "SyncManager" in window) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await (reg as any).sync.register("sync-sessions");
    } catch {
      // Browser doesn't support BackgroundSync — flush manually next time online
    }
  }

  return completed;
}
```

- [ ] **Step 3: Update call sites in library-view.ts**

Find every place that calls `startReadingSession`, `finishReadingSession`, `getActiveReadingSession`. Replace `getActiveReadingSession(textId)` with `getInProgressSessionForText(textId)` (import from `../lib/idb`). Adapt return-type assumptions: `LocalSession.local_id` is now a string, not `session.id` (a number).

⚠️ This will break many call sites that access `session.id`. Search:

```bash
grep -nE "session\\.id|session_id" src/views/library-view.ts
```

For each match, decide:
- Calls that previously used the server's numeric `id` to call `discardReadingSession(session.id)` / `deleteReadingSession(session.id)` are now no-ops on local sessions; either remove or replace with a local-only delete (delete from IDB).

- [ ] **Step 4: Show timer based on `started_at`**

Find the current timer code (likely a `setInterval` updating elapsed seconds). Replace its body with:

```typescript
const elapsed = Math.floor((Date.now() - session.started_at) / 1000);
timerEl.textContent = formatDuration(elapsed);
```

- [ ] **Step 5: Manual test (offline-friendly)**

```
- Open a text. Click "Start Reading" — timer starts.
- DevTools → Application → IndexedDB → sessions: confirm one row, status=in_progress
- Switch tabs for 30s. Return — timer should now read ~30s + initial elapsed
- Click "Finish" — IDB status changes to completed_pending_upload, finished_at set
- (Upload doesn't work yet — Task 8 wires that up)
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/speed.ts src/views/library-view.ts src/utils.ts
git commit -m "feat(pwa): IndexedDB-backed session lifecycle"
```

---

## Task 8: Vocab Queue + Background Sync Upload

**Files:**
- Modify: `src/lib/library.ts` (route mark-known through queue)
- Modify: `src/sw.ts` (register sync handler)
- Create: `src/lib/sync.ts`
- Modify: `src-tauri/src/library/known_words.rs` (add `apply_vocab_changes_batch`)
- Modify: `src-tauri/src/library/speed.rs` (add `upload_completed_session`)
- Modify: `src-tauri/src/bin/server.rs` (add `/api/sync/vocab-changes` POST and `/api/sync/sessions` POST)

- [ ] **Step 1: Server endpoint for batched vocab changes**

In `src-tauri/src/library/known_words.rs`, add:

```rust
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct VocabChangeInput {
    pub word: String,
    pub word_type: String,
    pub status: String,            // "known" | "learning" | "removed"
    pub changed_at: i64,            // ms epoch
}

/// Apply a batch of vocab changes with last-write-wins semantics by changed_at.
/// Returns the number of changes that were actually applied (skipping older
/// timestamps if the DB has a newer one).
pub fn apply_vocab_changes_batch(
    conn: &Connection,
    changes: &[VocabChangeInput],
) -> Result<usize> {
    let mut applied = 0;
    for change in changes {
        // Compare against existing row (if any) — skip if DB is newer
        let existing_at: Option<i64> = conn
            .query_row(
                "SELECT updated_at FROM known_words WHERE word = ?",
                [&change.word],
                |row| row.get(0),
            )
            .optional()?;

        if let Some(at) = existing_at {
            if at >= change.changed_at {
                continue; // server has newer or equal — skip
            }
        }

        match change.status.as_str() {
            "removed" => {
                remove_known_word(conn, &change.word)?;
            }
            "known" | "learning" => {
                add_known_word(
                    conn,
                    &change.word,
                    &change.word_type,
                    Some(&change.status),
                    None,
                )?;
                conn.execute(
                    "UPDATE known_words SET updated_at = ? WHERE word = ?",
                    rusqlite::params![change.changed_at, &change.word],
                )?;
            }
            other => {
                log::warn!("Unknown vocab status '{}' for '{}'", other, change.word);
            }
        }
        applied += 1;
    }
    Ok(applied)
}
```

⚠️ This assumes `known_words` has an `updated_at` column. Check first:

```bash
grep -nE "updated_at|known_words" src-tauri/src/dictionary/schema.rs | head
```

If not present: add a migration in `schema.rs` that runs `ALTER TABLE known_words ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;`.

- [ ] **Step 2: Server endpoint for completed sessions**

In `src-tauri/src/library/speed.rs`, add:

```rust
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct UploadedSession {
    pub local_id: String,
    pub text_id: i64,
    pub started_at: i64,
    pub finished_at: i64,
    pub duration_seconds: i64,
    pub characters_per_minute: Option<f64>,
    pub known_characters_count: Option<i64>,
    pub text_known_char_percentage: Option<f64>,
    pub auto_marked_characters: Option<i64>,
    pub auto_marked_words: Option<i64>,
    pub source: Option<String>,
}

/// Insert a fully-formed client-built session. Idempotent on local_id.
pub fn upload_completed_session(conn: &Connection, s: &UploadedSession) -> Result<i64> {
    // Idempotent: skip if local_id already inserted
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM reading_sessions WHERE client_local_id = ?",
            [&s.local_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }

    conn.execute(
        "INSERT INTO reading_sessions
         (client_local_id, text_id, started_at, finished_at, duration_seconds,
          characters_per_minute, known_characters_count, text_known_char_percentage,
          auto_marked_characters, auto_marked_words, is_complete, is_manual_log, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)",
        rusqlite::params![
            &s.local_id,
            s.text_id,
            s.started_at,
            s.finished_at,
            s.duration_seconds,
            s.characters_per_minute,
            s.known_characters_count,
            s.text_known_char_percentage,
            s.auto_marked_characters,
            s.auto_marked_words,
            s.source.as_deref().unwrap_or("in_app"),
        ],
    )?;

    Ok(conn.last_insert_rowid())
}
```

⚠️ `reading_sessions` likely doesn't have a `client_local_id` column. Add a migration in `schema.rs`:

```sql
ALTER TABLE reading_sessions ADD COLUMN client_local_id TEXT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rs_client_local_id ON reading_sessions(client_local_id) WHERE client_local_id IS NOT NULL;
```

- [ ] **Step 3: Wire both as REST routes**

In `src-tauri/src/bin/server.rs` router builder, add:

```rust
        .route("/api/sync/vocab-changes", post(sync_vocab_changes_handler))
        .route("/api/sync/sessions", post(sync_sessions_handler))
```

And handlers:

```rust
async fn sync_vocab_changes_handler(
    State(db): State<Db>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    let result = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| ApiError::Internal(e.to_string()))?;
        let changes: Vec<library::known_words::VocabChangeInput> =
            serde_json::from_value(body.get("changes").cloned().unwrap_or(Value::Null))
                .map_err(|e| ApiError::BadRequest(format!("invalid changes: {}", e)))?;
        let applied = library::known_words::apply_vocab_changes_batch(&conn, &changes)
            .map_err(db_err)?;
        let _ = library::analysis::invalidate_shelf_analysis_cache(&conn);
        serialize(serde_json::json!({ "applied": applied }))
    })
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))??;
    Ok(Json(result))
}

async fn sync_sessions_handler(
    State(db): State<Db>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    let result = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| ApiError::Internal(e.to_string()))?;
        let sessions: Vec<library::speed::UploadedSession> =
            serde_json::from_value(body.get("sessions").cloned().unwrap_or(Value::Null))
                .map_err(|e| ApiError::BadRequest(format!("invalid sessions: {}", e)))?;
        let mut ids: Vec<i64> = Vec::new();
        for s in &sessions {
            ids.push(library::speed::upload_completed_session(&conn, s).map_err(db_err)?);
        }
        serialize(serde_json::json!({ "session_ids": ids }))
    })
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))??;
    Ok(Json(result))
}
```

Build, restart, smoke-test:

```bash
curl -s -X POST http://localhost:3000/api/sync/vocab-changes \
  -H 'Content-Type: application/json' \
  -d '{"changes": []}'
# Expected: {"applied":0}

curl -s -X POST http://localhost:3000/api/sync/sessions \
  -H 'Content-Type: application/json' \
  -d '{"sessions": []}'
# Expected: {"session_ids":[]}
```

- [ ] **Step 4: Client-side flush logic**

Create `src/lib/sync.ts`:

```typescript
import {
  listPendingVocabChanges,
  markVocabChangesUploaded,
  listPendingSessions,
  saveSession,
} from "./idb";

export async function flushPendingVocabChanges(): Promise<number> {
  const pending = await listPendingVocabChanges();
  if (pending.length === 0) return 0;

  const response = await fetch("/api/sync/vocab-changes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      changes: pending.map((c) => ({
        word: c.word,
        word_type: c.word_type,
        status: c.status,
        changed_at: c.changed_at,
      })),
    }),
  });
  if (!response.ok) throw new Error(`flush vocab failed: ${response.status}`);

  await markVocabChangesUploaded(pending.map((c) => c.id!));
  return pending.length;
}

export async function flushPendingSessions(): Promise<number> {
  const pending = await listPendingSessions();
  if (pending.length === 0) return 0;

  const response = await fetch("/api/sync/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessions: pending }),
  });
  if (!response.ok) throw new Error(`flush sessions failed: ${response.status}`);

  for (const s of pending) {
    await saveSession({ ...s, status: "uploaded" });
  }
  return pending.length;
}

export async function flushAll(): Promise<{ vocab: number; sessions: number }> {
  // Vocab first so analysis cache invalidation runs before any session
  // upload reads it
  const vocab = await flushPendingVocabChanges();
  const sessions = await flushPendingSessions();
  return { vocab, sessions };
}
```

- [ ] **Step 5: Update mark-known calls to enqueue locally**

Open `src/lib/library.ts`. Find `addKnownWord`, `updateWordStatus`, `removeKnownWord`. Wrap each in:

```typescript
import { enqueueVocabChange } from "./idb";

export async function addKnownWord(word: string, wordType: string, status?: string): Promise<void> {
  await enqueueVocabChange({
    word,
    word_type: wordType as "word" | "character",
    status: (status as "known" | "learning") ?? "known",
    changed_at: Date.now(),
  });
  // Best-effort immediate sync if online; ignore failure (queue will catch it later)
  if (navigator.onLine) {
    try {
      const { flushPendingVocabChanges } = await import("./sync");
      await flushPendingVocabChanges();
    } catch (err) {
      console.warn("immediate flush failed; queued for later:", err);
    }
  }
}
```

Similar for `updateWordStatus` (status: change) and `removeKnownWord` (status: "removed"). Important: callers of these functions expect the UI to update immediately. Make sure the UI logic doesn't depend on the server's response shape.

- [ ] **Step 6: Background Sync handler in SW**

Append to `src/sw.ts`:

```typescript
self.addEventListener("sync", (event: any) => {
  if (event.tag === "sync-sessions" || event.tag === "sync-vocab") {
    event.waitUntil(flushFromSw());
  }
});

async function flushFromSw(): Promise<void> {
  // Tell the page to flush — the page has the IDB code
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const c of clients) {
    c.postMessage({ type: "flush-sync-queue" });
  }
}
```

In `src/main.ts` near the SW registration, listen for the message and trigger the flush:

```typescript
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", async (event) => {
    if (event.data?.type === "flush-sync-queue") {
      const { flushAll } = await import("./lib/sync");
      flushAll().catch((err) => console.warn("background flush error:", err));
    }
  });
}

// Also flush on online event (covers browsers without Background Sync)
window.addEventListener("online", async () => {
  const { flushAll } = await import("./lib/sync");
  flushAll().catch((err) => console.warn("online flush error:", err));
});
```

- [ ] **Step 7: Manual test**

```
- Online: mark a word "known". Verify:
  - DevTools → IDB → vocab_queue: row appears, then status flips to "uploaded"
  - Server DB: known_words has the row
- Offline mode in DevTools: mark another word. Verify:
  - vocab_queue: row stays "pending"
- Restore network: see vocab_queue rows flip to "uploaded" (within seconds)
- Open a text, start session, finish session offline. After reconnect, verify
  the session appears in the server's reading_sessions table.
```

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/library/known_words.rs src-tauri/src/library/speed.rs \
        src-tauri/src/bin/server.rs src-tauri/src/dictionary/schema.rs \
        src/lib/sync.ts src/lib/library.ts src/sw.ts src/main.ts
git commit -m "feat(pwa): vocab queue and Background Sync upload of offline writes"
```

---

## Task 9: Conflict Resolution + Auto-Mark Sync Path

**Files:**
- Modify: `src-tauri/src/library/known_words.rs` (already done in Task 8)
- Modify: `src/views/library-view.ts` (auto-mark batch should also queue, not direct call)

The server's `apply_vocab_changes_batch` already enforces last-write-wins. The remaining gap is auto-mark: when the user finishes a text and the app auto-marks all unknown characters as known, those marks must also flow through the queue (in case offline at completion).

- [ ] **Step 1: Audit auto-mark callers**

```bash
grep -nE "auto_mark_text_as_known|autoMarkTextAsKnown" src/
```

Each call site needs to either:
(a) Stay as a server call (acceptable if always-online — but Mac PWA is mostly online, Android is the offline target)
(b) Compute the diff client-side and enqueue each character via `enqueueVocabChange`

For Android offline: auto-mark must happen on-device. Easiest path: compute the unknown-character set client-side using the cached `text_character_freq` data already in IDB (or fetched at text load), then enqueue.

- [ ] **Step 2: Implementation**

Decide based on the audit. If auto-mark currently produces a "marked X chars / Y words" UI message, the client-side version needs to compute the same numbers locally. If too complex for this plan, leave a TODO comment + GitHub issue and ship without offline auto-mark — the user can mark manually. Document the limitation.

- [ ] **Step 3: Commit (or skip if punted)**

```bash
git commit -am "feat(pwa): client-side auto-mark with queue (or: punt on offline auto-mark)"
```

---

## Task 10: Mobile Reading Polish

**Files:**
- Modify: `src/style.css`
- Modify: `src/views/library-view.ts`

The spec calls out: bottom-bar reading controls, font-size control. The drawer/responsive work from earlier already covers most of the layout. This task adds the explicit reading-control bottom bar.

- [ ] **Step 1: Add a sticky bottom bar to the reading view**

In `src/views/library-view.ts`, find the reading controls block (Start/Finish/Discard buttons inside the text view). Wrap them in `<div class="reading-bottom-bar">...</div>`.

- [ ] **Step 2: Sticky CSS on mobile**

Append to `src/style.css`:

```css
.reading-bottom-bar {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  flex-wrap: wrap;
  padding: 0.75rem 0;
}

@media (max-width: 700px) {
  .reading-bottom-bar {
    position: sticky;
    bottom: 0;
    left: 0;
    right: 0;
    margin: 0 -0.5rem;
    padding: 0.6rem 0.75rem;
    background: rgba(20, 20, 20, 0.95);
    border-top: 1px solid #333;
    backdrop-filter: blur(8px);
    z-index: 10;
    justify-content: space-between;
  }
}

@media (max-width: 700px) and (prefers-color-scheme: light) {
  .reading-bottom-bar {
    background: rgba(255, 255, 255, 0.95);
    border-top-color: #ddd;
  }
}
```

- [ ] **Step 3: Add a font-size control**

Add an `<input type="range" min="14" max="28" step="1">` next to the controls. On change, set a CSS variable on the reader root:

```typescript
fontInput.addEventListener("input", (e) => {
  const px = (e.target as HTMLInputElement).value;
  document.documentElement.style.setProperty("--reader-font-size", `${px}px`);
  localStorage.setItem("reader-font-size", px);
});

// On startup
const saved = localStorage.getItem("reader-font-size");
if (saved) document.documentElement.style.setProperty("--reader-font-size", `${saved}px`);
```

In CSS, use the variable:

```css
.text-content-interactive {
  font-size: var(--reader-font-size, 1.2rem);
}
```

- [ ] **Step 4: Manual test**

Open a text on phone. Bar sticks to bottom; font-size slider scales the text.

- [ ] **Step 5: Commit**

```bash
git add src/views/library-view.ts src/style.css
git commit -m "feat(pwa): sticky bottom-bar reading controls + font-size slider"
```

---

## Task 11: Final integration check + push

- [ ] **Step 1: Stop running server, rebuild release, restart**

```bash
pkill -f "target/release/server" 2>/dev/null
source "$HOME/.cargo/env"
cd src-tauri && cargo build --release --bin server
cd ..
npm run build
# Start it however you've been running it (nohup or systemd)
```

- [ ] **Step 2: End-to-end test on Android**

```
- Visit http://<linux-ip>:3000 → Add to Home Screen → open as installed PWA
- Open a text (online) — vocab cache populates
- Airplane mode ON
- Re-open the PWA → text still loads, lookups for words-in-text still work
- Start a session, read for a bit, mark a word "known", Finish session
- Airplane mode OFF
- Confirm in DevTools (chrome://inspect from Mac) that vocab_queue and sessions
  flush. Confirm Linux DB picked up both rows.
```

- [ ] **Step 3: Push**

```bash
git push origin main
```

---

## Self-Review Checklist (run before handing off)

- [ ] Manifest path matches `<link rel="manifest">` in index.html
- [ ] SW emits to `dist/sw.js` (not `dist/assets/sw-<hash>.js`) so registration path is stable
- [ ] All four IDB stores created in upgrade handler with correct keyPaths
- [ ] `apply_vocab_changes_batch` uses last-write-wins (skips when DB row is newer)
- [ ] `upload_completed_session` is idempotent on `client_local_id`
- [ ] Migration for `known_words.updated_at` and `reading_sessions.client_local_id` added to `schema.rs`
- [ ] No broken `session.id` references after Task 7 refactor
- [ ] Background Sync `online` event listener in main.ts as fallback
- [ ] `apple-touch-icon` is 180×180 PNG (not 192)
- [ ] `theme_color` matches `<meta name="theme-color">`

---

## Out of Scope (intentionally)

- **Multi-device write conflict UX**: spec accepts last-write-wins; no merge UI.
- **Encrypted local storage**: home-LAN trust model.
- **Selective per-shelf offline preload**: user has to open texts manually to cache them. A "preload this shelf" button is a future task.
- **Push notifications / reminders**: not in spec.
- **Offline auto-mark**: if Task 9 punts, document the limitation in README.
