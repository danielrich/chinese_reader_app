//! Tauri commands for dictionary and library operations.
//!
//! These commands expose the dictionary and library functionality to the frontend.

use crate::dictionary::{
    self,
    models::{
        DictionarySource, LookupOptions, LookupResult, UserDictionary,
        UserDictionaryEntry,
    },
    sources, DictionaryStats,
};
use crate::library::{
    self,
    models::{
        AnalysisReport, CharacterContext, FrequencyImportStats, FrequencySort, FrequencySource,
        ImportStats, KnownWord, LearningStats, PercentileCoverage, PreStudyResult, Shelf,
        ShelfAnalysis, ShelfFrequencyAnalysis, ShelfTree, TermFrequencyInfo, Text, TextAnalysis,
        TextSegment, TextSummary, VocabularyProgress,
    },
    DailyReadingVolume, MigrateLargeTextsResult, ReadingSession, ReadingStreak, SpeedDataPoint, SpeedStats,
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

// =============================================================================
// Library Shelf Commands
// =============================================================================

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

// =============================================================================
// Library Text Commands
// =============================================================================

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

// =============================================================================
// Library Analysis Commands
// =============================================================================

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

    library::analysis::reanalyze_text(&conn, text_id)
        .map_err(|e| CommandError::Database(e.to_string()))
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

// =============================================================================
// Known Words Commands
// =============================================================================

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

// =============================================================================
// Speed Tracking Commands
// =============================================================================

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

// =============================================================================
// Settings Commands
// =============================================================================

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

// =============================================================================
// Auto-Mark Commands
// =============================================================================

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

// =============================================================================
// Learning Commands
// =============================================================================

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

// =============================================================================
// Custom Segmentation Commands
// =============================================================================

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
        rusqlite::params![&word, frequency],
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
        rusqlite::params![&word, frequency],
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
fn find_or_create_shelf_dictionary(conn: &rusqlite::Connection, shelf_id: i64) -> CommandResult<(i64, String)> {
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
fn find_or_create_global_dictionary(conn: &rusqlite::Connection) -> CommandResult<(i64, String)> {
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
