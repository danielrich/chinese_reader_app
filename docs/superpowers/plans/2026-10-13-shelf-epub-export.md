# Shelf EPUB Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Download any shelf subtree as one Kindle-friendly EPUB with nested navigation and clickable first-occurrence definitions for unknown segmented words.

**Architecture:** A focused Rust library module loads an immutable export model, enriches chapters with segmentation and dictionary definitions, and packages standards-compliant EPUB bytes. A read-only Axum route streams the result; a shelf button downloads it in the browser.

**Tech Stack:** Rust 1.77.2, rusqlite, Jieba, Axum 0.8, `zip` 0.6.6, EPUB 3 XHTML, TypeScript 5.9, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-13-shelf-epub-export-and-untimed-offline-reads-design.md`

## Global Constraints

- Export exactly one selected shelf and all descendants in deterministic display order.
- Link only the first occurrence of each unknown multi-character segmented word that has a definition.
- Keep page-break CSS on an outer wrapper; the inner `epub:type="footnote"` aside must have no page-layout rules.
- The EPUB `mimetype` entry must be first, uncompressed, and contain exactly `application/epub+zip` with no newline.
- Export is read-only, uncached by the service worker, and bounded in memory.
- Invalid XML characters are dropped; valid Unicode and all user-visible strings are XML-escaped.
- The unrelated untracked performance plan and prototype files under `test-artifacts/` are not production inputs and must not be committed with implementation.

## Review Focus

- A shelf containing both direct texts and nested child shelves preserves the app's text-first, depth-first order; Task 1 adds a model-order test.
- Repeated unknown words produce exactly one link/footnote per chapter; Task 2 adds an XHTML test.
- XML metacharacters and illegal control characters cannot corrupt the EPUB; Task 3 adds parser/escaping tests.
- A dictionary miss leaves readable unlinked text rather than failing the export; Task 2 adds a lookup-miss test.
- Very large content returns an explicit error before unbounded allocation; Task 3 adds a size-limit test.

---

### Task 1: Load an ordered shelf export model

**Files:**
- Create: `src-tauri/src/library/epub.rs`
- Modify: `src-tauri/src/library/mod.rs`

**Interfaces:**
- Consumes: `shelves` and `texts` tables plus existing shelf ordering rules.
- Produces: `load_export_book(conn: &Connection, shelf_id: i64) -> Result<ExportBook>`, where `ExportBook` owns a nested `ExportSection` tree and ordered `ExportChapter` values.

- [ ] **Step 1: Write failing model-loading tests**

Define the intended model in the test module:

```rust
#[derive(Debug, Clone)]
pub struct ExportBook { pub shelf_id: i64, pub title: String, pub root: ExportSection }
#[derive(Debug, Clone)]
pub struct ExportSection { pub shelf_id: i64, pub title: String, pub chapters: Vec<ExportChapter>, pub children: Vec<ExportSection> }
#[derive(Debug, Clone)]
pub struct ExportChapter { pub text_id: i64, pub title: String, pub author: Option<String>, pub content: String }
```

Seed a root with direct texts ordered `sort_order`, two children ordered `sort_order, name`, and a grandchild. Assert direct chapters precede child navigation and depth-first flattening yields the expected text IDs. Add tests expecting `ShelfNotFound(99)` and `InvalidInput("Shelf contains no texts")` for missing/empty roots.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `cd src-tauri && cargo test --lib library::epub::tests::load_export -- --nocapture`

Expected: FAIL because the module and loader do not exist.

- [ ] **Step 3: Implement recursive loading with parameterized SQL**

Implement a private recursive loader using:

```sql
SELECT id, name FROM shelves WHERE parent_id = ? ORDER BY sort_order, name, id
SELECT id, title, author, content FROM texts WHERE shelf_id = ? ORDER BY sort_order, created_at DESC, id
```

Count chapters recursively after loading and reject a zero-text subtree. Do not use formatted IDs in SQL.

- [ ] **Step 4: Run the model tests**

Run: `cd src-tauri && cargo test --lib library::epub::tests::load_export -- --nocapture`

Expected: PASS.

- [ ] **Step 5: Commit the export model**

```bash
git add src-tauri/src/library/epub.rs src-tauri/src/library/mod.rs
git commit -m "feat: load shelf EPUB model"
```

### Task 2: Enrich chapters with unknown-word definitions

**Files:**
- Modify: `src-tauri/src/library/epub.rs`

**Interfaces:**
- Consumes: `analysis::segment_text`, `dictionary::lookup`, `LookupOptions`, and Task 1's `ExportChapter`.
- Produces: `prepare_chapter(conn: &Connection, chapter: &ExportChapter, cache: &mut HashMap<String, Option<DefinitionContent>>) -> Result<PreparedChapter>` with ordered text segments and definitions.

- [ ] **Step 1: Write failing tests for eligibility, deduplication, and misses**

Register `救贖`, `聖約`, and `未收錄詞語` with `analysis::add_segmentation_word` so the test does not depend on Jieba's bundled dictionary. Seed dictionary entries for `救贖` and `聖約`, mark `聖約` known, and prepare content `救贖帶來希望，救贖使人平安，聖約帶來力量，未收錄詞語。`. Assert:

```rust
assert_eq!(prepared.definitions.iter().map(|d| d.word.as_str()).collect::<Vec<_>>(), vec!["救贖"]);
assert_eq!(prepared.segments.iter().filter(|s| s.definition_id.is_some()).count(), 1);
assert_eq!(prepared.definitions[0].content.pinyin.as_deref(), Some("jiùshú"));
```

Add a dictionary-miss assertion that `未收錄詞語` remains present and unlinked. Add a `learning` fixture and assert it remains eligible.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `cd src-tauri && cargo test --lib library::epub::tests::prepare_chapter -- --nocapture`

Expected: FAIL because prepared chapter types/functions do not exist.

- [ ] **Step 3: Implement definition selection and first-occurrence linking**

Add:

```rust
pub struct DefinitionContent { pub word: String, pub pinyin: Option<String>, pub definition: String }
pub struct ExportDefinition { pub id: String, pub content: DefinitionContent }
pub struct PreparedSegment { pub text: String, pub definition_id: Option<String> }
pub struct PreparedChapter { pub chapter: ExportChapter, pub segments: Vec<PreparedSegment>, pub definitions: Vec<ExportDefinition> }
```

Call `segment_text`. Eligible segments satisfy `segment_type == "word" && !is_known`. Use a per-export `HashMap<String, Option<DefinitionContent>>` so repeated terms across chapters do not repeat database lookup. Call `dictionary::lookup` with examples/character info/user dictionaries disabled and `max_results: Some(10)`. Select the first entry with a non-empty first definition; prefer `pinyin_display`, then numeric `pinyin`. Wrap cloned cached content in an `ExportDefinition` with a chapter-local deterministic ID such as `def-{text_id}-{ordinal}`. Track a per-chapter `HashSet<String>` so only the first occurrence links.

- [ ] **Step 4: Run the focused and dictionary tests**

Run: `cd src-tauri && cargo test --lib library::epub::tests::prepare_chapter -- --nocapture`

Expected: PASS.

Run: `cd src-tauri && cargo test --lib dictionary::lookup::tests -- --nocapture`

Expected: PASS.

- [ ] **Step 5: Commit vocabulary enrichment**

```bash
git add src-tauri/src/library/epub.rs
git commit -m "feat: embed unknown-word definitions"
```

### Task 3: Build standards-compliant EPUB bytes

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/library/epub.rs`

**Interfaces:**
- Consumes: `ExportBook` and prepared chapters from Tasks 1-2.
- Produces: `build_epub(conn: &Connection, book: &ExportBook) -> Result<Vec<u8>>` and `export_shelf_epub(conn: &Connection, shelf_id: i64) -> Result<ExportedEpub>`.

- [ ] **Step 1: Add failing archive and XHTML tests**

Add `zip = { version = "0.6.6", default-features = false, features = ["deflate"] }`. Tests should open returned bytes with `zip::ZipArchive` and assert:

```rust
assert_eq!(archive.by_index(0).unwrap().name(), "mimetype");
assert_eq!(archive.by_index(0).unwrap().compression(), zip::CompressionMethod::Stored);
assert_eq!(read_entry(&mut archive, "mimetype"), "application/epub+zip");
for required in ["META-INF/container.xml", "OEBPS/content.opf", "OEBPS/nav.xhtml", "OEBPS/style.css"] {
    assert!(archive.by_name(required).is_ok());
}
```

Inspect a chapter string and assert the source anchor has `epub:type="noteref"`, the outer `<section class="definition-page-wrapper">` has page-break styling through CSS, the inner `<aside epub:type="footnote">` has no page-layout class, and the backlink targets the exact source ID. Include titles/content containing `&`, `<`, `>`, quotes, and `\u{0001}`; assert escaped valid XML and removal of the illegal control.

- [ ] **Step 2: Run the tests and verify failure**

Run: `cd src-tauri && cargo test --lib library::epub::tests::build_epub -- --nocapture`

Expected: FAIL because packaging is not implemented.

- [ ] **Step 3: Implement EPUB rendering helpers**

Add focused private helpers:

```rust
fn sanitize_xml_text(value: &str) -> String;
fn render_nav(book: &ExportBook, chapter_ids: &HashMap<i64, String>) -> String;
fn render_chapter(prepared: &PreparedChapter) -> String;
fn render_package(book: &ExportBook, chapters: &[RenderedChapter], modified: &str) -> String;
```

Escape `& < > " '` after dropping XML 1.0-invalid control characters. Segment rendering must escape every segment independently before wrapping the single linked occurrence.

Use `ZipWriter<Cursor<Vec<u8>>>`. Write `mimetype` first with `CompressionMethod::Stored`, then container, CSS, nav, OPF, and chapters with deflate. Use an explicit 200 MiB pre-compression content guard and return `InvalidInput("EPUB export is too large")` before ZIP assembly.

CSS must include:

```css
.unknown { text-decoration: underline; text-decoration-style: dotted; font-weight: 600; }
.definition-page-wrapper { break-before: page; page-break-before: always; break-after: page; page-break-after: always; }
.back-link { display: block; margin-top: 2em; font-weight: 700; }
```

Do not apply page-break or minimum-height declarations to the footnote aside.

- [ ] **Step 4: Add nested-navigation and size-guard tests**

Parse `nav.xhtml` as text and assert nested `<ol>` placement and links to the first descendant chapter. Construct an `ExportBook` over the configured byte limit and assert the explicit size error without creating a ZIP.

- [ ] **Step 5: Run EPUB and full Rust tests**

Run: `cd src-tauri && cargo test --lib library::epub::tests -- --nocapture`

Expected: PASS.

Run: `cd src-tauri && cargo test --lib`

Expected: PASS.

- [ ] **Step 6: Commit the EPUB builder**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/library/epub.rs
git commit -m "feat: generate Kindle-ready EPUB files"
```

### Task 4: Expose the read-only download route

**Files:**
- Modify: `src-tauri/src/bin/server.rs:1-20,223-235,275-330`

**Interfaces:**
- Consumes: `library::epub::export_shelf_epub` from Task 3.
- Produces: `GET /api/shelves/{id}/export.epub` with EPUB bytes and safe download headers.

- [ ] **Step 1: Write failing handler tests inside `server.rs`**

Create a one-connection in-memory `DbPool`, seed one shelf/text, call the handler directly, and assert:

```rust
let response = export_shelf_epub_handler(State(db), Path(1)).await.unwrap().into_response();
assert_eq!(response.status(), StatusCode::OK);
assert_eq!(response.headers()[header::CONTENT_TYPE], "application/epub+zip");
assert!(response.headers()[header::CONTENT_DISPOSITION].to_str().unwrap().contains("filename*=UTF-8''"));
```

Add missing-shelf `404` and empty-shelf `400` tests. Verify `cache_control_for_static_response("/api/shelves/1/export.epub", ...)` returns `None`.

- [ ] **Step 2: Run server tests and confirm failure**

Run: `cd src-tauri && cargo test --bin server export_shelf_epub -- --nocapture`

Expected: FAIL because the handler/route do not exist.

- [ ] **Step 3: Implement route and response mapping**

Register:

```rust
.route("/api/shelves/{id}/export.epub", get(export_shelf_epub_handler))
```

In the handler, acquire a pooled connection and run export in `spawn_blocking`. Map `ShelfNotFound` to `404`, empty/oversized `InvalidInput` to `400`, and other failures to `500`. Return bytes with `Content-Type: application/epub+zip`, `Cache-Control: no-store`, and ASCII fallback plus RFC 5987 UTF-8 `filename*` in `Content-Disposition`.

- [ ] **Step 4: Run server and full Rust tests**

Run: `cd src-tauri && cargo test --bin server export_shelf_epub -- --nocapture && cargo test --lib`

Expected: PASS.

- [ ] **Step 5: Commit the route**

```bash
git add src-tauri/src/bin/server.rs
git commit -m "feat: serve shelf EPUB downloads"
```

### Task 5: Add the shelf download button

**Files:**
- Modify: `src/lib/library.ts:321-380`
- Modify: `src/views/library-view.ts:410-425,595-610`
- Create: `tests/shelf-epub-export.spec.ts`

**Interfaces:**
- Consumes: `GET /api/shelves/{id}/export.epub` from Task 4.
- Produces: `library.downloadShelfEpub(shelfId: number, fallbackName: string): Promise<void>` and `#export-epub-btn` shelf action.

- [ ] **Step 1: Write failing browser tests for success and failure**

Mock normal shelf APIs. For the export route, fulfill with EPUB bytes and `Content-Disposition: attachment; filename*=UTF-8''Test%20Shelf.epub`. Trigger the button while intercepting `URL.createObjectURL` and an anchor's `click`; assert one request to `/api/shelves/1/export.epub`, the button reads `Preparing EPUB…` while pending, and the derived filename is `Test Shelf.epub`.

Add a `500` response test and assert the button returns to `Export as EPUB` and displays/alerts `EPUB export failed` without navigating away.

- [ ] **Step 2: Run the test and verify missing-button failure**

Run: `npm run build && npx playwright test tests/shelf-epub-export.spec.ts`

Expected: FAIL because the button and download helper do not exist.

- [ ] **Step 3: Implement the download helper**

Fetch the route with `cache: "no-store"`, throw an error containing response text when non-OK, create a blob URL, set an ephemeral anchor's `download` filename from `filename*` with a sanitized shelf fallback, click it, remove it, and revoke the URL in `finally`.

- [ ] **Step 4: Wire the shelf action and pending/error states**

Render:

```html
<button id="export-epub-btn" class="btn-secondary">Export as EPUB</button>
```

Pass `shelfName` from `renderShelfContents` into an updated `bindShelfContents(mainContainer, shelfId, shelfName, texts)` signature and bind the new action there. Disable only this button while exporting; restore it in `finally`; do not re-fetch the tree for the fallback filename.

- [ ] **Step 5: Run frontend verification**

Run: `npm run build`

Expected: PASS.

Run: `npx playwright test tests/shelf-epub-export.spec.ts`

Expected: PASS.

Run: `npm run test:offline`

Expected: PASS, proving the EPUB route is not required for offline launch/cache behavior.

- [ ] **Step 6: Commit the UI**

```bash
git add src/lib/library.ts src/views/library-view.ts tests/shelf-epub-export.spec.ts
git commit -m "feat: download shelf EPUB exports"
```

### Task 6: End-to-end artifact and deployment verification

**Files:**
- Modify only if verification reveals a defect in files owned by Tasks 1-5.

**Interfaces:**
- Consumes: all EPUB tasks and the separately completed untimed-read plan.
- Produces: verified local release and deployed `chasmfiend.local` service.

- [ ] **Step 1: Run the complete local suite**

```bash
cd src-tauri && cargo test --lib && cargo test --bin server
cd .. && npm run build && npm run test:offline
```

Expected: all commands exit 0.

- [ ] **Step 2: Generate and structurally inspect a real General Conference EPUB**

Run the local server against a database copy, request `/api/shelves/196/export.epub`, then verify:

```bash
unzip -t /tmp/general-conference.epub
unzip -Z1 /tmp/general-conference.epub | sed -n '1p'
unzip -p /tmp/general-conference.epub mimetype | wc -c
```

Expected: no archive errors, first entry `mimetype`, and byte count `20`. Inspect `nav.xhtml` for conference/talk nesting and one chapter for the tested wrapper/footnote structure.

- [ ] **Step 3: Check remote state before deployment**

Use the project SSH key to inspect `git status`, current commit, free disk, service status, and database path on `daniel@chasmfiend.local`. Stop and report if remote source has unrelated changes that deployment would overwrite.

- [ ] **Step 4: Back up and deploy**

Create a consistent SQLite backup even though this release has no migration. Transfer only reviewed source/build inputs, build the release binary and frontend on `chasmfiend.local`, and restart `chinese-reader` through systemd. Do not copy the local Mac database.

- [ ] **Step 5: Verify production behavior**

Confirm `https://localhost/health` returns `ok`, request the live General Conference EPUB, repeat archive checks, verify the shelf button in the browser, and record one untimed manual session against a disposable/test text or roll back that test row immediately after verification.

- [ ] **Step 6: Perform the final Scribe smoke test**

Send the production-generated EPUB to the Scribe and confirm nested navigation, popup definition, **Go to footnote**, forced definition page, and exact **Back to reading** behavior match the approved prototype.
