# Offline Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the reliability spec so a verified, self-consistent PWA shell and complete immutable text bundles remain usable without the server.

**Architecture:** Vite injects a revisioned critical-asset manifest into the custom service worker. The worker stages and verifies complete releases before selecting them, while IndexedDB commits text content, segments, vocabulary, navigation metadata, and a validated completion marker as one offline bundle. A small UI status module reports controller, release, diagnostics, and storage persistence without deleting caches or data.

**Tech Stack:** TypeScript 5.9, Vite 7, Service Worker Cache API, IndexedDB, Rust/Axum static server, Playwright Chromium.

## Global Constraints

- Keep the running production daemon and its current `dist` untouched until an isolated production build and automated checks pass.
- Do not clear Cache Storage or IndexedDB during update, retry, or recovery.
- Network navigation fallback deadline is 2,000 ms.
- Text records are immutable after import; IndexedDB is authoritative after download.
- `start_url` and `scope` remain `/`.
- Manual Android acceptance remains a user-run gate because it requires the original physical device and installation mode.

---

### Task 1: Establish an isolated verification harness

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `playwright.config.ts`
- Create: `tests/offline-reliability.spec.ts`

**Interfaces:**
- Consumes: production Vite build and Rust/static HTTP behavior.
- Produces: `npm run test:offline`, which boots an isolated server and tests a real Chromium service worker and IndexedDB context.

- [ ] Add Playwright as a development dependency and scripts for an isolated build and offline test.
- [ ] Write failing browser tests for bootstrap/control, cold offline `/` and query launch, two-second hung/refused fallback, optional/critical asset failures, mixed-release prevention, and offline API failure.
- [ ] Write failing browser tests for local-first text reads, interrupted bundle status, shelf completeness, upgrade preservation, cleanup interruption, and eviction diagnostics.
- [ ] Run the targeted tests and confirm each fails for the missing behavior rather than harness errors.

### Task 2: Make shell releases staged, verified, and selectable

**Files:**
- Modify: `src/sw.ts`
- Modify: `vite.config.ts`

**Interfaces:**
- Consumes: injected `buildId`, entry URL, and exact revisioned critical URLs.
- Produces: `VERIFY_SHELL` and `GET_DIAGNOSTICS` message replies containing selected release and verification state.

- [ ] Adjust the manifest injection so unresolved placeholders fail the build and the critical list contains entry HTML plus every generated JS/CSS chunk.
- [ ] Stage each release in its own cache, read back every critical response, and persist `ready` metadata only after verification.
- [ ] During activation, select a verified ready release before cleanup; retain the selected release and at least one older verified fallback.
- [ ] Ensure a failed or interrupted install never calls `skipWaiting()` and never changes the selected release.
- [ ] Serve revisioned assets only from the selected release cache and never mix unverified network assets into it.
- [ ] Run the shell release tests until they pass.

### Task 3: Enforce bounded navigation fallback and durable diagnostics

**Files:**
- Modify: `src/sw.ts`

**Interfaces:**
- Consumes: selected verified `ShellRelease`.
- Produces: navigation response within 2,000 ms and a bounded 50-event diagnostic record.

- [ ] Race navigation fetches against an aborting two-second timer and ignore query parameters for fallback lookup.
- [ ] Return selected `/index.html`; if missing, try the newest older verified release; if none exists, return diagnostic HTML.
- [ ] Record install, activation, selection, cleanup, fallback hit/miss, and missing asset events without allowing diagnostics failures to break fetch handling.
- [ ] Run refusal, hang, query, fallback, cleanup, and eviction tests until they pass.

### Task 4: Commit and validate complete offline text bundles

**Files:**
- Modify: `src/lib/idb.ts`
- Modify: `src/lib/library.ts`
- Modify: `src/views/library-view.ts`

**Interfaces:**
- Produces: `saveOfflineTextBundle(bundle): Promise<void>` and `getOfflineTextBundleStatus(textId): Promise<"missing" | "partial" | "complete">`.
- Consumes: full text, render segments, vocabulary entries, and text summary metadata.

- [ ] Write failing real-browser IndexedDB tests proving missing, partial, committed complete, schema mismatch, count mismatch, and interrupted transaction states.
- [ ] Store text, segments, vocabulary, summary, schema version, counts, and `downloaded_at` in one transaction; write the complete marker last within that transaction.
- [ ] Validate marker counts and required records through a separate transaction after commit; downgrade stale or invalid markers to partial.
- [ ] Keep `getText(id)` IndexedDB-first and verify a cache hit issues no `/api/texts/:id` request.
- [ ] Update shelf download to fetch all bundle inputs, await `saveOfflineTextBundle`, persist navigation records, and report failures by text ID.
- [ ] Determine shelf completion exclusively from expected text IDs with validated complete markers.
- [ ] Run text and shelf tests until they pass.

### Task 5: Add truthful offline readiness, persistence, and copyable diagnostics

**Files:**
- Create: `src/lib/offline-status.ts`
- Modify: `src/main.ts`
- Modify: `src/style.css`

**Interfaces:**
- Consumes: service-worker verification reply, registration/controller lifecycle, `navigator.storage` APIs.
- Produces: compact Offline status UI, Retry setup, and Copy diagnostics actions.

- [ ] Write failing browser tests for preparing, ready, unavailable, retry, reload-required, persistence states, quota display, and diagnostic copy.
- [ ] Report ready only when a controller exists and the selected critical release verifies.
- [ ] Persist launch/build/controller/install errors/release/storage fields to bounded local diagnostics.
- [ ] Request persistent storage after the first completed text or shelf download and display persisted/unsupported/not-granted plus usage/quota.
- [ ] Make Retry call `registration.update()` and verification without deleting Cache Storage or IndexedDB.
- [ ] Run readiness and persistence tests until they pass.

### Task 6: Verify production headers without disturbing the daemon

**Files:**
- Modify: `src-tauri/src/bin/server.rs`
- Modify: `docs/engineering-notes.md`

**Interfaces:**
- Produces: `/sw.js` JavaScript plus `no-cache`, HTML revalidation, and immutable cache policy for hashed `/assets/*`.

- [ ] Write failing Rust/static-response tests for MIME and cache headers.
- [ ] Add route-aware headers while preserving SPA fallback and API behavior.
- [ ] Build frontend and Rust server in an isolated remote directory, never the daemon’s live `dist` or release binary path.
- [ ] Capture before/after headers for `/sw.js`, `/index.html`, and one hashed asset and document them.

### Task 7: Full verification and controlled handoff

**Files:**
- Modify: `docs/engineering-notes.md`

**Interfaces:**
- Consumes: all prior test suites and isolated production artifacts.
- Produces: automated matrix, observed root-cause note, remaining limitations, and deployment instructions.

- [ ] Run TypeScript typecheck, production Vite build, Rust tests/build, and all Playwright cases in isolation.
- [ ] Re-read every R1-R7 and all 18 automated cases; record pass, fail, or a concrete environmental blocker for each.
- [ ] Review the final remote diff and confirm no database, cache, live `dist`, service unit, or running daemon process changed.
- [ ] Present the isolated artifacts and verification evidence; request explicit approval before any production deployment or daemon restart.
- [ ] Provide the 12-step Android acceptance checklist for the user and record its result separately from automated verification.
