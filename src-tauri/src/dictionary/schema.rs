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

-- =============================================================================
-- Library Module Tables
-- =============================================================================

-- Hierarchical shelves (parent_id for nesting)
CREATE TABLE IF NOT EXISTS shelves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    parent_id INTEGER,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES shelves(id) ON DELETE CASCADE
);

-- Texts in shelves
CREATE TABLE IF NOT EXISTS texts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shelf_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    source_type TEXT NOT NULL DEFAULT 'paste',
    content TEXT NOT NULL,
    character_count INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (shelf_id) REFERENCES shelves(id) ON DELETE CASCADE
);

-- Cached analysis results
CREATE TABLE IF NOT EXISTS text_analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id INTEGER NOT NULL UNIQUE,
    total_characters INTEGER NOT NULL DEFAULT 0,
    unique_characters INTEGER NOT NULL DEFAULT 0,
    known_characters INTEGER NOT NULL DEFAULT 0,
    known_character_occurrences INTEGER NOT NULL DEFAULT 0,
    total_words INTEGER NOT NULL DEFAULT 0,
    unique_words INTEGER NOT NULL DEFAULT 0,
    known_words INTEGER NOT NULL DEFAULT 0,
    known_word_occurrences INTEGER NOT NULL DEFAULT 0,
    analyzed_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (text_id) REFERENCES texts(id) ON DELETE CASCADE
);

-- Character frequencies per text
CREATE TABLE IF NOT EXISTS text_character_freq (
    text_id INTEGER NOT NULL,
    character TEXT NOT NULL,
    frequency INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (text_id, character),
    FOREIGN KEY (text_id) REFERENCES texts(id) ON DELETE CASCADE
);

-- Word frequencies per text (jieba-segmented)
CREATE TABLE IF NOT EXISTS text_word_freq (
    text_id INTEGER NOT NULL,
    word TEXT NOT NULL,
    frequency INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (text_id, word),
    FOREIGN KEY (text_id) REFERENCES texts(id) ON DELETE CASCADE
);

-- User's known vocabulary
-- status: 'known' (fully learned) or 'learning' (in progress, counts as unknown for analysis)
CREATE TABLE IF NOT EXISTS known_words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL UNIQUE,
    word_type TEXT NOT NULL DEFAULT 'character',
    status TEXT NOT NULL DEFAULT 'known',
    proficiency INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- User settings (key-value store)
CREATE TABLE IF NOT EXISTS user_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Library indexes
CREATE INDEX IF NOT EXISTS idx_shelves_parent ON shelves(parent_id);
CREATE INDEX IF NOT EXISTS idx_texts_shelf ON texts(shelf_id);
CREATE INDEX IF NOT EXISTS idx_known_words_word ON known_words(word);
-- Note: idx_known_words_status is created in migrations after ensuring column exists

-- =============================================================================
-- Reading Speed Tracking Tables
-- =============================================================================

-- Reading session tracking
CREATE TABLE IF NOT EXISTS reading_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text_id INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    character_count INTEGER NOT NULL,
    is_first_read INTEGER NOT NULL DEFAULT 0,
    is_complete INTEGER NOT NULL DEFAULT 0,
    -- Vocabulary snapshot at session start (for correlation graphs)
    known_characters_count INTEGER NOT NULL DEFAULT 0,
    known_words_count INTEGER NOT NULL DEFAULT 0,
    -- Cumulative reading before this session
    cumulative_characters_read INTEGER NOT NULL DEFAULT 0,
    -- Calculated on completion
    duration_seconds INTEGER,
    characters_per_minute REAL,
    -- Auto-marked vocabulary counts (recorded when session completed with auto-mark)
    auto_marked_characters INTEGER NOT NULL DEFAULT 0,
    auto_marked_words INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    is_manual_log INTEGER NOT NULL DEFAULT 0,
    source TEXT,
    FOREIGN KEY (text_id) REFERENCES texts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reading_sessions_text ON reading_sessions(text_id);
CREATE INDEX IF NOT EXISTS idx_reading_sessions_complete ON reading_sessions(is_complete, is_first_read);

-- =============================================================================
-- Learning Module Tables
-- =============================================================================

-- Word/character frequency data from external sources
CREATE TABLE IF NOT EXISTS word_frequencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL,
    term_type TEXT NOT NULL,        -- 'character' or 'word'
    source TEXT NOT NULL,           -- 'books', 'movies', 'internet', etc.
    rank INTEGER NOT NULL,          -- 1 = most common
    frequency_count INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(term, term_type, source)
);

CREATE INDEX IF NOT EXISTS idx_word_frequencies_term ON word_frequencies(term);
CREATE INDEX IF NOT EXISTS idx_word_frequencies_rank ON word_frequencies(rank);
CREATE INDEX IF NOT EXISTS idx_word_frequencies_source ON word_frequencies(source);

-- Daily vocabulary snapshots for progress tracking
CREATE TABLE IF NOT EXISTS vocabulary_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_date TEXT NOT NULL,
    known_characters INTEGER NOT NULL,
    known_words INTEGER NOT NULL,
    learning_characters INTEGER NOT NULL,
    learning_words INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(snapshot_date)
);

-- User-defined segmentation words (added to jieba at runtime)
CREATE TABLE IF NOT EXISTS user_segmentation_words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL UNIQUE,
    frequency INTEGER NOT NULL DEFAULT 10000,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_segmentation_words_word ON user_segmentation_words(word);

-- Cached shelf analysis results (invalidated on vocabulary/text changes)
CREATE TABLE IF NOT EXISTS shelf_analyses_cache (
    shelf_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (shelf_id) REFERENCES shelves(id) ON DELETE CASCADE
);
"#;

/// Initialize the database with the schema
pub fn init_database(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA_SQL)?;

    // Run migrations for existing databases
    run_migrations(conn)?;

    // Set some initial metadata
    conn.execute(
        "INSERT OR REPLACE INTO dictionary_metadata (key, value) VALUES ('schema_version', '2')",
        [],
    )?;

    Ok(())
}

/// Run database migrations for schema updates
fn run_migrations(conn: &Connection) -> Result<()> {
    // Migration: Add 'status' column to known_words table if it doesn't exist
    // This is needed for databases created before the learning status feature
    let has_status_column: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('known_words') WHERE name = 'status'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if !has_status_column {
        // Add the status column with default value 'known'
        conn.execute(
            "ALTER TABLE known_words ADD COLUMN status TEXT NOT NULL DEFAULT 'known'",
            [],
        )?;
    }

    // Create index on status column (safe to run even if it exists due to IF NOT EXISTS)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_known_words_status ON known_words(status)",
        [],
    )?;

    // Migration: Add auto_marked columns to reading_sessions table if they don't exist
    let has_auto_marked_column: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('reading_sessions') WHERE name = 'auto_marked_characters'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if !has_auto_marked_column {
        conn.execute(
            "ALTER TABLE reading_sessions ADD COLUMN auto_marked_characters INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
        conn.execute(
            "ALTER TABLE reading_sessions ADD COLUMN auto_marked_words INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    // Migration: Add occurrence count columns to text_analyses table if they don't exist
    let has_occurrence_columns: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('text_analyses') WHERE name = 'known_character_occurrences'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if !has_occurrence_columns {
        conn.execute(
            "ALTER TABLE text_analyses ADD COLUMN known_character_occurrences INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
        conn.execute(
            "ALTER TABLE text_analyses ADD COLUMN known_word_occurrences INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    // Migration: Add text_known_char_percentage column to reading_sessions table
    // This tracks the percentage of known characters in the specific text at session start
    let has_text_known_pct_column: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('reading_sessions') WHERE name = 'text_known_char_percentage'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if !has_text_known_pct_column {
        conn.execute(
            "ALTER TABLE reading_sessions ADD COLUMN text_known_char_percentage REAL",
            [],
        )?;
    }

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

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn).unwrap();
        conn
    }

    #[test]
    fn test_reading_sessions_has_manual_log_columns() {
        let conn = test_db();
        // Satisfy FK chain: shelves -> texts -> reading_sessions
        conn.execute(
            "INSERT INTO shelves (name) VALUES ('Test Shelf')",
            [],
        ).unwrap();
        let shelf_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO texts (shelf_id, title, content, character_count) VALUES (?1, 'Test Text', 'content', 7)",
            [shelf_id],
        ).unwrap();
        let text_id = conn.last_insert_rowid();

        // Insert a row using the new columns — will fail if columns don't exist
        conn.execute(
            "INSERT INTO reading_sessions
             (text_id, started_at, character_count, is_manual_log, source)
             VALUES (?1, '2026-01-01T00:00:00Z', 100, 1, 'physical_book')",
            [text_id],
        ).unwrap();

        let (is_manual, source): (i64, String) = conn.query_row(
            "SELECT is_manual_log, source FROM reading_sessions WHERE rowid = last_insert_rowid()",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();

        assert_eq!(is_manual, 1);
        assert_eq!(source, "physical_book");
    }

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
