//! Learning and vocabulary progress commands.

use crate::commands::{AppState, CommandError, CommandResult};
use crate::dictionary;
use crate::library::{
    self,
    models::{
        FrequencyImportStats, FrequencySource, KnownWord, LearningStats, PercentileCoverage,
        ShelfFrequencyAnalysis, TermFrequencyInfo, VocabularyProgress,
    },
};
use rusqlite::{params, Connection};
use tauri::State;

/// Import frequency data from tab-separated content
#[tauri::command]
pub fn import_frequency_data(
    state: State<AppState>,
    content: String,
    source: String,
    term_type: String,
) -> CommandResult<FrequencyImportStats> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::learning::import_frequency_data(&conn, &content, &source, &term_type)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// List available frequency sources
#[tauri::command]
pub fn list_frequency_sources(state: State<AppState>) -> CommandResult<Vec<FrequencySource>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::learning::list_frequency_sources(&conn)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Get learning statistics
#[tauri::command]
pub fn get_learning_stats(
    state: State<AppState>,
    frequency_source: Option<String>,
) -> CommandResult<LearningStats> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::learning::get_learning_stats(&conn, frequency_source.as_deref())
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Get percentile coverage for a source and term type
#[tauri::command]
pub fn get_percentile_coverage(
    state: State<AppState>,
    source: String,
    term_type: String,
    percentiles: Vec<i64>,
) -> CommandResult<Vec<PercentileCoverage>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::learning::get_percentile_coverage(&conn, &source, &term_type, &percentiles)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Get vocabulary progress over time
#[tauri::command]
pub fn get_vocabulary_progress(
    state: State<AppState>,
    days: Option<i64>,
) -> CommandResult<Vec<VocabularyProgress>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::learning::get_vocabulary_progress(&conn, days)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Record a vocabulary snapshot for today
#[tauri::command]
pub fn record_vocabulary_snapshot(state: State<AppState>) -> CommandResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::learning::record_vocabulary_snapshot(&conn)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Get frequency analysis for a shelf
#[tauri::command]
pub fn get_shelf_frequency_analysis(
    state: State<AppState>,
    shelf_id: i64,
    frequency_source: String,
) -> CommandResult<ShelfFrequencyAnalysis> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::learning::get_shelf_frequency_analysis(&conn, shelf_id, &frequency_source)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Get study priorities - unknown terms sorted by frequency
#[tauri::command]
pub fn get_study_priorities(
    state: State<AppState>,
    source: String,
    term_type: Option<String>,
    limit: Option<usize>,
) -> CommandResult<Vec<TermFrequencyInfo>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::learning::get_study_priorities(&conn, &source, term_type.as_deref(), limit)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Clear frequency data for a source
#[tauri::command]
pub fn clear_frequency_source(state: State<AppState>, source: String) -> CommandResult<usize> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    library::learning::clear_frequency_source(&conn, &source)
        .map_err(|e| CommandError::Database(e.to_string()))
}

/// Result of adding a custom segmentation word
#[derive(serde::Serialize)]
pub struct AddCustomWordResult {
    pub word: String,
    pub added_to_segmentation: bool,
    pub known_word: Option<KnownWord>,
}

/// Add a custom segmentation word.
/// This adds the word to jieba's dictionary so it will be recognized during segmentation.
/// Optionally also adds it to the known_words table.
#[tauri::command]
pub fn add_custom_segmentation_word(
    state: State<AppState>,
    word: String,
    add_to_vocabulary: bool,
    status: Option<String>,
) -> CommandResult<AddCustomWordResult> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    // Default frequency for user-added words (high enough to be recognized)
    let frequency: i64 = 10000;

    // Insert into user_segmentation_words table (ignore if already exists)
    conn.execute(
        "INSERT OR IGNORE INTO user_segmentation_words (word, frequency) VALUES (?, ?)",
        params![&word, frequency],
    )
    .map_err(|e| CommandError::Database(e.to_string()))?;

    // Add to jieba runtime
    library::analysis::add_segmentation_word(&word, Some(frequency));

    // Optionally add to known_words
    let known_word = if add_to_vocabulary {
        let word_type = if word.chars().count() == 1 { "character" } else { "word" };
        let kw = library::known_words::add_known_word(
            &conn,
            &word,
            word_type,
            status.as_deref(),
            None,
        )
        .map_err(|e| CommandError::Database(e.to_string()))?;
        Some(kw)
    } else {
        None
    };

    Ok(AddCustomWordResult {
        word,
        added_to_segmentation: true,
        known_word,
    })
}

/// Result of defining a custom word
#[derive(serde::Serialize)]
pub struct DefineCustomWordResult {
    pub word: String,
    pub dictionary_id: i64,
    pub dictionary_name: String,
    pub entry_id: i64,
    pub added_to_segmentation: bool,
    pub known_word: Option<KnownWord>,
}

/// Define a custom word with a user-provided definition.
/// Creates a user dictionary entry and adds the word to segmentation.
/// If shelf_id is provided, creates/uses a shelf-specific dictionary.
#[tauri::command]
pub fn define_custom_word(
    state: State<AppState>,
    word: String,
    definition: String,
    pinyin: Option<String>,
    notes: Option<String>,
    shelf_id: Option<i64>,
    add_to_vocabulary: bool,
    status: Option<String>,
) -> CommandResult<DefineCustomWordResult> {
    let conn = state
        .db
        .lock()
        .map_err(|e| CommandError::Database(e.to_string()))?;

    // Find or create the appropriate user dictionary
    let (dictionary_id, dictionary_name) = if let Some(sid) = shelf_id {
        // Find or create shelf-specific dictionary
        find_or_create_shelf_dictionary(&conn, sid)?
    } else {
        // Find or create global custom words dictionary
        find_or_create_global_dictionary(&conn)?
    };

    // Add the entry to the user dictionary
    let entry = dictionary::user::add_entry(
        &conn,
        dictionary_id,
        &word,
        &definition,
        pinyin.as_deref(),
        notes.as_deref(),
        &[],
    )
    .map_err(|e| CommandError::Database(e.to_string()))?;

    // Add to segmentation
    let frequency: i64 = 10000;
    conn.execute(
        "INSERT OR IGNORE INTO user_segmentation_words (word, frequency) VALUES (?, ?)",
        params![&word, frequency],
    )
    .map_err(|e| CommandError::Database(e.to_string()))?;

    library::analysis::add_segmentation_word(&word, Some(frequency));

    // Optionally add to known_words
    let known_word = if add_to_vocabulary {
        let word_type = if word.chars().count() == 1 { "character" } else { "word" };
        let kw = library::known_words::add_known_word(
            &conn,
            &word,
            word_type,
            status.as_deref(),
            None,
        )
        .map_err(|e| CommandError::Database(e.to_string()))?;
        Some(kw)
    } else {
        None
    };

    Ok(DefineCustomWordResult {
        word,
        dictionary_id,
        dictionary_name,
        entry_id: entry.id,
        added_to_segmentation: true,
        known_word,
    })
}

/// Find or create a shelf-specific user dictionary
fn find_or_create_shelf_dictionary(conn: &Connection, shelf_id: i64) -> CommandResult<(i64, String)> {
    let domain = format!("shelf:{}", shelf_id);

    // Try to find existing dictionary for this shelf
    let existing: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, name FROM user_dictionaries WHERE domain = ?",
            [&domain],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();

    if let Some((id, name)) = existing {
        return Ok((id, name));
    }

    // Get shelf name for the dictionary name
    let shelf_name: String = conn
        .query_row(
            "SELECT name FROM shelves WHERE id = ?",
            [shelf_id],
            |row| row.get(0),
        )
        .map_err(|e| CommandError::Database(format!("Shelf not found: {}", e)))?;

    let dict_name = format!("{} - Custom Words", shelf_name);

    // Create new dictionary
    let dict = dictionary::user::create_dictionary(
        conn,
        &dict_name,
        Some(&format!("Custom word definitions for shelf: {}", shelf_name)),
        Some(&domain),
    )
    .map_err(|e| CommandError::Database(e.to_string()))?;

    Ok((dict.id, dict.name))
}

/// Find or create the global custom words dictionary
fn find_or_create_global_dictionary(conn: &Connection) -> CommandResult<(i64, String)> {
    let domain = "global:custom_words";

    // Try to find existing global dictionary
    let existing: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, name FROM user_dictionaries WHERE domain = ?",
            [domain],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();

    if let Some((id, name)) = existing {
        return Ok((id, name));
    }

    // Create new global dictionary
    let dict = dictionary::user::create_dictionary(
        conn,
        "Custom Words",
        Some("User-defined custom word definitions"),
        Some(domain),
    )
    .map_err(|e| CommandError::Database(e.to_string()))?;

    Ok((dict.id, dict.name))
}
