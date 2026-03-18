//! Library shelf and text management commands.

use crate::commands::{AppState, CommandError, CommandResult};
use crate::library::{
    self,
    models::{Shelf, ShelfTree, Text, TextSummary},
    MigrateLargeTextsResult,
};
use tauri::State;

/// Create a new shelf
#[tauri::command]
pub fn create_shelf(
    state: State<AppState>,
    name: String,
    description: Option<String>,
    parent_id: Option<i64>,
) -> CommandResult<Shelf> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::shelf::create_shelf(&conn, &name, description.as_deref(), parent_id)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// List root shelves
#[tauri::command]
pub fn list_root_shelves(state: State<AppState>) -> CommandResult<Vec<Shelf>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::shelf::list_root_shelves(&conn).map_err(|e| CommandError::Database(e.to_string()))
}

/// Get the full shelf tree
#[tauri::command]
pub fn get_shelf_tree(state: State<AppState>) -> CommandResult<Vec<ShelfTree>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::shelf::get_shelf_tree(&conn).map_err(|e| CommandError::Database(e.to_string()))
}

/// Update a shelf
#[tauri::command]
pub fn update_shelf(
    state: State<AppState>,
    id: i64,
    name: Option<String>,
    description: Option<String>,
) -> CommandResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    // Handle the nested Option for description
    let desc_opt = if description.is_some() {
        Some(description.as_deref())
    } else {
        None
    };

    library::shelf::update_shelf(&conn, id, name.as_deref(), desc_opt)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Delete a shelf
#[tauri::command]
pub fn delete_shelf(state: State<AppState>, id: i64) -> CommandResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::shelf::delete_shelf(&conn, id).map_err(|e| CommandError::Database(e.to_string()))
}

/// Move a shelf to a new parent
#[tauri::command]
pub fn move_shelf(
    state: State<AppState>,
    id: i64,
    new_parent_id: Option<i64>,
) -> CommandResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::shelf::move_shelf(&conn, id, new_parent_id)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Result of creating a text (may be split into sections)
#[derive(serde::Serialize)]
pub struct CreateTextCommandResult {
    pub text: Text,
    pub section_shelf_id: Option<i64>,
    pub section_count: usize,
}

/// Create a new text (auto-splits large texts into sections)
#[tauri::command]
pub fn create_text(
    state: State<AppState>,
    shelf_id: i64,
    title: String,
    content: String,
    author: Option<String>,
    source_type: String,
    convert_to_traditional: Option<bool>,
) -> CommandResult<CreateTextCommandResult> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    let result = library::text::create_text_with_splitting(
        &conn,
        shelf_id,
        &title,
        &content,
        author.as_deref(),
        &source_type,
        convert_to_traditional.unwrap_or(false),
    )
    .map_err(|e| CommandError::Database(e.to_string()))?;

    Ok(CreateTextCommandResult {
        text: result.text,
        section_shelf_id: result.section_shelf_id,
        section_count: result.section_count,
    })
}

/// Get a text by ID
#[tauri::command]
pub fn get_text(state: State<AppState>, id: i64) -> CommandResult<Text> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::text::get_text(&conn, id)
        .map_err(|e| CommandError::Database(e.to_string()))?
        .ok_or_else(|| CommandError::NotFound(format!("Text with id {} not found", id)))
}

/// List texts in a shelf
#[tauri::command]
pub fn list_texts_in_shelf(state: State<AppState>, shelf_id: i64) -> CommandResult<Vec<TextSummary>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::text::list_texts_in_shelf(&conn, shelf_id)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Update a text
#[tauri::command]
pub fn update_text(
    state: State<AppState>,
    id: i64,
    title: Option<String>,
    author: Option<String>,
) -> CommandResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    // Handle the nested Option for author
    let author_opt = if author.is_some() {
        Some(author.as_deref())
    } else {
        None
    };

    library::text::update_text(&conn, id, title.as_deref(), author_opt)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Delete a text
#[tauri::command]
pub fn delete_text(state: State<AppState>, id: i64) -> CommandResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::text::delete_text(&conn, id).map_err(|e| CommandError::Database(e.to_string()))
}

/// Import a text from a file (auto-splits large texts)
#[tauri::command]
pub fn import_text_file(
    state: State<AppState>,
    shelf_id: i64,
    file_path: String,
    convert_to_traditional: Option<bool>,
) -> CommandResult<Text> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::text::import_text_file_with_options(
        &conn,
        shelf_id,
        &file_path,
        convert_to_traditional.unwrap_or(false),
    )
    .map_err(|e| CommandError::Database(e.to_string()))
}

/// Migrate large texts (>1500 chars) into shelves with sections
/// If shelf_id is provided, only migrate texts in that shelf (and sub-shelves)
#[tauri::command]
pub fn migrate_large_texts(
    state: State<AppState>,
    shelf_id: Option<i64>,
) -> CommandResult<MigrateLargeTextsResult> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::text::migrate_large_texts(&conn, shelf_id)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Auto-mark statistics
#[derive(serde::Serialize)]
pub struct AutoMarkStats {
    pub characters_marked: i64,
    pub words_marked: i64,
}

/// Auto-mark all unknown characters and words from a text as known
#[tauri::command]
pub fn auto_mark_text_as_known(state: State<AppState>, text_id: i64) -> CommandResult<AutoMarkStats> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    let stats = library::analysis::auto_mark_text_as_known(&conn, text_id)
        .map_err(|e| CommandError::Database(e.to_string()))?;

    Ok(AutoMarkStats {
        characters_marked: stats.characters_marked,
        words_marked: stats.words_marked,
    })
}
