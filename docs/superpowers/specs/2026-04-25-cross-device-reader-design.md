# Cross-Device Chinese Reader — Design Spec

**Date:** 2026-04-25
**Status:** Approved for implementation planning

---

## Overview

Three related features shipped in three sequential phases:

| Phase | What ships | Depends on |
|---|---|---|
| **1** | Offline read log + shelf unread badges (Tauri desktop) | Nothing — ship now |
| **2** | Linux HTTP server — Mac + Android browser access | Phase 1 |
| **3** | PWA + full offline reading on Android and Mac Chrome | Phase 2 |

---

## Architecture

**Hub:** Always-on Linux box running a standalone Rust HTTP server. Single source of truth (one SQLite database).

**Clients:** Both Mac and Android use Chrome. No Tauri app after Phase 2 migration. No cloud, no app store. Direct local network connection over home WiFi.

```
📱 Android (Chrome PWA)     🖥️  Mac (Chrome browser)
         ↘                        ↙
          🐧  Linux: Axum HTTP server
                     ↕
              💾  SQLite DB
```

**Offline reading:** Service worker caches text content and per-text vocab on first load. Sessions and vocab changes queue in IndexedDB and sync via Background Sync API when reconnected.

**No authentication.** Server binds to `0.0.0.0:3000`. Accessible to any device on the home network.

---

## Phase 1: Desktop features (Tauri app)

### 1a. Shelf unread badges

**Definition of "unread":** any text with no `reading_sessions` row where `is_complete = 1`.

**DB query:** new Rust function `get_unread_counts(shelf_ids: Vec<i64>) -> HashMap<i64, i64>` — called once after the shelf tree is loaded, passing all shelf IDs in a single query rather than per-shelf calls. Uses a single SQL query with `GROUP BY shelf_id` across all shelves, then the parent aggregation is done in Rust by summing descendant counts using the already-loaded shelf tree structure.

**UI:** `.shelf-count` badge changes from `37` to `37/12` when unread > 0. The unread number renders in amber (`#f59e0b`). When all texts are read, the badge reverts to just the total count — no change to existing display.

### 1b. Offline read log

**Purpose:** log a reading session that happened away from the app — physical book, other website, phone browser — for one or more texts in the library.

**DB schema change** — two new columns on `reading_sessions`:

| Column | Type | Notes |
|---|---|---|
| `is_manual_log` | `INTEGER NOT NULL DEFAULT 0` | 1 = manually logged, 0 = in-app |
| `source` | `TEXT NULL` | `"physical_book"`, `"other_site"`, `"phone"`, or NULL for in-app |

**Duration splitting:** user enters one total duration for all selected texts. Each text's share is proportional to its character count so all texts get the same characters-per-minute reading speed:

```
text_duration = total_duration × (text.character_count / sum_of_all_char_counts)
```

**Session record created per text:**
- `started_at` = `finished_at - proportional_duration`
- `finished_at` = user-specified datetime
- `duration_seconds` = proportional duration in seconds
- `character_count` = `text.character_count`
- `characters_per_minute` = `text.character_count / (proportional_duration_seconds / 60)`
- `cumulative_characters_read` = sum of `character_count` from all prior completed sessions for that text (query before insert)
- `is_complete = 1`
- `is_first_read` = 1 if no prior completed sessions for that text
- `is_manual_log = 1`
- `source` = selected source
- `auto_marked_characters = 0`, `auto_marked_words = 0`
- `known_characters_count`, `known_words_count` = current snapshot at time of logging

**UI flow:**
1. "Log offline read" button sits beside "Start Reading" in the reading controls area
2. Modal opens with:
   - Text search field → adds texts as removable chips (search across all shelves by title)
   - "When did you finish?" datetime picker (defaults to now)
   - "How long?" — hours + minutes (total for all texts)
   - "Where did you read?" — source chip selector: Physical book / Other site / Phone / Other
3. Save button labeled "Save N sessions" (updates count as texts are added)
4. On save: creates one completed session per text

**Session history display:** manual sessions show a "Logged" badge in place of "Complete". Source label displayed if set.

**Vocabulary:** no auto-marking for manually logged sessions. Vocab state is not altered.

---

## Phase 2: Linux HTTP server

### Binary structure

New Rust binary `chinese-reader-server` in the same Cargo workspace. Imports the existing library modules (`library`, `speed`, `vocabulary`, `dictionary`) directly — no code duplication. Axum HTTP handlers wrap the same functions that currently back Tauri `invoke()` calls.

Serves the compiled frontend as static files from the same binary.

### API surface

All existing Tauri commands exposed as REST endpoints:

```
GET  /api/shelves                        → get_shelf_tree (includes unread counts)
GET  /api/shelves/:id/texts              → get_texts_in_shelf
GET  /api/texts/:id/content              → get_text_content + segmentation
GET  /api/texts/:id/vocab-cache          → pre-fetch all dictionary entries for text
POST /api/sessions/complete              → upload a finished session (full record)
POST /api/vocab/sync                     → upload batch of timestamped vocab changes
GET  /api/sync/status                    → confirm pending items received
GET  /api/dictionary/lookup              → single word/character lookup
GET  /api/speed/stats                    → reading speed statistics
GET  /api/speed/data                     → speed correlation data
... (all other existing commands)

# Desktop/import commands — not exposed to browser clients:
POST /api/import/*                       → import scripts run directly on Linux server; browser clients do not trigger imports
# (import_text_file and similar commands take local filesystem paths and are not meaningful to browser clients)

# Legacy Tauri path only — not used by web clients:
POST /api/sessions                       → start_reading_session
PUT  /api/sessions/:id/finish            → finish_reading_session
```

### Frontend adaptation

`@tauri-apps/api` `invoke()` calls replaced with a thin wrapper that calls `fetch('/api/...')`. Same TypeScript, same UI. Environment detection: if `window.__TAURI__` exists use invoke, otherwise use fetch. This allows Phase 1 (Tauri) and Phase 2 (browser) to share the same frontend codebase.

---

## Phase 3: PWA + offline

### Session lifecycle (client-first)

Sessions no longer require a server round-trip to start. The full lifecycle happens on-device:

1. "Start Reading" → session record created in **IndexedDB** with `started_at = Date.now()` and a local temp ID
2. User may switch to another app (physical book, other reading app) — the PWA is backgrounded
3. The visible timer is **not** a running background process. It is recomputed as `Date.now() - started_at` each second when the app is in the foreground. On returning from another app the timer immediately shows the correct elapsed time including time spent away. JavaScript timers being suspended while backgrounded is expected and does not affect accuracy.
4. Vocabulary changes during reading appended to local queue as timestamped entries: `{ word, type, status, changed_at }`
5. "Finish" → `finished_at = Date.now()`, session completed in IndexedDB, moved to upload queue

This makes the PWA timer work as a stopwatch for physical book reading: start the timer, set the phone down and read, return and stop it. The "log offline read" modal covers the case where the user forgot to start the timer.
5. **Background Sync** fires when online → uploads in order:
   - Vocab changes (oldest-first)
   - Completed session (full record — server stores as-is)
6. Server applies vocab changes, marks affected `shelf_analyses_cache` rows stale
7. Cache rebuilds lazily on next request

**App close mid-session:** IndexedDB persists across close/reopen. On re-open, app detects in-progress session and resumes.

### What the client computes locally

The client constructs a complete session record without any server involvement:

| Field | Source |
|---|---|
| `started_at` / `finished_at` | Device clock |
| `duration_seconds` | `finished_at - started_at` |
| `characters_per_minute` | `char_count / (duration_seconds / 60)` |
| `known_characters_count` | Snapshot from local vocab cache at session start |
| `text_known_char_percentage` | Calculated from local vocab cache |
| `is_first_read` | Server resolves at upload time |
| `auto_marked_*` | Tracked locally during session |

### Vocabulary conflict resolution

If the same word is marked differently on two devices while both offline, last-write-wins by `changed_at` timestamp. Single-user app — this edge case is acceptable.

### Analysis invalidation

After applying a batch of vocab changes, the server marks stale any `shelf_analyses_cache` rows covering affected texts. Re-computation is lazy — triggered on next cache miss, not immediately. Historical `text_known_char_percentage` values on completed sessions are never retroactively updated.

### Offline dictionary

**Pre-caching:** when a text is downloaded for offline use, the service worker also fetches `GET /api/texts/:id/vocab-cache` — a single JSON blob containing all dictionary entries for every word and character that appears in that text (sourced from existing `text_word_freq` / `text_character_freq` tables). Stored in IndexedDB keyed by `text_id`.

**Lookup flow:**
```
User taps a word
  → check IndexedDB vocab cache for this text
      HIT  → show definition (fully offline)
      MISS → online?
               YES → fetch from server, show definition, add to cache
               NO  → show "Definition not available offline"
```

A miss occurs when the user selects a novel character combination not present in the text (e.g. cross-phrase selection). Surfaced as a soft informational message, not an error.

**Scope:** only per-text entries are cached on the client. The full dictionary DB stays on the Linux server.

### Service worker caching strategy

| Resource | Strategy |
|---|---|
| Text content + segmentation | Cache-first (permanent until text updated) |
| Per-text vocab cache | Cache-first (permanent until text updated) |
| Dictionary lookups (online miss) | Cache after fetch |
| Session writes | Queue in IndexedDB → Background Sync |
| Vocab changes | Queue in IndexedDB → Background Sync |
| Shelf/library structure | Network-first, fallback to cache |

### PWA manifest

Standard `manifest.json`: name "Chinese Reader", icons, `display: standalone`, `theme_color: #242424`. Android Chrome shows "Add to Home Screen" banner automatically after two visits.

### Responsive layout

Existing layout is desktop-first. Mobile changes:
- Shelf tree moves to a slide-in drawer (hamburger toggle)
- Text content area goes full-width
- Reading controls (Start/Finish/Log offline) pin to a bottom bar
- Chinese text rendered at comfortable mobile size with adjustable font size control
- Touch-friendly tap targets for character/word selection
