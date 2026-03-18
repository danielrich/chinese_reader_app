//! Known words management commands.

use crate::commands::{AppState, CommandError, CommandResult};
use crate::library::{
    self,
    models::{ImportStats, KnownWord},
};
use tauri::State;

/// Add a known word
#[tauri::command]
pub fn add_known_word(
    state: State<AppState>,
    word: String,
    word_type: String,
    status: Option<String>,
    proficiency: Option<i64>,
) -> CommandResult<KnownWord> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::known_words::add_known_word(&conn, &word, &word_type, status.as_deref(), proficiency)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Update the status of a known word
#[tauri::command]
pub fn update_word_status(
    state: State<AppState>,
    word: String,
    status: String,
) -> CommandResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::known_words::update_word_status(&conn, &word, &status)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Remove a known word
#[tauri::command]
pub fn remove_known_word(state: State<AppState>, word: String) -> CommandResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::known_words::remove_known_word(&conn, &word)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// List known words
#[tauri::command]
pub fn list_known_words(
    state: State<AppState>,
    word_type: Option<String>,
    status: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> CommandResult<Vec<KnownWord>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::known_words::list_known_words(&conn, word_type.as_deref(), status.as_deref(), limit, offset)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Import known words from content
#[tauri::command]
pub fn import_known_words(
    state: State<AppState>,
    content: String,
    word_type: String,
) -> CommandResult<ImportStats> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::known_words::import_known_words(&conn, &content, &word_type)
        .map_err(|e| CommandError::Database(e.to_string()))
}
