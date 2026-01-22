//! Shelf management for the library.
//!
//! Provides CRUD operations for hierarchical shelves.

use rusqlite::{params, Connection};

use super::error::{LibraryError, Result};
use super::models::{Shelf, ShelfTree};

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

/// Get text count for a shelf
fn get_text_count(conn: &Connection, shelf_id: i64) -> Result<i64> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM texts WHERE shelf_id = ?",
        [shelf_id],
        |row| row.get(0),
    )?;
    Ok(count)
}

/// Build shelf tree recursively
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
    })
}

/// Get the complete shelf tree
pub fn get_shelf_tree(conn: &Connection) -> Result<Vec<ShelfTree>> {
    let root_shelves = list_root_shelves(conn)?;

    root_shelves
        .into_iter()
        .map(|shelf| build_shelf_tree(conn, shelf))
        .collect()
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
    // Check shelf exists
    if get_shelf(conn, id)?.is_none() {
        return Err(LibraryError::ShelfNotFound(id));
    }

    conn.execute("DELETE FROM shelves WHERE id = ?", [id])?;
    Ok(())
}

/// Move a shelf to a new parent
pub fn move_shelf(conn: &Connection, id: i64, new_parent_id: Option<i64>) -> Result<()> {
    // Check shelf exists
    if get_shelf(conn, id)?.is_none() {
        return Err(LibraryError::ShelfNotFound(id));
    }

    // Check new parent exists if specified
    if let Some(pid) = new_parent_id {
        if get_shelf(conn, pid)?.is_none() {
            return Err(LibraryError::ShelfNotFound(pid));
        }
        // Prevent moving shelf to be its own descendant
        if is_descendant(conn, pid, id)? {
            return Err(LibraryError::InvalidInput(
                "Cannot move shelf to its own descendant".to_string(),
            ));
        }
    }

    // Get next sort order for the new parent
    let sort_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM shelves WHERE parent_id IS ?",
            [new_parent_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    conn.execute(
        "UPDATE shelves SET parent_id = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        params![new_parent_id, sort_order, id],
    )?;

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
    fn test_delete_shelf() {
        let conn = setup_test_db();

        let shelf = create_shelf(&conn, "To Delete", None, None).unwrap();
        delete_shelf(&conn, shelf.id).unwrap();

        assert!(get_shelf(&conn, shelf.id).unwrap().is_none());
    }
}
