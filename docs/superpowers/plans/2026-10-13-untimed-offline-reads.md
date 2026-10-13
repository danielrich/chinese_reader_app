# Untimed Offline Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a manual offline read to omit duration while still recording completion, characters, first-read status, and streak participation.

**Architecture:** Keep the existing invoke command and nullable database columns. Make duration optional across Rust and TypeScript, branch only the time/speed calculations, and make the modal expose blank optional time inputs behind an explicit disclosure.

**Tech Stack:** Rust 1.77.2, rusqlite, TypeScript 5.9, DOM UI, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-13-shelf-epub-export-and-untimed-offline-reads-design.md`

## Global Constraints

- No database migration: `duration_seconds` and `characters_per_minute` are already nullable.
- Missing or JSON `null` duration means untimed; a supplied zero or negative duration is invalid.
- Untimed sessions must count toward completion, characters, first-read totals, and streaks without contributing speed or elapsed time.
- Timed manual logging must retain its existing proportional split and CPM behavior.
- The unrelated untracked `docs/superpowers/plans/2026-08-20-performance-and-nightly-analysis.md` must remain untouched.

## Review Focus

- A caller that sends `null` duration gets null metrics rather than a validation error; Task 1 adds a Rust test.
- A caller that sends numeric zero is rejected rather than silently treated as untimed; Task 1 adds a Rust test.
- Multiple untimed texts each record their full character count and completed status; Task 1 adds a two-text test.
- Blank UI inputs serialize as `null`, while one positive field serializes the combined seconds; Task 2 adds Playwright assertions on request JSON.
- Reading history does not render misleading `0s` or `0 chars/min` for an untimed session; Task 2 adds a browser assertion.

---

### Task 1: Persist untimed completed sessions

**Files:**
- Modify: `src-tauri/src/library/speed.rs:70-76,688-815,1360-1430`

**Interfaces:**
- Consumes: existing `reading_sessions.duration_seconds` and `characters_per_minute` nullable columns.
- Produces: `ManualLogInput { total_duration_seconds: Option<i64> }` and `log_offline_read(&Connection, ManualLogInput) -> Result<Vec<ReadingSession>>` supporting timed and untimed rows.

- [ ] **Step 1: Write failing Rust tests for untimed persistence and invalid numeric durations**

Add tests beside the existing manual-log tests:

```rust
#[test]
fn test_log_offline_read_without_duration_preserves_completion_metrics() {
    let conn = setup_manual_log_db();
    let sessions = log_offline_read(&conn, ManualLogInput {
        text_ids: vec![1, 2],
        finished_at: "2026-10-13T18:00:00Z".into(),
        total_duration_seconds: None,
        source: Some("physical_book".into()),
    }).unwrap();

    assert_eq!(sessions.len(), 2);
    for session in &sessions {
        assert!(session.is_complete);
        assert!(session.is_manual_log);
        assert_eq!(session.started_at, "2026-10-13T18:00:00+00:00");
        assert_eq!(session.duration_seconds, None);
        assert_eq!(session.characters_per_minute, None);
    }
    assert_eq!(sessions.iter().map(|s| s.character_count).sum::<i64>(), 3000);
    assert!(sessions.iter().all(|s| s.is_first_read));
}

#[test]
fn test_log_offline_read_rejects_supplied_zero_duration() {
    let conn = setup_manual_log_db();
    let result = log_offline_read(&conn, ManualLogInput {
        text_ids: vec![1],
        finished_at: "2026-10-13T18:00:00Z".into(),
        total_duration_seconds: Some(0),
        source: None,
    });
    assert!(matches!(result, Err(LibraryError::InvalidInput(_))));
}
```

Extract the repeated two-text setup from `test_log_offline_read_multiple_texts` into `setup_manual_log_db()`. Change existing timed fixtures to `Some(3000)` and `Some(600)`.

- [ ] **Step 2: Run the focused tests and confirm the type/behavior failure**

Run: `cd src-tauri && cargo test --lib library::speed::tests::test_log_offline_read -- --nocapture`

Expected: FAIL because `total_duration_seconds` is still `i64` and untimed values cannot be represented.

- [ ] **Step 3: Implement optional-duration branching**

Change the input field to:

```rust
pub total_duration_seconds: Option<i64>,
```

Validate only supplied values:

```rust
if input.total_duration_seconds.is_some_and(|seconds| seconds <= 0) {
    return Err(LibraryError::InvalidInput("Duration must be positive".into()));
}
```

Inside the text loop, calculate nullable values:

```rust
let (started_at, duration_seconds, characters_per_minute) =
    if let Some(total_seconds) = input.total_duration_seconds {
        let seconds = (total_seconds as f64 * (char_count as f64 / total_chars as f64))
            .round() as i64;
        let seconds = seconds.max(1);
        (
            finished_at - chrono::Duration::seconds(seconds),
            Some(seconds),
            Some(char_count as f64 / (seconds as f64 / 60.0)),
        )
    } else {
        (finished_at, None, None)
    };
```

Bind the two options directly into the existing insert. Leave character, completion, cumulative, vocabulary snapshot, manual/source, and first-read logic unchanged.

- [ ] **Step 4: Add aggregate assertions for streak and daily characters**

Extend the untimed test:

```rust
let volumes = get_daily_reading_volume(&conn, 30).unwrap();
let volume = volumes.iter().find(|v| v.sessions_count == 2).unwrap();
assert_eq!(volume.characters_read, 3000);
assert_eq!(volume.reading_seconds, 0);
```

Use a dynamically generated RFC3339 timestamp for today in this test so `get_reading_streak()` can assert `read_today` and `current_streak >= 1` without depending on a historical date.

- [ ] **Step 5: Run the Rust library suite**

Run: `cd src-tauri && cargo test --lib`

Expected: PASS, including existing proportional-duration tests.

- [ ] **Step 6: Commit the backend behavior**

```bash
git add src-tauri/src/library/speed.rs
git commit -m "feat: support untimed offline reads"
```

### Task 2: Make duration optional in the modal and history

**Files:**
- Modify: `src/lib/speed.ts:155-165`
- Modify: `src/views/library-view.ts:1040-1100,2110-2310`
- Create: `tests/manual-offline-read.spec.ts`

**Interfaces:**
- Consumes: backend `ManualLogInput.total_duration_seconds: Option<i64>` from Task 1.
- Produces: `ManualLogInput.total_duration_seconds: number | null`, a collapsed `#offline-duration-fields` control, and history rendering that omits unavailable metrics.

- [ ] **Step 1: Write a browser test for the blank default and null request**

Create a focused Playwright test that mocks `get_shelf_tree`, `list_texts_in_shelf`, `get_text`, `segment_text`, `get_text_reading_history`, and `log_offline_read`. Capture the `log_offline_read` request body, navigate Library → shelf → text → **Log offline read**, then assert:

```ts
await expect(page.locator("#offline-duration-fields")).toBeHidden();
await expect(page.locator("#duration-hours")).toHaveValue("");
await expect(page.locator("#duration-minutes")).toHaveValue("");
await page.locator("#offline-save-btn").click();
expect(captured.input.total_duration_seconds).toBeNull();
```

Add a second test that expands **Add reading time**, fills `1` hour and `5` minutes, saves, and expects `3900`.

- [ ] **Step 2: Run the browser test and verify the prefilled-duration failure**

Run: `npm run build && npx playwright test tests/manual-offline-read.spec.ts`

Expected: FAIL because the current modal is visible, prefilled with 30 minutes, and blocks zero duration.

- [ ] **Step 3: Implement the optional duration UI and request type**

Change the TypeScript interface:

```ts
total_duration_seconds: number | null;
```

Render an **Add reading time** button followed by a hidden `#offline-duration-fields` container. Both numeric inputs start with `value=""`. The disclosure button toggles the container and `aria-expanded`.

In `saveOfflineLog`, distinguish blank from numeric input:

```ts
const hasDuration = hoursInput.value.trim() !== "" || minutesInput.value.trim() !== "";
const totalSeconds = hasDuration
  ? (Number(hoursInput.value || 0) * 3600) + (Number(minutesInput.value || 0) * 60)
  : null;
if (hasDuration && (!Number.isFinite(totalSeconds) || totalSeconds! <= 0)) {
  alert("Reading time must be greater than zero, or leave both fields blank.");
  return;
}
```

Pass `total_duration_seconds: totalSeconds` without changing the selected text, date, or source behavior.

- [ ] **Step 4: Add a failing browser assertion for untimed history**

Mock a completed manual session with `duration_seconds: null` and `characters_per_minute: null`. Open History and assert `Logged` and `Characters` are visible while `Duration`, `chars/min`, `0s`, and `0 chars/min` are absent.

- [ ] **Step 5: Implement conditional history metrics**

Render time/speed spans only when their values are non-null:

```ts
const timedStats = session.duration_seconds !== null && session.characters_per_minute !== null
  ? `...existing Duration and chars/min spans...`
  : "";
```

Always render the character-count span.

- [ ] **Step 6: Run frontend verification**

Run: `npm run build`

Expected: PASS.

Run: `npx playwright test tests/manual-offline-read.spec.ts`

Expected: PASS.

Run: `npm run test:offline`

Expected: PASS for the full browser suite.

- [ ] **Step 7: Commit the frontend behavior**

```bash
git add src/lib/speed.ts src/views/library-view.ts tests/manual-offline-read.spec.ts
git commit -m "feat: make offline reading time optional"
```

### Task 3: Verify the independently shippable change

**Files:**
- No production files expected.

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: a green untimed-offline-read deliverable ready to combine with the EPUB plan.

- [ ] **Step 1: Run all local verification**

```bash
cd src-tauri && cargo test --lib
cd .. && npm run build
npm run test:offline
```

Expected: all commands exit 0 with no ignored failure.

- [ ] **Step 2: Review the diff for scope and null handling**

Run: `git diff HEAD~2 --check && git diff HEAD~2 -- src-tauri/src/library/speed.rs src/lib/speed.ts src/views/library-view.ts tests/manual-offline-read.spec.ts`

Confirm no schema migration, no fabricated zero metrics, and no unrelated changes.

