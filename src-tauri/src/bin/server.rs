//! Chinese Reader HTTP server.
//!
//! Exposes the same library functions as the Tauri app over HTTP,
//! so the app can be accessed from any browser on the local network.
//!
//! Usage:
//!   cargo run --bin server -- [--db-path <path>] [--port <port>] [--dist <path>]

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use chinese_reader_lib::{dictionary, library};
use rusqlite::Connection;
use serde_json::Value;
use std::env;
use std::sync::{Arc, Mutex};
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

type Db = Arc<Mutex<Connection>>;

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();

    let db_path = if let Some(idx) = args.iter().position(|a| a == "--db-path") {
        args.get(idx + 1)
            .cloned()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                eprintln!("--db-path requires a value");
                std::process::exit(1);
            })
    } else {
        dictionary::get_default_db_path().unwrap_or_else(|e| {
            eprintln!("Failed to determine default db path: {}", e);
            std::process::exit(1);
        })
    };

    let port: u16 = if let Some(idx) = args.iter().position(|a| a == "--port") {
        args.get(idx + 1)
            .and_then(|v| v.parse().ok())
            .unwrap_or(3000)
    } else {
        3000
    };

    let dist_dir: std::path::PathBuf = if let Some(idx) = args.iter().position(|a| a == "--dist") {
        args.get(idx + 1)
            .cloned()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("./dist"))
    } else {
        std::path::PathBuf::from("./dist")
    };

    println!("Database: {:?}", db_path);
    let conn = dictionary::init_connection(&db_path).unwrap_or_else(|e| {
        eprintln!("Failed to initialize database: {}", e);
        std::process::exit(1);
    });

    match library::analysis::load_user_segmentation_words(&conn) {
        Ok(count) if count > 0 => println!("Loaded {} user segmentation words", count),
        Ok(_) => {}
        Err(e) => eprintln!("Warning: failed to load segmentation words: {}", e),
    }

    let db: Db = Arc::new(Mutex::new(conn));

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let index_path = dist_dir.join("index.html");
    let serve_static = ServeDir::new(&dist_dir).not_found_service(ServeFile::new(&index_path));

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/invoke/{command}", post(dispatch))
        .route("/api/texts/{id}", get(get_text_handler))
        .route("/api/texts/{id}/vocab-cache", get(get_text_vocab_cache_handler))
        .route("/api/sync/sessions", post(sync_sessions_handler))
        .fallback_service(serve_static)
        .with_state(db)
        .layer(cors);

    let addr = format!("0.0.0.0:{}", port);
    println!("Serving on http://{}", addr);
    println!("Static files from: {:?}", dist_dir);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| {
            eprintln!("Failed to bind {}: {}", addr, e);
            std::process::exit(1);
        });

    axum::serve(listener, app).await.unwrap();
}

async fn health() -> &'static str {
    "ok"
}

async fn dispatch(
    State(db): State<Db>,
    Path(command): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    let result = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| ApiError::Internal(e.to_string()))?;
        dispatch_sync(&conn, &command, &body)
    })
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))??;

    Ok(Json(result))
}

async fn get_text_handler(
    State(db): State<Db>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let result = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| ApiError::Internal(e.to_string()))?;
        let text = library::text::get_text(&conn, id)
            .map_err(db_err)?
            .ok_or_else(|| not_found(format!("Text {} not found", id)))?;
        serialize(text)
    })
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))??;

    Ok(Json(result))
}

async fn get_text_vocab_cache_handler(
    State(db): State<Db>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, AppError> {
    let result = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| ApiError::Internal(e.to_string()))?;
        let cache = library::analysis::get_text_vocab_cache(&conn, id).map_err(db_err)?;
        serialize(cache)
    })
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))??;

    Ok(Json(result))
}

async fn sync_sessions_handler(
    State(db): State<Db>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    let result = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| ApiError::Internal(e.to_string()))?;
        let sessions: Vec<library::speed::UploadSession> =
            serde_json::from_value(body.get("sessions").cloned().unwrap_or(Value::Array(vec![])))
                .map_err(|e| ApiError::BadRequest(format!("invalid sessions: {}", e)))?;
        let mut ids: Vec<i64> = Vec::new();
        for s in &sessions {
            ids.push(library::speed::upload_completed_session(&conn, s).map_err(db_err)?);
        }
        serialize(serde_json::json!({ "session_ids": ids }))
    })
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))??;
    Ok(Json(result))
}

// ── Error types ──────────────────────────────────────────────────────────────

#[derive(Debug)]
enum ApiError {
    NotFound(String),
    BadRequest(String),
    Internal(String),
}

impl From<ApiError> for AppError {
    fn from(e: ApiError) -> Self {
        match e {
            ApiError::NotFound(s) => AppError(s, StatusCode::NOT_FOUND),
            ApiError::BadRequest(s) => AppError(s, StatusCode::BAD_REQUEST),
            ApiError::Internal(s) => AppError(s, StatusCode::INTERNAL_SERVER_ERROR),
        }
    }
}

struct AppError(String, StatusCode);

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        (self.1, self.0).into_response()
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn field<T: serde::de::DeserializeOwned>(body: &Value, name: &str) -> Result<T, ApiError> {
    let val = body
        .get(name)
        .ok_or_else(|| ApiError::BadRequest(format!("Missing field: {}", name)))?;
    serde_json::from_value(val.clone())
        .map_err(|e| ApiError::BadRequest(format!("Invalid field '{}': {}", name, e)))
}

fn opt_field<T: serde::de::DeserializeOwned>(body: &Value, name: &str) -> Option<T> {
    body.get(name).and_then(|v| {
        if v.is_null() {
            None
        } else {
            serde_json::from_value(v.clone()).ok()
        }
    })
}

fn db_err(e: impl std::fmt::Display) -> ApiError {
    ApiError::Internal(e.to_string())
}

fn not_found(msg: impl std::fmt::Display) -> ApiError {
    ApiError::NotFound(msg.to_string())
}

fn serialize<T: serde::Serialize>(v: T) -> Result<Value, ApiError> {
    serde_json::to_value(v).map_err(|e| ApiError::Internal(e.to_string()))
}

// ── Main dispatch ─────────────────────────────────────────────────────────────

fn dispatch_sync(conn: &Connection, command: &str, body: &Value) -> Result<Value, ApiError> {
    match command {
        // ── Dictionary lookup ──────────────────────────────────────────────
        "dictionary_lookup" => {
            let query: String = field(body, "query")?;
            let include_examples: bool = field(body, "include_examples")?;
            let include_character_info: bool = field(body, "include_character_info")?;
            let include_user_dictionaries: bool = field(body, "include_user_dictionaries")?;
            let sources: Vec<String> = field(body, "sources")?;
            use chinese_reader_lib::dictionary::models::{DictionarySource, LookupOptions};
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
            serialize(dictionary::lookup(conn, &query, &options).map_err(db_err)?)
        }

        "dictionary_search" => {
            let query: String = field(body, "query")?;
            let max_results: Option<usize> = opt_field(body, "max_results");
            use chinese_reader_lib::dictionary::models::LookupOptions;
            let options = LookupOptions {
                max_results: max_results.or(Some(50)),
                include_examples: false,
                ..Default::default()
            };
            serialize(dictionary::search_fulltext(conn, &query, &options).map_err(db_err)?)
        }

        "dictionary_stats" => serialize(dictionary::get_stats(conn).map_err(db_err)?),

        // ── User dictionaries ──────────────────────────────────────────────
        "create_user_dictionary" => {
            let name: String = field(body, "name")?;
            let description: Option<String> = opt_field(body, "description");
            let domain: Option<String> = opt_field(body, "domain");
            serialize(
                dictionary::user::create_dictionary(
                    conn,
                    &name,
                    description.as_deref(),
                    domain.as_deref(),
                )
                .map_err(db_err)?,
            )
        }

        "list_user_dictionaries" => {
            serialize(dictionary::user::list_dictionaries(conn).map_err(db_err)?)
        }

        "get_user_dictionary" => {
            let id: i64 = field(body, "id")?;
            let dict = dictionary::user::get_dictionary(conn, id)
                .map_err(db_err)?
                .ok_or_else(|| not_found(format!("Dictionary {} not found", id)))?;
            serialize(dict)
        }

        "delete_user_dictionary" => {
            let id: i64 = field(body, "id")?;
            dictionary::user::delete_dictionary(conn, id).map_err(db_err)?;
            Ok(Value::Null)
        }

        "add_user_dictionary_entry" => {
            let dictionary_id: i64 = field(body, "dictionary_id")?;
            let term: String = field(body, "term")?;
            let definition: String = field(body, "definition")?;
            let pinyin: Option<String> = opt_field(body, "pinyin");
            let notes: Option<String> = opt_field(body, "notes");
            let tags: Vec<String> = opt_field(body, "tags").unwrap_or_default();
            serialize(
                dictionary::user::add_entry(
                    conn,
                    dictionary_id,
                    &term,
                    &definition,
                    pinyin.as_deref(),
                    notes.as_deref(),
                    &tags,
                )
                .map_err(db_err)?,
            )
        }

        "list_user_dictionary_entries" => {
            let dictionary_id: i64 = field(body, "dictionary_id")?;
            let limit: Option<usize> = opt_field(body, "limit");
            let offset: Option<usize> = opt_field(body, "offset");
            serialize(
                dictionary::user::list_entries(conn, dictionary_id, limit, offset)
                    .map_err(db_err)?,
            )
        }

        "update_user_dictionary_entry" => {
            let id: i64 = field(body, "id")?;
            let term: Option<String> = opt_field(body, "term");
            let definition: Option<String> = opt_field(body, "definition");
            let pinyin: Option<String> = opt_field(body, "pinyin");
            let notes: Option<String> = opt_field(body, "notes");
            let tags: Option<Vec<String>> = opt_field(body, "tags");
            dictionary::user::update_entry(
                conn,
                id,
                term.as_deref(),
                definition.as_deref(),
                pinyin.as_deref(),
                notes.as_deref(),
                tags.as_deref(),
            )
            .map_err(db_err)?;
            Ok(Value::Null)
        }

        "delete_user_dictionary_entry" => {
            let id: i64 = field(body, "id")?;
            dictionary::user::delete_entry(conn, id).map_err(db_err)?;
            Ok(Value::Null)
        }

        "import_user_dictionary_entries" => {
            // Requires &mut Connection — not supported via HTTP, use desktop app for bulk imports.
            Err(ApiError::BadRequest(
                "import_user_dictionary_entries: use the desktop app for bulk imports".to_string(),
            ))
        }

        // ── Library shelves ────────────────────────────────────────────────
        "create_shelf" => {
            let name: String = field(body, "name")?;
            let description: Option<String> = opt_field(body, "description");
            let parent_id: Option<i64> = opt_field(body, "parent_id");
            serialize(
                library::shelf::create_shelf(conn, &name, description.as_deref(), parent_id)
                    .map_err(db_err)?,
            )
        }

        "list_root_shelves" => serialize(library::shelf::list_root_shelves(conn).map_err(db_err)?),

        "get_shelf_tree" => serialize(library::shelf::get_shelf_tree(conn).map_err(db_err)?),

        "update_shelf" => {
            let id: i64 = field(body, "id")?;
            let name: Option<String> = opt_field(body, "name");
            let description: Option<String> = opt_field(body, "description");
            let desc_opt = if body.get("description").is_some() {
                Some(description.as_deref())
            } else {
                None
            };
            library::shelf::update_shelf(conn, id, name.as_deref(), desc_opt).map_err(db_err)?;
            Ok(Value::Null)
        }

        "delete_shelf" => {
            let id: i64 = field(body, "id")?;
            library::shelf::delete_shelf(conn, id).map_err(db_err)?;
            Ok(Value::Null)
        }

        "move_shelf" => {
            let id: i64 = field(body, "id")?;
            let new_parent_id: Option<i64> = opt_field(body, "new_parent_id");
            library::shelf::move_shelf(conn, id, new_parent_id).map_err(db_err)?;
            let _ = library::analysis::invalidate_shelf_analysis_cache(conn);
            Ok(Value::Null)
        }

        // ── Library texts ──────────────────────────────────────────────────
        "create_text" => {
            let shelf_id: i64 = field(body, "shelf_id")?;
            let title: String = field(body, "title")?;
            let content: String = field(body, "content")?;
            let author: Option<String> = opt_field(body, "author");
            let source_type: String = field(body, "source_type")?;
            let convert_to_traditional: bool =
                opt_field(body, "convert_to_traditional").unwrap_or(false);
            let result = library::text::create_text_with_splitting(
                conn,
                shelf_id,
                &title,
                &content,
                author.as_deref(),
                &source_type,
                convert_to_traditional,
            )
            .map_err(db_err)?;
            let _ = library::analysis::invalidate_shelf_analysis_cache(conn);
            serialize(serde_json::json!({
                "text": result.text,
                "section_shelf_id": result.section_shelf_id,
                "section_count": result.section_count,
            }))
        }

        "get_text" => {
            let id: i64 = field(body, "id")?;
            let text = library::text::get_text(conn, id)
                .map_err(db_err)?
                .ok_or_else(|| not_found(format!("Text {} not found", id)))?;
            serialize(text)
        }

        "list_texts_in_shelf" => {
            let shelf_id: i64 = field(body, "shelf_id")?;
            serialize(library::text::list_texts_in_shelf(conn, shelf_id).map_err(db_err)?)
        }

        "search_texts" => {
            let query: String = field(body, "query")?;
            serialize(library::text::search_texts(conn, &query).map_err(db_err)?)
        }

        "update_text" => {
            let id: i64 = field(body, "id")?;
            let title: Option<String> = opt_field(body, "title");
            let author: Option<String> = opt_field(body, "author");
            let author_opt = if body.get("author").is_some() {
                Some(author.as_deref())
            } else {
                None
            };
            library::text::update_text(conn, id, title.as_deref(), author_opt).map_err(db_err)?;
            Ok(Value::Null)
        }

        "delete_text" => {
            let id: i64 = field(body, "id")?;
            library::text::delete_text(conn, id).map_err(db_err)?;
            let _ = library::analysis::invalidate_shelf_analysis_cache(conn);
            Ok(Value::Null)
        }

        "migrate_large_texts" => {
            let shelf_id: Option<i64> = opt_field(body, "shelf_id");
            let result = library::text::migrate_large_texts(conn, shelf_id).map_err(db_err)?;
            let _ = library::analysis::invalidate_shelf_analysis_cache(conn);
            serialize(result)
        }

        // ── Library analysis ───────────────────────────────────────────────
        "get_text_analysis" => {
            let text_id: i64 = field(body, "text_id")?;
            let result = match library::analysis::get_text_analysis(conn, text_id) {
                Ok(a) => a,
                Err(library::LibraryError::AnalysisNotFound(_)) => {
                    library::analysis::analyze_text(conn, text_id).map_err(db_err)?
                }
                Err(e) => return Err(db_err(e)),
            };
            serialize(result)
        }

        "get_analysis_report" => {
            let text_id: i64 = field(body, "text_id")?;
            let top_n: Option<usize> = opt_field(body, "top_n");
            let sort: Option<library::models::FrequencySort> = opt_field(body, "sort");
            let sort = sort.unwrap_or_default();
            serialize(
                library::analysis::get_analysis_report(conn, text_id, top_n, sort)
                    .map_err(db_err)?,
            )
        }

        "reanalyze_text" => {
            let text_id: i64 = field(body, "text_id")?;
            let result = library::analysis::reanalyze_text(conn, text_id).map_err(db_err)?;
            let _ = library::analysis::invalidate_shelf_analysis_cache(conn);
            serialize(result)
        }

        "get_shelf_analysis" => {
            let shelf_id: i64 = field(body, "shelf_id")?;
            serialize(library::analysis::get_shelf_analysis(conn, shelf_id).map_err(db_err)?)
        }

        "segment_text" => {
            let content: String = field(body, "content")?;
            serialize(library::analysis::segment_text(conn, &content).map_err(db_err)?)
        }

        "get_prestudy_characters" => {
            let shelf_id: i64 = field(body, "shelf_id")?;
            let target_rate: f64 = field(body, "target_rate")?;
            serialize(
                library::analysis::get_prestudy_characters(conn, shelf_id, target_rate)
                    .map_err(db_err)?,
            )
        }

        "get_character_context" => {
            let shelf_id: i64 = field(body, "shelf_id")?;
            let character: String = field(body, "character")?;
            let max_snippets: usize = opt_field(body, "max_snippets").unwrap_or(3);
            serialize(
                library::analysis::get_character_context(conn, shelf_id, &character, max_snippets)
                    .map_err(db_err)?,
            )
        }

        "get_word_context_all" => {
            let word: String = field(body, "word")?;
            let max_snippets: usize = opt_field(body, "max_snippets").unwrap_or(5);
            serialize(
                library::analysis::get_word_context_all(conn, &word, max_snippets)
                    .map_err(db_err)?,
            )
        }

        // ── Known words ────────────────────────────────────────────────────
        "add_known_word" => {
            let word: String = field(body, "word")?;
            let word_type: String = field(body, "word_type")?;
            let status: Option<String> = opt_field(body, "status");
            let proficiency: Option<i64> = opt_field(body, "proficiency");
            let result = library::known_words::add_known_word(
                conn,
                &word,
                &word_type,
                status.as_deref(),
                proficiency,
            )
            .map_err(db_err)?;
            let _ = library::analysis::invalidate_shelf_analysis_cache(conn);
            serialize(result)
        }

        "update_word_status" => {
            let word: String = field(body, "word")?;
            let status: String = field(body, "status")?;
            library::known_words::update_word_status(conn, &word, &status).map_err(db_err)?;
            let _ = library::analysis::invalidate_shelf_analysis_cache(conn);
            Ok(Value::Null)
        }

        "remove_known_word" => {
            let word: String = field(body, "word")?;
            library::known_words::remove_known_word(conn, &word).map_err(db_err)?;
            let _ = library::analysis::invalidate_shelf_analysis_cache(conn);
            Ok(Value::Null)
        }

        "list_known_words" => {
            let word_type: Option<String> = opt_field(body, "word_type");
            let status: Option<String> = opt_field(body, "status");
            let limit: Option<usize> = opt_field(body, "limit");
            let offset: Option<usize> = opt_field(body, "offset");
            serialize(
                library::known_words::list_known_words(
                    conn,
                    word_type.as_deref(),
                    status.as_deref(),
                    limit,
                    offset,
                )
                .map_err(db_err)?,
            )
        }

        "import_known_words" => {
            let content: String = field(body, "content")?;
            let word_type: String = field(body, "word_type")?;
            let result = library::known_words::import_known_words(conn, &content, &word_type)
                .map_err(db_err)?;
            let _ = library::analysis::invalidate_shelf_analysis_cache(conn);
            serialize(result)
        }

        // ── Speed tracking ─────────────────────────────────────────────────
        "start_reading_session" => {
            let text_id: i64 = field(body, "text_id")?;
            serialize(library::speed::start_reading_session(conn, text_id).map_err(db_err)?)
        }

        "finish_reading_session" => {
            let session_id: i64 = field(body, "session_id")?;
            serialize(library::speed::finish_reading_session(conn, session_id).map_err(db_err)?)
        }

        "discard_reading_session" => {
            let session_id: i64 = field(body, "session_id")?;
            library::speed::discard_reading_session(conn, session_id).map_err(db_err)?;
            Ok(Value::Null)
        }

        "delete_reading_session" => {
            let session_id: i64 = field(body, "session_id")?;
            library::speed::delete_reading_session(conn, session_id).map_err(db_err)?;
            Ok(Value::Null)
        }

        "update_session_auto_marked" => {
            let session_id: i64 = field(body, "session_id")?;
            let auto_marked_characters: i64 = field(body, "auto_marked_characters")?;
            let auto_marked_words: i64 = field(body, "auto_marked_words")?;
            library::speed::update_session_auto_marked(
                conn,
                session_id,
                auto_marked_characters,
                auto_marked_words,
            )
            .map_err(db_err)?;
            Ok(Value::Null)
        }

        "get_active_reading_session" => {
            let text_id: i64 = field(body, "text_id")?;
            serialize(library::speed::get_active_session(conn, text_id).map_err(db_err)?)
        }

        "get_text_reading_history" => {
            let text_id: i64 = field(body, "text_id")?;
            serialize(library::speed::get_text_reading_history(conn, text_id).map_err(db_err)?)
        }

        "get_speed_data" => {
            let shelf_id: Option<i64> = opt_field(body, "shelf_id");
            let first_reads_only: bool = opt_field(body, "first_reads_only").unwrap_or(true);
            let limit: Option<usize> = opt_field(body, "limit");
            serialize(
                library::speed::get_speed_data(conn, shelf_id, first_reads_only, limit)
                    .map_err(db_err)?,
            )
        }

        "get_speed_stats" => {
            let shelf_id: Option<i64> = opt_field(body, "shelf_id");
            serialize(library::speed::get_speed_stats(conn, shelf_id).map_err(db_err)?)
        }

        "get_daily_reading_volume" => {
            let days: i64 = field(body, "days")?;
            serialize(library::speed::get_daily_reading_volume(conn, days).map_err(db_err)?)
        }

        "get_reading_streak" => {
            serialize(library::speed::get_reading_streak(conn).map_err(db_err)?)
        }

        "log_offline_read" => {
            let input: library::ManualLogInput = field(body, "input")?;
            serialize(library::speed::log_offline_read(conn, input).map_err(db_err)?)
        }

        // ── Settings ───────────────────────────────────────────────────────
        "get_setting" => {
            let key: String = field(body, "key")?;
            serialize(library::settings::get_setting(conn, &key).map_err(db_err)?)
        }

        "set_setting" => {
            let key: String = field(body, "key")?;
            let value: String = field(body, "value")?;
            library::settings::set_setting(conn, &key, &value).map_err(db_err)?;
            Ok(Value::Null)
        }

        // ── Auto-mark ──────────────────────────────────────────────────────
        "auto_mark_text_as_known" => {
            let text_id: i64 = field(body, "text_id")?;
            let stats = library::analysis::auto_mark_text_as_known(conn, text_id).map_err(db_err)?;
            serialize(serde_json::json!({
                "characters_marked": stats.characters_marked,
                "words_marked": stats.words_marked,
            }))
        }

        // ── Learning ───────────────────────────────────────────────────────
        "import_frequency_data" => {
            let content: String = field(body, "content")?;
            let source: String = field(body, "source")?;
            let term_type: String = field(body, "term_type")?;
            serialize(
                library::learning::import_frequency_data(conn, &content, &source, &term_type)
                    .map_err(db_err)?,
            )
        }

        "list_frequency_sources" => {
            serialize(library::learning::list_frequency_sources(conn).map_err(db_err)?)
        }

        "get_learning_stats" => {
            let frequency_source: Option<String> = opt_field(body, "frequency_source");
            serialize(
                library::learning::get_learning_stats(conn, frequency_source.as_deref())
                    .map_err(db_err)?,
            )
        }

        "get_percentile_coverage" => {
            let source: String = field(body, "source")?;
            let term_type: String = field(body, "term_type")?;
            let percentiles: Vec<i64> = field(body, "percentiles")?;
            serialize(
                library::learning::get_percentile_coverage(conn, &source, &term_type, &percentiles)
                    .map_err(db_err)?,
            )
        }

        "get_vocabulary_progress" => {
            let days: Option<i64> = opt_field(body, "days");
            serialize(library::learning::get_vocabulary_progress(conn, days).map_err(db_err)?)
        }

        "record_vocabulary_snapshot" => {
            library::learning::record_vocabulary_snapshot(conn).map_err(db_err)?;
            Ok(Value::Null)
        }

        "get_shelf_frequency_analysis" => {
            let shelf_id: i64 = field(body, "shelf_id")?;
            let frequency_source: String = field(body, "frequency_source")?;
            serialize(
                library::learning::get_shelf_frequency_analysis(conn, shelf_id, &frequency_source)
                    .map_err(db_err)?,
            )
        }

        "get_study_priorities" => {
            let source: String = field(body, "source")?;
            let term_type: Option<String> = opt_field(body, "term_type");
            let limit: Option<usize> = opt_field(body, "limit");
            serialize(
                library::learning::get_study_priorities(conn, &source, term_type.as_deref(), limit)
                    .map_err(db_err)?,
            )
        }

        "clear_frequency_source" => {
            let source: String = field(body, "source")?;
            serialize(library::learning::clear_frequency_source(conn, &source).map_err(db_err)?)
        }

        // ── Custom segmentation ────────────────────────────────────────────
        "add_custom_segmentation_word" => {
            let word: String = field(body, "word")?;
            let add_to_vocabulary: bool = field(body, "add_to_vocabulary")?;
            let status: Option<String> = opt_field(body, "status");
            let frequency: i64 = 10000;
            conn.execute(
                "INSERT OR IGNORE INTO user_segmentation_words (word, frequency) VALUES (?, ?)",
                rusqlite::params![&word, frequency],
            )
            .map_err(db_err)?;
            library::analysis::add_segmentation_word(&word, Some(frequency));
            let known_word = if add_to_vocabulary {
                let word_type = if word.chars().count() == 1 {
                    "character"
                } else {
                    "word"
                };
                Some(
                    library::known_words::add_known_word(
                        conn,
                        &word,
                        word_type,
                        status.as_deref(),
                        None,
                    )
                    .map_err(db_err)?,
                )
            } else {
                None
            };
            serialize(serde_json::json!({
                "word": word,
                "added_to_segmentation": true,
                "known_word": known_word,
            }))
        }

        "define_custom_word" => {
            let word: String = field(body, "word")?;
            let definition: String = field(body, "definition")?;
            let pinyin: Option<String> = opt_field(body, "pinyin");
            let notes: Option<String> = opt_field(body, "notes");
            let shelf_id: Option<i64> = opt_field(body, "shelf_id");
            let add_to_vocabulary: bool = field(body, "add_to_vocabulary")?;
            let status: Option<String> = opt_field(body, "status");

            let (dictionary_id, dictionary_name) = if let Some(sid) = shelf_id {
                let domain = format!("shelf:{}", sid);
                let existing: Option<(i64, String)> = conn
                    .query_row(
                        "SELECT id, name FROM user_dictionaries WHERE domain = ?",
                        [&domain],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .ok();
                if let Some(pair) = existing {
                    pair
                } else {
                    let shelf_name: String = conn
                        .query_row("SELECT name FROM shelves WHERE id = ?", [sid], |row| {
                            row.get(0)
                        })
                        .map_err(|e| ApiError::NotFound(format!("Shelf not found: {}", e)))?;
                    let dict_name = format!("{} - Custom Words", shelf_name);
                    let dict = dictionary::user::create_dictionary(
                        conn,
                        &dict_name,
                        Some(&format!("Custom word definitions for shelf: {}", shelf_name)),
                        Some(&domain),
                    )
                    .map_err(db_err)?;
                    (dict.id, dict.name)
                }
            } else {
                let domain = "global:custom_words";
                let existing: Option<(i64, String)> = conn
                    .query_row(
                        "SELECT id, name FROM user_dictionaries WHERE domain = ?",
                        [domain],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .ok();
                if let Some(pair) = existing {
                    pair
                } else {
                    let dict = dictionary::user::create_dictionary(
                        conn,
                        "Custom Words",
                        Some("User-defined custom word definitions"),
                        Some(domain),
                    )
                    .map_err(db_err)?;
                    (dict.id, dict.name)
                }
            };

            let entry = dictionary::user::add_entry(
                conn,
                dictionary_id,
                &word,
                &definition,
                pinyin.as_deref(),
                notes.as_deref(),
                &[],
            )
            .map_err(db_err)?;

            let frequency: i64 = 10000;
            conn.execute(
                "INSERT OR IGNORE INTO user_segmentation_words (word, frequency) VALUES (?, ?)",
                rusqlite::params![&word, frequency],
            )
            .map_err(db_err)?;
            library::analysis::add_segmentation_word(&word, Some(frequency));

            let known_word = if add_to_vocabulary {
                let word_type = if word.chars().count() == 1 {
                    "character"
                } else {
                    "word"
                };
                Some(
                    library::known_words::add_known_word(
                        conn,
                        &word,
                        word_type,
                        status.as_deref(),
                        None,
                    )
                    .map_err(db_err)?,
                )
            } else {
                None
            };

            serialize(serde_json::json!({
                "word": word,
                "dictionary_id": dictionary_id,
                "dictionary_name": dictionary_name,
                "entry_id": entry.id,
                "added_to_segmentation": true,
                "known_word": known_word,
            }))
        }

        _ => Err(ApiError::BadRequest(format!("Unknown command: {}", command))),
    }
}
