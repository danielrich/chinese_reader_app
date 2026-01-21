//! Tauri commands for dictionary operations.
//!
//! These commands expose the dictionary functionality to the frontend.

use crate::dictionary::{
    self,
    models::{
        DictionarySource, LookupOptions, LookupResult, UserDictionary,
        UserDictionaryEntry,
    },
    sources, DictionaryStats,
};
use rusqlite::Connection;
use std::fs::File;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

/// Application state containing the database connection
pub struct AppState {
    pub db: Mutex<Connection>,
}

/// Error type for Tauri commands
#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("Database error: {0}")]
    Database(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("IO error: {0}")]
    Io(String),

    #[error("Invalid input: {0}")]
    InvalidInput(String),
}

impl serde::Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

type CommandResult<T> = Result<T, CommandError>;

// =============================================================================
// Dictionary Lookup Commands
// =============================================================================

/// Lookup a word or character in the dictionaries
#[tauri::command]
pub fn dictionary_lookup(
    state: State<AppState>,
    query: String,
    include_examples: bool,
    include_character_info: bool,
    include_user_dictionaries: bool,
    sources: Vec<String>,
) -> CommandResult<LookupResult> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    let source_enums: Vec<DictionarySource> = sources
        .iter()
        .filter_map(|s| match s.as_str() {
            "cc_cedict" => Some(DictionarySource::CcCedict),
            "moe_dict" => Some(DictionarySource::MoeDict),
            "kangxi" => Some(DictionarySource::Kangxi),
            "ctext" => Some(DictionarySource::Ctext),
            "user" => Some(DictionarySource::User),
            _ => None,
        })
        .collect();

    let options = LookupOptions {
        sources: source_enums,
        include_examples,
        include_character_info,
        include_user_dictionaries,
        user_dictionary_ids: Vec::new(),
        max_results: Some(50),
    };

    dictionary::lookup(&conn, &query, &options).map_err(|e| CommandError::Database(e.to_string()))
}

/// Full-text search across dictionaries
#[tauri::command]
pub fn dictionary_search(
    state: State<AppState>,
    query: String,
    max_results: Option<usize>,
) -> CommandResult<Vec<crate::dictionary::models::DictionaryEntry>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    let options = LookupOptions {
        max_results: max_results.or(Some(50)),
        include_examples: false,
        ..Default::default()
    };

    dictionary::search_fulltext(&conn, &query, &options)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Get dictionary statistics
#[tauri::command]
pub fn dictionary_stats(state: State<AppState>) -> CommandResult<DictionaryStats> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    dictionary::get_stats(&conn).map_err(|e| CommandError::Database(e.to_string()))
}

// =============================================================================
// Dictionary Import Commands
// =============================================================================

/// Import CC-CEDICT from a file
#[tauri::command]
pub fn import_cedict(state: State<AppState>, file_path: String) -> CommandResult<ImportResult> {
    let mut conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(CommandError::NotFound(format!(
            "File not found: {}",
            file_path
        )));
    }

    let file = File::open(&path).map_err(|e| CommandError::Io(e.to_string()))?;

    let stats =
        sources::import_cedict(&mut conn, file).map_err(|e| CommandError::Database(e.to_string()))?;

    Ok(ImportResult {
        source: "CC-CEDICT".to_string(),
        entries_added: stats.entries_added,
        errors: stats.errors,
    })
}

/// Import MOE Dictionary from a JSON file
#[tauri::command]
pub fn import_moedict(state: State<AppState>, file_path: String) -> CommandResult<ImportResult> {
    let mut conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(CommandError::NotFound(format!(
            "File not found: {}",
            file_path
        )));
    }

    let file = File::open(&path).map_err(|e| CommandError::Io(e.to_string()))?;

    let stats =
        sources::import_moedict(&mut conn, file).map_err(|e| CommandError::Database(e.to_string()))?;

    Ok(ImportResult {
        source: "MOE Dictionary".to_string(),
        entries_added: stats.entries_added,
        errors: stats.errors,
    })
}

/// Import Kangxi Dictionary from a text file
#[tauri::command]
pub fn import_kangxi(state: State<AppState>, file_path: String) -> CommandResult<ImportResult> {
    let mut conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(CommandError::NotFound(format!(
            "File not found: {}",
            file_path
        )));
    }

    let file = File::open(&path).map_err(|e| CommandError::Io(e.to_string()))?;

    let stats = sources::import_kangxi_text(&mut conn, file)
        .map_err(|e| CommandError::Database(e.to_string()))?;

    Ok(ImportResult {
        source: "Kangxi Dictionary".to_string(),
        entries_added: stats.entries_added,
        errors: stats.errors,
    })
}

#[derive(serde::Serialize)]
pub struct ImportResult {
    pub source: String,
    pub entries_added: usize,
    pub errors: usize,
}

// =============================================================================
// User Dictionary Commands
// =============================================================================

/// Create a new user dictionary
#[tauri::command]
pub fn create_user_dictionary(
    state: State<AppState>,
    name: String,
    description: Option<String>,
    domain: Option<String>,
) -> CommandResult<UserDictionary> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    dictionary::user::create_dictionary(&conn, &name, description.as_deref(), domain.as_deref())
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// List all user dictionaries
#[tauri::command]
pub fn list_user_dictionaries(state: State<AppState>) -> CommandResult<Vec<UserDictionary>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    dictionary::user::list_dictionaries(&conn).map_err(|e| CommandError::Database(e.to_string()))
}

/// Get a user dictionary by ID
#[tauri::command]
pub fn get_user_dictionary(state: State<AppState>, id: i64) -> CommandResult<UserDictionary> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    dictionary::user::get_dictionary(&conn, id)
        .map_err(|e| CommandError::Database(e.to_string()))?
        .ok_or_else(|| CommandError::NotFound(format!("Dictionary with id {} not found", id)))
}

/// Delete a user dictionary
#[tauri::command]
pub fn delete_user_dictionary(state: State<AppState>, id: i64) -> CommandResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    dictionary::user::delete_dictionary(&conn, id)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Add an entry to a user dictionary
#[tauri::command]
pub fn add_user_dictionary_entry(
    state: State<AppState>,
    dictionary_id: i64,
    term: String,
    definition: String,
    pinyin: Option<String>,
    notes: Option<String>,
    tags: Vec<String>,
) -> CommandResult<UserDictionaryEntry> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    dictionary::user::add_entry(
        &conn,
        dictionary_id,
        &term,
        &definition,
        pinyin.as_deref(),
        notes.as_deref(),
        &tags,
    )
    .map_err(|e| CommandError::Database(e.to_string()))
}

/// List entries in a user dictionary
#[tauri::command]
pub fn list_user_dictionary_entries(
    state: State<AppState>,
    dictionary_id: i64,
    limit: Option<usize>,
    offset: Option<usize>,
) -> CommandResult<Vec<UserDictionaryEntry>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    dictionary::user::list_entries(&conn, dictionary_id, limit, offset)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Update a user dictionary entry
#[tauri::command]
pub fn update_user_dictionary_entry(
    state: State<AppState>,
    id: i64,
    term: Option<String>,
    definition: Option<String>,
    pinyin: Option<String>,
    notes: Option<String>,
    tags: Option<Vec<String>>,
) -> CommandResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    dictionary::user::update_entry(
        &conn,
        id,
        term.as_deref(),
        definition.as_deref(),
        pinyin.as_deref(),
        notes.as_deref(),
        tags.as_deref(),
    )
    .map_err(|e| CommandError::Database(e.to_string()))
}

/// Delete a user dictionary entry
#[tauri::command]
pub fn delete_user_dictionary_entry(state: State<AppState>, id: i64) -> CommandResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    dictionary::user::delete_entry(&conn, id).map_err(|e| CommandError::Database(e.to_string()))
}

/// Import entries from simple tab-separated format
#[tauri::command]
pub fn import_user_dictionary_entries(
    state: State<AppState>,
    dictionary_id: i64,
    content: String,
) -> CommandResult<ImportResult> {
    let mut conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    let stats = dictionary::user::import_simple_format(&mut conn, dictionary_id, &content)
        .map_err(|e| CommandError::Database(e.to_string()))?;

    Ok(ImportResult {
        source: "User import".to_string(),
        entries_added: stats.entries_added,
        errors: stats.errors,
    })
}
