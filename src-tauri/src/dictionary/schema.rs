//! Database schema definitions and initialization for the dictionary system.
//!
//! Uses SQLite for storage with full-text search support.

use rusqlite::{Connection, Result};

/// SQL statements to create the dictionary database schema
pub const SCHEMA_SQL: &str = r#"
-- Main dictionary entries table
CREATE TABLE IF NOT EXISTS dictionary_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    traditional TEXT NOT NULL,
    simplified TEXT NOT NULL,
    pinyin TEXT NOT NULL,
    pinyin_display TEXT,
    zhuyin TEXT,
    source TEXT NOT NULL,
    frequency_rank INTEGER,
    hsk_level INTEGER,
    tocfl_level INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Definitions table (one entry can have multiple definitions)
CREATE TABLE IF NOT EXISTS definitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    part_of_speech TEXT,
    language TEXT NOT NULL DEFAULT 'en',
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (entry_id) REFERENCES dictionary_entries(id) ON DELETE CASCADE
);

-- Usage examples table
CREATE TABLE IF NOT EXISTS usage_examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    translation TEXT,
    source TEXT,
    source_detail TEXT,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (entry_id) REFERENCES dictionary_entries(id) ON DELETE CASCADE
);

-- Character-specific information
CREATE TABLE IF NOT EXISTS characters (
    character TEXT PRIMARY KEY,
    radical_number INTEGER,
    radical TEXT,
    additional_strokes INTEGER,
    total_strokes INTEGER,
    decomposition TEXT,
    etymology TEXT,
    traditional_form TEXT,
    simplified_form TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Character variants mapping
CREATE TABLE IF NOT EXISTS character_variants (
    character TEXT NOT NULL,
    variant TEXT NOT NULL,
    variant_type TEXT,
    PRIMARY KEY (character, variant),
    FOREIGN KEY (character) REFERENCES characters(character) ON DELETE CASCADE
);

-- User-defined dictionaries
CREATE TABLE IF NOT EXISTS user_dictionaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    domain TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- User dictionary entries
CREATE TABLE IF NOT EXISTS user_dictionary_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dictionary_id INTEGER NOT NULL,
    term TEXT NOT NULL,
    pinyin TEXT,
    definition TEXT NOT NULL,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (dictionary_id) REFERENCES user_dictionaries(id) ON DELETE CASCADE
);

-- Tags for user dictionary entries
CREATE TABLE IF NOT EXISTS user_entry_tags (
    entry_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (entry_id, tag),
    FOREIGN KEY (entry_id) REFERENCES user_dictionary_entries(id) ON DELETE CASCADE
);

-- Dictionary metadata (version info, last update, etc.)
CREATE TABLE IF NOT EXISTS dictionary_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_entries_traditional ON dictionary_entries(traditional);
CREATE INDEX IF NOT EXISTS idx_entries_simplified ON dictionary_entries(simplified);
CREATE INDEX IF NOT EXISTS idx_entries_pinyin ON dictionary_entries(pinyin);
CREATE INDEX IF NOT EXISTS idx_entries_source ON dictionary_entries(source);
CREATE INDEX IF NOT EXISTS idx_definitions_entry ON definitions(entry_id);
CREATE INDEX IF NOT EXISTS idx_examples_entry ON usage_examples(entry_id);
CREATE INDEX IF NOT EXISTS idx_user_entries_dictionary ON user_dictionary_entries(dictionary_id);
CREATE INDEX IF NOT EXISTS idx_user_entries_term ON user_dictionary_entries(term);

-- Full-text search virtual table for entries
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    traditional,
    simplified,
    pinyin,
    content='dictionary_entries',
    content_rowid='id'
);

-- Full-text search for user entries
CREATE VIRTUAL TABLE IF NOT EXISTS user_entries_fts USING fts5(
    term,
    definition,
    notes,
    content='user_dictionary_entries',
    content_rowid='id'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON dictionary_entries BEGIN
    INSERT INTO entries_fts(rowid, traditional, simplified, pinyin)
    VALUES (new.id, new.traditional, new.simplified, new.pinyin);
END;

CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON dictionary_entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, traditional, simplified, pinyin)
    VALUES ('delete', old.id, old.traditional, old.simplified, old.pinyin);
END;

CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON dictionary_entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, traditional, simplified, pinyin)
    VALUES ('delete', old.id, old.traditional, old.simplified, old.pinyin);
    INSERT INTO entries_fts(rowid, traditional, simplified, pinyin)
    VALUES (new.id, new.traditional, new.simplified, new.pinyin);
END;

CREATE TRIGGER IF NOT EXISTS user_entries_ai AFTER INSERT ON user_dictionary_entries BEGIN
    INSERT INTO user_entries_fts(rowid, term, definition, notes)
    VALUES (new.id, new.term, new.definition, new.notes);
END;

CREATE TRIGGER IF NOT EXISTS user_entries_ad AFTER DELETE ON user_dictionary_entries BEGIN
    INSERT INTO user_entries_fts(user_entries_fts, rowid, term, definition, notes)
    VALUES ('delete', old.id, old.term, old.definition, old.notes);
END;

CREATE TRIGGER IF NOT EXISTS user_entries_au AFTER UPDATE ON user_dictionary_entries BEGIN
    INSERT INTO user_entries_fts(user_entries_fts, rowid, term, definition, notes)
    VALUES ('delete', old.id, old.term, old.definition, old.notes);
    INSERT INTO user_entries_fts(rowid, term, definition, notes)
    VALUES (new.id, new.term, new.definition, new.notes);
END;
"#;

/// Initialize the database with the schema
pub fn init_database(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA_SQL)?;

    // Set some initial metadata
    conn.execute(
        "INSERT OR REPLACE INTO dictionary_metadata (key, value) VALUES ('schema_version', '1')",
        [],
    )?;

    Ok(())
}

/// Check if the database has been initialized with dictionary data
pub fn is_dictionary_initialized(conn: &Connection, source: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM dictionary_entries WHERE source = ?",
        [source],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Get metadata value
pub fn get_metadata(conn: &Connection, key: &str) -> Result<Option<String>> {
    let result = conn.query_row(
        "SELECT value FROM dictionary_metadata WHERE key = ?",
        [key],
        |row| row.get(0),
    );

    match result {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Set metadata value
pub fn set_metadata(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO dictionary_metadata (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
        [key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_schema_creation() {
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn).unwrap();

        // Verify tables exist
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        assert!(tables.contains(&"dictionary_entries".to_string()));
        assert!(tables.contains(&"definitions".to_string()));
        assert!(tables.contains(&"user_dictionaries".to_string()));
    }

    #[test]
    fn test_metadata() {
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn).unwrap();

        set_metadata(&conn, "test_key", "test_value").unwrap();
        let value = get_metadata(&conn, "test_key").unwrap();
        assert_eq!(value, Some("test_value".to_string()));
    }
}
