# Desktop Reading Focus Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan.

**Goal:** Widen desktop reading and automatically hide distractions on Start Reading.
**Architecture:** Keep session tracking in library-view.ts; add a reversible layout
state and responsive CSS. Dictionary panels appear only when a lookup is open.
**Tech Stack:** TypeScript, CSS, Playwright, Vite.
**Spec:** docs/superpowers/specs/2026-11-16-desktop-reading-focus-design.md

## Global Constraints

- Preserve the mobile layout (700px and below).
- No dependencies; use semantic CSS tokens for new UI.
- Exiting Focus does not stop or pause a reading session.

## Review Focus

- Starting from another text tab must display Content in Focus mode.
- Finishing/discarding must restore navigation and allow starting again.
- Escape must restore layout without losing the timer or text position.
- Dictionary lookups must remain visible and closable in Focus mode.
- A narrow/mobile viewport must not inherit desktop-only hidden navigation.

### Task 1: Desktop reading layout and Focus mode

**Files:** src/views/library-view.ts, src/style.css, tests/reading-focus.spec.ts.
**Interfaces:** setReadingFocus(enabled: boolean): void handles reversible layout;
existing reading-session functions continue to own timer state.

- [x] Add browser tests using mocked API responses and real local session storage.
- [x] Verify tests fail because Focus mode and wider reading do not exist.
- [x] Implement desktop widths, on-demand dictionary, Focus toolbar and lifecycle.
- [x] Run npm run test:offline and inspect the rendered desktop/mobile layouts.
- [x] Review diff and leave changes available for the user.

### Task 2: Deploy to chasmfiend

- [x] Inspect the documented deployment path and service.
- [x] Copy the verified build with scp and activate it on chasmfiend.
- [x] Verify the remote server returns the updated application assets.

## Verification and deployment record

- `npm run test:offline`: production build succeeded; all 26 browser tests passed.
- Review found a long-title flex sizing issue; the 800px regression test failed
  before the fix and passed after adding `min-width: 0` to the title flex item.
  Follow-up review confirmed the fix with no remaining findings.
- Deployed with scp to `/home/daniel/exper/chinese_reader_app/dist` on chasmfiend,
  retaining previous hashed assets. Synchronized the two changed source files
  and the new browser test to the remote checkout.
- Previous frontend retained at `dist.before-reader-focus-20261116` beside `dist`.
- Restarted `chinese-reader`; confirmed active/running and `/health` returned `ok`.
  Live HTML, service-worker, JavaScript and CSS SHA-256 hashes matched the local
  build. The previous JavaScript asset remained accessible.
- Live browser smoke check passed: manual Focus used a 1416×932 reading area
  inside a 1440×1000 viewport, and Escape restored navigation. The check did
  not start or alter a reading session.
- At the user's request, installed the existing app-specific public key in
  the remote account's authorized keys and configured local SSH aliases
  `chasmfiend` and `chasmfiend.local` to select that key. Verified BatchMode SSH.
  Preserved backups of both SSH configuration files before editing.
- Existing systemd state reported `NeedDaemonReload=yes`; restarted using the
  loaded service configuration without changing the pending unit definitions.

## Follow-up: imported fixed-width lines

The user reported books remaining narrow after widening the reader. Read-only
inspection of the live library found imported Wheel of Time chapters with
28–30-character source lines, including breaks inside words and sentences.
The renderer converted every source newline into a forced HTML line break.

Added `src/lib/text-layout.ts` to conservatively detect fixed-width Chinese
prose and suppress likely continuation breaks in the display. Stored texts,
cached segments, exports and analysis remain unchanged. Blank lines, short
lines, sentence endings, ordinary prose and short verse retain their breaks.
Affected chapters offer an Original line breaks checkbox to restore formatting.
The same rendering path handles cached and fresh segments, including split CRLF.

The browser reproduction failed before the fix: character 31 started a new row.
Afterward it shares the first row, and character 56 is over 900px farther right.
Tests also verify paragraph separation, restoring original breaks and verse.
Real chapters 132/133/134 detect 45/376/223 artificial break characters;
ordinary prose sample 7170 detects none. Review found no important issues.

`npm run test:offline` passed all 28 tests. Deployed the verified build and
matching source via scp, retaining `dist.before-reflow-20261116` for rollback
and previous hashed assets for existing clients. Restarted the daemon; health
and live asset checksums passed. Live browser verification on chapter 133 in
a 1440px window measured the rendered text reaching x=1394px with reflow,
versus x=608px with Original line breaks checked. Toggling back restored reflow.
No reading session was started and no stored book content was modified.
