//! User dictionary management commands.

use crate::commands::{AppState, CommandError, CommandResult, ImportResult};
use crate::dictionary::{
    self,
    models::{UserDictionary, UserDictionaryEntry},
};
use tauri::State;

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
