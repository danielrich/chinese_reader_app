//! Shelf management for the library.
//!
//! Provides CRUD operations for hierarchical shelves.

use chrono::Utc;
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};

use super::error::{LibraryError, Result};
use super::maintenance::{cached_or_requested_ancestor_ids, mark_analysis_dirty_in_transaction};
use super::models::{Shelf, ShelfTree};

#[cfg(test)]
thread_local! {
    static BULK_QUERY_STAGES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn record_bulk_query_stage() {
    #[cfg(test)]
    BULK_QUERY_STAGES.with(|count| count.set(count.get() + 1));
}

#[cfg(test)]
fn reset_bulk_query_stages() {
    BULK_QUERY_STAGES.with(|count| count.set(0));
}

#[cfg(test)]
fn bulk_query_stage_count() -> usize {
    BULK_QUERY_STAGES.with(std::cell::Cell::get)
}

/// Create a new shelf
pub fn create_shelf(
    conn: &Connection,
    name: &str,
    description: Option<&str>,
    parent_id: Option<i64>,
) -> Result<Shelf> {
    // Validate parent exists if specified
    if let Some(pid) = parent_id {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM shelves WHERE id = ?)",
            [pid],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(LibraryError::ShelfNotFound(pid));
        }
    }

    // Get next sort order for this parent
    let sort_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM shelves WHERE parent_id IS ?",
            [parent_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    conn.execute(
        "INSERT INTO shelves (name, description, parent_id, sort_order) VALUES (?, ?, ?, ?)",
        params![name, description, parent_id, sort_order],
    )?;

    let id = conn.last_insert_rowid();
    get_shelf(conn, id)?.ok_or(LibraryError::ShelfNotFound(id))
}

/// Get a shelf by ID
pub fn get_shelf(conn: &Connection, id: i64) -> Result<Option<Shelf>> {
    let result = conn.query_row(
        "SELECT id, name, description, parent_id, sort_order, created_at, updated_at
         FROM shelves WHERE id = ?",
        [id],
        |row| {
            Ok(Shelf {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                parent_id: row.get(3)?,
                sort_order: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        },
    );

    match result {
        Ok(shelf) => Ok(Some(shelf)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// List root shelves (those without a parent)
pub fn list_root_shelves(conn: &Connection) -> Result<Vec<Shelf>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, parent_id, sort_order, created_at, updated_at
         FROM shelves WHERE parent_id IS NULL ORDER BY sort_order, name",
    )?;

    let shelves = stmt
        .query_map([], |row| {
            Ok(Shelf {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                parent_id: row.get(3)?,
                sort_order: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(shelves)
}

/// List child shelves of a parent
pub fn list_child_shelves(conn: &Connection, parent_id: i64) -> Result<Vec<Shelf>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, parent_id, sort_order, created_at, updated_at
         FROM shelves WHERE parent_id = ? ORDER BY sort_order, name",
    )?;

    let shelves = stmt
        .query_map([parent_id], |row| {
            Ok(Shelf {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                parent_id: row.get(3)?,
                sort_order: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(shelves)
}

/// Returns unread text counts for the given shelf IDs in a single query.
/// A text is "unread" if it has no completed reading session (is_complete = 1).
pub fn get_unread_counts(
    conn: &Connection,
    shelf_ids: &[i64],
) -> Result<std::collections::HashMap<i64, i64>> {
    if shelf_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }

    let placeholders = shelf_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
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

fn load_all_shelves(conn: &Connection) -> Result<Vec<Shelf>> {
    record_bulk_query_stage();
    let mut stmt = conn.prepare(
        "SELECT id, name, description, parent_id, sort_order, created_at, updated_at
         FROM shelves ORDER BY parent_id, sort_order, name",
    )?;
    let shelves = stmt
        .query_map([], |row| {
            Ok(Shelf {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                parent_id: row.get(3)?,
                sort_order: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(shelves)
}

fn load_direct_text_counts(conn: &Connection) -> Result<HashMap<i64, i64>> {
    record_bulk_query_stage();
    let mut stmt = conn.prepare("SELECT shelf_id, COUNT(*) FROM texts GROUP BY shelf_id")?;
    let counts = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<std::result::Result<HashMap<_, _>, _>>()?;
    Ok(counts)
}

fn load_all_unread_counts(conn: &Connection) -> Result<HashMap<i64, i64>> {
    record_bulk_query_stage();
    let mut stmt = conn.prepare(
        "SELECT t.shelf_id, COUNT(*)
         FROM texts t
         WHERE NOT EXISTS (
             SELECT 1 FROM reading_sessions rs
             WHERE rs.text_id = t.id AND rs.is_complete = 1
         )
         GROUP BY t.shelf_id",
    )?;
    let counts = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<std::result::Result<HashMap<_, _>, _>>()?;
    Ok(counts)
}

fn assemble_shelf_node(
    shelf: Shelf,
    children_by_parent: &mut HashMap<Option<i64>, Vec<Shelf>>,
    direct_text_counts: &HashMap<i64, i64>,
    direct_unread_counts: &HashMap<i64, i64>,
    visiting: &mut HashSet<i64>,
    assembled: &mut HashSet<i64>,
) -> Result<ShelfTree> {
    if !visiting.insert(shelf.id) {
        return Err(LibraryError::InvalidInput(format!(
            "Cycle detected in shelf hierarchy at shelf {}",
            shelf.id
        )));
    }

    let child_shelves = children_by_parent
        .remove(&Some(shelf.id))
        .unwrap_or_default();
    let mut children = Vec::with_capacity(child_shelves.len());
    for child in child_shelves {
        children.push(assemble_shelf_node(
            child,
            children_by_parent,
            direct_text_counts,
            direct_unread_counts,
            visiting,
            assembled,
        )?);
    }

    visiting.remove(&shelf.id);
    assembled.insert(shelf.id);
    let text_count = direct_text_counts.get(&shelf.id).copied().unwrap_or(0)
        + children.iter().map(|child| child.text_count).sum::<i64>();
    let unread_count = direct_unread_counts.get(&shelf.id).copied().unwrap_or(0)
        + children.iter().map(|child| child.unread_count).sum::<i64>();

    Ok(ShelfTree {
        shelf,
        children,
        text_count,
        unread_count,
    })
}

/// Get the complete shelf tree
pub fn get_shelf_tree(conn: &Connection) -> Result<Vec<ShelfTree>> {
    let shelves = load_all_shelves(conn)?;
    let direct_text_counts = load_direct_text_counts(conn)?;
    let direct_unread_counts = load_all_unread_counts(conn)?;
    let shelf_ids: HashSet<i64> = shelves.iter().map(|shelf| shelf.id).collect();

    for shelf in &shelves {
        if let Some(parent_id) = shelf.parent_id {
            if !shelf_ids.contains(&parent_id) {
                return Err(LibraryError::InvalidInput(format!(
                    "Shelf {} references missing parent {}",
                    shelf.id, parent_id
                )));
            }
        }
    }

    let mut children_by_parent: HashMap<Option<i64>, Vec<Shelf>> = HashMap::new();
    for shelf in shelves {
        children_by_parent
            .entry(shelf.parent_id)
            .or_default()
            .push(shelf);
    }

    let roots = children_by_parent.remove(&None).unwrap_or_default();
    let expected_count = shelf_ids.len();
    let mut visiting = HashSet::new();
    let mut assembled = HashSet::new();
    let mut trees = Vec::with_capacity(roots.len());
    for root in roots {
        trees.push(assemble_shelf_node(
            root,
            &mut children_by_parent,
            &direct_text_counts,
            &direct_unread_counts,
            &mut visiting,
            &mut assembled,
        )?);
    }

    if assembled.len() != expected_count {
        return Err(LibraryError::InvalidInput(
            "Cycle detected in shelf hierarchy".to_string(),
        ));
    }

    Ok(trees)
}

/// Update a shelf
pub fn update_shelf(
    conn: &Connection,
    id: i64,
    name: Option<&str>,
    description: Option<Option<&str>>,
) -> Result<()> {
    // Check shelf exists
    if get_shelf(conn, id)?.is_none() {
        return Err(LibraryError::ShelfNotFound(id));
    }

    if let Some(new_name) = name {
        conn.execute(
            "UPDATE shelves SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            params![new_name, id],
        )?;
    }

    if let Some(new_description) = description {
        conn.execute(
            "UPDATE shelves SET description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            params![new_description, id],
        )?;
    }

    Ok(())
}

/// Delete a shelf (cascades to texts and child shelves)
pub fn delete_shelf(conn: &Connection, id: i64) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    let shelf = get_shelf(&tx, id)?.ok_or(LibraryError::ShelfNotFound(id))?;
    let dirty_shelf_ids = match shelf.parent_id {
        Some(parent_id) => cached_or_requested_ancestor_ids(&tx, &[parent_id])?,
        None => Vec::new(),
    };

    tx.execute("DELETE FROM shelves WHERE id = ?", [id])?;
    mark_analysis_dirty_in_transaction(&tx, &dirty_shelf_ids, Utc::now())?;
    tx.commit()?;
    Ok(())
}

/// Move a shelf to a new parent
pub fn move_shelf(conn: &Connection, id: i64, new_parent_id: Option<i64>) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    let shelf = get_shelf(&tx, id)?.ok_or(LibraryError::ShelfNotFound(id))?;

    // Check new parent exists if specified
    if let Some(pid) = new_parent_id {
        if get_shelf(&tx, pid)?.is_none() {
            return Err(LibraryError::ShelfNotFound(pid));
        }
        // Prevent moving shelf to be its own descendant
        if is_descendant(&tx, pid, id)? {
            return Err(LibraryError::InvalidInput(
                "Cannot move shelf to its own descendant".to_string(),
            ));
        }
    }

    let mut dirty_shelf_ids = match shelf.parent_id {
        Some(parent_id) => cached_or_requested_ancestor_ids(&tx, &[parent_id])?,
        None => Vec::new(),
    };

    // Get next sort order for the new parent
    let sort_order: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM shelves WHERE parent_id IS ?",
            [new_parent_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    tx.execute(
        "UPDATE shelves SET parent_id = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        params![new_parent_id, sort_order, id],
    )?;

    if let Some(parent_id) = new_parent_id {
        dirty_shelf_ids.extend(cached_or_requested_ancestor_ids(&tx, &[parent_id])?);
    }
    dirty_shelf_ids.sort_unstable();
    dirty_shelf_ids.dedup();
    mark_analysis_dirty_in_transaction(&tx, &dirty_shelf_ids, Utc::now())?;
    tx.commit()?;

    Ok(())
}

/// Check if `potential_descendant` is a descendant of `ancestor`
fn is_descendant(conn: &Connection, potential_descendant: i64, ancestor: i64) -> Result<bool> {
    let mut current_id = potential_descendant;

    while let Some(shelf) = get_shelf(conn, current_id)? {
        if let Some(parent_id) = shelf.parent_id {
            if parent_id == ancestor {
                return Ok(true);
            }
            current_id = parent_id;
        } else {
            break;
        }
    }

    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictionary::schema::init_database;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn).unwrap();
        conn
    }

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn).unwrap();
        // Create a shelf and two texts, complete a session on one
        conn.execute(
            "INSERT INTO shelves (id, name, sort_order) VALUES (1, 'Test', 0)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO texts (id, shelf_id, title, content, character_count) VALUES (1, 1, 'Text A', 'content', 100)", []).unwrap();
        conn.execute("INSERT INTO texts (id, shelf_id, title, content, character_count) VALUES (2, 1, 'Text B', 'content', 200)", []).unwrap();
        // Only text 1 has a completed session
        conn.execute(
            "INSERT INTO reading_sessions (text_id, started_at, character_count, is_complete)
             VALUES (1, '2026-01-01T00:00:00Z', 100, 1)",
            [],
        )
        .unwrap();
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
        )
        .unwrap();
        let counts = get_unread_counts(&conn, &[1]).unwrap();
        assert_eq!(counts.get(&1), Some(&0));
    }

    #[test]
    fn test_unread_count_empty_shelf_ids() {
        let conn = setup();
        let counts = get_unread_counts(&conn, &[]).unwrap();
        assert!(counts.is_empty());
    }

    #[test]
    fn test_create_and_get_shelf() {
        let conn = setup_test_db();

        let shelf = create_shelf(&conn, "Test Shelf", Some("A test shelf"), None).unwrap();

        assert_eq!(shelf.name, "Test Shelf");
        assert_eq!(shelf.description, Some("A test shelf".to_string()));
        assert_eq!(shelf.parent_id, None);

        let retrieved = get_shelf(&conn, shelf.id).unwrap().unwrap();
        assert_eq!(retrieved.name, shelf.name);
    }

    #[test]
    fn test_nested_shelves() {
        let conn = setup_test_db();

        let parent = create_shelf(&conn, "Parent", None, None).unwrap();
        let child = create_shelf(&conn, "Child", None, Some(parent.id)).unwrap();

        assert_eq!(child.parent_id, Some(parent.id));

        let children = list_child_shelves(&conn, parent.id).unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].name, "Child");
    }

    #[test]
    fn test_shelf_tree() {
        let conn = setup_test_db();

        let parent = create_shelf(&conn, "Parent", None, None).unwrap();
        let _child1 = create_shelf(&conn, "Child 1", None, Some(parent.id)).unwrap();
        let _child2 = create_shelf(&conn, "Child 2", None, Some(parent.id)).unwrap();

        let tree = get_shelf_tree(&conn).unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].children.len(), 2);
    }

    #[test]
    fn shelf_tree_preserves_order_and_rolls_up_counts() {
        let conn = setup_test_db();
        conn.execute_batch(
            "INSERT INTO shelves (id, name, parent_id, sort_order) VALUES
                 (1, 'Root B', NULL, 0),
                 (2, 'Root A', NULL, 0),
                 (3, 'Child Z', 2, 0),
                 (4, 'Child A', 2, 0),
                 (5, 'Grandchild', 4, 0),
                 (6, 'Empty', NULL, 2);
             INSERT INTO texts (id, shelf_id, title, content, character_count) VALUES
                 (1, 2, 'Root unread', 'a', 1),
                 (2, 3, 'Child read', 'b', 1),
                 (3, 4, 'Child unread', 'c', 1),
                 (4, 5, 'Grandchild read', 'd', 1),
                 (5, 5, 'Grandchild unread', 'e', 1);
             INSERT INTO reading_sessions
                 (text_id, started_at, character_count, is_complete) VALUES
                 (2, '2026-01-01T00:00:00Z', 1, 1),
                 (4, '2026-01-01T00:00:00Z', 1, 1);",
        )
        .unwrap();

        let tree = get_shelf_tree(&conn).unwrap();

        assert_eq!(
            tree.iter()
                .map(|n| n.shelf.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Root A", "Root B", "Empty"]
        );
        let root = &tree[0];
        assert_eq!(
            root.children
                .iter()
                .map(|n| n.shelf.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Child A", "Child Z"]
        );
        assert_eq!(root.text_count, 5);
        assert_eq!(root.unread_count, 3);
        assert_eq!(root.children[0].text_count, 3);
        assert_eq!(root.children[0].unread_count, 2);
        assert_eq!(root.children[0].children[0].text_count, 2);
        assert_eq!(root.children[0].children[0].unread_count, 1);
        assert_eq!((tree[1].text_count, tree[1].unread_count), (0, 0));
        assert_eq!((tree[2].text_count, tree[2].unread_count), (0, 0));
    }

    #[test]
    fn shelf_tree_uses_three_bulk_query_stages_regardless_of_size() {
        let conn = setup_test_db();
        for id in 1..=500 {
            conn.execute(
                "INSERT INTO shelves (id, name, sort_order) VALUES (?, ?, ?)",
                params![id, format!("Shelf {id:03}"), id],
            )
            .unwrap();
        }

        reset_bulk_query_stages();
        get_shelf_tree(&conn).unwrap();

        assert_eq!(bulk_query_stage_count(), 3);
    }

    #[test]
    fn shelf_tree_rejects_orphaned_shelves() {
        let conn = setup_test_db();
        conn.execute("PRAGMA foreign_keys = OFF", []).unwrap();
        conn.execute(
            "INSERT INTO shelves (id, name, parent_id, sort_order) VALUES (1, 'Orphan', 999, 0)",
            [],
        )
        .unwrap();

        let error = get_shelf_tree(&conn).unwrap_err();
        assert!(matches!(error, LibraryError::InvalidInput(_)));
    }

    #[test]
    fn shelf_tree_rejects_cycles() {
        let conn = setup_test_db();
        conn.execute("PRAGMA foreign_keys = OFF", []).unwrap();
        conn.execute_batch(
            "INSERT INTO shelves (id, name, parent_id, sort_order) VALUES
                 (1, 'Cycle A', 2, 0),
                 (2, 'Cycle B', 1, 0);",
        )
        .unwrap();

        let error = get_shelf_tree(&conn).unwrap_err();
        assert!(matches!(error, LibraryError::InvalidInput(_)));
    }

    #[test]
    fn test_delete_shelf() {
        let conn = setup_test_db();

        let shelf = create_shelf(&conn, "To Delete", None, None).unwrap();
        delete_shelf(&conn, shelf.id).unwrap();

        assert!(get_shelf(&conn, shelf.id).unwrap().is_none());
    }
}
