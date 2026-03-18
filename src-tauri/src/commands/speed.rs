//! Reading speed tracking commands.

use crate::commands::{AppState, CommandError, CommandResult};
use crate::library::{
    self, DailyReadingVolume, ReadingSession, ReadingStreak, SpeedDataPoint, SpeedStats,
};
use tauri::State;

/// Start a new reading session for a text
#[tauri::command]
pub fn start_reading_session(state: State<AppState>, text_id: i64) -> CommandResult<ReadingSession> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::speed::start_reading_session(&conn, text_id)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Finish an active reading session
#[tauri::command]
pub fn finish_reading_session(
    state: State<AppState>,
    session_id: i64,
) -> CommandResult<ReadingSession> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::speed::finish_reading_session(&conn, session_id)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Discard (delete) an incomplete reading session
#[tauri::command]
pub fn discard_reading_session(state: State<AppState>, session_id: i64) -> CommandResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::speed::discard_reading_session(&conn, session_id)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Delete a reading session (any session)
#[tauri::command]
pub fn delete_reading_session(state: State<AppState>, session_id: i64) -> CommandResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::speed::delete_reading_session(&conn, session_id)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Update auto-marked vocabulary counts for a session
#[tauri::command]
pub fn update_session_auto_marked(
    state: State<AppState>,
    session_id: i64,
    auto_marked_characters: i64,
    auto_marked_words: i64,
) -> CommandResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::speed::update_session_auto_marked(&conn, session_id, auto_marked_characters, auto_marked_words)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Get the active (incomplete) reading session for a text
#[tauri::command]
pub fn get_active_reading_session(
    state: State<AppState>,
    text_id: i64,
) -> CommandResult<Option<ReadingSession>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::speed::get_active_session(&conn, text_id)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Get reading history for a text
#[tauri::command]
pub fn get_text_reading_history(
    state: State<AppState>,
    text_id: i64,
) -> CommandResult<Vec<ReadingSession>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::speed::get_text_reading_history(&conn, text_id)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Get speed data points for graphing
#[tauri::command]
pub fn get_speed_data(
    state: State<AppState>,
    shelf_id: Option<i64>,
    first_reads_only: Option<bool>,
    limit: Option<usize>,
) -> CommandResult<Vec<SpeedDataPoint>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::speed::get_speed_data(&conn, shelf_id, first_reads_only.unwrap_or(true), limit)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Get aggregated speed statistics
#[tauri::command]
pub fn get_speed_stats(state: State<AppState>, shelf_id: Option<i64>) -> CommandResult<SpeedStats> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::speed::get_speed_stats(&conn, shelf_id)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Get daily reading volume for the past N days
#[tauri::command]
pub fn get_daily_reading_volume(state: State<AppState>, days: i64) -> CommandResult<Vec<DailyReadingVolume>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::speed::get_daily_reading_volume(&conn, days)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Get reading streak information
#[tauri::command]
pub fn get_reading_streak(state: State<AppState>) -> CommandResult<ReadingStreak> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::speed::get_reading_streak(&conn)
        .map_err(|e| CommandError::Database(e.to_string()))
}
