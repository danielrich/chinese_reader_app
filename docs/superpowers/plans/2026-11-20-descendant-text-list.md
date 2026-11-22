# Ordered Descendant Text List Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution.

**Goal:** Show all book sections in chapter order from the book shelf.
**Architecture:** Optional recursive SQLite list with depth-first shelf ordering; shelf UI and offline download request recursion. Version parent navigation cache keys and propagate local read status to cached ancestors.
**Tech Stack:** Rust/rusqlite, TypeScript, Playwright.
**Spec:** docs/superpowers/specs/2026-11-20-descendant-text-list-design.md

## Global Constraints
Preserve content and ownership. Existing direct list API behavior remains default. Do not overwrite unrelated local or server edits.

## Review Focus
- Chapter 2 versus 10, equal and negative shelf sort positions: stable hierarchical shelf order.
- Empty and nested descendants: depth-first listing excludes unrelated books.
- Parent caches from old releases: cannot render empty direct list as recursive list.
- Finishing from book view: parent and owning chapter show Read offline.
- Caching from a series: intermediate book lists include descendant sections offline.

### Task 1: Ordered backend list
- [x] Add and run failing Rust regression for direct/recursive ordering and read status.
- [x] Implement optional include_descendants in text.rs and HTTP dispatch.
- [x] Run Rust suite.

### Task 2: UI and offline navigation
- [x] Add and run failing browser tests for book listing, cross-chapter Next, Back, offline list, and completed-read propagation.
- [x] Update library API and shelf view, cache keys, offline collection, completion updates.
- [x] Build and run browser suite.

### Task 3: Deploy
- [x] Compare changed source against server; build/test Linux candidate without overwriting active files.
- [ ] Retain rollback files, activate matching server/frontend, verify live book list and health.

Execution: user authorized this specific shelf behavior. Work in current checkout, preserving its existing UI edits. No additional approval gate for routine implementation.

## Validation and pending activation

Local Rust suite: 78 library and 3 server tests pass; one pre-existing documentation test ignored. Workspace browser suite: 66 pass. Exact deployment candidate (excluding unrelated pending shelf-navigation/CSS changes): 64 pass; final expanded book-specific suite: 5 pass, including legacy direct-cache rejection. Desktop and mobile screenshots inspected.

Linux release build succeeded in /tmp/chinese-reader-descendants-20261120, with copied compilation cache and no changes to the running binary. Linux API verified against a synthetic database: direct list stays empty for a parent, recursive list returns chapter 2 sections before chapter 10. A proposed runtime test against a private library snapshot was rejected by automatic review because the temporary server binds all interfaces; this was replaced with synthetic-only runtime validation. No private library snapshot was created or served.

The four existing remote source files match local HEAD; the deployment candidate changes only text.rs, server.rs, library.ts, and library-view.ts. It excludes unrelated pending local styling changes. The running service is active and unchanged. Activation script, baseline/candidate SHA-256 manifests, and built frontend/backend are staged on chasmfiend. Script validates manifests, backs up existing source/binary/dist, activates matching files, restarts the service, verifies live ordered book IDs against the database, and rolls back on failure.

Activation remains pending because chinese-reader.service runs as root and daniel's noninteractive SSH sudo requires authentication. Run from the Mac:

```bash
ssh -t daniel@chasmfiend 'bash /tmp/chinese-reader-descendants-20261120/activate.sh'
```

The script obtains sudo authentication before changing live files. This is an OS privilege requirement, not a missing task authorization. No live reading data changed by this feature task.
