//! User settings commands.

use crate::commands::{AppState, CommandError, CommandResult};
use crate::library;
use tauri::State;

/// Get a user setting
#[tauri::command]
pub fn get_setting(state: State<AppState>, key: String) -> CommandResult<Option<String>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::settings::get_setting(&conn, &key).map_err(|e| CommandError::Database(e.to_string()))
}

/// Set a user setting
#[tauri::command]
pub fn set_setting(state: State<AppState>, key: String, value: String) -> CommandResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::settings::set_setting(&conn, &key, &value)
        .map_err(|e| CommandError::Database(e.to_string()))
}
