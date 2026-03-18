//! Dictionary lookup and import commands.

use crate::commands::{AppState, CommandError, CommandResult, ImportResult};
use crate::dictionary::{
    self,
    models::{DictionarySource, LookupOptions, LookupResult},
    sources, DictionaryStats,
};
use std::fs::File;
use std::path::PathBuf;
use tauri::State;

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
