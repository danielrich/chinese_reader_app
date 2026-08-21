//! Chinese Reader HTTP server.
//!
//! Exposes the same library functions as the Tauri app over HTTP,
//! so the app can be accessed from any browser on the local network.
//!
//! Usage:
//!   cargo run --bin server -- [--db-path <path>] [--port <port>] [--dist <path>] [--cert <pem>] [--key <pem>] [--run-analysis-maintenance]
//!
//! HTTPS example (generate certs with mkcert first):
//!   ./server --cert chasmfiend.local.pem --key chasmfiend.local-key.pem

use axum::{
    body::Body,
    extract::{Path, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chinese_reader_lib::{dictionary, library};
use chrono::{DateTime, Datelike, Duration as ChronoDuration, Local, NaiveDate, TimeZone, Utc};
use rusqlite::Connection;
use serde_json::Value;
use std::env;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tower_http::compression::CompressionLayer;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

const DB_PRAGMAS: &str =
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=30000;";
const SLOW_REQUEST_THRESHOLD: Duration = Duration::from_millis(250);

#[derive(Default)]
struct RequestTimings {
    pool_wait: Duration,
    write_wait: Duration,
    blocking: Duration,
    serialization: Duration,
    total: Duration,
}

fn slow_request_log(command: &str, timings: &RequestTimings) -> Option<String> {
    (timings.total > SLOW_REQUEST_THRESHOLD).then(|| {
        format!(
            "slow_request command={} pool_wait_ms={} write_wait_ms={} blocking_ms={} serialization_ms={} total_ms={}",
            command,
            timings.pool_wait.as_millis(),
            timings.write_wait.as_millis(),
            timings.blocking.as_millis(),
            timings.serialization.as_millis(),
            timings.total.as_millis()
        )
    })
}

fn finalize_timed_request<T>(
    command: &str,
    total_started: Instant,
    mut timings: RequestTimings,
    result: Result<T, ApiError>,
) -> (Result<T, ApiError>, Option<String>) {
    timings.total = total_started.elapsed();
    let line = slow_request_log(command, &timings);
    (result, line)
}

fn emit_finalized_request<T>(
    command: &str,
    total_started: Instant,
    timings: RequestTimings,
    result: Result<T, ApiError>,
) -> Result<T, ApiError> {
    let (result, line) = finalize_timed_request(command, total_started, timings, result);
    if let Some(line) = line {
        eprintln!("{line}");
    }
    result
}

// These timings cover handler work through JSON byte serialization and response
// construction. Streaming gzip is applied later by Tower middleware and is not
// included in handler timing.

fn weak_etag_matches(if_none_match: Option<&HeaderValue>, etag: &str) -> bool {
    let Some(value) = if_none_match.and_then(|value| value.to_str().ok()) else {
        return false;
    };
    let target = etag.strip_prefix("W/").unwrap_or(etag);
    value.split(',').map(str::trim).any(|candidate| {
        candidate == "*" || candidate.strip_prefix("W/").unwrap_or(candidate) == target
    })
}

fn text_vocab_version(conn: &Connection, text_id: i64) -> Result<String, ApiError> {
    let version: (String, Option<i64>, Option<String>) = conn
        .query_row(
            "SELECT texts.updated_at, text_analyses.id, text_analyses.analyzed_at
             FROM texts LEFT JOIN text_analyses ON text_analyses.text_id = texts.id
             WHERE texts.id = ?1",
            [text_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => not_found(format!("Text {text_id} not found")),
            other => db_err(other),
        })?;
    Ok(format!(
        "{text_id}\0{}\0{}\0{}",
        version.0,
        version.1.unwrap_or_default(),
        version.2.unwrap_or_default()
    ))
}

fn text_vocab_etag(version: &str, representation: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in version.as_bytes().iter().chain(representation) {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("\"text-vocab-{hash:016x}\"")
}

fn serialize_json_bytes_with<F>(serializer: F) -> Result<(Vec<u8>, Duration), ApiError>
where
    F: FnOnce() -> serde_json::Result<Vec<u8>>,
{
    let started = Instant::now();
    let bytes = serializer().map_err(|error| ApiError::Internal(error.to_string()))?;
    Ok((bytes, started.elapsed()))
}

fn json_response(bytes: Vec<u8>) -> Result<Response, ApiError> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(bytes))
        .map_err(|error| ApiError::Internal(error.to_string()))
}

fn local_maintenance_cutoff(date: NaiveDate) -> DateTime<Local> {
    Local
        .with_ymd_and_hms(date.year(), date.month(), date.day(), 0, 5, 0)
        .single()
        .expect("00:05 must be an unambiguous local time")
}

/// Select the scheduler cutoff, retaining a five-minute post-cutoff grace window.
fn next_maintenance_cutoff(now: DateTime<Local>) -> DateTime<Local> {
    let today = local_maintenance_cutoff(now.date_naive());
    if now < today || now < today + ChronoDuration::minutes(5) {
        today
    } else {
        local_maintenance_cutoff(
            now.date_naive()
                .succ_opt()
                .expect("next maintenance date must exist"),
        )
    }
}

fn most_recent_maintenance_cutoff(now: DateTime<Local>) -> DateTime<Local> {
    let today = local_maintenance_cutoff(now.date_naive());
    if now >= today {
        today
    } else {
        local_maintenance_cutoff(
            now.date_naive()
                .pred_opt()
                .expect("previous maintenance date must exist"),
        )
    }
}

fn scheduled_cutoff_after_last_run(
    now: DateTime<Local>,
    last_run: DateTime<Local>,
) -> DateTime<Local> {
    let latest_due = most_recent_maintenance_cutoff(now);
    if latest_due > last_run {
        return latest_due;
    }

    let candidate = next_maintenance_cutoff(now);
    if candidate > now {
        candidate
    } else {
        local_maintenance_cutoff(
            now.date_naive()
                .succ_opt()
                .expect("next maintenance date must exist"),
        )
    }
}

async fn execute_scheduled_maintenance(db_path: std::path::PathBuf, cutoff: DateTime<Local>) {
    let cutoff_utc = cutoff.with_timezone(&Utc);
    let started = Instant::now();
    match tokio::task::spawn_blocking(move || {
        library::maintenance::run_due_analysis_maintenance(&db_path, cutoff_utc)
    })
    .await
    {
        Ok(report) => eprintln!(
            "analysis_maintenance cutoff={} duration_ms={} claimed={} succeeded={} failed={} final_dirty={} fatal_error={:?}",
            report.cutoff,
            started.elapsed().as_millis(),
            report.claimed,
            report.succeeded,
            report.failed,
            report.still_dirty,
            report.fatal_error
        ),
        Err(error) => eprintln!(
            "analysis_maintenance cutoff={} duration_ms={} success=false worker_error={}",
            cutoff,
            started.elapsed().as_millis(),
            error
        ),
    }
}

fn spawn_analysis_maintenance_scheduler(db_path: std::path::PathBuf) {
    tokio::spawn(async move {
        let startup_now = Local::now();
        let mut last_cutoff = most_recent_maintenance_cutoff(startup_now);
        execute_scheduled_maintenance(db_path.clone(), last_cutoff).await;

        loop {
            let now = Local::now();
            let cutoff = scheduled_cutoff_after_last_run(now, last_cutoff);
            let sleep_for = (cutoff - now).to_std().unwrap_or_default();
            tokio::time::sleep(sleep_for).await;
            execute_scheduled_maintenance(db_path.clone(), cutoff).await;
            last_cutoff = cutoff;
        }
    });
}

fn cache_control_for_static_response(
    path: &str,
    content_type: Option<&str>,
) -> Option<&'static str> {
    if path.starts_with("/api/") || path == "/health" {
        return None;
    }
    if path == "/sw.js" || content_type.is_some_and(|value| value.starts_with("text/html")) {
        return Some("no-cache");
    }
    if path.starts_with("/assets/") {
        return Some("public, max-age=31536000, immutable");
    }
    None
}

async fn add_static_cache_headers(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let mut response = next.run(request).await;
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    if let Some(policy) = cache_control_for_static_response(&path, content_type) {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(policy));
    }
    response
}

#[cfg(test)]
mod static_header_tests {
    use super::cache_control_for_static_response;

    #[test]
    fn assigns_release_safe_cache_policies() {
        assert_eq!(
            cache_control_for_static_response("/sw.js", Some("text/javascript")),
            Some("no-cache")
        );
        assert_eq!(
            cache_control_for_static_response("/index.html", Some("text/html; charset=utf-8")),
            Some("no-cache")
        );
        assert_eq!(
            cache_control_for_static_response("/assets/main-abc123.js", Some("text/javascript")),
            Some("public, max-age=31536000, immutable")
        );
        assert_eq!(
            cache_control_for_static_response("/api/texts/1", Some("application/json")),
            None
        );
    }
}

#[cfg(test)]
mod maintenance_schedule_tests {
    use super::{next_maintenance_cutoff, scheduled_cutoff_after_last_run};
    use chrono::{Local, TimeZone};

    fn local(hour: u32, minute: u32, second: u32) -> chrono::DateTime<Local> {
        Local
            .with_ymd_and_hms(2026, 8, 20, hour, minute, second)
            .single()
            .unwrap()
    }

    #[test]
    fn next_maintenance_cutoff_honors_grace_window_boundaries() {
        assert_eq!(next_maintenance_cutoff(local(0, 4, 59)), local(0, 5, 0));
        assert_eq!(next_maintenance_cutoff(local(0, 5, 0)), local(0, 5, 0));
        assert_eq!(next_maintenance_cutoff(local(0, 9, 59)), local(0, 5, 0));
        assert_eq!(
            next_maintenance_cutoff(local(0, 10, 0)),
            Local
                .with_ymd_and_hms(2026, 8, 21, 0, 5, 0)
                .single()
                .unwrap()
        );
        assert_eq!(
            next_maintenance_cutoff(local(23, 0, 0)),
            Local
                .with_ymd_and_hms(2026, 8, 21, 0, 5, 0)
                .single()
                .unwrap()
        );
    }

    #[test]
    fn scheduler_runs_a_cutoff_crossed_during_startup_catch_up() {
        let last_run = Local
            .with_ymd_and_hms(2026, 8, 19, 0, 5, 0)
            .single()
            .unwrap();

        assert_eq!(
            scheduled_cutoff_after_last_run(local(0, 10, 0), last_run),
            local(0, 5, 0)
        );
    }
}

// ── Connection pool ───────────────────────────────────────────────────────────

/// A simple pool of SQLite connections backed by a semaphore.
/// WAL mode lets readers run in parallel; writers still serialize via SQLite.
struct DbPool {
    conns: std::sync::Mutex<Vec<Connection>>,
    sem: Arc<tokio::sync::Semaphore>,
    write_sem: Arc<tokio::sync::Semaphore>,
}

impl DbPool {
    fn new(conns: Vec<Connection>) -> Arc<Self> {
        let n = conns.len();
        Arc::new(DbPool {
            conns: std::sync::Mutex::new(conns),
            sem: Arc::new(tokio::sync::Semaphore::new(n)),
            write_sem: Arc::new(tokio::sync::Semaphore::new(1)),
        })
    }

    async fn acquire(self: &Arc<Self>) -> PoolConn {
        let permit = Arc::clone(&self.sem).acquire_owned().await.unwrap();
        let conn = self.conns.lock().unwrap().pop().unwrap();
        PoolConn {
            pool: Arc::clone(self),
            conn: Some(conn),
            _permit: permit,
        }
    }

    async fn acquire_write_permit(self: &Arc<Self>) -> tokio::sync::OwnedSemaphorePermit {
        Arc::clone(&self.write_sem).acquire_owned().await.unwrap()
    }
}

/// RAII guard: returns the connection to the pool on drop.
struct PoolConn {
    pool: Arc<DbPool>,
    conn: Option<Connection>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

impl std::ops::Deref for PoolConn {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.conn.as_ref().unwrap()
    }
}

impl Drop for PoolConn {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            self.pool.conns.lock().unwrap().push(conn);
        }
    }
}

type Db = Arc<DbPool>;

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

    let cert_path: Option<std::path::PathBuf> = args
        .iter()
        .position(|a| a == "--cert")
        .and_then(|i| args.get(i + 1))
        .map(std::path::PathBuf::from);

    let key_path: Option<std::path::PathBuf> = args
        .iter()
        .position(|a| a == "--key")
        .and_then(|i| args.get(i + 1))
        .map(std::path::PathBuf::from);

    let tls = cert_path.is_some() && key_path.is_some();

    let port: u16 = if let Some(idx) = args.iter().position(|a| a == "--port") {
        args.get(idx + 1)
            .and_then(|v| v.parse().ok())
            .unwrap_or(if tls { 443 } else { 3000 })
    } else if tls {
        443
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

    if args.iter().any(|arg| arg == "--run-analysis-maintenance") {
        let report = library::maintenance::run_due_analysis_maintenance(&db_path, Utc::now());
        println!(
            "{}",
            serde_json::to_string_pretty(&report)
                .unwrap_or_else(|error| format!("failed to serialize report: {error}"))
        );
        if report.fatal_error.is_some() || report.failed > 0 {
            std::process::exit(1);
        }
        return;
    }

    // Run schema migrations on the first connection, then build an 8-connection
    // WAL-mode pool so reads can run in parallel without blocking each other.
    let first = dictionary::init_connection(&db_path).unwrap_or_else(|e| {
        eprintln!("Failed to initialize database: {}", e);
        std::process::exit(1);
    });
    first
        .execute_batch(DB_PRAGMAS)
        .unwrap_or_else(|e| eprintln!("Warning: could not enable WAL mode: {}", e));

    match library::analysis::load_user_segmentation_words(&first) {
        Ok(count) if count > 0 => println!("Loaded {} user segmentation words", count),
        Ok(_) => {}
        Err(e) => eprintln!("Warning: failed to load segmentation words: {}", e),
    }

    let mut conns = vec![first];
    for _ in 1..8 {
        match Connection::open(&db_path) {
            Ok(c) => {
                let _ = c.execute_batch(DB_PRAGMAS);
                conns.push(c);
            }
            Err(e) => eprintln!("Warning: could not open extra DB connection: {}", e),
        }
    }
    println!("Connection pool: {} connections", conns.len());

    let db: Db = DbPool::new(conns);
    spawn_analysis_maintenance_scheduler(db_path.clone());

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
        .route(
            "/api/texts/{id}/vocab-cache",
            get(get_text_vocab_cache_handler_with_headers),
        )
        .route("/api/sync/sessions", post(sync_sessions_handler))
        .fallback_service(serve_static)
        .with_state(db)
        .layer(middleware::from_fn(add_static_cache_headers))
        .layer(CompressionLayer::new().gzip(true))
        .layer(cors);

    let addr: std::net::SocketAddr = format!("0.0.0.0:{}", port).parse().unwrap();

    if let (Some(cert), Some(key)) = (cert_path, key_path) {
        println!("Serving on https://{}", addr);
        println!("Static files from: {:?}", dist_dir);
        let tls_config = axum_server::tls_rustls::RustlsConfig::from_pem_file(&cert, &key)
            .await
            .unwrap_or_else(|e| {
                eprintln!("Failed to load TLS cert/key: {}", e);
                std::process::exit(1);
            });
        axum_server::bind_rustls(addr, tls_config)
            .serve(app.into_make_service())
            .await
            .unwrap();
    } else {
        println!("Serving on http://{}", addr);
        println!("Static files from: {:?}", dist_dir);
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .unwrap_or_else(|e| {
                eprintln!("Failed to bind {}: {}", addr, e);
                std::process::exit(1);
            });
        axum::serve(listener, app).await.unwrap();
    }
}

async fn health() -> &'static str {
    "ok"
}

async fn dispatch(
    State(db): State<Db>,
    Path(command): Path<String>,
    Json(body): Json<Value>,
) -> Result<Response, AppError> {
    let total_started = Instant::now();
    let mut timings = RequestTimings::default();
    let _write_permit = if is_write_command(&command) {
        let started = Instant::now();
        let permit = db.acquire_write_permit().await;
        timings.write_wait = started.elapsed();
        Some(permit)
    } else {
        None
    };

    let pool_started = Instant::now();
    let conn = db.acquire().await;
    timings.pool_wait = pool_started.elapsed();
    let blocking_started = Instant::now();
    let work_command = command.clone();
    let result =
        tokio::task::spawn_blocking(move || dispatch_sync(&conn, &work_command, &body)).await;
    timings.blocking = blocking_started.elapsed();
    let result = match result {
        Ok(result) => result,
        Err(error) => Err(ApiError::Internal(error.to_string())),
    };
    let response = result.and_then(|value| {
        let serialized = serialize_json_bytes_with(|| serde_json::to_vec(&value));
        if let Ok((_, elapsed)) = &serialized {
            timings.serialization = *elapsed;
        }
        serialized.and_then(|(bytes, _)| json_response(bytes))
    });
    Ok(emit_finalized_request(
        &command,
        total_started,
        timings,
        response,
    )?)
}

async fn get_text_handler(State(db): State<Db>, Path(id): Path<i64>) -> Result<Response, AppError> {
    let total_started = Instant::now();
    let pool_started = Instant::now();
    let conn = db.acquire().await;
    let pool_wait = pool_started.elapsed();
    let blocking_started = Instant::now();
    let result = tokio::task::spawn_blocking(move || {
        let text = library::text::get_text(&conn, id)
            .map_err(db_err)?
            .ok_or_else(|| not_found(format!("Text {} not found", id)))?;
        serialize(text)
    })
    .await;
    let blocking = blocking_started.elapsed();
    let result = match result {
        Ok(result) => result,
        Err(error) => Err(ApiError::Internal(error.to_string())),
    };
    let mut timings = RequestTimings {
        pool_wait,
        blocking,
        ..Default::default()
    };
    let response = result.and_then(|value| {
        let serialized = serialize_json_bytes_with(|| serde_json::to_vec(&value));
        if let Ok((_, elapsed)) = &serialized {
            timings.serialization = *elapsed;
        }
        serialized.and_then(|(bytes, _)| json_response(bytes))
    });
    Ok(emit_finalized_request(
        "get_text",
        total_started,
        timings,
        response,
    )?)
}

async fn get_text_vocab_cache_handler_with_headers(
    State(db): State<Db>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let total_started = Instant::now();
    let pool_started = Instant::now();
    let conn = db.acquire().await;
    let pool_wait = pool_started.elapsed();
    let blocking_started = Instant::now();
    let result = tokio::task::spawn_blocking(move || -> Result<(String, Value), ApiError> {
        let version = text_vocab_version(&conn, id)?;
        let value = serialize(library::analysis::get_text_vocab_cache(&conn, id).map_err(db_err)?)?;
        Ok((version, value))
    })
    .await;
    let blocking = blocking_started.elapsed();
    let result = match result {
        Ok(result) => result,
        Err(error) => Err(ApiError::Internal(error.to_string())),
    };
    let mut timings = RequestTimings {
        pool_wait,
        blocking,
        ..Default::default()
    };
    let response = result.and_then(|(version, value)| {
        let serialized = serialize_json_bytes_with(|| serde_json::to_vec(&value));
        if let Ok((_, elapsed)) = &serialized {
            timings.serialization = *elapsed;
        }
        let (bytes, _) = serialized?;
        let etag = text_vocab_etag(&version, &bytes);
        let mut response = if weak_etag_matches(headers.get(header::IF_NONE_MATCH), &etag) {
            StatusCode::NOT_MODIFIED.into_response()
        } else {
            json_response(bytes)?
        };
        response.headers_mut().insert(
            header::ETAG,
            HeaderValue::from_str(&etag).map_err(|e| ApiError::Internal(e.to_string()))?,
        );
        Ok(response)
    });
    Ok(emit_finalized_request(
        "get_text_vocab_cache",
        total_started,
        timings,
        response,
    )?)
}

#[cfg(test)]
mod server_performance_tests {
    use super::{
        finalize_timed_request, get_text_vocab_cache_handler_with_headers,
        serialize_json_bytes_with, slow_request_log, text_vocab_etag, text_vocab_version,
        weak_etag_matches, ApiError, AppError, DbPool, RequestTimings,
    };
    use axum::{
        body::{to_bytes, Body, HttpBody},
        extract::{Path, State},
        http::{header, HeaderMap, HeaderValue, Request, StatusCode},
        response::IntoResponse,
        routing::get,
        Router,
    };
    use rusqlite::Connection;
    use std::time::{Duration, Instant};
    use tower::ServiceExt;
    use tower_http::compression::CompressionLayer;

    #[tokio::test]
    async fn gzip_accept_encoding_compresses_json() {
        let app = Router::new()
            .route(
                "/json",
                get(|| async {
                    axum::Json(serde_json::json!({ "data": "x".repeat(4096) })).into_response()
                }),
            )
            .layer(CompressionLayer::new().gzip(true));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/json")
                    .header(header::ACCEPT_ENCODING, "gzip")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.headers().get(header::CONTENT_ENCODING).unwrap(),
            "gzip"
        );
        assert!(!to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .is_empty());
    }

    #[test]
    fn if_none_match_uses_weak_comparison() {
        let etag = "\"text-vocab-7-abc\"";
        assert!(weak_etag_matches(
            Some(&HeaderValue::from_static("W/\"text-vocab-7-abc\"")),
            etag
        ));
        assert!(weak_etag_matches(
            Some(&HeaderValue::from_static(
                "\"other\", W/\"text-vocab-7-abc\""
            )),
            etag
        ));
        assert!(!weak_etag_matches(
            Some(&HeaderValue::from_static("\"other\"")),
            etag
        ));
    }

    #[test]
    fn vocabulary_etag_is_quoted_and_tracks_text_analysis_and_representation() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE texts (id INTEGER PRIMARY KEY, updated_at TEXT NOT NULL); CREATE TABLE text_analyses (id INTEGER PRIMARY KEY, text_id INTEGER UNIQUE, analyzed_at TEXT); INSERT INTO texts VALUES (7, 'v1'); INSERT INTO text_analyses VALUES (1, 7, 'a1');").unwrap();
        let first_version = text_vocab_version(&conn, 7).unwrap();
        let first = text_vocab_etag(&first_version, br#"{"definition":"old"}"#);
        assert!(first.starts_with('"') && first.ends_with('"'));
        conn.execute("UPDATE texts SET updated_at = 'v2' WHERE id = 7", [])
            .unwrap();
        let text_changed = text_vocab_etag(
            &text_vocab_version(&conn, 7).unwrap(),
            br#"{"definition":"old"}"#,
        );
        assert_ne!(first, text_changed);
        conn.execute(
            "UPDATE text_analyses SET id = 2, analyzed_at = 'a2' WHERE text_id = 7",
            [],
        )
        .unwrap();
        let analysis_changed = text_vocab_etag(
            &text_vocab_version(&conn, 7).unwrap(),
            br#"{"definition":"old"}"#,
        );
        assert_ne!(text_changed, analysis_changed);
        assert_ne!(
            analysis_changed,
            text_vocab_etag(
                &text_vocab_version(&conn, 7).unwrap(),
                br#"{"definition":"new"}"#
            )
        );
    }

    #[test]
    fn only_slow_samples_log_phase_timings_without_request_content() {
        let fast = RequestTimings {
            total: Duration::from_millis(250),
            ..Default::default()
        };
        assert!(slow_request_log("dictionary_lookup", &fast).is_none());
        let slow = RequestTimings {
            pool_wait: Duration::from_millis(1),
            write_wait: Duration::from_millis(2),
            blocking: Duration::from_millis(248),
            serialization: Duration::from_millis(3),
            total: Duration::from_millis(251),
        };
        let line = slow_request_log("dictionary_lookup", &slow).unwrap();
        assert_eq!(line, "slow_request command=dictionary_lookup pool_wait_ms=1 write_wait_ms=2 blocking_ms=248 serialization_ms=3 total_ms=251");
        assert!(!line.contains("query") && !line.contains("content"));
    }

    #[test]
    fn large_controlled_serialization_contributes_to_slow_threshold() {
        let value = serde_json::json!({ "data": "x".repeat(1_000_000) });
        let (_, serialization) = serialize_json_bytes_with(|| {
            std::thread::sleep(Duration::from_millis(251));
            serde_json::to_vec(&value)
        })
        .unwrap();
        let timings = RequestTimings {
            serialization,
            total: serialization,
            ..Default::default()
        };
        let line = slow_request_log("large_response", &timings).unwrap();
        assert!(line.contains("serialization_ms="));
        assert!(serialization > Duration::from_millis(250));
    }

    #[test]
    fn slow_failed_request_logs_all_fields_and_preserves_error_status() {
        let started = Instant::now();
        std::thread::sleep(Duration::from_millis(251));
        let timings = RequestTimings {
            blocking: started.elapsed(),
            ..Default::default()
        };
        let (result, line) = finalize_timed_request(
            "get_text",
            started,
            timings,
            Err::<(), ApiError>(ApiError::Internal("controlled failure".to_string())),
        );
        let line = line.expect("slow failed request must be logged");
        assert!(line.contains("command=get_text"));
        assert!(line.contains("pool_wait_ms=0"));
        assert!(line.contains("write_wait_ms=0"));
        assert!(line.contains("blocking_ms="));
        assert!(line.contains("serialization_ms=0"));
        assert!(line.contains("total_ms="));
        let response = AppError::from(result.unwrap_err()).into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn matching_vocab_etag_returns_304_with_no_body() {
        let conn = Connection::open_in_memory().unwrap();
        seed_vocab_schema(&conn);
        let version = text_vocab_version(&conn, 7).unwrap();
        let value = super::serialize(
            chinese_reader_lib::library::analysis::get_text_vocab_cache(&conn, 7).unwrap(),
        )
        .unwrap();
        let etag = text_vocab_etag(&version, &serde_json::to_vec(&value).unwrap());
        let db = DbPool::new(vec![conn]);
        let mut headers = HeaderMap::new();
        headers.insert(
            header::IF_NONE_MATCH,
            HeaderValue::from_str(&format!("W/{etag}")).unwrap(),
        );
        let response = get_text_vocab_cache_handler_with_headers(State(db), Path(7), headers)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(response.headers().get(header::ETAG).unwrap(), etag.as_str());
        assert_eq!(response.body().size_hint().lower(), 0);
    }

    fn seed_vocab_schema(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE texts (id INTEGER PRIMARY KEY, updated_at TEXT NOT NULL);
             CREATE TABLE text_analyses (id INTEGER PRIMARY KEY, text_id INTEGER UNIQUE, analyzed_at TEXT);
             CREATE TABLE text_word_freq (text_id INTEGER, word TEXT);
             CREATE TABLE text_character_freq (text_id INTEGER, character TEXT);
             CREATE TABLE dictionary_entries (id INTEGER PRIMARY KEY, traditional TEXT, pinyin TEXT, source TEXT);
             CREATE TABLE definitions (entry_id INTEGER, text TEXT, sort_order INTEGER);
             INSERT INTO texts VALUES (7, 'v1');
             INSERT INTO text_analyses VALUES (1, 7, 'a1');
             INSERT INTO text_word_freq VALUES (7, '中國');
             INSERT INTO dictionary_entries VALUES (10, '中國', 'zhong1 guo2', 'test');
             INSERT INTO definitions VALUES (10, 'old definition', 0);",
        )
        .unwrap();
    }

    #[tokio::test]
    async fn dictionary_definition_change_invalidates_old_vocab_etag() {
        let conn = Connection::open_in_memory().unwrap();
        seed_vocab_schema(&conn);
        let db = DbPool::new(vec![conn]);
        let first =
            get_text_vocab_cache_handler_with_headers(State(db.clone()), Path(7), HeaderMap::new())
                .await
                .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let old_etag = first.headers().get(header::ETAG).unwrap().clone();
        let old_body = to_bytes(first.into_body(), usize::MAX).await.unwrap();
        assert!(String::from_utf8_lossy(&old_body).contains("old definition"));

        {
            let conn = db.acquire().await;
            conn.execute(
                "UPDATE definitions SET text = 'new definition' WHERE entry_id = 10",
                [],
            )
            .unwrap();
        }
        let mut headers = HeaderMap::new();
        headers.insert(header::IF_NONE_MATCH, old_etag.clone());
        let second = get_text_vocab_cache_handler_with_headers(State(db), Path(7), headers)
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::OK);
        assert_ne!(second.headers().get(header::ETAG).unwrap(), &old_etag);
        let new_body = to_bytes(second.into_body(), usize::MAX).await.unwrap();
        assert!(String::from_utf8_lossy(&new_body).contains("new definition"));
    }
}

async fn sync_sessions_handler(
    State(db): State<Db>,
    Json(body): Json<Value>,
) -> Result<Response, AppError> {
    let total_started = Instant::now();
    let started = Instant::now();
    let _write_permit = db.acquire_write_permit().await;
    let write_wait = started.elapsed();

    let pool_started = Instant::now();
    let conn = db.acquire().await;
    let pool_wait = pool_started.elapsed();
    let blocking_started = Instant::now();
    let result = tokio::task::spawn_blocking(move || {
        let sessions: Vec<library::speed::UploadSession> = serde_json::from_value(
            body.get("sessions")
                .cloned()
                .unwrap_or(Value::Array(vec![])),
        )
        .map_err(|e| ApiError::BadRequest(format!("invalid sessions: {}", e)))?;
        let mut ids: Vec<i64> = Vec::new();
        for s in &sessions {
            ids.push(library::speed::upload_completed_session(&conn, s).map_err(db_err)?);
        }
        serialize(serde_json::json!({ "session_ids": ids }))
    })
    .await;
    let blocking = blocking_started.elapsed();
    let result = match result {
        Ok(result) => result,
        Err(error) => Err(ApiError::Internal(error.to_string())),
    };
    let mut timings = RequestTimings {
        pool_wait,
        write_wait,
        blocking,
        ..Default::default()
    };
    let response = result.and_then(|value| {
        let serialized = serialize_json_bytes_with(|| serde_json::to_vec(&value));
        if let Ok((_, elapsed)) = &serialized {
            timings.serialization = *elapsed;
        }
        serialized.and_then(|(bytes, _)| json_response(bytes))
    });
    Ok(emit_finalized_request(
        "sync_sessions",
        total_started,
        timings,
        response,
    )?)
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

#[derive(Debug)]
struct AppError(String, StatusCode);

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        (self.1, self.0).into_response()
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn is_write_command(command: &str) -> bool {
    matches!(
        command,
        "create_user_dictionary"
            | "delete_user_dictionary"
            | "add_user_dictionary_entry"
            | "update_user_dictionary_entry"
            | "delete_user_dictionary_entry"
            | "import_user_dictionary_entries"
            | "create_shelf"
            | "update_shelf"
            | "delete_shelf"
            | "move_shelf"
            | "create_text"
            | "update_text"
            | "delete_text"
            | "migrate_large_texts"
            | "get_text_analysis"
            | "get_analysis_report"
            | "reanalyze_text"
            | "get_prestudy_characters"
            | "get_prestudy_words"
            | "add_known_word"
            | "update_word_status"
            | "remove_known_word"
            | "import_known_words"
            | "start_reading_session"
            | "finish_reading_session"
            | "discard_reading_session"
            | "delete_reading_session"
            | "update_session_auto_marked"
            | "log_offline_read"
            | "set_setting"
            | "auto_mark_text_as_known"
            | "import_frequency_data"
            | "record_vocabulary_snapshot"
            | "clear_frequency_source"
            | "add_custom_segmentation_word"
            | "define_custom_word"
    )
}

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
            Ok(Value::Null)
        }

        "migrate_large_texts" => {
            let shelf_id: Option<i64> = opt_field(body, "shelf_id");
            let result = library::text::migrate_large_texts(conn, shelf_id).map_err(db_err)?;
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
            serialize(result)
        }

        "get_shelf_analysis" => {
            let shelf_id: i64 = field(body, "shelf_id")?;
            serialize(
                library::analysis::get_shelf_analysis_status(conn, shelf_id, Utc::now())
                    .map_err(db_err)?,
            )
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

        "get_prestudy_words" => {
            let shelf_id: i64 = field(body, "shelf_id")?;
            let target_rate: f64 = field(body, "target_rate")?;
            serialize(
                library::analysis::get_prestudy_words(conn, shelf_id, target_rate)
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

        "get_word_context" => {
            let shelf_id: i64 = field(body, "shelf_id")?;
            let word: String = field(body, "word")?;
            let max_snippets: usize = opt_field(body, "max_snippets").unwrap_or(3);
            serialize(
                library::analysis::get_word_context(conn, shelf_id, &word, max_snippets)
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
            serialize(result)
        }

        "update_word_status" => {
            let word: String = field(body, "word")?;
            let status: String = field(body, "status")?;
            library::known_words::update_word_status(conn, &word, &status).map_err(db_err)?;
            Ok(Value::Null)
        }

        "remove_known_word" => {
            let word: String = field(body, "word")?;
            library::known_words::remove_known_word(conn, &word).map_err(db_err)?;
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
            let first_reads_only: bool = opt_field(body, "first_reads_only").unwrap_or(true);
            serialize(
                library::speed::get_speed_stats(conn, shelf_id, first_reads_only)
                    .map_err(db_err)?,
            )
        }

        "get_read_pass_estimates" => {
            let shelf_id: Option<i64> = opt_field(body, "shelf_id");
            serialize(library::speed::get_read_pass_estimates(conn, shelf_id).map_err(db_err)?)
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
            let stats =
                library::analysis::auto_mark_text_as_known(conn, text_id).map_err(db_err)?;
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
                        Some(&format!(
                            "Custom word definitions for shelf: {}",
                            shelf_name
                        )),
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

        _ => Err(ApiError::BadRequest(format!(
            "Unknown command: {}",
            command
        ))),
    }
}
