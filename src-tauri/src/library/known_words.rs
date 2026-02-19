//! Known vocabulary tracking.
//!
//! Manages the user's known words/characters for analysis comparison.
//! Words can be in "known" or "learning" status.
//! Learning words are highlighted differently and count as unknown for analysis.

use rusqlite::{params, Connection};

use super::error::Result;
use super::models::{ImportStats, KnownWord};

/// Add a word to the known vocabulary
pub fn add_known_word(
    conn: &Connection,
    word: &str,
    word_type: &str,
    status: Option<&str>,
    proficiency: Option<i64>,
) -> Result<KnownWord> {
    let status = status.unwrap_or("known");
    let proficiency = proficiency.unwrap_or(1);

    conn.execute(
        "INSERT OR REPLACE INTO known_words (word, word_type, status, proficiency)
         VALUES (?, ?, ?, ?)",
        params![word, word_type, status, proficiency],
    )?;

    get_known_word(conn, word)?.ok_or_else(|| {
        super::error::LibraryError::InvalidInput(format!("Failed to add word: {}", word))
    })
}

/// Get a known word by word string
pub fn get_known_word(conn: &Connection, word: &str) -> Result<Option<KnownWord>> {
    let result = conn.query_row(
        "SELECT id, word, word_type, status, proficiency, created_at FROM known_words WHERE word = ?",
        [word],
        |row| {
            Ok(KnownWord {
                id: row.get(0)?,
                word: row.get(1)?,
                word_type: row.get(2)?,
                status: row.get(3)?,
                proficiency: row.get(4)?,
                created_at: row.get(5)?,
            })
        },
    );

    match result {
        Ok(kw) => Ok(Some(kw)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Update the status of a known word
pub fn update_word_status(conn: &Connection, word: &str, status: &str) -> Result<()> {
    conn.execute(
        "UPDATE known_words SET status = ? WHERE word = ?",
        params![status, word],
    )?;
    Ok(())
}

/// Get the status of a word (returns None if word is not in known_words)
pub fn get_word_status(conn: &Connection, word: &str) -> Result<Option<String>> {
    let result = conn.query_row(
        "SELECT status FROM known_words WHERE word = ?",
        [word],
        |row| row.get(0),
    );

    match result {
        Ok(status) => Ok(Some(status)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Remove a word from known vocabulary
pub fn remove_known_word(conn: &Connection, word: &str) -> Result<()> {
    conn.execute("DELETE FROM known_words WHERE word = ?", [word])?;
    Ok(())
}

/// List known words with optional filtering
pub fn list_known_words(
    conn: &Connection,
    word_type: Option<&str>,
    status: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<KnownWord>> {
    let base_query = "SELECT id, word, word_type, status, proficiency, created_at FROM known_words";

    // Build WHERE clause
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<String> = Vec::new();

    if let Some(wt) = word_type {
        conditions.push("word_type = ?".to_string());
        params.push(wt.to_string());
    }

    if let Some(st) = status {
        conditions.push("status = ?".to_string());
        params.push(st.to_string());
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };

    let mut sql = format!("{}{} ORDER BY created_at DESC", base_query, where_clause);

    if let Some(l) = limit {
        sql.push_str(&format!(" LIMIT {}", l));
    }
    if let Some(o) = offset {
        sql.push_str(&format!(" OFFSET {}", o));
    }

    let mut stmt = conn.prepare(&sql)?;

    let param_refs: Vec<&dyn rusqlite::ToSql> = params
        .iter()
        .map(|s| s as &dyn rusqlite::ToSql)
        .collect();

    let known_words = stmt
        .query_map(param_refs.as_slice(), |row| {
            Ok(KnownWord {
                id: row.get(0)?,
                word: row.get(1)?,
                word_type: row.get(2)?,
                status: row.get(3)?,
                proficiency: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(known_words)
}

/// List all known words (for analysis comparison)
pub fn list_all_known_words(conn: &Connection) -> Result<Vec<KnownWord>> {
    list_known_words(conn, None, None, None, None)
}

/// Update proficiency level for a known word
pub fn update_proficiency(conn: &Connection, word: &str, proficiency: i64) -> Result<()> {
    conn.execute(
        "UPDATE known_words SET proficiency = ? WHERE word = ?",
        params![proficiency, word],
    )?;
    Ok(())
}

/// Import known words from text content (one word per line)
pub fn import_known_words(
    conn: &Connection,
    content: &str,
    word_type: &str,
) -> Result<ImportStats> {
    let mut words_added = 0;
    let mut words_skipped = 0;
    let mut errors = 0;

    for line in content.lines() {
        let word = line.trim();
        if word.is_empty() {
            continue;
        }

        // Check if word already exists
        if get_known_word(conn, word)?.is_some() {
            words_skipped += 1;
            continue;
        }

        match add_known_word(conn, word, word_type, None, None) {
            Ok(_) => words_added += 1,
            Err(_) => errors += 1,
        }
    }

    Ok(ImportStats {
        words_added,
        words_skipped,
        errors,
    })
}

/// Get count of known words by type
pub fn get_known_word_count(conn: &Connection, word_type: Option<&str>) -> Result<i64> {
    let count: i64 = if let Some(wt) = word_type {
        conn.query_row(
            "SELECT COUNT(*) FROM known_words WHERE word_type = ?",
            [wt],
            |row| row.get(0),
        )?
    } else {
        conn.query_row("SELECT COUNT(*) FROM known_words", [], |row| row.get(0))?
    };
    Ok(count)
}

/// Check if a word is known (status='known', not 'learning')
/// Learning words count as unknown for analysis purposes
pub fn is_word_known(conn: &Connection, word: &str) -> Result<bool> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM known_words WHERE word = ? AND status = 'known')",
        [word],
        |row| row.get(0),
    )?;
    Ok(exists)
}

/// Check if a word is in learning status
pub fn is_word_learning(conn: &Connection, word: &str) -> Result<bool> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM known_words WHERE word = ? AND status = 'learning')",
        [word],
        |row| row.get(0),
    )?;
    Ok(exists)
}

/// Check if a word exists in known_words table (regardless of status)
pub fn word_exists(conn: &Connection, word: &str) -> Result<bool> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM known_words WHERE word = ?)",
        [word],
        |row| row.get(0),
    )?;
    Ok(exists)
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
    fn test_add_and_get_known_word() {
        let conn = setup_test_db();

        let word = add_known_word(&conn, "中", "character", None, None).unwrap();

        assert_eq!(word.word, "中");
        assert_eq!(word.word_type, "character");
        assert_eq!(word.status, "known");
        assert_eq!(word.proficiency, 1);

        let retrieved = get_known_word(&conn, "中").unwrap().unwrap();
        assert_eq!(retrieved.word, word.word);
    }

    #[test]
    fn test_add_learning_word() {
        let conn = setup_test_db();

        let word = add_known_word(&conn, "学", "character", Some("learning"), None).unwrap();

        assert_eq!(word.word, "学");
        assert_eq!(word.status, "learning");

        // Learning words should not count as known
        assert!(!is_word_known(&conn, "学").unwrap());
        assert!(is_word_learning(&conn, "学").unwrap());
        assert!(word_exists(&conn, "学").unwrap());
    }

    #[test]
    fn test_update_word_status() {
        let conn = setup_test_db();

        add_known_word(&conn, "习", "character", Some("learning"), None).unwrap();
        assert!(!is_word_known(&conn, "习").unwrap());

        update_word_status(&conn, "习", "known").unwrap();
        assert!(is_word_known(&conn, "习").unwrap());
    }

    #[test]
    fn test_remove_known_word() {
        let conn = setup_test_db();

        add_known_word(&conn, "测", "character", None, None).unwrap();
        remove_known_word(&conn, "测").unwrap();

        assert!(get_known_word(&conn, "测").unwrap().is_none());
    }

    #[test]
    fn test_import_known_words() {
        let conn = setup_test_db();

        let content = "中\n文\n学\n习\n";
        let stats = import_known_words(&conn, content, "character").unwrap();

        assert_eq!(stats.words_added, 4);
        assert_eq!(stats.words_skipped, 0);
        assert_eq!(stats.errors, 0);

        // Import again - should skip all
        let stats2 = import_known_words(&conn, content, "character").unwrap();
        assert_eq!(stats2.words_added, 0);
        assert_eq!(stats2.words_skipped, 4);
    }

    #[test]
    fn test_list_known_words() {
        let conn = setup_test_db();

        add_known_word(&conn, "中", "character", None, None).unwrap();
        add_known_word(&conn, "文", "character", None, None).unwrap();
        add_known_word(&conn, "学习", "word", None, None).unwrap();

        let all = list_known_words(&conn, None, None, None).unwrap();
        assert_eq!(all.len(), 3);

        let chars = list_known_words(&conn, Some("character"), None, None).unwrap();
        assert_eq!(chars.len(), 2);

        let words = list_known_words(&conn, Some("word"), None, None).unwrap();
        assert_eq!(words.len(), 1);
    }

    #[test]
    fn test_is_word_known() {
        let conn = setup_test_db();

        add_known_word(&conn, "测试", "word", None, None).unwrap();

        assert!(is_word_known(&conn, "测试").unwrap());
        assert!(!is_word_known(&conn, "未知").unwrap());
    }
}
