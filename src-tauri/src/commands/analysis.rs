//! Text analysis commands.

use crate::commands::{AppState, CommandError, CommandResult};
use crate::library::{
    self,
    models::{
        AnalysisReport, CharacterContext, FrequencySort, PreStudyResult, ShelfAnalysis,
        TextAnalysis, TextSegment,
    },
};
use tauri::State;

/// Get text analysis (runs analysis if not cached)
#[tauri::command]
pub fn get_text_analysis(state: State<AppState>, text_id: i64) -> CommandResult<TextAnalysis> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    // Try to get cached analysis, run if not found
    match library::analysis::get_text_analysis(&conn, text_id) {
        Ok(analysis) => Ok(analysis),
        Err(library::LibraryError::AnalysisNotFound(_)) => {
            library::analysis::analyze_text(&conn, text_id)
                .map_err(|e| CommandError::Database(e.to_string()))
        }
        Err(e) => Err(CommandError::Database(e.to_string())),
    }
}

/// Get full analysis report
#[tauri::command]
pub fn get_analysis_report(
    state: State<AppState>,
    text_id: i64,
    top_n: Option<usize>,
    sort: Option<FrequencySort>,
) -> CommandResult<AnalysisReport> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    let sort = sort.unwrap_or_default();
    library::analysis::get_analysis_report(&conn, text_id, top_n, sort)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Re-analyze a text
#[tauri::command]
pub fn reanalyze_text(state: State<AppState>, text_id: i64) -> CommandResult<TextAnalysis> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    let result = library::analysis::reanalyze_text(&conn, text_id)
        .map_err(|e| CommandError::Database(e.to_string()))?;

    // Invalidate all shelf analysis caches since text analysis was updated
    let _ = library::analysis::invalidate_shelf_analysis_cache(&conn);

    Ok(result)
}

/// Get aggregated analysis for a shelf
#[tauri::command]
pub fn get_shelf_analysis(state: State<AppState>, shelf_id: i64) -> CommandResult<ShelfAnalysis> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::analysis::get_shelf_analysis(&conn, shelf_id)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Segment text content with known/unknown status
#[tauri::command]
pub fn segment_text(state: State<AppState>, content: String) -> CommandResult<Vec<TextSegment>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::analysis::segment_text(&conn, &content)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Get pre-study characters for a shelf to reach target known rate
#[tauri::command]
pub fn get_prestudy_characters(
    state: State<AppState>,
    shelf_id: i64,
    target_rate: f64,
) -> CommandResult<PreStudyResult> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::analysis::get_prestudy_characters(&conn, shelf_id, target_rate)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Get context snippets for a character from texts in a shelf
#[tauri::command]
pub fn get_character_context(
    state: State<AppState>,
    shelf_id: i64,
    character: String,
    max_snippets: Option<usize>,
) -> CommandResult<CharacterContext> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::analysis::get_character_context(&conn, shelf_id, &character, max_snippets.unwrap_or(3))
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Get context snippets for a word/character from all texts in the library
#[tauri::command]
pub fn get_word_context_all(
    state: State<AppState>,
    word: String,
    max_snippets: Option<usize>,
) -> CommandResult<CharacterContext> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::analysis::get_word_context_all(&conn, &word, max_snippets.unwrap_or(5))
        .map_err(|e| CommandError::Database(e.to_string()))
}
