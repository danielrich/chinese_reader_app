//! Speed tracking module for reading sessions.
//!
//! This module provides functionality for:
//! - Starting and finishing reading sessions
//! - Tracking reading speed over time
//! - Correlating speed with vocabulary knowledge

use chrono::{DateTime, Duration, Local, NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::error::{LibraryError, Result};

// =============================================================================
// Models
// =============================================================================

/// A reading session for a text
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadingSession {
    pub id: i64,
    pub text_id: i64,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub character_count: i64,
    pub is_first_read: bool,
    pub is_complete: bool,
    pub known_characters_count: i64,
    pub known_words_count: i64,
    pub cumulative_characters_read: i64,
    pub duration_seconds: Option<i64>,
    pub characters_per_minute: Option<f64>,
    pub auto_marked_characters: i64,
    pub auto_marked_words: i64,
    /// Percentage of known characters in this specific text at session start (0-100)
    pub text_known_char_percentage: Option<f64>,
    pub created_at: String,
    pub is_manual_log: bool,
    pub source: Option<String>,
}

impl ReadingSession {
    fn from_row(row: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            text_id: row.get("text_id")?,
            started_at: row.get("started_at")?,
            finished_at: row.get("finished_at")?,
            character_count: row.get("character_count")?,
            is_first_read: row.get::<_, i64>("is_first_read")? == 1,
            is_complete: row.get::<_, i64>("is_complete")? == 1,
            known_characters_count: row.get("known_characters_count")?,
            known_words_count: row.get("known_words_count")?,
            cumulative_characters_read: row.get("cumulative_characters_read")?,
            duration_seconds: row.get("duration_seconds")?,
            characters_per_minute: row.get("characters_per_minute")?,
            auto_marked_characters: row.get("auto_marked_characters")?,
            auto_marked_words: row.get("auto_marked_words")?,
            text_known_char_percentage: row.get("text_known_char_percentage")?,
            created_at: row.get("created_at")?,
            is_manual_log: row.get::<_, i64>("is_manual_log")? == 1,
            source: row.get("source")?,
        })
    }
}

/// Input for logging offline reading sessions
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManualLogInput {
    pub text_ids: Vec<i64>,
    pub finished_at: String,         // ISO 8601 datetime chosen by user
    pub total_duration_seconds: i64, // total reading time for all texts
    pub source: Option<String>,      // "physical_book" | "other_site" | "phone" | null
}

/// A data point for speed graphs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeedDataPoint {
    pub session_id: i64,
    pub text_id: i64,
    pub text_title: String,
    pub shelf_id: i64,
    pub finished_at: String,
    pub characters_per_minute: f64,
    pub character_count: i64,
    pub cumulative_characters_read: i64,
    pub known_characters_count: i64,
    pub known_words_count: i64,
    pub auto_marked_characters: i64,
    pub auto_marked_words: i64,
    /// Percentage of known characters in this specific text at session start (0-100)
    pub text_known_char_percentage: Option<f64>,
}

/// Aggregated speed statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeedStats {
    pub total_sessions: i64,
    pub total_characters_read: i64,
    pub total_reading_time_seconds: i64,
    pub average_speed: f64,
    pub fastest_speed: f64,
    pub slowest_speed: f64,
    pub recent_average_speed: f64,
    /// Characters in texts not yet read (first read)
    pub unread_characters: i64,
    /// Estimated seconds to complete unread texts (based on recent speed)
    pub estimated_completion_seconds: Option<i64>,
}

impl Default for SpeedStats {
    fn default() -> Self {
        Self {
            total_sessions: 0,
            total_characters_read: 0,
            total_reading_time_seconds: 0,
            average_speed: 0.0,
            fastest_speed: 0.0,
            slowest_speed: 0.0,
            recent_average_speed: 0.0,
            unread_characters: 0,
            estimated_completion_seconds: None,
        }
    }
}

// =============================================================================
// Core Functions
// =============================================================================

/// Start a new reading session for a text
pub fn start_reading_session(conn: &Connection, text_id: i64) -> Result<ReadingSession> {
    // Check text exists and get character count
    let (character_count, _shelf_id): (i64, i64) = conn
        .query_row(
            "SELECT character_count, shelf_id FROM texts WHERE id = ?",
            [text_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| LibraryError::TextNotFound(text_id))?;

    // Check no active session exists for this text
    let active_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM reading_sessions WHERE text_id = ? AND is_complete = 0",
        [text_id],
        |row| row.get(0),
    )?;

    if active_count > 0 {
        return Err(LibraryError::ActiveSessionExists(text_id));
    }

    // Determine if this is the first read (no prior complete sessions)
    let prior_complete: i64 = conn.query_row(
        "SELECT COUNT(*) FROM reading_sessions WHERE text_id = ? AND is_complete = 1",
        [text_id],
        |row| row.get(0),
    )?;
    let is_first_read = prior_complete == 0;

    // Snapshot current known vocabulary counts
    let known_characters_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM known_words WHERE word_type = 'character'",
        [],
        |row| row.get(0),
    )?;

    let known_words_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM known_words WHERE word_type = 'word'",
        [],
        |row| row.get(0),
    )?;

    // Calculate cumulative characters read from prior complete sessions
    let cumulative_characters_read: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(character_count), 0) FROM reading_sessions WHERE is_complete = 1",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    // Calculate known character percentage for this specific text
    // This uses text_character_freq table which contains character frequencies for the text
    let text_known_char_percentage: Option<f64> = conn
        .query_row(
            r#"
            SELECT
                CASE WHEN COALESCE(SUM(frequency), 0) = 0 THEN NULL
                ELSE CAST(SUM(CASE WHEN kw.id IS NOT NULL AND kw.status = 'known' THEN frequency ELSE 0 END) AS REAL)
                     / CAST(SUM(frequency) AS REAL) * 100.0
                END
            FROM text_character_freq tcf
            LEFT JOIN known_words kw ON kw.word = tcf.character AND kw.word_type = 'character'
            WHERE tcf.text_id = ?
            "#,
            [text_id],
            |row| row.get(0),
        )
        .unwrap_or(None);

    // Insert the session
    let started_at = Utc::now().to_rfc3339();

    conn.execute(
        r#"
        INSERT INTO reading_sessions (
            text_id, started_at, character_count, is_first_read,
            known_characters_count, known_words_count, cumulative_characters_read,
            text_known_char_percentage
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        "#,
        params![
            text_id,
            started_at,
            character_count,
            is_first_read as i64,
            known_characters_count,
            known_words_count,
            cumulative_characters_read,
            text_known_char_percentage,
        ],
    )?;

    let session_id = conn.last_insert_rowid();

    // Return the created session
    get_session_by_id(conn, session_id)
}

/// Finish an active reading session
pub fn finish_reading_session(conn: &Connection, session_id: i64) -> Result<ReadingSession> {
    // Get the session
    let session = get_session_by_id(conn, session_id)?;

    // Verify not already complete
    if session.is_complete {
        return Err(LibraryError::SessionAlreadyComplete(session_id));
    }

    // Calculate duration
    let started_at = DateTime::parse_from_rfc3339(&session.started_at)
        .map_err(|e| LibraryError::InvalidInput(format!("Invalid start time: {}", e)))?;
    let finished_at = Utc::now();
    let duration_seconds = (finished_at - started_at.with_timezone(&Utc)).num_seconds();

    // Calculate characters per minute
    let characters_per_minute = if duration_seconds > 0 {
        (session.character_count as f64) / (duration_seconds as f64 / 60.0)
    } else {
        0.0
    };

    // Update the session
    conn.execute(
        r#"
        UPDATE reading_sessions
        SET finished_at = ?,
            is_complete = 1,
            duration_seconds = ?,
            characters_per_minute = ?
        WHERE id = ?
        "#,
        params![
            finished_at.to_rfc3339(),
            duration_seconds,
            characters_per_minute,
            session_id,
        ],
    )?;

    // Return the updated session
    get_session_by_id(conn, session_id)
}

/// Discard (delete) an incomplete reading session
pub fn discard_reading_session(conn: &Connection, session_id: i64) -> Result<()> {
    // Verify session exists
    let session = get_session_by_id(conn, session_id)?;

    // Only allow discarding incomplete sessions
    if session.is_complete {
        return Err(LibraryError::InvalidInput(
            "Cannot discard a completed session".to_string(),
        ));
    }

    conn.execute("DELETE FROM reading_sessions WHERE id = ?", [session_id])?;

    Ok(())
}

/// Delete a reading session (any session, complete or not)
pub fn delete_reading_session(conn: &Connection, session_id: i64) -> Result<()> {
    // Verify session exists
    get_session_by_id(conn, session_id)?;

    conn.execute("DELETE FROM reading_sessions WHERE id = ?", [session_id])?;

    Ok(())
}

/// Get an active (incomplete) session for a text, if any
pub fn get_active_session(conn: &Connection, text_id: i64) -> Result<Option<ReadingSession>> {
    let result = conn.query_row(
        r#"
        SELECT id, text_id, started_at, finished_at, character_count,
               is_first_read, is_complete, known_characters_count,
               known_words_count, cumulative_characters_read,
               duration_seconds, characters_per_minute,
               auto_marked_characters, auto_marked_words,
               text_known_char_percentage, created_at,
               is_manual_log, source
        FROM reading_sessions
        WHERE text_id = ? AND is_complete = 0
        ORDER BY started_at DESC
        LIMIT 1
        "#,
        [text_id],
        ReadingSession::from_row,
    );

    match result {
        Ok(session) => Ok(Some(session)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Get reading history for a text
pub fn get_text_reading_history(conn: &Connection, text_id: i64) -> Result<Vec<ReadingSession>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT id, text_id, started_at, finished_at, character_count,
               is_first_read, is_complete, known_characters_count,
               known_words_count, cumulative_characters_read,
               duration_seconds, characters_per_minute,
               auto_marked_characters, auto_marked_words,
               text_known_char_percentage, created_at,
               is_manual_log, source
        FROM reading_sessions
        WHERE text_id = ?
        ORDER BY started_at DESC
        "#,
    )?;

    let sessions = stmt
        .query_map([text_id], ReadingSession::from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(sessions)
}

// =============================================================================
// Analysis Functions
// =============================================================================

/// Get speed data points for graphing
pub fn get_speed_data(
    conn: &Connection,
    shelf_id: Option<i64>,
    first_reads_only: bool,
    limit: Option<usize>,
) -> Result<Vec<SpeedDataPoint>> {
    let limit_clause = limit
        .map(|l| format!("LIMIT {}", l))
        .unwrap_or_default();

    let mut query = String::from(
        r#"
        SELECT rs.id as session_id, rs.text_id, t.title as text_title,
               t.shelf_id, rs.finished_at, rs.characters_per_minute,
               rs.character_count, rs.cumulative_characters_read,
               rs.known_characters_count, rs.known_words_count,
               rs.auto_marked_characters, rs.auto_marked_words,
               rs.text_known_char_percentage
        FROM reading_sessions rs
        JOIN texts t ON rs.text_id = t.id
        WHERE rs.is_complete = 1
        "#,
    );

    if first_reads_only {
        query.push_str(" AND rs.is_first_read = 1");
    }

    if let Some(sid) = shelf_id {
        // Include the shelf and all its descendants
        query.push_str(&format!(
            r#" AND t.shelf_id IN (
                WITH RECURSIVE shelf_tree AS (
                    SELECT id FROM shelves WHERE id = {}
                    UNION ALL
                    SELECT s.id FROM shelves s
                    JOIN shelf_tree st ON s.parent_id = st.id
                )
                SELECT id FROM shelf_tree
            )"#,
            sid
        ));
    }

    query.push_str(" ORDER BY rs.finished_at ASC ");
    query.push_str(&limit_clause);

    let mut stmt = conn.prepare(&query)?;
    let data_points = stmt
        .query_map([], |row| {
            Ok(SpeedDataPoint {
                session_id: row.get("session_id")?,
                text_id: row.get("text_id")?,
                text_title: row.get("text_title")?,
                shelf_id: row.get("shelf_id")?,
                finished_at: row.get("finished_at")?,
                characters_per_minute: row.get("characters_per_minute")?,
                character_count: row.get("character_count")?,
                cumulative_characters_read: row.get("cumulative_characters_read")?,
                known_characters_count: row.get("known_characters_count")?,
                known_words_count: row.get("known_words_count")?,
                auto_marked_characters: row.get("auto_marked_characters")?,
                auto_marked_words: row.get("auto_marked_words")?,
                text_known_char_percentage: row.get("text_known_char_percentage")?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(data_points)
}

/// Get aggregated speed statistics
pub fn get_speed_stats(conn: &Connection, shelf_id: Option<i64>) -> Result<SpeedStats> {
    let shelf_filter = if let Some(sid) = shelf_id {
        format!(
            r#" AND t.shelf_id IN (
                WITH RECURSIVE shelf_tree AS (
                    SELECT id FROM shelves WHERE id = {}
                    UNION ALL
                    SELECT s.id FROM shelves s
                    JOIN shelf_tree st ON s.parent_id = st.id
                )
                SELECT id FROM shelf_tree
            )"#,
            sid
        )
    } else {
        String::new()
    };

    // Get basic stats
    let base_query = format!(
        r#"
        SELECT
            COUNT(*) as total_sessions,
            COALESCE(SUM(rs.character_count), 0) as total_characters_read,
            COALESCE(SUM(rs.duration_seconds), 0) as total_reading_time_seconds,
            COALESCE(AVG(rs.characters_per_minute), 0) as average_speed,
            COALESCE(MAX(rs.characters_per_minute), 0) as fastest_speed,
            COALESCE(MIN(rs.characters_per_minute), 0) as slowest_speed
        FROM reading_sessions rs
        JOIN texts t ON rs.text_id = t.id
        WHERE rs.is_complete = 1 AND rs.is_first_read = 1
        {}
        "#,
        shelf_filter
    );

    let (total_sessions, total_characters_read, total_reading_time_seconds, average_speed, fastest_speed, slowest_speed): (i64, i64, i64, f64, f64, f64) = conn.query_row(
        &base_query,
        [],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        },
    )?;

    // Get recent average (last 5 sessions)
    let recent_query = format!(
        r#"
        SELECT COALESCE(AVG(characters_per_minute), 0)
        FROM (
            SELECT rs.characters_per_minute
            FROM reading_sessions rs
            JOIN texts t ON rs.text_id = t.id
            WHERE rs.is_complete = 1 AND rs.is_first_read = 1
            {}
            ORDER BY rs.finished_at DESC
            LIMIT 5
        )
        "#,
        shelf_filter
    );

    let recent_average_speed: f64 = conn.query_row(&recent_query, [], |row| row.get(0))?;

    // If shelf-specific speed is 0, fall back to global speed for estimation
    let speed_for_estimation = if recent_average_speed > 0.0 {
        recent_average_speed
    } else if shelf_id.is_some() {
        // Fall back to global recent average
        let global_recent: f64 = conn.query_row(
            r#"
            SELECT COALESCE(AVG(characters_per_minute), 0)
            FROM (
                SELECT rs.characters_per_minute
                FROM reading_sessions rs
                WHERE rs.is_complete = 1 AND rs.is_first_read = 1
                ORDER BY rs.finished_at DESC
                LIMIT 5
            )
            "#,
            [],
            |row| row.get(0),
        )?;
        global_recent
    } else {
        0.0
    };

    // Get unread characters (texts without a first-read completion)
    let unread_query = format!(
        r#"
        SELECT COALESCE(SUM(t.character_count), 0)
        FROM texts t
        WHERE NOT EXISTS (
            SELECT 1 FROM reading_sessions rs
            WHERE rs.text_id = t.id AND rs.is_complete = 1 AND rs.is_first_read = 1
        )
        {}
        "#,
        if let Some(sid) = shelf_id {
            format!(
                r#" AND t.shelf_id IN (
                    WITH RECURSIVE shelf_tree AS (
                        SELECT id FROM shelves WHERE id = {}
                        UNION ALL
                        SELECT s.id FROM shelves s
                        JOIN shelf_tree st ON s.parent_id = st.id
                    )
                    SELECT id FROM shelf_tree
                )"#,
                sid
            )
        } else {
            String::new()
        }
    );

    let unread_characters: i64 = conn.query_row(&unread_query, [], |row| row.get(0))?;

    // Calculate estimated completion time based on recent speed (or global fallback)
    let estimated_completion_seconds = if speed_for_estimation > 0.0 && unread_characters > 0 {
        Some(((unread_characters as f64) / speed_for_estimation * 60.0) as i64)
    } else {
        None
    };

    Ok(SpeedStats {
        total_sessions,
        total_characters_read,
        total_reading_time_seconds,
        average_speed,
        fastest_speed,
        slowest_speed,
        recent_average_speed,
        unread_characters,
        estimated_completion_seconds,
    })
}

/// Create completed reading sessions for texts read offline.
/// Duration is split proportionally by character count so all texts get the same CPM.
pub fn log_offline_read(conn: &Connection, input: ManualLogInput) -> Result<Vec<ReadingSession>> {
    if input.text_ids.is_empty() {
        return Err(LibraryError::InvalidInput("No texts specified".into()));
    }
    if input.total_duration_seconds <= 0 {
        return Err(LibraryError::InvalidInput("Duration must be positive".into()));
    }

    let finished_at = DateTime::parse_from_rfc3339(&input.finished_at)
        .map_err(|e| LibraryError::InvalidInput(format!("Invalid datetime: {}", e)))?;

    // Fetch character counts for all text IDs
    let placeholders = input
        .text_ids
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id, character_count FROM texts WHERE id IN ({})",
        placeholders
    );
    let params: Vec<&dyn rusqlite::ToSql> = input
        .text_ids
        .iter()
        .map(|id| id as &dyn rusqlite::ToSql)
        .collect();
    let mut stmt = conn.prepare(&sql)?;
    let char_counts: std::collections::HashMap<i64, i64> = stmt
        .query_map(params.as_slice(), |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;

    let total_chars: i64 = char_counts.values().sum();
    if total_chars == 0 {
        return Err(LibraryError::InvalidInput(
            "Selected texts have no characters".into(),
        ));
    }

    // Snapshot current vocabulary counts (same for all sessions in this batch)
    let known_characters_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM known_words WHERE word_type = 'character'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let known_words_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM known_words WHERE word_type = 'word'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let mut session_ids = Vec::new();

    for &text_id in &input.text_ids {
        let char_count = *char_counts
            .get(&text_id)
            .ok_or_else(|| LibraryError::TextNotFound(text_id))?;

        // Proportional duration
        let duration_secs = (input.total_duration_seconds as f64
            * (char_count as f64 / total_chars as f64))
            .round() as i64;
        let duration_secs = duration_secs.max(1); // at least 1 second

        let started_at = finished_at - chrono::Duration::seconds(duration_secs);

        let characters_per_minute = char_count as f64 / (duration_secs as f64 / 60.0);

        // Is this the first completed read of this text?
        let prior_complete: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM reading_sessions WHERE text_id = ? AND is_complete = 1",
                [text_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let is_first_read = prior_complete == 0;

        // Cumulative chars read before this session
        let cumulative: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(character_count), 0) FROM reading_sessions WHERE text_id = ? AND is_complete = 1",
                [text_id],
                |row| row.get(0),
            )
            .unwrap_or(0);

        conn.execute(
            "INSERT INTO reading_sessions (
                text_id, started_at, finished_at, character_count,
                is_first_read, is_complete,
                known_characters_count, known_words_count,
                cumulative_characters_read,
                duration_seconds, characters_per_minute,
                auto_marked_characters, auto_marked_words,
                is_manual_log, source
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0, 0, 1, ?)",
            rusqlite::params![
                text_id,
                started_at.to_rfc3339(),
                finished_at.to_rfc3339(),
                char_count,
                is_first_read as i64,
                known_characters_count,
                known_words_count,
                cumulative,
                duration_secs,
                characters_per_minute,
                input.source,
            ],
        )?;

        session_ids.push(conn.last_insert_rowid());
    }

    // Return all created sessions
    session_ids
        .iter()
        .map(|&id| get_session_by_id(conn, id))
        .collect()
}

// =============================================================================
// Offline Session Upload
// =============================================================================

/// A completed session recorded client-side and uploaded when back online.
#[derive(Debug, Deserialize)]
pub struct UploadSession {
    pub local_id: String,
    pub text_id: i64,
    pub started_at_ms: i64,
    pub finished_at_ms: i64,
}

/// Insert a client-recorded session. Idempotent on `local_id`.
/// All snapshot fields (known counts, CPM, etc.) are computed server-side
/// at upload time — close enough for a short offline window.
pub fn upload_completed_session(conn: &Connection, s: &UploadSession) -> Result<i64> {
    // Idempotent: return existing server ID if already uploaded
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM reading_sessions WHERE client_local_id = ?",
            [&s.local_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }

    let (character_count, _): (i64, i64) = conn
        .query_row(
            "SELECT character_count, shelf_id FROM texts WHERE id = ?",
            [s.text_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| LibraryError::TextNotFound(s.text_id))?;

    let duration_seconds = ((s.finished_at_ms - s.started_at_ms) / 1000).max(1);
    let characters_per_minute = character_count as f64 / (duration_seconds as f64 / 60.0);

    let prior_complete: i64 = conn.query_row(
        "SELECT COUNT(*) FROM reading_sessions WHERE text_id = ? AND is_complete = 1",
        [s.text_id],
        |row| row.get(0),
    )?;
    let is_first_read = prior_complete == 0;

    let known_characters_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM known_words WHERE word_type = 'character'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let known_words_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM known_words WHERE word_type = 'word'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let cumulative_characters_read: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(character_count), 0) FROM reading_sessions WHERE is_complete = 1",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let text_known_char_percentage: Option<f64> = conn
        .query_row(
            r#"
            SELECT
                CASE WHEN COALESCE(SUM(frequency), 0) = 0 THEN NULL
                ELSE CAST(SUM(CASE WHEN kw.id IS NOT NULL AND kw.status = 'known'
                               THEN frequency ELSE 0 END) AS REAL)
                     / CAST(SUM(frequency) AS REAL) * 100.0
                END
            FROM text_character_freq tcf
            LEFT JOIN known_words kw ON kw.word = tcf.character AND kw.word_type = 'character'
            WHERE tcf.text_id = ?
            "#,
            [s.text_id],
            |row| row.get(0),
        )
        .unwrap_or(None);

    let started_at = DateTime::from_timestamp_millis(s.started_at_ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339();
    let finished_at = DateTime::from_timestamp_millis(s.finished_at_ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339();

    conn.execute(
        r#"
        INSERT INTO reading_sessions (
            client_local_id, text_id, started_at, finished_at, character_count,
            is_first_read, is_complete,
            known_characters_count, known_words_count, cumulative_characters_read,
            duration_seconds, characters_per_minute,
            auto_marked_characters, auto_marked_words,
            text_known_char_percentage,
            is_manual_log, source
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0, 0, ?, 0, 'in_app')
        "#,
        rusqlite::params![
            s.local_id,
            s.text_id,
            started_at,
            finished_at,
            character_count,
            is_first_read as i64,
            known_characters_count,
            known_words_count,
            cumulative_characters_read,
            duration_seconds,
            characters_per_minute,
            text_known_char_percentage,
        ],
    )?;

    Ok(conn.last_insert_rowid())
}

// =============================================================================
// Helper Functions
// =============================================================================

fn get_session_by_id(conn: &Connection, session_id: i64) -> Result<ReadingSession> {
    conn.query_row(
        r#"
        SELECT id, text_id, started_at, finished_at, character_count,
               is_first_read, is_complete, known_characters_count,
               known_words_count, cumulative_characters_read,
               duration_seconds, characters_per_minute,
               auto_marked_characters, auto_marked_words,
               text_known_char_percentage, created_at,
               is_manual_log, source
        FROM reading_sessions
        WHERE id = ?
        "#,
        [session_id],
        ReadingSession::from_row,
    )
    .map_err(|_| LibraryError::SessionNotFound(session_id))
}

/// Update auto-marked counts for a session
pub fn update_session_auto_marked(
    conn: &Connection,
    session_id: i64,
    auto_marked_characters: i64,
    auto_marked_words: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE reading_sessions SET auto_marked_characters = ?, auto_marked_words = ? WHERE id = ?",
        params![auto_marked_characters, auto_marked_words, session_id],
    )?;
    Ok(())
}

/// Daily reading volume data point
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyReadingVolume {
    /// Date in YYYY-MM-DD format
    pub date: String,
    /// Total characters read on this day
    pub characters_read: i64,
    /// Total reading time in seconds
    pub reading_seconds: i64,
    /// Number of sessions completed
    pub sessions_count: i64,
}

/// Reading streak information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadingStreak {
    /// Current consecutive days with reading
    pub current_streak: i64,
    /// Longest streak ever
    pub longest_streak: i64,
    /// Whether the user has read today
    pub read_today: bool,
    /// Date of the last reading session (YYYY-MM-DD)
    pub last_reading_date: Option<String>,
}

/// Get daily reading volume for the past N days
pub fn get_daily_reading_volume(conn: &Connection, days: i64) -> Result<Vec<DailyReadingVolume>> {
    let query = r#"
        SELECT
            date(finished_at, 'localtime') as reading_date,
            SUM(character_count) as characters_read,
            SUM(duration_seconds) as reading_seconds,
            COUNT(*) as sessions_count
        FROM reading_sessions
        WHERE is_complete = 1
          AND finished_at >= date('now', 'localtime', ? || ' days')
        GROUP BY date(finished_at, 'localtime')
        ORDER BY reading_date ASC
    "#;

    let days_param = format!("-{}", days);
    let mut stmt = conn.prepare(query)?;
    let volumes = stmt
        .query_map([days_param], |row| {
            Ok(DailyReadingVolume {
                date: row.get("reading_date")?,
                characters_read: row.get("characters_read")?,
                reading_seconds: row.get::<_, Option<i64>>("reading_seconds")?.unwrap_or(0),
                sessions_count: row.get("sessions_count")?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(volumes)
}

/// Calculate reading streak information
pub fn get_reading_streak(conn: &Connection) -> Result<ReadingStreak> {
    // Get all unique reading dates, ordered most recent first
    let query = r#"
        SELECT DISTINCT date(finished_at, 'localtime') as reading_date
        FROM reading_sessions
        WHERE is_complete = 1
        ORDER BY reading_date DESC
    "#;

    let mut stmt = conn.prepare(query)?;
    let dates: Vec<String> = stmt
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if dates.is_empty() {
        return Ok(ReadingStreak {
            current_streak: 0,
            longest_streak: 0,
            read_today: false,
            last_reading_date: None,
        });
    }

    let today = Local::now().format("%Y-%m-%d").to_string();
    let yesterday = (Local::now() - Duration::days(1))
        .format("%Y-%m-%d")
        .to_string();

    let last_reading_date = dates.first().cloned();
    let read_today = last_reading_date.as_ref() == Some(&today);

    // Calculate current streak
    let mut current_streak = 0i64;
    let mut check_date = if read_today {
        Local::now().date_naive()
    } else if last_reading_date.as_ref() == Some(&yesterday) {
        // If they read yesterday but not today, streak is still active
        (Local::now() - Duration::days(1)).date_naive()
    } else {
        // No recent reading, streak is broken
        return Ok(ReadingStreak {
            current_streak: 0,
            longest_streak: calculate_longest_streak(&dates),
            read_today: false,
            last_reading_date,
        });
    };

    for date_str in &dates {
        let date = NaiveDate::parse_from_str(date_str, "%Y-%m-%d")
            .unwrap_or_else(|_| Local::now().date_naive());

        if date == check_date {
            current_streak += 1;
            check_date -= Duration::days(1);
        } else if date < check_date {
            // Gap in dates, streak ends
            break;
        }
        // If date > check_date, skip (shouldn't happen with DESC order)
    }

    let longest_streak = calculate_longest_streak(&dates).max(current_streak);

    Ok(ReadingStreak {
        current_streak,
        longest_streak,
        read_today,
        last_reading_date,
    })
}

/// Helper to calculate the longest streak from a list of dates
fn calculate_longest_streak(dates: &[String]) -> i64 {
    if dates.is_empty() {
        return 0;
    }

    // Convert to NaiveDates and sort ascending
    let mut parsed_dates: Vec<NaiveDate> = dates
        .iter()
        .filter_map(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .collect();
    parsed_dates.sort();
    parsed_dates.dedup();

    if parsed_dates.is_empty() {
        return 0;
    }

    let mut longest = 1i64;
    let mut current = 1i64;

    for window in parsed_dates.windows(2) {
        let diff = (window[1] - window[0]).num_days();
        if diff == 1 {
            current += 1;
            longest = longest.max(current);
        } else {
            current = 1;
        }
    }

    longest
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictionary::schema::init_database;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn).unwrap();

        // Create a test shelf
        conn.execute(
            "INSERT INTO shelves (name) VALUES ('Test Shelf')",
            [],
        )
        .unwrap();

        // Create a test text
        conn.execute(
            "INSERT INTO texts (shelf_id, title, content, character_count) VALUES (1, 'Test', '??????', 100)",
            [],
        )
        .unwrap();

        conn
    }

    #[test]
    fn test_start_reading_session() {
        let conn = setup_test_db();

        let session = start_reading_session(&conn, 1).unwrap();

        assert_eq!(session.text_id, 1);
        assert_eq!(session.character_count, 100);
        assert!(session.is_first_read);
        assert!(!session.is_complete);
        assert!(session.finished_at.is_none());
    }

    #[test]
    fn test_cannot_start_duplicate_session() {
        let conn = setup_test_db();

        start_reading_session(&conn, 1).unwrap();
        let result = start_reading_session(&conn, 1);

        assert!(matches!(result, Err(LibraryError::ActiveSessionExists(1))));
    }

    #[test]
    fn test_finish_reading_session() {
        let conn = setup_test_db();

        let session = start_reading_session(&conn, 1).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));
        let finished = finish_reading_session(&conn, session.id).unwrap();

        assert!(finished.is_complete);
        assert!(finished.finished_at.is_some());
        assert!(finished.duration_seconds.is_some());
        assert!(finished.characters_per_minute.is_some());
    }

    #[test]
    fn test_discard_session() {
        let conn = setup_test_db();

        let session = start_reading_session(&conn, 1).unwrap();
        discard_reading_session(&conn, session.id).unwrap();

        let active = get_active_session(&conn, 1).unwrap();
        assert!(active.is_none());
    }

    #[test]
    fn test_delete_completed_session() {
        let conn = setup_test_db();

        // Create and complete a session
        let session = start_reading_session(&conn, 1).unwrap();
        finish_reading_session(&conn, session.id).unwrap();

        // Verify it exists in history
        let history = get_text_reading_history(&conn, 1).unwrap();
        assert_eq!(history.len(), 1);

        // Delete it
        delete_reading_session(&conn, session.id).unwrap();

        // Verify it's gone
        let history = get_text_reading_history(&conn, 1).unwrap();
        assert_eq!(history.len(), 0);
    }

    #[test]
    fn test_second_read_not_first() {
        let conn = setup_test_db();

        // First session
        let session1 = start_reading_session(&conn, 1).unwrap();
        finish_reading_session(&conn, session1.id).unwrap();

        // Second session
        let session2 = start_reading_session(&conn, 1).unwrap();

        assert!(session1.is_first_read);
        assert!(!session2.is_first_read);
    }

    #[test]
    fn test_get_speed_stats_empty() {
        let conn = setup_test_db();

        let stats = get_speed_stats(&conn, None).unwrap();

        assert_eq!(stats.total_sessions, 0);
        assert_eq!(stats.total_characters_read, 0);
    }

    #[test]
    fn test_log_offline_read_proportional_duration() {
        use crate::dictionary::schema::init_database;
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn).unwrap();

        conn.execute("INSERT INTO shelves (id, name, sort_order) VALUES (1, 'S', 0)", []).unwrap();
        // Text A: 1000 chars, Text B: 2000 chars → total 3000
        conn.execute("INSERT INTO texts (id, shelf_id, title, content, character_count) VALUES (1, 1, 'A', 'x', 1000)", []).unwrap();
        conn.execute("INSERT INTO texts (id, shelf_id, title, content, character_count) VALUES (2, 1, 'B', 'x', 2000)", []).unwrap();

        let finished_at = "2026-04-25T21:00:00Z".to_string();
        let input = ManualLogInput {
            text_ids: vec![1, 2],
            finished_at: finished_at.clone(),
            total_duration_seconds: 3000, // 50 minutes
            source: Some("physical_book".to_string()),
        };

        let sessions = log_offline_read(&conn, input).unwrap();
        assert_eq!(sessions.len(), 2);

        // Text A (1000 chars / 3000 total) → 1000s duration
        let a = sessions.iter().find(|s| s.text_id == 1).unwrap();
        assert_eq!(a.duration_seconds, Some(1000));
        assert!(a.characters_per_minute.is_some());
        // 1000 chars / (1000s / 60) = 60 cpm
        assert!((a.characters_per_minute.unwrap() - 60.0).abs() < 0.1);
        assert_eq!(a.is_manual_log, true);
        assert_eq!(a.is_complete, true);
        assert_eq!(a.source, Some("physical_book".to_string()));

        // Text B (2000 chars / 3000 total) → 2000s duration
        let b = sessions.iter().find(|s| s.text_id == 2).unwrap();
        assert_eq!(b.duration_seconds, Some(2000));
    }

    #[test]
    fn test_log_offline_read_sets_is_first_read() {
        use crate::dictionary::schema::init_database;
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn).unwrap();

        conn.execute("INSERT INTO shelves (id, name, sort_order) VALUES (1, 'S', 0)", []).unwrap();
        conn.execute("INSERT INTO texts (id, shelf_id, title, content, character_count) VALUES (1, 1, 'A', 'x', 500)", []).unwrap();
        // Pre-existing completed session on text 1
        conn.execute(
            "INSERT INTO reading_sessions (text_id, started_at, character_count, is_complete)
             VALUES (1, '2026-01-01T00:00:00Z', 500, 1)",
            [],
        ).unwrap();

        let input = ManualLogInput {
            text_ids: vec![1],
            finished_at: "2026-04-25T21:00:00Z".to_string(),
            total_duration_seconds: 600,
            source: None,
        };
        let sessions = log_offline_read(&conn, input).unwrap();
        // Not first read because prior completed session exists
        assert_eq!(sessions[0].is_first_read, false);
    }
}
