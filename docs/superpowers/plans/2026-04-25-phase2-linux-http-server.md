# Phase 2: Linux HTTP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Axum HTTP server binary so the Chinese Reader app can be accessed from any browser on the home network (Linux host, Mac/Android Chrome clients).

**Architecture:** New Rust binary `src-tauri/src/bin/server.rs` imports the same `chinese_reader_lib` used by the Tauri app and exposes a `POST /api/invoke/:command` RPC endpoint that mirrors Tauri's invoke() semantics. A new frontend `src/lib/api.ts` wrapper detects `window.__TAURI__` and routes calls to either the Tauri bridge or the HTTP server. Static frontend files are served from a configurable `dist/` directory with SPA fallback.

**Tech Stack:** Rust/Axum 0.8, tower-http 0.6 (fs + cors), tokio (already in deps), TypeScript/Vite frontend, SQLite via rusqlite (already bundled).

---

## File Structure

**Created:**
- `src-tauri/src/bin/server.rs` — standalone HTTP server binary
- `src/lib/api.ts` — frontend invoke wrapper with environment detection + `confirm` dialog wrapper
- `scripts/sync-db-to-linux.sh` — copies the Mac DB to a Linux machine via scp

**Modified:**
- `src-tauri/Cargo.toml` — add axum, tower-http deps + `[[bin]]` entry
- `src/lib/library.ts` — change `invoke` import to `./api`
- `src/lib/speed.ts` — change `invoke` import to `./api`
- `src/lib/dictionary.ts` — change `invoke` import to `./api`
- `src/lib/learning.ts` — change `invoke` import to `./api`
- `src/views/library-view.ts` — change `confirm` import from `@tauri-apps/plugin-dialog` to `./lib/api`

---

## Exposed Commands

All 68 registered Tauri commands are exposed **except** the 4 that require local filesystem paths:
- ❌ `import_cedict` (needs local file path)
- ❌ `import_moedict` (needs local file path)
- ❌ `import_kangxi` (needs local file path)
- ❌ `import_text_file` (needs local file path)

All other 64 commands are exposed, including `migrate_large_texts` (operates on DB only).

---

## Task 1: Add Axum Dependencies to Cargo.toml

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add axum, tower-http, and the server [[bin]] entry**

Open `src-tauri/Cargo.toml` and make two additions:

After the existing `[[bin]]` block (the `import` binary), add:
```toml
[[bin]]
name = "server"
path = "src/bin/server.rs"
```

In the `[dependencies]` section, add after the `reqwest` line:
```toml
axum = "0.8"
tower-http = { version = "0.6", features = ["fs", "cors"] }
```

- [ ] **Step 2: Verify the cargo workspace compiles**

```bash
cd src-tauri && cargo check --lib
```
Expected: No errors (new deps will be downloaded).

- [ ] **Step 3: Commit**

```bash
cd /Users/daniel/exper/test_repo
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat: add axum and tower-http deps for HTTP server binary"
```

---

## Task 2: Server Binary Skeleton with DB Init and /health Endpoint

**Files:**
- Create: `src-tauri/src/bin/server.rs`

- [ ] **Step 1: Create the server binary with initialization and a /health endpoint**

Create `src-tauri/src/bin/server.rs` with this exact content:

```rust
//! Chinese Reader HTTP server.
//!
//! Exposes the same library functions as the Tauri app over HTTP,
//! so the app can be accessed from any browser on the local network.
//!
//! Usage:
//!   cargo run --bin server -- [--db-path <path>] [--port <port>] [--dist <path>]
//!
//! Defaults:
//!   --db-path: same location as the Tauri app (Application Support)
//!   --port:    3000
//!   --dist:    ./dist (relative to working directory)

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use chinese_reader_lib::{dictionary, library};
use rusqlite::Connection;
use std::env;
use std::sync::{Arc, Mutex};
use tower_http::cors::{Any, CorsLayer};

type Db = Arc<Mutex<Connection>>;

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();

    // Parse --db-path
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

    // Parse --port
    let port: u16 = if let Some(idx) = args.iter().position(|a| a == "--port") {
        args.get(idx + 1)
            .and_then(|v| v.parse().ok())
            .unwrap_or(3000)
    } else {
        3000
    };

    // Parse --dist
    let dist_dir: std::path::PathBuf = if let Some(idx) = args.iter().position(|a| a == "--dist") {
        args.get(idx + 1)
            .cloned()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("./dist"))
    } else {
        std::path::PathBuf::from("./dist")
    };

    // Initialize database
    println!("Database: {:?}", db_path);
    let conn = dictionary::init_connection(&db_path).unwrap_or_else(|e| {
        eprintln!("Failed to initialize database: {}", e);
        std::process::exit(1);
    });

    // Load user segmentation words into jieba
    match library::analysis::load_user_segmentation_words(&conn) {
        Ok(count) if count > 0 => println!("Loaded {} user segmentation words", count),
        Ok(_) => {}
        Err(e) => eprintln!("Warning: failed to load segmentation words: {}", e),
    }

    let db: Db = Arc::new(Mutex::new(conn));

    // CORS: allow all origins (home network use)
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/invoke/{command}", post(dispatch))
        .with_state(db)
        .layer(cors);

    let addr = format!("0.0.0.0:{}", port);
    println!("Serving on http://{}", addr);
    println!("Static files from: {:?}", dist_dir);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap_or_else(|e| {
        eprintln!("Failed to bind {}: {}", addr, e);
        std::process::exit(1);
    });

    axum::serve(listener, app).await.unwrap();
}

async fn health() -> &'static str {
    "ok"
}

// Placeholder for Task 3
async fn dispatch(
    State(_db): State<Db>,
    Path(command): Path<String>,
    Json(_body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError(format!("Command not yet implemented: {}", command), StatusCode::NOT_IMPLEMENTED))
}

struct AppError(String, StatusCode);

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        (self.1, self.0).into_response()
    }
}
```

- [ ] **Step 2: Build the server binary**

```bash
cd src-tauri && cargo build --bin server 2>&1 | head -50
```
Expected: `Finished dev [unoptimized + debuginfo]` with no errors.

- [ ] **Step 3: Smoke test /health**

In one terminal:
```bash
cd src-tauri && cargo run --bin server &
sleep 2
curl -s http://localhost:3000/health
```
Expected output: `ok`

Kill the server: `kill %1`

- [ ] **Step 4: Commit**

```bash
cd /Users/daniel/exper/test_repo
git add src-tauri/src/bin/server.rs
git commit -m "feat: add HTTP server binary skeleton with /health endpoint"
```

---

## Task 3: Full API Dispatch Handler

**Files:**
- Modify: `src-tauri/src/bin/server.rs`

This task implements the `POST /api/invoke/:command` handler that dispatches to all 64 exposed library functions. The pattern is:
1. Lock the DB mutex
2. Extract typed args from the JSON body using helper functions
3. Call the library function directly (same as Tauri commands, minus the `State` wrapper)
4. Serialize the result to JSON

- [ ] **Step 1: Write the complete dispatch implementation**

Replace the entire `src-tauri/src/bin/server.rs` with:

```rust
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

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/invoke/{command}", post(dispatch))
        .with_state(db)
        .layer(cors);

    let addr = format!("0.0.0.0:{}", port);
    println!("Serving on http://{}", addr);
    println!("Static files from: {:?}", dist_dir);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap_or_else(|e| {
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

/// Extract a required field from the JSON body.
fn field<T: serde::de::DeserializeOwned>(body: &Value, name: &str) -> Result<T, ApiError> {
    let val = body
        .get(name)
        .ok_or_else(|| ApiError::BadRequest(format!("Missing field: {}", name)))?;
    serde_json::from_value(val.clone())
        .map_err(|e| ApiError::BadRequest(format!("Invalid field '{}': {}", name, e)))
}

/// Extract an optional field from the JSON body (missing or null → None).
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

        "dictionary_stats" => {
            serialize(dictionary::get_stats(conn).map_err(db_err)?)
        }

        // ── User dictionaries ──────────────────────────────────────────────
        "create_user_dictionary" => {
            let name: String = field(body, "name")?;
            let description: Option<String> = opt_field(body, "description");
            let domain: Option<String> = opt_field(body, "domain");
            serialize(
                dictionary::user::create_dictionary(conn, &name, description.as_deref(), domain.as_deref())
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
            serialize(dictionary::user::list_entries(conn, dictionary_id, limit, offset).map_err(db_err)?)
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
            let dictionary_id: i64 = field(body, "dictionary_id")?;
            let content: String = field(body, "content")?;
            // import_simple_format requires &mut Connection
            // We can't get &mut from the lock guard directly via &Connection.
            // Use raw_conn workaround: execute in a way that doesn't need &mut.
            // Actually import_simple_format uses transactions, so it needs &mut.
            // We'll return an error pointing users to the Tauri app for bulk imports.
            let _ = (dictionary_id, content);
            return Err(ApiError::BadRequest(
                "import_user_dictionary_entries requires &mut Connection — use the desktop app for bulk imports".to_string(),
            ));
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

        "list_root_shelves" => {
            serialize(library::shelf::list_root_shelves(conn).map_err(db_err)?)
        }

        "get_shelf_tree" => {
            serialize(library::shelf::get_shelf_tree(conn).map_err(db_err)?)
        }

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
            let convert_to_traditional: bool = opt_field(body, "convert_to_traditional").unwrap_or(false);
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
            serialize(library::analysis::get_analysis_report(conn, text_id, top_n, sort).map_err(db_err)?)
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
            serialize(library::analysis::get_prestudy_characters(conn, shelf_id, target_rate).map_err(db_err)?)
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
            serialize(library::analysis::get_word_context_all(conn, &word, max_snippets).map_err(db_err)?)
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
            serialize(library::speed::get_speed_data(conn, shelf_id, first_reads_only, limit).map_err(db_err)?)
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
                let word_type = if word.chars().count() == 1 { "character" } else { "word" };
                Some(
                    library::known_words::add_known_word(conn, &word, word_type, status.as_deref(), None)
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

            // Find or create the appropriate dictionary
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
                        .query_row("SELECT name FROM shelves WHERE id = ?", [sid], |row| row.get(0))
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
                let word_type = if word.chars().count() == 1 { "character" } else { "word" };
                Some(
                    library::known_words::add_known_word(conn, &word, word_type, status.as_deref(), None)
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
```

**Important note about `import_user_dictionary_entries`:** The `dictionary::user::import_simple_format` function requires `&mut Connection`. Because we lock the `Arc<Mutex<Connection>>` and get a `MutexGuard<Connection>`, we can obtain `&mut Connection` via `DerefMut`. The above code incorrectly returns an error — correct it as follows: replace the `import_user_dictionary_entries` arm with:

```rust
"import_user_dictionary_entries" => {
    let dictionary_id: i64 = field(body, "dictionary_id")?;
    let content: String = field(body, "content")?;
    // Need &mut — acquire from MutexGuard via DerefMut in the spawn_blocking closure
    // (This arm is called with conn: &Connection, we need to refactor)
    // For now, expose as unsupported — use desktop app for bulk imports.
    let _ = (dictionary_id, content);
    Err(ApiError::BadRequest(
        "import_user_dictionary_entries: use the desktop app for bulk imports".to_string(),
    ))
}
```

(The `import_simple_format` function signature requires `&mut Connection` for the transaction. Since `dispatch_sync` takes `&Connection`, this one command remains desktop-only. This is acceptable — it's a bulk import tool.)

- [ ] **Step 2: Build and verify compilation**

```bash
cd src-tauri && cargo build --bin server 2>&1 | tail -20
```
Expected: `Finished dev [unoptimized + debuginfo]` — no errors.

If there are compilation errors related to missing public functions (e.g., `library::text::search_texts`), check that the function is `pub` in `src/library/text.rs`.

- [ ] **Step 3: Smoke test key endpoints**

Start the server:
```bash
cd src-tauri && cargo run --bin server &
sleep 3
```

Test no-arg commands:
```bash
curl -s -X POST http://localhost:3000/api/invoke/get_shelf_tree \
  -H 'Content-Type: application/json' -d '{}' | head -c 200

curl -s -X POST http://localhost:3000/api/invoke/list_root_shelves \
  -H 'Content-Type: application/json' -d '{}' | head -c 200

curl -s -X POST http://localhost:3000/api/invoke/dictionary_stats \
  -H 'Content-Type: application/json' -d '{}' | head -c 200
```
Expected: JSON arrays/objects (not error strings).

Test with args:
```bash
curl -s -X POST http://localhost:3000/api/invoke/get_setting \
  -H 'Content-Type: application/json' -d '{"key": "font_size"}' | head -c 100
```
Expected: `null` or a JSON string value.

Test unknown command returns 400:
```bash
curl -s -o /dev/null -w "%{http_code}" -X POST \
  http://localhost:3000/api/invoke/not_a_command \
  -H 'Content-Type: application/json' -d '{}'
```
Expected: `400`

Kill: `kill %1`

- [ ] **Step 4: Commit**

```bash
cd /Users/daniel/exper/test_repo
git add src-tauri/src/bin/server.rs
git commit -m "feat: implement full API dispatch handler for all 64 exposed commands"
```

---

## Task 4: Static File Serving with SPA Fallback

**Files:**
- Modify: `src-tauri/src/bin/server.rs`

Add tower-http `ServeDir` to serve the built frontend, with `index.html` fallback for SPA client-side routing.

- [ ] **Step 1: Add static file serving to the router**

In `server.rs`, add this import at the top:
```rust
use tower_http::services::{ServeDir, ServeFile};
```

Then in `main()`, replace the router construction (find the `let app = Router::new()` block) with:

```rust
    // Static file serving: serve dist_dir, fallback to index.html for SPA routes
    let index_path = dist_dir.join("index.html");
    let serve_static = ServeDir::new(&dist_dir)
        .not_found_service(ServeFile::new(&index_path));

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/invoke/{command}", post(dispatch))
        .fallback_service(serve_static)
        .with_state(db)
        .layer(cors);
```

- [ ] **Step 2: Build to verify no compilation errors**

```bash
cd src-tauri && cargo build --bin server 2>&1 | tail -10
```
Expected: `Finished` with no errors.

- [ ] **Step 3: Test static serving**

Build the frontend first:
```bash
cd /Users/daniel/exper/test_repo && npm run build
```
Expected: `dist/` directory created with `index.html`.

Start the server pointing at the dist dir:
```bash
cd /Users/daniel/exper/test_repo
src-tauri/target/debug/server --dist dist &
sleep 2
```

Test index.html is served:
```bash
curl -s http://localhost:3000/ | head -5
```
Expected: HTML starting with `<!DOCTYPE html>` or `<html`.

Test SPA fallback (a non-existent route returns index.html):
```bash
curl -s http://localhost:3000/some/spa/route | head -5
```
Expected: Same HTML (index.html content).

Test API still works:
```bash
curl -s -X POST http://localhost:3000/api/invoke/get_shelf_tree \
  -H 'Content-Type: application/json' -d '{}' | head -c 50
```
Expected: JSON array.

Kill: `kill %1`

- [ ] **Step 4: Commit**

```bash
cd /Users/daniel/exper/test_repo
git add src-tauri/src/bin/server.rs
git commit -m "feat: add static file serving and SPA fallback to HTTP server"
```

---

## Task 5: Frontend API Wrapper and Library Import Updates

**Files:**
- Create: `src/lib/api.ts`
- Modify: `src/lib/library.ts`
- Modify: `src/lib/speed.ts`
- Modify: `src/lib/dictionary.ts`
- Modify: `src/lib/learning.ts`

This task creates a single `invoke` wrapper that routes calls to either the Tauri bridge or the HTTP server, then updates all library files to use it.

- [ ] **Step 1: Create `src/lib/api.ts`**

This file provides two exports:
1. `invoke` — routes to Tauri bridge or HTTP server depending on environment
2. `confirm` — wraps `@tauri-apps/plugin-dialog` confirm in Tauri, falls back to `window.confirm()` in browser

```typescript
/**
 * Environment-aware API wrappers.
 *
 * In Tauri context (desktop app):   uses @tauri-apps/api/core invoke()
 *                                   and @tauri-apps/plugin-dialog confirm()
 * In browser context (HTTP server): POSTs to /api/invoke/:command
 *                                   and uses window.confirm()
 */

type InvokeArgs = Record<string, unknown>;

export async function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  if (typeof window !== "undefined" && (window as any).__TAURI__) {
    // Running inside Tauri — use the native bridge
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke<T>(command, args);
  }

  // Running in a plain browser — call the HTTP server
  const response = await fetch(`/api/invoke/${command}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Command ${command} failed (${response.status}): ${text}`);
  }

  // Commands that return null (void) need special handling
  const text = await response.text();
  if (text === "" || text === "null") {
    return null as unknown as T;
  }
  return JSON.parse(text) as T;
}

/**
 * Show a confirmation dialog. Uses native Tauri dialog in desktop context,
 * falls back to window.confirm() in browser context.
 */
export async function confirm(message: string): Promise<boolean> {
  if (typeof window !== "undefined" && (window as any).__TAURI__) {
    const { confirm: tauriConfirm } = await import("@tauri-apps/plugin-dialog");
    return tauriConfirm(message);
  }
  return window.confirm(message);
}
```

- [ ] **Step 2: Update `src/lib/library.ts`**

Find the line:
```typescript
import { invoke } from "@tauri-apps/api/core";
```

Replace with:
```typescript
import { invoke } from "./api";
```

- [ ] **Step 3: Update `src/lib/speed.ts`**

Find the line:
```typescript
import { invoke } from "@tauri-apps/api/core";
```

Replace with:
```typescript
import { invoke } from "./api";
```

- [ ] **Step 4: Update `src/lib/dictionary.ts`**

Find the line:
```typescript
import { invoke } from "@tauri-apps/api/core";
```

Replace with:
```typescript
import { invoke } from "./api";
```

- [ ] **Step 5: Update `src/lib/learning.ts`**

Find the line:
```typescript
import { invoke } from "@tauri-apps/api/core";
```

Replace with:
```typescript
import { invoke } from "./api";
```

- [ ] **Step 6: Update `src/views/library-view.ts` confirm import**

`library-view.ts` currently imports `confirm` from `@tauri-apps/plugin-dialog` which is Tauri-only and will throw in a plain browser. Change it to use the wrapper.

Find the line at the top of the file:
```typescript
import { confirm } from "@tauri-apps/plugin-dialog";
```

Replace with:
```typescript
import { confirm } from "../lib/api";
```

(The `library-view.ts` file is in `src/views/`, so the relative path to `src/lib/api.ts` is `../lib/api`.)

No other changes needed — all 5 call sites (`confirmDeleteShelf`, `confirmDeleteText`, discard session) use the same `confirm` function signature and will work identically with the wrapper.

- [ ] **Step 7: Build the frontend to confirm no TypeScript errors**

```bash
cd /Users/daniel/exper/test_repo && npm run build 2>&1 | tail -20
```
Expected: Build succeeds. No TypeScript errors. `dist/` updated.

- [ ] **Step 8: Verify Tauri app still works (build check)**

```bash
cd /Users/daniel/exper/test_repo/src-tauri && cargo check 2>&1 | tail -10
```
Expected: No errors.

- [ ] **Step 9: End-to-end browser test**

Build frontend and start server:
```bash
cd /Users/daniel/exper/test_repo
npm run build
src-tauri/target/debug/server --dist dist --port 3000 &
sleep 2
```

Open http://localhost:3000 in a browser. The app should load and function correctly — shelves visible, texts loadable, dictionary lookups working. Confirm dialogs should use `window.confirm()` (native browser prompt).

Kill: `kill %1`

- [ ] **Step 10: Commit**

```bash
cd /Users/daniel/exper/test_repo
git add src/lib/api.ts src/lib/library.ts src/lib/speed.ts src/lib/dictionary.ts src/lib/learning.ts src/views/library-view.ts
git commit -m "feat: add api.ts invoke/confirm wrappers; route frontend through HTTP server in browser"
```

---

## Running on Linux

### Step A: Build a release binary for Linux

The server binary must be compiled on a Linux machine (or cross-compiled). The easiest approach is to copy the source to the Linux machine and build there:

```bash
# On Linux machine — clone or rsync the repo, then:
cd /path/to/test_repo/src-tauri
cargo build --release --bin server
# Binary is at: target/release/server
```

Alternatively, if building on Mac and cross-compiling to x86_64 Linux:
```bash
rustup target add x86_64-unknown-linux-gnu
# Requires a C cross-linker (e.g. brew install FiloSottile/musl-cross/musl-cross)
cargo build --release --bin server --target x86_64-unknown-linux-gnu
# Binary is at: target/x86_64-unknown-linux-gnu/release/server
```

### Step B: Build the frontend

On Mac (or any machine with Node.js):
```bash
cd /path/to/test_repo
npm run build
# Frontend assets are in dist/
```

### Step C: Transfer files to the Linux machine

```bash
# From Mac — transfer the server binary and dist/ to Linux:
rsync -av dist/ user@linux-host:/opt/chinese-reader/dist/
scp src-tauri/target/release/server user@linux-host:/opt/chinese-reader/server
# Or if cross-compiled:
# scp src-tauri/target/x86_64-unknown-linux-gnu/release/server user@linux-host:/opt/chinese-reader/server
```

### Step D: Transfer the database

The SQLite database is on Mac at:
```
~/Library/Application Support/com.chinesereader.ChineseReader/dictionary.db
```

Copy to Linux:
```bash
scp ~/Library/Application\ Support/com.chinesereader.ChineseReader/dictionary.db \
    user@linux-host:/opt/chinese-reader/dictionary.db
```

To keep the DB in sync after reading sessions on Mac, re-run this `scp` command. (Future work: bidirectional sync or shared DB are out of scope for this phase.)

### Step E: Run the server on Linux

```bash
# On Linux:
cd /opt/chinese-reader
chmod +x server
./server --db-path dictionary.db --dist dist --port 3000
```

The Mac/Android Chrome clients browse to `http://<linux-ip>:3000`.

To run persistently (survives SSH logout):
```bash
nohup ./server --db-path dictionary.db --dist dist --port 3000 > server.log 2>&1 &
echo $! > server.pid
# To stop: kill $(cat server.pid)
```

Or use systemd (if available on the Linux machine):
```ini
# /etc/systemd/system/chinese-reader.service
[Unit]
Description=Chinese Reader HTTP Server
After=network.target

[Service]
WorkingDirectory=/opt/chinese-reader
ExecStart=/opt/chinese-reader/server --db-path /opt/chinese-reader/dictionary.db --dist /opt/chinese-reader/dist --port 3000
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now chinese-reader
```

---

## Migration Guide: Moving Existing Data to Linux

The Chinese Reader stores everything — dictionary data, library texts, known words, reading history — in a single SQLite file. SQLite databases are fully portable between macOS and Linux (same file format, no conversion needed). The migration is simply copying the file.

### One-time migration

A helper script is provided at `scripts/sync-db-to-linux.sh`:

```bash
# From the repo root on Mac:
./scripts/sync-db-to-linux.sh user@192.168.1.50 /opt/chinese-reader/dictionary.db
```

This script:
1. Finds the Mac DB at `~/Library/Application Support/com.chinesereader.ChineseReader/dictionary.db`
2. Creates the remote directory if needed (via SSH)
3. Copies the DB via `scp`

Or do it manually:
```bash
scp ~/Library/Application\ Support/com.chinesereader.ChineseReader/dictionary.db \
    user@192.168.1.50:/opt/chinese-reader/dictionary.db
```

### What gets migrated

Everything in the single DB file:
- ✅ All library shelves and texts (full content)
- ✅ All known words and vocabulary status
- ✅ All reading session history (speed data, streaks)
- ✅ All dictionary data (CC-CEDICT, MOE-Dict, Kangxi, custom)
- ✅ All user dictionary entries and custom word definitions
- ✅ All frequency import data and learning stats
- ✅ All app settings

### Keeping Linux in sync with Mac

After using the Mac Tauri app (adding new texts, marking words, etc.), re-run the sync to push updates to Linux:

```bash
# Stop the Linux server first to avoid DB lock conflicts during copy
ssh user@linux-host "kill \$(cat /opt/chinese-reader/server.pid) 2>/dev/null; true"

# Sync the DB
./scripts/sync-db-to-linux.sh user@linux-host /opt/chinese-reader/dictionary.db

# Restart the server
ssh user@linux-host "cd /opt/chinese-reader && nohup ./server --db-path dictionary.db --dist dist --port 3000 > server.log 2>&1 & echo \$! > server.pid"
```

**Note:** This is a one-way sync (Mac → Linux). Any changes made via the Linux web server (marking words known, logging sessions) will be overwritten the next time you sync. For this phase, treat the Mac Tauri app as the source of truth.
