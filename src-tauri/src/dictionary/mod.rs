//! Dictionary module for Chinese Reader.
//!
//! This module provides functionality for:
//! - Loading and querying multiple dictionary sources (CC-CEDICT, MOE Dict, Kangxi)
//! - Managing user-defined dictionaries for custom terms
//! - Full-text search across all dictionaries
//! - Character-level information (radicals, stroke count, decomposition)
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────┐
//! │                     Dictionary Module                        │
//! ├─────────────────────────────────────────────────────────────┤
//! │  Sources:                                                    │
//! │    - CC-CEDICT (Chinese-English, 160k+ entries)             │
//! │    - MOE Dict (Traditional Chinese, 163k entries)           │
//! │    - Kangxi (Classical Chinese characters)                  │
//! │    - User dictionaries (custom terms)                       │
//! │                                                              │
//! │  Features:                                                   │
//! │    - Unified lookup API                                     │
//! │    - Full-text search                                       │
//! │    - Character decomposition                                │
//! │    - Usage examples from classical texts                    │
//! └─────────────────────────────────────────────────────────────┘
//! ```
//!
//! # Usage
//!
//! ```rust,ignore
//! use chinese_reader_lib::dictionary::{self, models::LookupOptions};
//!
//! // Initialize the database
//! let conn = dictionary::init_connection("/path/to/dictionary.db")?;
//!
//! // Lookup a word
//! let options = LookupOptions {
//!     include_examples: true,
//!     include_character_info: true,
//!     ..Default::default()
//! };
//! let result = dictionary::lookup::lookup(&conn, "中文", &options)?;
//!
//! // Create a user dictionary
//! let dict = dictionary::user::create_dictionary(
//!     &conn,
//!     "紅樓夢人物",
//!     Some("Character names from Dream of the Red Chamber"),
//!     Some("book:紅樓夢"),
//! )?;
//! ```

pub mod error;
pub mod lookup;
pub mod models;
pub mod schema;
pub mod sources;
pub mod user;

use directories::ProjectDirs;
use rusqlite::Connection;
use std::path::PathBuf;

pub use error::{DictionaryError, Result};
pub use lookup::{lookup, search_fulltext};
pub use models::*;

/// Get the default database path for the application
pub fn get_default_db_path() -> Result<PathBuf> {
    let proj_dirs = ProjectDirs::from("com", "chinesereader", "ChineseReader")
        .ok_or_else(|| DictionaryError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Could not determine application data directory",
        )))?;

    let data_dir = proj_dirs.data_dir();
    std::fs::create_dir_all(data_dir)?;

    Ok(data_dir.join("dictionary.db"))
}

/// Initialize a database connection and ensure schema exists
pub fn init_connection(db_path: &std::path::Path) -> Result<Connection> {
    let conn = Connection::open(db_path)?;

    // Enable foreign keys
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

    // Initialize schema
    schema::init_database(&conn)?;

    Ok(conn)
}

/// Initialize an in-memory database (useful for testing)
pub fn init_memory_connection() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    schema::init_database(&conn)?;
    Ok(conn)
}

/// Check if a dictionary source has been imported
pub fn is_source_imported(conn: &Connection, source: &DictionarySource) -> Result<bool> {
    Ok(schema::is_dictionary_initialized(conn, source.as_str())?)
}

/// Get dictionary statistics
pub fn get_stats(conn: &Connection) -> Result<DictionaryStats> {
    let total_entries: i64 = conn.query_row(
        "SELECT COUNT(*) FROM dictionary_entries",
        [],
        |row| row.get(0),
    )?;

    let cedict_entries: i64 = conn.query_row(
        "SELECT COUNT(*) FROM dictionary_entries WHERE source = 'cc_cedict'",
        [],
        |row| row.get(0),
    )?;

    let moedict_entries: i64 = conn.query_row(
        "SELECT COUNT(*) FROM dictionary_entries WHERE source = 'moe_dict'",
        [],
        |row| row.get(0),
    )?;

    let kangxi_entries: i64 = conn.query_row(
        "SELECT COUNT(*) FROM dictionary_entries WHERE source = 'kangxi'",
        [],
        |row| row.get(0),
    )?;

    let character_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM characters",
        [],
        |row| row.get(0),
    )?;

    let user_dict_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM user_dictionaries",
        [],
        |row| row.get(0),
    )?;

    let user_entry_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM user_dictionary_entries",
        [],
        |row| row.get(0),
    )?;

    Ok(DictionaryStats {
        total_entries: total_entries as usize,
        cedict_entries: cedict_entries as usize,
        moedict_entries: moedict_entries as usize,
        kangxi_entries: kangxi_entries as usize,
        character_count: character_count as usize,
        user_dictionary_count: user_dict_count as usize,
        user_entry_count: user_entry_count as usize,
    })
}

/// Statistics about the dictionary database
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DictionaryStats {
    pub total_entries: usize,
    pub cedict_entries: usize,
    pub moedict_entries: usize,
    pub kangxi_entries: usize,
    pub character_count: usize,
    pub user_dictionary_count: usize,
    pub user_entry_count: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_init_memory_connection() {
        let conn = init_memory_connection().unwrap();
        let stats = get_stats(&conn).unwrap();
        assert_eq!(stats.total_entries, 0);
    }

    #[test]
    fn test_is_source_imported() {
        let conn = init_memory_connection().unwrap();
        let imported = is_source_imported(&conn, &DictionarySource::CcCedict).unwrap();
        assert!(!imported);
    }
}
