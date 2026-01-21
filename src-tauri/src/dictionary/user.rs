//! User dictionary management.
//!
//! Allows users to create custom dictionaries for book-specific terms,
//! character names, domain-specific vocabulary, etc.

use crate::dictionary::models::{UserDictionary, UserDictionaryEntry};
use rusqlite::{Connection, Result};

/// Create a new user dictionary
pub fn create_dictionary(
    conn: &Connection,
    name: &str,
    description: Option<&str>,
    domain: Option<&str>,
) -> Result<UserDictionary> {
    conn.execute(
        r#"INSERT INTO user_dictionaries (name, description, domain)
           VALUES (?, ?, ?)"#,
        (name, description, domain),
    )?;

    let id = conn.last_insert_rowid();
    get_dictionary(conn, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// Get a user dictionary by ID
pub fn get_dictionary(conn: &Connection, id: i64) -> Result<Option<UserDictionary>> {
    let result = conn.query_row(
        r#"SELECT id, name, description, domain, created_at, updated_at
           FROM user_dictionaries WHERE id = ?"#,
        [id],
        |row| {
            Ok(UserDictionary {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                domain: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    );

    match result {
        Ok(dict) => Ok(Some(dict)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// List all user dictionaries
pub fn list_dictionaries(conn: &Connection) -> Result<Vec<UserDictionary>> {
    let mut stmt = conn.prepare(
        r#"SELECT id, name, description, domain, created_at, updated_at
           FROM user_dictionaries
           ORDER BY name"#,
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(UserDictionary {
            id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            domain: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })?;

    rows.collect()
}

/// Update a user dictionary
pub fn update_dictionary(
    conn: &Connection,
    id: i64,
    name: Option<&str>,
    description: Option<&str>,
    domain: Option<&str>,
) -> Result<()> {
    let mut updates = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(n) = name {
        updates.push("name = ?");
        params.push(Box::new(n.to_string()));
    }
    if let Some(d) = description {
        updates.push("description = ?");
        params.push(Box::new(d.to_string()));
    }
    if let Some(d) = domain {
        updates.push("domain = ?");
        params.push(Box::new(d.to_string()));
    }

    if updates.is_empty() {
        return Ok(());
    }

    updates.push("updated_at = CURRENT_TIMESTAMP");
    params.push(Box::new(id));

    let sql = format!(
        "UPDATE user_dictionaries SET {} WHERE id = ?",
        updates.join(", ")
    );

    let params_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    conn.execute(&sql, params_refs.as_slice())?;

    Ok(())
}

/// Delete a user dictionary and all its entries
pub fn delete_dictionary(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM user_dictionaries WHERE id = ?", [id])?;
    Ok(())
}

/// Add an entry to a user dictionary
pub fn add_entry(
    conn: &Connection,
    dictionary_id: i64,
    term: &str,
    definition: &str,
    pinyin: Option<&str>,
    notes: Option<&str>,
    tags: &[String],
) -> Result<UserDictionaryEntry> {
    conn.execute(
        r#"INSERT INTO user_dictionary_entries (dictionary_id, term, pinyin, definition, notes)
           VALUES (?, ?, ?, ?, ?)"#,
        (dictionary_id, term, pinyin, definition, notes),
    )?;

    let entry_id = conn.last_insert_rowid();

    // Add tags
    for tag in tags {
        conn.execute(
            "INSERT OR IGNORE INTO user_entry_tags (entry_id, tag) VALUES (?, ?)",
            (entry_id, tag),
        )?;
    }

    // Update dictionary timestamp
    conn.execute(
        "UPDATE user_dictionaries SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [dictionary_id],
    )?;

    get_entry(conn, entry_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// Get a user dictionary entry by ID
pub fn get_entry(conn: &Connection, id: i64) -> Result<Option<UserDictionaryEntry>> {
    let result = conn.query_row(
        r#"SELECT id, dictionary_id, term, pinyin, definition, notes, created_at, updated_at
           FROM user_dictionary_entries WHERE id = ?"#,
        [id],
        |row| {
            Ok(UserDictionaryEntry {
                id: row.get(0)?,
                dictionary_id: row.get(1)?,
                term: row.get(2)?,
                pinyin: row.get(3)?,
                definition: row.get(4)?,
                notes: row.get(5)?,
                tags: Vec::new(),
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        },
    );

    match result {
        Ok(mut entry) => {
            entry.tags = get_entry_tags(conn, entry.id)?;
            Ok(Some(entry))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

fn get_entry_tags(conn: &Connection, entry_id: i64) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT tag FROM user_entry_tags WHERE entry_id = ?")?;
    let rows = stmt.query_map([entry_id], |row| row.get(0))?;
    rows.collect()
}

/// List entries in a user dictionary
pub fn list_entries(
    conn: &Connection,
    dictionary_id: i64,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<UserDictionaryEntry>> {
    let limit = limit.unwrap_or(100);
    let offset = offset.unwrap_or(0);

    let mut stmt = conn.prepare(
        r#"SELECT id, dictionary_id, term, pinyin, definition, notes, created_at, updated_at
           FROM user_dictionary_entries
           WHERE dictionary_id = ?
           ORDER BY term
           LIMIT ? OFFSET ?"#,
    )?;

    let rows = stmt.query_map((dictionary_id, limit as i64, offset as i64), |row| {
        Ok(UserDictionaryEntry {
            id: row.get(0)?,
            dictionary_id: row.get(1)?,
            term: row.get(2)?,
            pinyin: row.get(3)?,
            definition: row.get(4)?,
            notes: row.get(5)?,
            tags: Vec::new(),
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    })?;

    let mut entries = Vec::new();
    for row in rows {
        let mut entry = row?;
        entry.tags = get_entry_tags(conn, entry.id)?;
        entries.push(entry);
    }

    Ok(entries)
}

/// Update a user dictionary entry
pub fn update_entry(
    conn: &Connection,
    id: i64,
    term: Option<&str>,
    definition: Option<&str>,
    pinyin: Option<&str>,
    notes: Option<&str>,
    tags: Option<&[String]>,
) -> Result<()> {
    let mut updates = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(t) = term {
        updates.push("term = ?");
        params.push(Box::new(t.to_string()));
    }
    if let Some(d) = definition {
        updates.push("definition = ?");
        params.push(Box::new(d.to_string()));
    }
    if let Some(p) = pinyin {
        updates.push("pinyin = ?");
        params.push(Box::new(p.to_string()));
    }
    if let Some(n) = notes {
        updates.push("notes = ?");
        params.push(Box::new(n.to_string()));
    }

    if !updates.is_empty() {
        updates.push("updated_at = CURRENT_TIMESTAMP");
        params.push(Box::new(id));

        let sql = format!(
            "UPDATE user_dictionary_entries SET {} WHERE id = ?",
            updates.join(", ")
        );

        let params_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        conn.execute(&sql, params_refs.as_slice())?;
    }

    // Update tags if provided
    if let Some(new_tags) = tags {
        conn.execute("DELETE FROM user_entry_tags WHERE entry_id = ?", [id])?;
        for tag in new_tags {
            conn.execute(
                "INSERT INTO user_entry_tags (entry_id, tag) VALUES (?, ?)",
                (id, tag),
            )?;
        }
    }

    Ok(())
}

/// Delete a user dictionary entry
pub fn delete_entry(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM user_dictionary_entries WHERE id = ?", [id])?;
    Ok(())
}

/// Get entry count for a dictionary
pub fn get_entry_count(conn: &Connection, dictionary_id: i64) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM user_dictionary_entries WHERE dictionary_id = ?",
        [dictionary_id],
        |row| row.get(0),
    )
}

/// Import entries from a simple format (term\tdefinition per line)
pub fn import_simple_format(
    conn: &mut Connection,
    dictionary_id: i64,
    content: &str,
) -> Result<ImportStats> {
    let mut stats = ImportStats::default();
    let tx = conn.transaction()?;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        stats.lines_processed += 1;

        let parts: Vec<&str> = line.splitn(2, '\t').collect();
        if parts.len() < 2 {
            stats.errors += 1;
            continue;
        }

        let term = parts[0].trim();
        let definition = parts[1].trim();

        if term.is_empty() || definition.is_empty() {
            stats.errors += 1;
            continue;
        }

        match tx.execute(
            r#"INSERT INTO user_dictionary_entries (dictionary_id, term, definition)
               VALUES (?, ?, ?)"#,
            (dictionary_id, term, definition),
        ) {
            Ok(_) => stats.entries_added += 1,
            Err(_) => stats.errors += 1,
        }
    }

    // Update dictionary timestamp
    tx.execute(
        "UPDATE user_dictionaries SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [dictionary_id],
    )?;

    tx.commit()?;
    Ok(stats)
}

/// Statistics from import operation
#[derive(Debug, Default)]
pub struct ImportStats {
    pub lines_processed: usize,
    pub entries_added: usize,
    pub errors: usize,
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
    fn test_create_dictionary() {
        let conn = setup_test_db();

        let dict = create_dictionary(&conn, "紅樓夢人物", Some("Character names"), Some("book:紅樓夢")).unwrap();

        assert_eq!(dict.name, "紅樓夢人物");
        assert_eq!(dict.description, Some("Character names".to_string()));
    }

    #[test]
    fn test_add_entry() {
        let conn = setup_test_db();
        let dict = create_dictionary(&conn, "Test", None, None).unwrap();

        let entry = add_entry(
            &conn,
            dict.id,
            "賈寶玉",
            "Main protagonist of Dream of the Red Chamber",
            Some("jiǎ bǎo yù"),
            Some("Son of Jia Zheng"),
            &["character".to_string(), "protagonist".to_string()],
        ).unwrap();

        assert_eq!(entry.term, "賈寶玉");
        assert_eq!(entry.tags.len(), 2);
    }

    #[test]
    fn test_import_simple_format() {
        let mut conn = setup_test_db();
        let dict = create_dictionary(&conn, "Test", None, None).unwrap();

        let content = "詞語\t定義\n測試\ttest entry\n";
        let stats = import_simple_format(&mut conn, dict.id, content).unwrap();

        assert_eq!(stats.entries_added, 2);
    }
}
