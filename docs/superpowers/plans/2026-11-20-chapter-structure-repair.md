# Chapter Structure Repair Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement inline.

**Goal:** Repair chapter hierarchy without losing reading history.
**Architecture:** A Python SQLite maintenance command previews selected books, validates combined chapter positions, backs up, then moves unsplit texts into chapter shelves atomically. Optional source title order resolves ambiguous positions.
**Tech Stack:** Python standard library, SQLite.
**Spec:** docs/superpowers/specs/2026-11-20-chapter-structure-repair-design.md

## Global Constraints
Preserve existing text IDs, content, titles, sections, and reading history. No unrelated edits. No guessing ambiguous chapter order. Preview by default. Backup before mutation.

## Review Focus
- Equal sort positions: reject unless a complete source order is supplied.
- Unrelated/nested child shelves: reject.
- Repeated repair: no additional shelves.
- Failure midway: roll back all books.
- Existing sessions/analysis: preserve exact rows.

### Task 1: Repair command
Files: scripts/repair_chapter_structure.py; scripts/test_repair_chapter_structure.py; scripts/README.md.
- [x] Write regression tests for the five review cases, preview, missing DB, and backup.
- [x] Run unittest and observe missing repair implementation.
- [x] Implement plan_book(conn, shelf_id, source_order=None) and repair_database(path, shelf_ids, apply=False, source_orders=None, backup_dir=None), with read-only default and atomic application.
- [x] Run full Python unittest discovery for scripts and document command.

### Task 2: Apply and verify
- [x] Preview the available database; identify active database with user.
- [x] Apply to selected mixed book shelves with backup; compare protected data to backup and verify same-level ordered chapters.

Execution ruling: proceed in current checkout with new maintenance files only; preserve existing UI edits. User already authorized the concrete structure repair. No additional plan approval required.

Validation: 10 maintenance tests pass. Full database-copy rehearsal moved 14 texts across shelves 208, 210, 278, and 292, with bidirectional SQL EXCEPT comparisons proving protected text columns and all session, analysis, frequency, and known-word rows unchanged. Second application was a no-op. EPUB NCX order matches all 48 Stormlight I upper-volume entries, 28 Martian entries, and 47 Steelheart entries. The initial local rehearsal did not modify live data; see completed live application below.

## Live application

Applied over authorized SSH to daniel@chasmfiend on 2026-11-20. Active database: /home/daniel/.local/share/com.chinesereader.ChineseReader/dictionary.db.

Repaired mixed book shelves 6, 208, 210, 278, and 292 (50, 48, 28, 18, and 47 chapter shelves respectively). Created 15 chapter shelves and moved the 15 existing direct texts, preserving all existing content and section boundaries. Other Stormlight volumes already had uniform chapter levels and were left as stored.

Backup: /home/daniel/.local/share/com.chinesereader.ChineseReader/backups/dictionary.db.backup-20261120T234329996714Z.

Bidirectional SQL EXCEPT comparisons against the backup confirmed unchanged protected text fields, all 160 reading sessions, 5,217 text analyses, 3,612,313 character frequency rows, 1,544,235 word frequency rows, and 5,822 known-word rows. Every repaired book has no direct texts and has consecutive chapter shelf positions. SQLite quick_check and foreign_key_check passed. A second preview requires no changes. Refresh the app online to update navigation caches.
