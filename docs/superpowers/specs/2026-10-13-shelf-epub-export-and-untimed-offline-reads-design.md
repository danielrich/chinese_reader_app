# Shelf EPUB Export and Untimed Offline Reads Design

**Date:** 2026-10-13
**Status:** Approved for implementation planning

## Goal

Make a library shelf portable to an e-reader as one navigable EPUB while making offline reading logs quick to record when elapsed time is unknown. A shelf export preserves the selected shelf's descendants and texts as a nested Kindle table of contents. An untimed offline read still records completion, characters read, first-read state, and streak participation without contributing fabricated duration or speed data.

## Scope

This change adds:

- An **Export as EPUB** action on every shelf.
- A server endpoint that generates and downloads one EPUB for the selected shelf subtree.
- Optional rather than mandatory duration fields in the existing offline-read modal.
- Backend support for completed manual reading sessions whose duration and speed are unknown.

It does not send files directly to an Amazon account, manage Kindle Collections, export vocabulary or analysis data, synchronize Kindle annotations back into Chinese Reader, or add PDF export.

## EPUB export

### User experience

The shelf action downloads `<shelf-name>.epub`. The user can open it locally or deliver it through Amazon Send to Kindle.

The selected shelf becomes the book title and top-level navigation entry. Child shelves become nested sections in their existing display order. Texts become readable chapters in their existing display order. Texts directly attached to the selected shelf appear before its child shelves, matching the app's shelf view. Empty shelves may appear as navigation sections only when they have a non-empty descendant; completely empty branches are omitted.

For example, exporting `總會大會` produces one book with conference shelves as sections and talks as chapters. Exporting `2026年十月總會大會` produces a smaller book containing only that conference and its talks.

The button is disabled while a download is being prepared and reports a concise error if generation fails. No database state changes during export.

### Server architecture

Add a dedicated read-only route:

```text
GET /api/shelves/:id/export.epub
```

The handler loads the requested shelf, its descendant shelves, and all subtree texts using deterministic `sort_order, name/id` ordering. It passes a self-contained export model to an EPUB builder module. The builder has no HTTP or database responsibilities, which keeps book generation directly unit-testable.

The response uses `application/epub+zip` and a UTF-8-safe `Content-Disposition` filename. Generation runs in `spawn_blocking` so database and ZIP work do not block Axum's async executor. The export is assembled in memory for the initial version; current shelf sizes are comfortably below Send to Kindle's file-size limit. A clear internal size guard prevents unbounded allocation and returns an error rather than exhausting the server.

### EPUB structure

Generate an EPUB 3 document with:

- An uncompressed `mimetype` entry first in the ZIP archive.
- `META-INF/container.xml`.
- Package metadata with title, language `zh`, a generated identifier, and modification timestamp.
- One XHTML content document per text.
- A linked, visible contents page.
- An EPUB navigation document whose nested ordered lists mirror the shelf hierarchy.
- A linear spine containing chapters in depth-first display order.
- Minimal embedded CSS optimized for horizontal Chinese reading on e-ink.

Shelf names, titles, authors, and text content are escaped as XML. Plain-text paragraphs are produced by splitting stored content on blank lines and line breaks; source text is never interpreted as markup. Shelf sections without direct prose link to their first descendant chapter. Authors are rendered beneath chapter titles when present.

The implementation uses a small ZIP dependency and explicit EPUB files rather than a browser-side generator. This centralizes database traversal, avoids downloading every chapter as separate API calls, and makes the same export available to any browser client.

### Failure behavior

- Unknown shelf: `404`.
- Shelf subtree with no texts: `400` with a user-readable message.
- Invalid XML characters are removed while valid Unicode, including CJK extension characters, is retained.
- Oversized export or ZIP/build failure: `500` with a concise response; partial files are never returned.
- A failed export leaves the database and shelf UI unchanged.

## Untimed offline reading

### Modal behavior

The offline-read modal no longer pre-fills 30 minutes. Reading time is optional and initially collapsed behind **Add reading time**. Expanding it reveals blank hours and minutes inputs.

If both fields remain blank, saving records an untimed read. If either field is entered, the combined duration must be positive and the current proportional duration/speed behavior remains unchanged. The completion datetime continues to default to now. Text selection and source selection retain their existing behavior.

### API and persistence semantics

Change `total_duration_seconds` in the TypeScript and Rust manual-log input types from required integer to optional integer.

For an untimed manual read, create one completed session per selected text with:

- `started_at` equal to `finished_at` as a neutral event timestamp.
- `finished_at` set to the chosen completion time.
- `duration_seconds = NULL`.
- `characters_per_minute = NULL`.
- `character_count` copied from the text.
- Existing cumulative-character, first-read, known-vocabulary snapshot, manual-log, source, and completion fields calculated exactly as they are today.

These sessions count toward unread/completed state, daily characters, first-read totals, and reading streaks. SQL speed and elapsed-time aggregates continue to ignore their null metrics. A timed manual read retains the existing proportional split across selected texts.

History renders an untimed manual session as **Logged** with its character count and source, but no Time or Speed values. Timed manual sessions keep those values.

## API and frontend integration

The frontend export function uses a normal browser navigation/download request rather than the JSON `invoke` wrapper. It validates HTTP errors before saving the returned blob and derives the filename from `Content-Disposition` with a shelf-name fallback.

The service worker does not cache EPUB responses. Export requires a connection to the Chinese Reader server; it does not need public internet access.

The existing offline-log call remains an invoke-style JSON command. Older callers that send a positive duration remain compatible. Missing or JSON `null` duration selects the new untimed path; zero or negative numeric durations remain invalid so malformed timed submissions cannot silently become untimed.

## Testing

Rust unit tests cover:

- Recursive shelf/text ordering in the export model.
- Escaping titles, authors, and Chinese text into valid XHTML/XML.
- Required EPUB ZIP entries and the uncompressed first `mimetype` entry.
- Nested navigation matching a multi-level shelf tree.
- Empty and missing shelf errors.
- Untimed manual logs producing completed sessions with null duration/speed while preserving characters, first-read state, and streak eligibility.
- Timed manual logs retaining proportional duration and CPM behavior.
- Rejecting zero and negative supplied durations.

Server tests cover EPUB response content type, filename headers, unknown/empty shelves, and route read-only behavior.

Frontend/browser tests cover the shelf button, successful download request, visible export failure, the collapsed optional-time control, saving an untimed read, and saving a timed read. Existing Rust, TypeScript build, and Playwright offline tests must remain green.

Validate a generated General Conference EPUB with an EPUB validator when available, inspect its nested TOC in Kindle Previewer, and perform one Send to Kindle smoke test on the Scribe after deployment.

## Deployment and rollback

No database migration is required because reading-session duration and speed columns are already nullable. Deploy the rebuilt Rust server and frontend to `chasmfiend.local`, restart `chinese-reader`, confirm `/health`, then test one untimed log and one shelf download against the live service.

Rollback restores the previous frontend and server binary. Untimed session rows remain valid under the existing schema, although the previous UI will not create new ones.
