# Phase 1: Offline Read Log + Shelf Unread Badges — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add shelf unread count badges and an offline read log modal to the existing Tauri desktop app.

**Architecture:** Two independent Rust backend additions (unread count query, manual session insert) with corresponding Tauri commands, TypeScript invokers, and frontend UI changes. One DB migration adds two nullable columns to `reading_sessions`.

**Tech Stack:** Rust + rusqlite (backend), Tauri commands, TypeScript (frontend), SQLite migrations via existing pattern in `schema.rs`.

**Spec:** `docs/superpowers/specs/2026-04-25-cross-device-reader-design.md` — Phase 1 section.

---

## File Map

| File | Change |
|---|---|
| `src-tauri/src/dictionary/schema.rs` | Add migration: `is_manual_log`, `source` columns on `reading_sessions` |
| `src-tauri/src/library/models.rs` | Add `unread_count: i64` field to `ShelfTree` |
| `src-tauri/src/library/shelf.rs` | Add `get_unread_counts()`, update `build_shelf_tree()` |
| `src-tauri/src/library/speed.rs` | Add `ManualLogInput` struct + `log_offline_read()` function |
| `src-tauri/src/library/text.rs` | Add `search_texts()` function (needed for modal text picker) |
| `src-tauri/src/commands/library.rs` | Add `search_texts` command |
| `src-tauri/src/commands/speed.rs` | Add `log_offline_read` command |
| `src-tauri/src/library/mod.rs` | Re-export `ManualLogInput` |
| `src-tauri/src/lib.rs` | Register 2 new commands |
| `src/lib/speed.ts` | Add `is_manual_log`/`source` to `ReadingSession`, add `ManualLogInput` type + `logOfflineRead` invoker |
| `src/lib/library.ts` | Add `searchTexts` invoker |
| `src/views/library-view.ts` | Update `renderShelfNodes`, add "Log offline read" button + modal, update session history rendering |
| `src/style.css` | Amber unread count color, text chip styles, offline log modal form styles |

---

## Task 1: DB Migration — `is_manual_log` and `source` columns

**Files:**
- Modify: `src-tauri/src/dictionary/schema.rs`

The existing migration pattern (lines ~384–439) uses `PRAGMA table_info` to check before `ALTER TABLE`. Follow the same pattern.

- [ ] **Step 1: Write the failing test**

Add to the bottom of `src-tauri/src/dictionary/schema.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn).unwrap();
        conn
    }

    #[test]
    fn test_reading_sessions_has_manual_log_columns() {
        let conn = test_db();
        // Insert a row using the new columns — will fail if columns don't exist
        conn.execute(
            "INSERT INTO reading_sessions
             (text_id, started_at, character_count, is_manual_log, source)
             VALUES (1, '2026-01-01T00:00:00Z', 100, 1, 'physical_book')",
            [],
        ).unwrap();

        let (is_manual, source): (i64, String) = conn.query_row(
            "SELECT is_manual_log, source FROM reading_sessions WHERE rowid = last_insert_rowid()",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();

        assert_eq!(is_manual, 1);
        assert_eq!(source, "physical_book");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src-tauri && cargo test test_reading_sessions_has_manual_log_columns -- --nocapture
```

Expected: FAIL — `table reading_sessions has no column named is_manual_log`

- [ ] **Step 3: Add migration in `run_migrations()`**

Find the `run_migrations` function (around line 358). Add these two migrations after the last existing one:

```rust
// Migration: add is_manual_log to reading_sessions
let has_manual_log: bool = conn
    .query_row(
        "SELECT COUNT(*) FROM pragma_table_info('reading_sessions') WHERE name = 'is_manual_log'",
        [],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0) > 0;

if !has_manual_log {
    conn.execute_batch(
        "ALTER TABLE reading_sessions ADD COLUMN is_manual_log INTEGER NOT NULL DEFAULT 0;",
    )?;
}

// Migration: add source to reading_sessions
let has_source: bool = conn
    .query_row(
        "SELECT COUNT(*) FROM pragma_table_info('reading_sessions') WHERE name = 'source'",
        [],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0) > 0;

if !has_source {
    conn.execute_batch(
        "ALTER TABLE reading_sessions ADD COLUMN source TEXT;",
    )?;
}
```

Also add both columns to the `CREATE TABLE IF NOT EXISTS reading_sessions` statement so fresh DBs get them too. Add before the `FOREIGN KEY` line:

```sql
    is_manual_log INTEGER NOT NULL DEFAULT 0,
    source TEXT,
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd src-tauri && cargo test test_reading_sessions_has_manual_log_columns -- --nocapture
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/dictionary/schema.rs
git commit -m "feat: add is_manual_log and source columns to reading_sessions"
```

---

## Task 2: Rust — Shelf Unread Counts

**Files:**
- Modify: `src-tauri/src/library/models.rs` (add field to `ShelfTree`)
- Modify: `src-tauri/src/library/shelf.rs` (add query + wire into `build_shelf_tree`)

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/library/shelf.rs` (bottom of file, inside or alongside existing `#[cfg(test)]`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictionary::schema::init_database;
    use rusqlite::Connection;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn).unwrap();
        // Create a shelf and two texts, complete a session on one
        conn.execute("INSERT INTO shelves (id, name, sort_order) VALUES (1, 'Test', 0)", []).unwrap();
        conn.execute("INSERT INTO texts (id, shelf_id, title, content, character_count) VALUES (1, 1, 'Text A', 'content', 100)", []).unwrap();
        conn.execute("INSERT INTO texts (id, shelf_id, title, content, character_count) VALUES (2, 1, 'Text B', 'content', 200)", []).unwrap();
        // Only text 1 has a completed session
        conn.execute(
            "INSERT INTO reading_sessions (text_id, started_at, character_count, is_complete)
             VALUES (1, '2026-01-01T00:00:00Z', 100, 1)",
            [],
        ).unwrap();
        conn
    }

    #[test]
    fn test_unread_count_excludes_completed_texts() {
        let conn = setup();
        let counts = get_unread_counts(&conn, &[1]).unwrap();
        // Shelf 1 has 2 texts, 1 completed → 1 unread
        assert_eq!(counts.get(&1), Some(&1));
    }

    #[test]
    fn test_unread_count_zero_when_all_read() {
        let conn = setup();
        conn.execute(
            "INSERT INTO reading_sessions (text_id, started_at, character_count, is_complete)
             VALUES (2, '2026-01-01T00:00:00Z', 200, 1)",
            [],
        ).unwrap();
        let counts = get_unread_counts(&conn, &[1]).unwrap();
        assert_eq!(counts.get(&1), Some(&0));
    }
}
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd src-tauri && cargo test test_unread_count -- --nocapture
```

Expected: FAIL — `cannot find function get_unread_counts`

- [ ] **Step 3: Add `unread_count` field to `ShelfTree`**

In `src-tauri/src/library/models.rs`, update the `ShelfTree` struct:

```rust
pub struct ShelfTree {
    pub shelf: Shelf,
    pub children: Vec<ShelfTree>,
    pub text_count: i64,
    pub unread_count: i64,   // ← add this
}
```

- [ ] **Step 4: Add `get_unread_counts()` to `shelf.rs`**

Add this function to `src-tauri/src/library/shelf.rs` (before `build_shelf_tree`):

```rust
/// Returns unread text counts (texts with no completed reading session) for the given shelf IDs.
/// Does NOT recurse — call with all shelf IDs and aggregate in Rust.
pub fn get_unread_counts(
    conn: &Connection,
    shelf_ids: &[i64],
) -> Result<std::collections::HashMap<i64, i64>> {
    if shelf_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }

    // Build parameterized placeholders: ?,?,?
    let placeholders = shelf_ids
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");

    let sql = format!(
        "SELECT t.shelf_id, COUNT(*) as unread
         FROM texts t
         WHERE t.shelf_id IN ({})
           AND NOT EXISTS (
               SELECT 1 FROM reading_sessions rs
               WHERE rs.text_id = t.id AND rs.is_complete = 1
           )
         GROUP BY t.shelf_id",
        placeholders
    );

    let params: Vec<&dyn rusqlite::ToSql> = shelf_ids
        .iter()
        .map(|id| id as &dyn rusqlite::ToSql)
        .collect();

    let mut stmt = conn.prepare(&sql)?;
    let mut map = std::collections::HashMap::new();

    // Initialise all shelves to 0 so shelves with no unread still appear
    for &id in shelf_ids {
        map.insert(id, 0i64);
    }

    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
    })?;

    for row in rows {
        let (shelf_id, count) = row?;
        map.insert(shelf_id, count);
    }

    Ok(map)
}
```

- [ ] **Step 5: Update `build_shelf_tree()` to populate `unread_count`**

The current `build_shelf_tree` is recursive and called per-shelf. To avoid N+1 queries, we compute unread counts once at the top level in `get_shelf_tree`. Find `get_shelf_tree` (the public entry point) in `shelf.rs` and update it:

```rust
pub fn get_shelf_tree(conn: &Connection) -> Result<Vec<ShelfTree>> {
    let root_shelves = list_root_shelves(conn)?;
    let mut trees: Vec<ShelfTree> = root_shelves
        .into_iter()
        .map(|shelf| build_shelf_tree(conn, shelf))
        .collect::<Result<Vec<_>>>()?;

    // Collect all shelf IDs from the tree, fetch unread counts in one query
    let all_ids = collect_shelf_ids(&trees);
    let unread_counts = get_unread_counts(conn, &all_ids)?;
    apply_unread_counts(&mut trees, &unread_counts);

    Ok(trees)
}

fn collect_shelf_ids(trees: &[ShelfTree]) -> Vec<i64> {
    let mut ids = Vec::new();
    for tree in trees {
        ids.push(tree.shelf.id);
        ids.extend(collect_shelf_ids(&tree.children));
    }
    ids
}

/// Recursively sets unread_count on each node.
/// Parent unread_count = own unread + sum of children's unread_count.
fn apply_unread_counts(
    trees: &mut Vec<ShelfTree>,
    counts: &std::collections::HashMap<i64, i64>,
) {
    for tree in trees.iter_mut() {
        apply_unread_counts(&mut tree.children, counts);
        let own = counts.get(&tree.shelf.id).copied().unwrap_or(0);
        let children_sum: i64 = tree.children.iter().map(|c| c.unread_count).sum();
        tree.unread_count = own + children_sum;
    }
}
```

Also update `build_shelf_tree` to initialise the new field (it will be overwritten by `apply_unread_counts` but must compile):

```rust
fn build_shelf_tree(conn: &Connection, shelf: Shelf) -> Result<ShelfTree> {
    let text_count = get_text_count(conn, shelf.id)?;
    let children_shelves = list_child_shelves(conn, shelf.id)?;
    let children: Vec<ShelfTree> = children_shelves
        .into_iter()
        .map(|child| build_shelf_tree(conn, child))
        .collect::<Result<Vec<_>>>()?;

    Ok(ShelfTree {
        shelf,
        children,
        text_count,
        unread_count: 0,  // ← set by apply_unread_counts after the full tree is built
    })
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd src-tauri && cargo test test_unread_count -- --nocapture
```

Expected: PASS

- [ ] **Step 7: Build to catch any compile errors**

```bash
cd src-tauri && cargo build 2>&1 | head -40
```

Expected: no errors (warnings OK)

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/library/models.rs src-tauri/src/library/shelf.rs
git commit -m "feat: add unread_count to ShelfTree with single-query aggregation"
```

---

## Task 3: Frontend — Shelf Unread Badge

**Files:**
- Modify: `src/views/library-view.ts` (renderShelfNodes)
- Modify: `src/style.css`

- [ ] **Step 1: Update `renderShelfNodes` in `library-view.ts`**

Find line ~91 in `renderShelfNodes`:

```typescript
<span class="shelf-count">${node.text_count}</span>
```

Replace with:

```typescript
<span class="shelf-count">
  ${node.unread_count > 0
    ? `${node.text_count}<span class="shelf-count-sep">/</span><span class="shelf-unread">${node.unread_count}</span>`
    : node.text_count
  }
</span>
```

- [ ] **Step 2: Add CSS for unread count**

Add to `src/style.css` after the `.shelf-count` rule:

```css
.shelf-count-sep {
  color: #3a3a3a;
  margin: 0 1px;
}

.shelf-unread {
  color: #f59e0b;
  font-weight: 600;
}
```

- [ ] **Step 3: Verify in dev build**

```bash
cd /Users/daniel/exper/test_repo && npm run tauri dev
```

Navigate to a shelf that has unread texts. Expected: count shows as `37/12` with the `12` in amber. Shelf with all texts read shows just `37`. Parent shelves aggregate child unread counts.

- [ ] **Step 4: Commit**

```bash
git add src/views/library-view.ts src/style.css
git commit -m "feat: show total/unread badge on shelves in amber"
```

---

## Task 4: Text Search Command (needed for offline log modal)

**Files:**
- Modify: `src-tauri/src/library/text.rs` (same file as `list_texts_in_shelf` — add `search_texts` here)
- Modify: `src-tauri/src/commands/library.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)]` block in **`src-tauri/src/library/text.rs`** (alongside the function — standard Rust pattern):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictionary::schema::init_database;
    use rusqlite::Connection;

    #[test]
    fn test_search_texts_by_title() {
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn).unwrap();
        conn.execute("INSERT INTO shelves (id, name, sort_order) VALUES (1, 'S', 0)", []).unwrap();
        conn.execute("INSERT INTO texts (shelf_id, title, content, character_count) VALUES (1, '復活節講話', 'x', 50)", []).unwrap();
        conn.execute("INSERT INTO texts (shelf_id, title, content, character_count) VALUES (1, '信心與希望', 'x', 60)", []).unwrap();

        let results = search_texts(&conn, "復活").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "復活節講話");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd src-tauri && cargo test test_search_texts_by_title -- --nocapture
```

Expected: FAIL — `cannot find function search_texts`

- [ ] **Step 3: Add `search_texts()` function**

Add to `src-tauri/src/library/text.rs` (same file as `list_texts_in_shelf`):

```rust
/// Search texts across all shelves by title substring. Returns up to 50 results.
pub fn search_texts(conn: &Connection, query: &str) -> Result<Vec<crate::library::models::TextSummary>> {
    let pattern = format!("%{}%", query);
    let mut stmt = conn.prepare(
        "SELECT id, shelf_id, title, author, character_count, has_analysis, created_at
         FROM texts
         WHERE title LIKE ?1
         ORDER BY title
         LIMIT 50",
    )?;

    let rows = stmt.query_map([&pattern], |row| {
        Ok(crate::library::models::TextSummary {
            id: row.get(0)?,
            shelf_id: row.get(1)?,
            title: row.get(2)?,
            author: row.get(3)?,
            character_count: row.get(4)?,
            has_analysis: row.get::<_, i64>(5)? == 1,
            created_at: row.get(6)?,
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}
```

- [ ] **Step 4: Add Tauri command in `commands/library.rs`**

```rust
#[tauri::command]
pub fn search_texts(
    state: State<AppState>,
    query: String,
) -> CommandResult<Vec<library::models::TextSummary>> {
    let conn = state.db.lock().map_err(|e| CommandError::Database(e.to_string()))?;
    library::text::search_texts(&conn, &query).map_err(|e| CommandError::Database(e.to_string()))
}
```

- [ ] **Step 5: Register command in `src-tauri/src/lib.rs`**

Add to the `invoke_handler` list after `commands::list_texts_in_shelf`:

```rust
commands::search_texts,
```

- [ ] **Step 6: Run tests and build**

```bash
cd src-tauri && cargo test test_search_texts -- --nocapture
cd src-tauri && cargo build 2>&1 | head -20
```

Expected: tests PASS, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/library/text.rs src-tauri/src/commands/library.rs src-tauri/src/lib.rs
git commit -m "feat: add search_texts command for cross-shelf title search"
```

---

## Task 5: Rust — `log_offline_read` Function

**Files:**
- Modify: `src-tauri/src/library/speed.rs`

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/library/speed.rs` `#[cfg(test)]` block:

```rust
#[test]
fn test_log_offline_read_proportional_duration() {
    use crate::dictionary::schema::init_database;
    let conn = Connection::open_in_memory().unwrap();
    init_database(&conn).unwrap();

    conn.execute("INSERT INTO shelves (id, name, sort_order) VALUES (1, 'S', 0)", []).unwrap();
    // Text A: 1000 chars, Text B: 2000 chars → total 3000
    conn.execute("INSERT INTO texts (id, shelf_id, title, content, character_count) VALUES (1, 1, 'A', 'x', 1000)", []).unwrap();
    conn.execute("INSERT INTO texts (id, shelf_id, title, content, character_count) VALUES (2, 1, 'B', 'x', 2000)", []).unwrap();

    let finished_at = "2026-04-25T21:00:00Z".to_string();
    let input = ManualLogInput {
        text_ids: vec![1, 2],
        finished_at: finished_at.clone(),
        total_duration_seconds: 3000, // 50 minutes
        source: Some("physical_book".to_string()),
    };

    let sessions = log_offline_read(&conn, input).unwrap();
    assert_eq!(sessions.len(), 2);

    // Text A (1000 chars / 3000 total) → 1000s duration
    let a = sessions.iter().find(|s| s.text_id == 1).unwrap();
    assert_eq!(a.duration_seconds, Some(1000));
    assert!(a.characters_per_minute.is_some());
    // 1000 chars / (1000s / 60) = 60 cpm
    assert!((a.characters_per_minute.unwrap() - 60.0).abs() < 0.1);
    assert_eq!(a.is_manual_log, true);
    assert_eq!(a.is_complete, true);
    assert_eq!(a.source, Some("physical_book".to_string()));

    // Text B (2000 chars / 3000 total) → 2000s duration
    let b = sessions.iter().find(|s| s.text_id == 2).unwrap();
    assert_eq!(b.duration_seconds, Some(2000));
}

#[test]
fn test_log_offline_read_sets_is_first_read() {
    use crate::dictionary::schema::init_database;
    let conn = Connection::open_in_memory().unwrap();
    init_database(&conn).unwrap();

    conn.execute("INSERT INTO shelves (id, name, sort_order) VALUES (1, 'S', 0)", []).unwrap();
    conn.execute("INSERT INTO texts (id, shelf_id, title, content, character_count) VALUES (1, 1, 'A', 'x', 500)", []).unwrap();
    // Pre-existing completed session on text 1
    conn.execute(
        "INSERT INTO reading_sessions (text_id, started_at, character_count, is_complete)
         VALUES (1, '2026-01-01T00:00:00Z', 500, 1)",
        [],
    ).unwrap();

    let input = ManualLogInput {
        text_ids: vec![1],
        finished_at: "2026-04-25T21:00:00Z".to_string(),
        total_duration_seconds: 600,
        source: None,
    };
    let sessions = log_offline_read(&conn, input).unwrap();
    // Not first read because prior completed session exists
    assert_eq!(sessions[0].is_first_read, false);
}
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd src-tauri && cargo test test_log_offline_read -- --nocapture
```

Expected: FAIL — `cannot find struct ManualLogInput` / `cannot find function log_offline_read`

- [ ] **Step 3: Add `ManualLogInput` struct, update `ReadingSession`, and update `get_session_by_id` SELECT**

In `src-tauri/src/library/speed.rs`, add `ManualLogInput` near the top (after `ReadingSession`):

> ⚠️ **Critical:** `get_session_by_id` has a hardcoded column list in its SELECT. You MUST add the new columns there too, or the function will panic at runtime when `from_row()` tries to read them. Find `get_session_by_id` and add `is_manual_log, source` to its SELECT list:
>
> ```rust
> // Find the SELECT in get_session_by_id and extend it to include the two new columns:
> "SELECT id, text_id, started_at, finished_at, character_count,
>          is_first_read, is_complete, known_characters_count,
>          known_words_count, cumulative_characters_read,
>          duration_seconds, characters_per_minute,
>          auto_marked_characters, auto_marked_words,
>          text_known_char_percentage, created_at,
>          is_manual_log, source          -- ← add these two
>  FROM reading_sessions WHERE id = ?"
> ```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManualLogInput {
    pub text_ids: Vec<i64>,
    pub finished_at: String,          // ISO 8601 datetime chosen by user
    pub total_duration_seconds: i64,  // total reading time for all texts
    pub source: Option<String>,       // "physical_book" | "other_site" | "phone" | null
}
```

Update `ReadingSession` struct to include the new columns:

```rust
pub struct ReadingSession {
    // ... existing fields ...
    pub is_manual_log: bool,
    pub source: Option<String>,
}
```

Update `ReadingSession::from_row` to include them:

```rust
is_manual_log: row.get::<_, i64>("is_manual_log")? == 1,
source: row.get("source")?,
```

- [ ] **Step 4: Add `log_offline_read()` function**

Add to `src-tauri/src/library/speed.rs`:

```rust
/// Create completed reading sessions for texts read offline.
/// Duration is split proportionally by character count so all texts get the same CPM.
pub fn log_offline_read(conn: &Connection, input: ManualLogInput) -> Result<Vec<ReadingSession>> {
    if input.text_ids.is_empty() {
        return Err(LibraryError::InvalidInput("No texts specified".into()));
    }
    if input.total_duration_seconds <= 0 {
        return Err(LibraryError::InvalidInput("Duration must be positive".into()));
    }

    let finished_at = DateTime::parse_from_rfc3339(&input.finished_at)
        .map_err(|e| LibraryError::InvalidInput(format!("Invalid datetime: {}", e)))?;

    // Fetch character counts for all text IDs
    let placeholders = input.text_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id, character_count FROM texts WHERE id IN ({})",
        placeholders
    );
    let params: Vec<&dyn rusqlite::ToSql> = input.text_ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
    let mut stmt = conn.prepare(&sql)?;
    let char_counts: std::collections::HashMap<i64, i64> = stmt
        .query_map(params.as_slice(), |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;

    let total_chars: i64 = char_counts.values().sum();
    if total_chars == 0 {
        return Err(LibraryError::InvalidInput("Selected texts have no characters".into()));
    }

    // Snapshot current vocabulary counts (same for all sessions in this batch)
    let known_characters_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM known_words WHERE word_type = 'character'",
        [],
        |row| row.get(0),
    ).unwrap_or(0);
    let known_words_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM known_words WHERE word_type = 'word'",
        [],
        |row| row.get(0),
    ).unwrap_or(0);

    let mut session_ids = Vec::new();

    for &text_id in &input.text_ids {
        let char_count = *char_counts.get(&text_id)
            .ok_or_else(|| LibraryError::TextNotFound(text_id))?;

        // Proportional duration
        let duration_secs = (input.total_duration_seconds as f64
            * (char_count as f64 / total_chars as f64))
            .round() as i64;
        let duration_secs = duration_secs.max(1); // at least 1 second

        let started_at = finished_at - chrono::Duration::seconds(duration_secs);

        let characters_per_minute = char_count as f64 / (duration_secs as f64 / 60.0);

        // Is this the first completed read of this text?
        let prior_complete: i64 = conn.query_row(
            "SELECT COUNT(*) FROM reading_sessions WHERE text_id = ? AND is_complete = 1",
            [text_id],
            |row| row.get(0),
        ).unwrap_or(0);
        let is_first_read = prior_complete == 0;

        // Cumulative chars read before this session
        let cumulative: i64 = conn.query_row(
            "SELECT COALESCE(SUM(character_count), 0) FROM reading_sessions WHERE text_id = ? AND is_complete = 1",
            [text_id],
            |row| row.get(0),
        ).unwrap_or(0);

        conn.execute(
            "INSERT INTO reading_sessions (
                text_id, started_at, finished_at, character_count,
                is_first_read, is_complete,
                known_characters_count, known_words_count,
                cumulative_characters_read,
                duration_seconds, characters_per_minute,
                auto_marked_characters, auto_marked_words,
                is_manual_log, source
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0, 0, 1, ?)",
            rusqlite::params![
                text_id,
                started_at.to_rfc3339(),
                finished_at.to_rfc3339(),
                char_count,
                is_first_read as i64,
                known_characters_count,
                known_words_count,
                cumulative,
                duration_secs,
                characters_per_minute,
                input.source,
            ],
        )?;

        session_ids.push(conn.last_insert_rowid());
    }

    // Return all created sessions
    session_ids
        .iter()
        .map(|&id| get_session_by_id(conn, id))
        .collect()
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd src-tauri && cargo test test_log_offline_read -- --nocapture
```

Expected: both tests PASS

- [ ] **Step 6: Build**

```bash
cd src-tauri && cargo build 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/library/speed.rs
git commit -m "feat: add log_offline_read with proportional char-count duration split"
```

---

## Task 6: Tauri Command — `log_offline_read`

**Files:**
- Modify: `src-tauri/src/commands/speed.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Re-export `ManualLogInput` from `src-tauri/src/library/mod.rs`**

Find the `pub use speed::{...}` line in `library/mod.rs` and add `ManualLogInput` to it so the command module can reference `library::ManualLogInput`:

```rust
pub use speed::{..., ManualLogInput};  // add ManualLogInput alongside ReadingSession
```

- [ ] **Step 2: Add command to `commands/speed.rs`**

```rust
#[tauri::command]
pub fn log_offline_read(
    state: State<AppState>,
    input: library::ManualLogInput,
) -> CommandResult<Vec<library::ReadingSession>> {
    let conn = state.db.lock().map_err(|e| CommandError::Database(e.to_string()))?;
    library::speed::log_offline_read(&conn, input)
        .map_err(|e| CommandError::Database(e.to_string()))
}
```

- [ ] **Step 3: Register in `src-tauri/src/lib.rs`**

Add after `commands::get_reading_streak`:

```rust
commands::log_offline_read,
```

- [ ] **Step 4: Build**

```bash
cd src-tauri && cargo build 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/library/mod.rs src-tauri/src/commands/speed.rs src-tauri/src/lib.rs
git commit -m "feat: expose log_offline_read as Tauri command"
```

---

## Task 7: TypeScript API Layer

**Files:**
- Modify: `src/lib/speed.ts`
- Modify: `src/lib/library.ts`

- [ ] **Step 1: Update `ReadingSession` in `src/lib/speed.ts`**

Add two fields to the `ReadingSession` interface:

```typescript
export interface ReadingSession {
  // ... existing fields ...
  is_manual_log: boolean;
  source: string | null;
}
```

- [ ] **Step 2: Add `ManualLogInput` type and `logOfflineRead` invoker**

```typescript
export interface ManualLogInput {
  text_ids: number[];
  finished_at: string;           // ISO 8601
  total_duration_seconds: number;
  source: string | null;
}

export async function logOfflineRead(input: ManualLogInput): Promise<ReadingSession[]> {
  return invoke<ReadingSession[]>("log_offline_read", { input });
}
```

- [ ] **Step 3: Add `searchTexts` invoker to `src/lib/library.ts`**

```typescript
export async function searchTexts(query: string): Promise<TextSummary[]> {
  return invoke<TextSummary[]>("search_texts", { query });
}
```

- [ ] **Step 4: Build TypeScript**

```bash
cd /Users/daniel/exper/test_repo && npm run build 2>&1 | tail -20
```

Expected: no TypeScript errors

- [ ] **Step 5: Commit**

```bash
git add src/lib/speed.ts src/lib/library.ts
git commit -m "feat: add ManualLogInput type and logOfflineRead/searchTexts invokers"
```

---

## Task 8: Frontend — Offline Log Button + Modal

**Files:**
- Modify: `src/views/library-view.ts`
- Modify: `src/style.css`

- [ ] **Step 1: Add CSS for modal form**

Add to `src/style.css`:

```css
/* Offline read log modal */
.offline-log-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.offline-log-form .form-label {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #888;
  margin-bottom: 4px;
  display: block;
}

.offline-log-form input[type="datetime-local"],
.offline-log-form input[type="number"] {
  background: #333;
  border: 1px solid #444;
  border-radius: 5px;
  color: rgba(255, 255, 255, 0.87);
  padding: 0.4rem 0.6rem;
  font-size: 0.875rem;
  font-family: inherit;
  width: 100%;
  box-sizing: border-box;
}

.text-chip-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 6px;
}

.text-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #333;
  border: 1px solid #444;
  border-radius: 6px;
  padding: 5px 10px;
  font-size: 0.8rem;
}

.text-chip-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.text-chip-remove {
  background: none;
  border: none;
  color: #666;
  cursor: pointer;
  font-size: 1rem;
  padding: 0;
  line-height: 1;
}

.text-chip-remove:hover { color: #fff; }

.text-search-input {
  background: #1e1e1e;
  border: 1px dashed #555;
  border-radius: 5px;
  color: rgba(255, 255, 255, 0.87);
  padding: 0.4rem 0.6rem;
  font-size: 0.875rem;
  font-family: inherit;
  width: 100%;
  box-sizing: border-box;
}

.text-search-results {
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 5px;
  max-height: 150px;
  overflow-y: auto;
  display: none;
}

.text-search-results.open { display: block; }

.text-search-result-item {
  padding: 7px 10px;
  font-size: 0.8rem;
  cursor: pointer;
  border-bottom: 1px solid #333;
}

.text-search-result-item:last-child { border-bottom: none; }
.text-search-result-item:hover { background: #333; }

.duration-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.source-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.source-chip {
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 0.75rem;
  cursor: pointer;
  border: 1px solid #444;
  background: #333;
  color: #aaa;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.source-chip.active {
  border-color: #646cff;
  background: rgba(100, 108, 255, 0.15);
  color: #646cff;
}
```

- [ ] **Step 2: Add "Log offline read" button to reading controls**

In `library-view.ts`, find the reading controls template (around line 379–388). The inactive state currently shows only "Start Reading". Update it:

```typescript
: `
  <button id="start-reading-btn" class="btn-primary">Start Reading</button>
  <button id="log-offline-btn" class="btn-secondary">Log offline read</button>
`
```

- [ ] **Step 3: Add `showOfflineLogModal()` function**

Add this function to `library-view.ts` (near the other modal functions):

```typescript
async function showOfflineLogModal() {
  // State local to this modal instance
  const selectedTexts: Map<number, { id: number; title: string; character_count: number }> = new Map();
  let selectedSource: string | null = null;

  // Default finished_at to now (datetime-local format)
  const now = new Date();
  const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);

  const modalContent = `
    <div class="offline-log-form">
      <div>
        <label class="form-label">Texts you read</label>
        <div id="chip-list" class="text-chip-list"></div>
        <input
          type="text"
          id="text-search"
          class="text-search-input"
          placeholder="🔍 Search texts to add…"
          autocomplete="off"
        />
        <div id="text-search-results" class="text-search-results"></div>
      </div>

      <div>
        <label class="form-label">When did you finish?</label>
        <input type="datetime-local" id="finished-at" value="${localIso}" />
      </div>

      <div>
        <label class="form-label">Total reading time</label>
        <div class="duration-row">
          <div>
            <input type="number" id="duration-hours" min="0" max="23" value="0" placeholder="hrs" />
          </div>
          <div>
            <input type="number" id="duration-minutes" min="0" max="59" value="30" placeholder="min" />
          </div>
        </div>
      </div>

      <div>
        <label class="form-label">Where did you read?</label>
        <div class="source-chips">
          <button class="source-chip" data-source="physical_book">Physical book</button>
          <button class="source-chip" data-source="other_site">Other site</button>
          <button class="source-chip" data-source="phone">Phone (no app)</button>
          <button class="source-chip" data-source="other">Other</button>
        </div>
      </div>
    </div>
  `;

  const { modal, closeModal: close } = createModal("Log offline reading", modalContent, [
    {
      label: "Cancel",
      class: "btn-secondary",
      onClick: () => close(),
    },
    {
      label: "Save 0 sessions",
      id: "offline-save-btn",
      class: "btn-primary",
      onClick: async () => {
        await saveOfflineLog(modal, selectedTexts, selectedSource, close);
      },
    },
  ]);

  // Helper: re-render chip list
  function refreshChips() {
    const chipList = modal.querySelector("#chip-list")!;
    chipList.innerHTML = [...selectedTexts.values()]
      .map(
        (t) => `
        <div class="text-chip" data-chip-id="${t.id}">
          <span class="text-chip-name">${escapeHtml(t.title)}</span>
          <button class="text-chip-remove" data-remove-id="${t.id}">×</button>
        </div>
      `
      )
      .join("");
    chipList.querySelectorAll(".text-chip-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedTexts.delete(parseInt((btn as HTMLElement).dataset.removeId!));
        refreshChips();
        updateSaveLabel();
      });
    });
  }

  function updateSaveLabel() {
    const saveBtn = modal.querySelector("#offline-save-btn") as HTMLButtonElement | null;
    if (saveBtn) {
      const n = selectedTexts.size;
      saveBtn.textContent = `Save ${n} session${n !== 1 ? "s" : ""}`;
      saveBtn.disabled = n === 0;
    }
  }

  // Source chip toggle
  modal.querySelectorAll(".source-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      modal.querySelectorAll(".source-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      selectedSource = (chip as HTMLElement).dataset.source || null;
    });
  });

  // Text search
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  const searchInput = modal.querySelector("#text-search") as HTMLInputElement;
  const resultsEl = modal.querySelector("#text-search-results") as HTMLElement;

  searchInput.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = searchInput.value.trim();
      if (q.length < 1) { resultsEl.classList.remove("open"); return; }
      const results = await library.searchTexts(q);
      resultsEl.innerHTML = results
        .filter((r) => !selectedTexts.has(r.id))
        .map(
          (r) =>
            `<div class="text-search-result-item" data-id="${r.id}" data-title="${escapeHtml(r.title)}" data-chars="${r.character_count}">
              ${escapeHtml(r.title)}
            </div>`
        )
        .join("") || `<div class="text-search-result-item" style="color:#666">No results</div>`;
      resultsEl.classList.add("open");
    }, 250);
  });

  resultsEl.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest(".text-search-result-item") as HTMLElement | null;
    if (!item || !item.dataset.id) return;
    const id = parseInt(item.dataset.id);
    selectedTexts.set(id, {
      id,
      title: item.dataset.title || "",
      character_count: parseInt(item.dataset.chars || "0"),
    });
    searchInput.value = "";
    resultsEl.classList.remove("open");
    refreshChips();
    updateSaveLabel();
  });

  // Close results on outside click
  document.addEventListener(
    "click",
    (e) => {
      if (!searchInput.contains(e.target as Node) && !resultsEl.contains(e.target as Node)) {
        resultsEl.classList.remove("open");
      }
    },
    { once: false }
  );

  updateSaveLabel();
}

async function saveOfflineLog(
  modal: HTMLElement,
  selectedTexts: Map<number, { id: number; title: string; character_count: number }>,
  source: string | null,
  close: () => void
) {
  const finishedAtInput = modal.querySelector("#finished-at") as HTMLInputElement;
  const hoursInput = modal.querySelector("#duration-hours") as HTMLInputElement;
  const minutesInput = modal.querySelector("#duration-minutes") as HTMLInputElement;

  const hours = parseInt(hoursInput.value) || 0;
  const minutes = parseInt(minutesInput.value) || 0;
  const totalSeconds = hours * 3600 + minutes * 60;

  if (totalSeconds <= 0) {
    alert("Please enter a reading duration.");
    return;
  }
  if (selectedTexts.size === 0) {
    alert("Please add at least one text.");
    return;
  }

  // Convert datetime-local to ISO 8601 with timezone offset
  const localDt = new Date(finishedAtInput.value);
  const finishedAt = localDt.toISOString();

  try {
    await speed.logOfflineRead({
      text_ids: [...selectedTexts.keys()],
      finished_at: finishedAt,
      total_duration_seconds: totalSeconds,
      source,
    });
    close();
    // Refresh history and shelf tree (function is named loadReadingHistory in library-view.ts)
    if (currentTextId) await loadReadingHistory(currentTextId);
    await loadShelfTree();
  } catch (err) {
    console.error("Failed to log offline read:", err);
    alert("Failed to save. Please try again.");
  }
}
```

- [ ] **Step 4: Wire up the button event listener in both render paths**

The reading controls are rendered in two places. Update **both**:

**Path 1 — initial text load** (find `start-reading-btn` listener setup, add immediately after):
```typescript
document.getElementById("log-offline-btn")?.addEventListener("click", () => {
  showOfflineLogModal();
});
```

**Path 2 — `updateReadingControlsUI` inactive branch** (around line 638, this re-renders the controls after a session finishes). Find the inactive branch that renders only `<button id="start-reading-btn"...>` and update it to also include the "Log offline read" button (same template as Step 2), then re-attach the listener in the same branch.

- [ ] **Step 5: Test in dev build**

```bash
cd /Users/daniel/exper/test_repo && npm run tauri dev
```

- Open a text. Confirm "Log offline read" appears next to "Start Reading".
- Click it. Confirm modal opens with search, datetime (defaulting to now), duration, source chips.
- Search for a text title. Confirm results appear and can be added as chips.
- Remove a chip. Confirm it disappears.
- Set duration to 1h 0m, select "Physical book", save.
- Confirm sessions created in the History tab.

- [ ] **Step 6: Commit**

```bash
git add src/views/library-view.ts src/style.css
git commit -m "feat: add offline read log button and modal with text search"
```

---

## Task 9: Session History — "Logged" Badge

**Files:**
- Modify: `src/views/library-view.ts`

- [ ] **Step 1: Update the history rendering**

Find the session history loop (around line 689–722). Update the status badge and add a source label:

```typescript
for (const session of history) {
  const isManual = (session as any).is_manual_log;
  const statusText = isManual ? "Logged" : session.is_complete ? "Completed" : "In Progress";
  const statusClass = isManual ? "manual" : session.is_complete ? "complete" : "in-progress";
  const firstReadBadge = session.is_first_read
    ? '<span class="first-read-badge">First Read</span>'
    : "";
  const sourceBadge =
    isManual && (session as any).source
      ? `<span class="source-badge">${escapeHtml((session as any).source.replace("_", " "))}</span>`
      : "";
  // ... rest unchanged, replace statusClass/statusText/firstReadBadge usages
```

Add CSS for the new badges in `src/style.css`:

```css
.history-status.manual {
  background: rgba(100, 108, 255, 0.15);
  color: #646cff;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 0.75rem;
}

.source-badge {
  font-size: 0.7rem;
  color: #888;
  background: #2a2a2a;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: capitalize;
}
```

- [ ] **Step 2: Test in dev build**

- Log an offline session. Open the History tab on that text.
- Confirm manually logged sessions show "Logged" (styled in purple) and the source label.
- Confirm normal in-app sessions still show "Completed".

- [ ] **Step 3: Commit**

```bash
git add src/views/library-view.ts src/style.css
git commit -m "feat: show Logged badge and source label for manual reading sessions"
```

---

## Final Verification

- [ ] Run full Rust test suite: `cd src-tauri && cargo test -- --nocapture`
- [ ] Run full build: `npm run build`
- [ ] Launch dev app: `npm run tauri dev`
- [ ] Smoke test shelf unread badges: confirm counts update after logging an offline session
- [ ] Smoke test offline log: log a 3-text session, verify proportional durations in History tab
- [ ] Smoke test first-read: log a session on a never-read text, confirm "First Read" badge appears
