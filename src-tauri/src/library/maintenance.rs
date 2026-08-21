//! Durable state for deferred shelf-analysis maintenance.

use chrono::{DateTime, Utc};
use rusqlite::{params, params_from_iter, types::Type, Connection, Transaction};
use std::path::Path;
use std::time::Instant;

use crate::dictionary;
use crate::library::analysis::{
    compute_shelf_analysis, load_user_segmentation_words, publish_shelf_analysis,
};
use crate::library::models::{MaintenanceJobFailure, MaintenanceRunReport};
use crate::library::Result;

const TASK: &str = "shelf_analysis";

/// The durable state of the singleton shelf-analysis maintenance task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaintenanceSnapshot {
    pub dirty_at: Option<DateTime<Utc>>,
    pub last_started_at: Option<DateTime<Utc>>,
    pub last_completed_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
}

/// Marks the task and supplied shelf jobs dirty, retaining the earliest dirty time.
pub fn mark_analysis_dirty(conn: &Connection, shelf_ids: &[i64], at: DateTime<Utc>) -> Result<()> {
    if shelf_ids.is_empty() {
        return Ok(());
    }

    let tx = conn.unchecked_transaction()?;
    mark_analysis_dirty_in_transaction(&tx, shelf_ids, at)?;
    tx.commit()?;
    Ok(())
}

/// Marks analysis dirty as part of an existing domain-mutation transaction.
pub fn mark_analysis_dirty_in_transaction(
    tx: &Transaction<'_>,
    shelf_ids: &[i64],
    at: DateTime<Utc>,
) -> Result<()> {
    if shelf_ids.is_empty() {
        return Ok(());
    }

    let at = at.to_rfc3339();
    update_task_dirty(tx, &at)?;
    for shelf_id in shelf_ids {
        tx.execute(
            "INSERT INTO analysis_shelf_jobs (shelf_id, dirty_at, requested_at)
             VALUES (?1, ?2, ?2)
             ON CONFLICT(shelf_id) DO UPDATE SET
                 dirty_at = CASE
                     WHEN analysis_shelf_jobs.dirty_at IS NULL
                       OR excluded.dirty_at < analysis_shelf_jobs.dirty_at
                       OR (
                           analysis_shelf_jobs.dirty_at <= (
                               SELECT last_started_at
                               FROM analysis_maintenance
                               WHERE task = 'shelf_analysis'
                           )
                           AND excluded.dirty_at > (
                               SELECT last_started_at
                               FROM analysis_maintenance
                               WHERE task = 'shelf_analysis'
                           )
                       )
                     THEN excluded.dirty_at
                     ELSE analysis_shelf_jobs.dirty_at
                 END",
            params![shelf_id, at],
        )?;
    }

    Ok(())
}

/// Returns the supplied shelves and their ancestors that already have cached or
/// explicitly requested shelf analysis state.
pub fn cached_or_requested_ancestor_ids(conn: &Connection, shelf_ids: &[i64]) -> Result<Vec<i64>> {
    if shelf_ids.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders = shelf_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "WITH RECURSIVE ancestors(id) AS (
             SELECT id FROM shelves WHERE id IN ({placeholders})
             UNION
             SELECT shelves.parent_id
             FROM shelves
             JOIN ancestors ON shelves.id = ancestors.id
             WHERE shelves.parent_id IS NOT NULL
         )
         SELECT id FROM ancestors
         WHERE EXISTS (
             SELECT 1 FROM shelf_analyses_cache WHERE shelf_id = ancestors.id
         ) OR EXISTS (
             SELECT 1 FROM analysis_shelf_jobs WHERE shelf_id = ancestors.id
         )
         ORDER BY id"
    );
    let mut statement = conn.prepare(&sql)?;
    let shelf_ids = statement
        .query_map(params_from_iter(shelf_ids.iter()), |row| row.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(shelf_ids)
}

/// Registers a shelf analysis request and schedules it for deferred maintenance.
pub fn request_shelf_analysis(conn: &Connection, shelf_id: i64, at: DateTime<Utc>) -> Result<()> {
    let at = at.to_rfc3339();
    let tx = conn.unchecked_transaction()?;

    let changed = tx.execute(
        "INSERT INTO analysis_shelf_jobs (shelf_id, dirty_at, requested_at)
         SELECT ?1, ?2, ?2
         WHERE NOT EXISTS (
             SELECT 1 FROM shelf_analyses_cache WHERE shelf_id = ?1
         )
         ON CONFLICT(shelf_id) DO UPDATE SET
             requested_at = excluded.requested_at,
             dirty_at = excluded.dirty_at
         WHERE analysis_shelf_jobs.dirty_at IS NULL",
        params![shelf_id, at],
    )?;
    if changed > 0 {
        update_task_dirty(&tx, &at)?;
    }

    tx.commit()?;
    Ok(())
}

/// Reads the singleton shelf-analysis maintenance task state.
pub fn maintenance_snapshot(conn: &Connection) -> Result<MaintenanceSnapshot> {
    conn.query_row(
        "SELECT dirty_at, last_started_at, last_completed_at, last_error
         FROM analysis_maintenance WHERE task = ?1",
        [TASK],
        |row| {
            Ok(MaintenanceSnapshot {
                dirty_at: parse_timestamp(row.get(0)?, 0)?,
                last_started_at: parse_timestamp(row.get(1)?, 1)?,
                last_completed_at: parse_timestamp(row.get(2)?, 2)?,
                last_error: row.get(3)?,
            })
        },
    )
    .map_err(Into::into)
}

/// Selects jobs that were dirty by the fixed maintenance cutoff.
pub fn claim_due_jobs(conn: &Connection, cutoff: DateTime<Utc>) -> Result<Vec<i64>> {
    let cutoff = cutoff.to_rfc3339();
    let tx = conn.unchecked_transaction()?;
    let jobs = {
        let mut statement = tx.prepare(
            "SELECT shelf_id FROM analysis_shelf_jobs
             WHERE dirty_at IS NOT NULL AND dirty_at <= ?1
             ORDER BY shelf_id",
        )?;
        let jobs = statement
            .query_map([&cutoff], |row| row.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        jobs
    };

    tx.execute(
        "UPDATE analysis_maintenance
         SET last_started_at = ?1
         WHERE task = ?2 AND dirty_at IS NOT NULL AND dirty_at <= ?1",
        params![cutoff, TASK],
    )?;
    tx.commit()?;
    Ok(jobs)
}

/// Records successful completion, clearing only dirtiness observed by the cutoff.
pub fn complete_shelf_job(conn: &Connection, shelf_id: i64, cutoff: DateTime<Utc>) -> Result<()> {
    let cutoff = cutoff.to_rfc3339();
    let tx = conn.unchecked_transaction()?;

    tx.execute(
        "UPDATE analysis_shelf_jobs
         SET dirty_at = CASE WHEN dirty_at <= ?1 THEN NULL ELSE dirty_at END,
             last_completed_at = ?1,
             last_error = NULL
         WHERE shelf_id = ?2",
        params![cutoff, shelf_id],
    )?;
    complete_task_if_no_due_jobs(&tx, &cutoff)?;

    tx.commit()?;
    Ok(())
}

/// Records a failed job without discarding its dirty state.
pub fn fail_shelf_job(conn: &Connection, shelf_id: i64, error: &str) -> Result<()> {
    let tx = conn.unchecked_transaction()?;

    tx.execute(
        "UPDATE analysis_shelf_jobs SET last_error = ?1 WHERE shelf_id = ?2",
        params![error, shelf_id],
    )?;
    tx.execute(
        "UPDATE analysis_maintenance SET last_error = ?1 WHERE task = ?2",
        params![error, TASK],
    )?;

    tx.commit()?;
    Ok(())
}

/// Run all shelf-analysis jobs dirty at or before a fixed cutoff.
///
/// The connection is dedicated to maintenance, computation is sequential, and
/// each cache publication is a separate short transaction.
pub fn run_due_analysis_maintenance(db_path: &Path, cutoff: DateTime<Utc>) -> MaintenanceRunReport {
    let mut report = MaintenanceRunReport {
        cutoff,
        claimed: 0,
        succeeded: 0,
        failed: 0,
        failures: Vec::new(),
        fatal_error: None,
        still_dirty: false,
    };

    let mut conn = match dictionary::init_connection(db_path) {
        Ok(conn) => conn,
        Err(error) => {
            report.fatal_error = Some(error.to_string());
            return report;
        }
    };
    if let Err(error) = conn.execute_batch(
        "PRAGMA foreign_keys=ON;
         PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA busy_timeout=30000;",
    ) {
        report.fatal_error = Some(error.to_string());
        return report;
    }
    if let Err(error) = load_user_segmentation_words(&conn) {
        report.fatal_error = Some(error.to_string());
        return report;
    }
    let jobs = match claim_due_jobs(&conn, cutoff) {
        Ok(jobs) => jobs,
        Err(error) => {
            report.fatal_error = Some(error.to_string());
            return report;
        }
    };
    report.claimed = jobs.len();

    for shelf_id in jobs {
        let job_started = Instant::now();
        let result = compute_shelf_analysis(&conn, shelf_id).and_then(|analysis| {
            let output_bytes = publish_shelf_analysis(&mut conn, shelf_id, &analysis, cutoff)?;
            complete_shelf_job(&conn, shelf_id, cutoff)?;
            Ok(output_bytes)
        });

        match result {
            Ok(output_bytes) => {
                report.succeeded += 1;
                eprintln!(
                    "analysis_maintenance_job cutoff={} shelf_id={} duration_ms={} output_bytes={} success=true",
                    cutoff,
                    shelf_id,
                    job_started.elapsed().as_millis(),
                    output_bytes
                );
            }
            Err(error) => {
                let error = error.to_string();
                report.failed += 1;
                eprintln!(
                    "analysis_maintenance_job cutoff={} shelf_id={} duration_ms={} output_bytes=0 success=false",
                    cutoff,
                    shelf_id,
                    job_started.elapsed().as_millis()
                );
                report.failures.push(MaintenanceJobFailure {
                    shelf_id,
                    error: error.clone(),
                });
                if let Err(record_error) = fail_shelf_job(&conn, shelf_id, &error) {
                    report.fatal_error = Some(format!(
                        "failed to record shelf {shelf_id} maintenance error: {record_error}"
                    ));
                }
            }
        }
    }

    match maintenance_snapshot(&conn) {
        Ok(snapshot) => report.still_dirty = snapshot.dirty_at.is_some(),
        Err(error) => report.fatal_error = Some(error.to_string()),
    }
    report
}

fn update_task_dirty(conn: &Connection, at: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE analysis_maintenance
         SET dirty_at = CASE
             WHEN dirty_at IS NULL
               OR ?1 < dirty_at
               OR (dirty_at <= last_started_at AND ?1 > last_started_at)
             THEN ?1
             ELSE dirty_at
         END
         WHERE task = ?2",
        params![at, TASK],
    )?;
    Ok(())
}

fn complete_task_if_no_due_jobs(
    tx: &rusqlite::Transaction<'_>,
    cutoff: &str,
) -> rusqlite::Result<()> {
    let due_job_exists: bool = tx.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM analysis_shelf_jobs
            WHERE dirty_at IS NOT NULL AND dirty_at <= ?1
        )",
        [cutoff],
        |row| row.get(0),
    )?;

    if !due_job_exists {
        tx.execute(
            "UPDATE analysis_maintenance
             SET dirty_at = CASE WHEN dirty_at <= ?1 THEN NULL ELSE dirty_at END,
                 last_completed_at = CASE
                     WHEN dirty_at <= ?1 THEN ?1
                     ELSE last_completed_at
                 END,
                 last_error = CASE WHEN dirty_at <= ?1 THEN NULL ELSE last_error END
             WHERE task = ?2",
            params![cutoff, TASK],
        )?;
    }

    Ok(())
}

fn parse_timestamp(
    value: Option<String>,
    column: usize,
) -> rusqlite::Result<Option<DateTime<Utc>>> {
    value
        .map(|value| {
            DateTime::parse_from_rfc3339(&value)
                .map(|timestamp| timestamp.with_timezone(&Utc))
                .map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(column, Type::Text, Box::new(error))
                })
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictionary;
    use crate::library::analysis::{
        auto_mark_text_as_known, get_shelf_analysis_status, reanalyze_text,
    };
    use crate::library::models::{ShelfAnalysis, ShelfAnalysisStatus};
    use crate::library::{known_words, shelf, speed, text};
    use rusqlite::Connection;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_DB: AtomicU64 = AtomicU64::new(0);

    fn utc(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn setup_test_db() -> Connection {
        let conn = dictionary::init_memory_connection().unwrap();
        for shelf_id in 1..=10 {
            conn.execute(
                "INSERT INTO shelves (id, name) VALUES (?1, ?2)",
                params![shelf_id, format!("Shelf {shelf_id}")],
            )
            .unwrap();
        }
        conn
    }

    fn setup_mutation_test_db() -> Connection {
        let conn = dictionary::init_memory_connection().unwrap();
        conn.execute_batch(
            "INSERT INTO shelves (id, name, parent_id) VALUES (1, 'Old root', NULL);
             INSERT INTO shelves (id, name, parent_id) VALUES (2, 'Old parent', 1);
             INSERT INTO shelves (id, name, parent_id) VALUES (3, 'Old leaf', 2);
             INSERT INTO shelves (id, name, parent_id) VALUES (4, 'Unrelated cached', NULL);
             INSERT INTO shelves (id, name, parent_id) VALUES (5, 'New root', NULL);
             INSERT INTO shelves (id, name, parent_id) VALUES (6, 'New leaf', 5);
             INSERT INTO shelves (id, name, parent_id) VALUES (7, 'Unrelated uncached', NULL);
             INSERT INTO texts (id, shelf_id, title, content, character_count)
             VALUES (11, 3, 'Original', '中文內容', 4);
             INSERT INTO shelf_analyses_cache (shelf_id, data, cached_at)
             VALUES (1, 'old-root', '2026-08-19T00:00:00Z');
             INSERT INTO shelf_analyses_cache (shelf_id, data, cached_at)
             VALUES (4, 'old-unrelated', '2026-08-19T00:00:00Z');
             INSERT INTO shelf_analyses_cache (shelf_id, data, cached_at)
             VALUES (5, 'old-new-root', '2026-08-19T00:00:00Z');
             INSERT INTO analysis_shelf_jobs (shelf_id, dirty_at, requested_at)
             VALUES (2, NULL, '2026-08-19T00:00:00Z');",
        )
        .unwrap();
        conn
    }

    fn job_ids(conn: &Connection, only_dirty: bool) -> Vec<i64> {
        let sql = if only_dirty {
            "SELECT shelf_id FROM analysis_shelf_jobs WHERE dirty_at IS NOT NULL ORDER BY shelf_id"
        } else {
            "SELECT shelf_id FROM analysis_shelf_jobs ORDER BY shelf_id"
        };
        let mut statement = conn.prepare(sql).unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    fn cached_rows(conn: &Connection) -> Vec<(i64, String)> {
        let mut statement = conn
            .prepare("SELECT shelf_id, data FROM shelf_analyses_cache ORDER BY shelf_id")
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    fn install_dirty_marker_failure(conn: &Connection) {
        conn.execute_batch(
            "CREATE TRIGGER fail_analysis_job_insert
             BEFORE INSERT ON analysis_shelf_jobs
             BEGIN
                 SELECT RAISE(FAIL, 'forced dirty marker failure');
             END;
             CREATE TRIGGER fail_analysis_job_update
             BEFORE UPDATE ON analysis_shelf_jobs
             BEGIN
                 SELECT RAISE(FAIL, 'forced dirty marker failure');
             END;",
        )
        .unwrap();
    }

    fn install_dirty_generation_counter(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE dirty_generation_updates (id INTEGER PRIMARY KEY);
             CREATE TRIGGER count_dirty_generation_update
             AFTER UPDATE ON analysis_maintenance
             BEGIN
                 INSERT INTO dirty_generation_updates (id) VALUES (NULL);
             END;",
        )
        .unwrap();
    }

    #[derive(Clone, Copy, Debug)]
    enum AtomicMutationCase {
        CreateText,
        FinishSession,
        ChangeKnownWord,
        MoveShelf,
        ReanalyzeText,
    }

    #[test]
    fn marks_analysis_dirty_atomically_with_domain_mutations() {
        for case in [
            AtomicMutationCase::CreateText,
            AtomicMutationCase::FinishSession,
            AtomicMutationCase::ChangeKnownWord,
            AtomicMutationCase::MoveShelf,
            AtomicMutationCase::ReanalyzeText,
        ] {
            let conn = setup_mutation_test_db();
            let session_id = if matches!(case, AtomicMutationCase::FinishSession) {
                Some(speed::start_reading_session(&conn, 11).unwrap().id)
            } else {
                None
            };
            if matches!(case, AtomicMutationCase::ChangeKnownWord) {
                conn.execute(
                    "INSERT INTO known_words (word, word_type, status)
                     VALUES ('中', 'character', 'learning')",
                    [],
                )
                .unwrap();
            }
            install_dirty_marker_failure(&conn);

            let failed = match case {
                AtomicMutationCase::CreateText => {
                    text::create_text(&conn, 3, "Rolled back", "新內容", None, "paste")
                        .is_err()
                }
                AtomicMutationCase::FinishSession => {
                    speed::finish_reading_session(&conn, session_id.unwrap()).is_err()
                }
                AtomicMutationCase::ChangeKnownWord => {
                    known_words::update_word_status(&conn, "中", "known").is_err()
                }
                AtomicMutationCase::MoveShelf => shelf::move_shelf(&conn, 3, Some(5)).is_err(),
                AtomicMutationCase::ReanalyzeText => reanalyze_text(&conn, 11).is_err(),
            };
            assert!(failed, "{case:?}");

            let text_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM texts", [], |row| row.get(0))
                .unwrap();
            assert_eq!(text_count, 1, "{case:?}");
            let analysis_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM text_analyses", [], |row| row.get(0))
                .unwrap();
            assert_eq!(analysis_count, 0, "{case:?}");
            if let Some(session_id) = session_id {
                let is_complete: i64 = conn
                    .query_row(
                        "SELECT is_complete FROM reading_sessions WHERE id = ?",
                        [session_id],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(is_complete, 0, "{case:?}");
            }
            if matches!(case, AtomicMutationCase::ChangeKnownWord) {
                assert_eq!(
                    known_words::get_word_status(&conn, "中").unwrap().as_deref(),
                    Some("learning"),
                    "{case:?}"
                );
            }
            let parent_id: Option<i64> = conn
                .query_row("SELECT parent_id FROM shelves WHERE id = 3", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(parent_id, Some(2), "{case:?}");
            assert!(job_ids(&conn, true).is_empty(), "{case:?}");
            assert_eq!(maintenance_snapshot(&conn).unwrap().dirty_at, None, "{case:?}");
        }
    }

    #[derive(Clone, Copy, Debug)]
    enum VocabularyBatchCase {
        Import,
        AutoMark,
    }

    #[test]
    fn marks_analysis_dirty_once_for_vocabulary_batch() {
        for case in [VocabularyBatchCase::Import, VocabularyBatchCase::AutoMark] {
            let conn = setup_mutation_test_db();
            install_dirty_generation_counter(&conn);

            let changed_terms = match case {
                VocabularyBatchCase::Import => {
                    let stats = known_words::import_known_words(&conn, "中\n文\n學\n", "character")
                        .unwrap();
                    assert_eq!(stats.words_added, 3);
                    stats.words_added as i64
                }
                VocabularyBatchCase::AutoMark => {
                    let stats = auto_mark_text_as_known(&conn, 11).unwrap();
                    stats.characters_marked + stats.words_marked
                }
            };

            assert!(changed_terms > 1, "{case:?}");
            let generation_updates: i64 = conn
                .query_row("SELECT COUNT(*) FROM dirty_generation_updates", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(generation_updates, 1, "{case:?}");
            let known_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM known_words", [], |row| row.get(0))
                .unwrap();
            assert_eq!(known_count, changed_terms, "{case:?}");
            assert_eq!(job_ids(&conn, true), vec![1, 2, 4, 5], "{case:?}");
            assert_eq!(cached_rows(&conn).len(), 3, "{case:?}");
        }
    }

    #[derive(Clone, Copy, Debug)]
    enum MutationCase {
        FinishSession,
        UploadSession,
        ManualSession,
        DeleteSession,
        ChangeKnownWord,
        AutoMarkKnownWords,
        CreateText,
        DeleteText,
        MoveText,
        MoveShelf,
        DeleteShelf,
    }

    #[test]
    fn marks_analysis_dirty_for_relevant_mutations() {
        let local_cases = [
            MutationCase::FinishSession,
            MutationCase::UploadSession,
            MutationCase::ManualSession,
            MutationCase::DeleteSession,
            MutationCase::CreateText,
            MutationCase::DeleteText,
            MutationCase::DeleteShelf,
        ];
        for case in local_cases {
            let conn = setup_mutation_test_db();
            match case {
                MutationCase::FinishSession => {
                    let session = speed::start_reading_session(&conn, 11).unwrap();
                    speed::finish_reading_session(&conn, session.id).unwrap();
                }
                MutationCase::UploadSession => {
                    speed::upload_completed_session(
                        &conn,
                        &speed::UploadSession {
                            local_id: "offline-1".into(),
                            text_id: 11,
                            started_at_ms: 1_756_000_000_000,
                            finished_at_ms: 1_756_000_060_000,
                        },
                    )
                    .unwrap();
                }
                MutationCase::ManualSession => {
                    speed::log_offline_read(
                        &conn,
                        speed::ManualLogInput {
                            text_ids: vec![11],
                            finished_at: "2026-08-20T12:00:00Z".into(),
                            total_duration_seconds: 60,
                            source: Some("physical_book".into()),
                        },
                    )
                    .unwrap();
                }
                MutationCase::DeleteSession => {
                    conn.execute(
                        "INSERT INTO reading_sessions
                         (text_id, started_at, finished_at, character_count, is_complete)
                         VALUES (11, '2026-08-20T10:00:00Z', '2026-08-20T10:01:00Z', 4, 1)",
                        [],
                    )
                    .unwrap();
                    let session_id = conn.last_insert_rowid();
                    speed::delete_reading_session(&conn, session_id).unwrap();
                }
                MutationCase::CreateText => {
                    text::create_text(&conn, 3, "Created", "新內容", None, "paste").unwrap();
                }
                MutationCase::DeleteText => text::delete_text(&conn, 11).unwrap(),
                MutationCase::DeleteShelf => shelf::delete_shelf(&conn, 3).unwrap(),
                _ => unreachable!(),
            }

            assert_eq!(job_ids(&conn, true), vec![1, 2], "{case:?}");
            assert_eq!(job_ids(&conn, false), vec![1, 2], "{case:?}");
            assert_eq!(
                cached_rows(&conn),
                vec![
                    (1, "old-root".into()),
                    (4, "old-unrelated".into()),
                    (5, "old-new-root".into()),
                ],
                "{case:?}"
            );
        }

        for case in [MutationCase::MoveText, MutationCase::MoveShelf] {
            let conn = setup_mutation_test_db();
            match case {
                MutationCase::MoveText => text::move_text(&conn, 11, 6).unwrap(),
                MutationCase::MoveShelf => shelf::move_shelf(&conn, 3, Some(5)).unwrap(),
                _ => unreachable!(),
            }

            assert_eq!(job_ids(&conn, true), vec![1, 2, 5], "{case:?}");
            assert_eq!(job_ids(&conn, false), vec![1, 2, 5], "{case:?}");
            assert_eq!(cached_rows(&conn).len(), 3, "{case:?}");
        }

        for case in [
            MutationCase::ChangeKnownWord,
            MutationCase::AutoMarkKnownWords,
        ] {
            let conn = setup_mutation_test_db();
            match case {
                MutationCase::ChangeKnownWord => {
                    conn.execute(
                        "INSERT INTO known_words (word, word_type, status) VALUES ('中', 'character', 'learning')",
                        [],
                    )
                    .unwrap();
                    known_words::update_word_status(&conn, "中", "known").unwrap();
                }
                MutationCase::AutoMarkKnownWords => {
                    auto_mark_text_as_known(&conn, 11).unwrap();
                }
                _ => unreachable!(),
            }

            assert_eq!(job_ids(&conn, true), vec![1, 2, 4, 5], "{case:?}");
            assert_eq!(job_ids(&conn, false), vec![1, 2, 4, 5], "{case:?}");
            assert_eq!(
                cached_rows(&conn),
                vec![
                    (1, "old-root".into()),
                    (4, "old-unrelated".into()),
                    (5, "old-new-root".into()),
                ],
                "{case:?}"
            );
        }
    }

    fn temporary_db_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "chinese-reader-maintenance-{}-{}.sqlite3",
            std::process::id(),
            NEXT_TEST_DB.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn empty_analysis(shelf_id: i64) -> ShelfAnalysis {
        ShelfAnalysis {
            shelf_id,
            text_count: 0,
            total_characters: 0,
            unique_characters: 0,
            known_characters_count: 0,
            total_words: 0,
            unique_words: 0,
            known_words_count: 0,
            unknown_characters: vec![],
            known_characters: vec![],
            unknown_words: vec![],
            known_words: vec![],
        }
    }

    #[test]
    fn shelf_analysis_status_failed_rebuild_preserves_old_json_while_later_jobs_continue() {
        let path = temporary_db_path();
        let conn = dictionary::init_connection(&path).unwrap();
        conn.execute("INSERT INTO shelves (id, name) VALUES (4, 'Shelf 4')", [])
            .unwrap();
        conn.execute("INSERT INTO shelves (id, name) VALUES (5, 'Shelf 5')", [])
            .unwrap();
        let old_json = serde_json::to_string(&empty_analysis(4)).unwrap();
        conn.execute(
            "INSERT INTO shelf_analyses_cache (shelf_id, data, cached_at)
             VALUES (4, ?1, '2026-08-19 00:05:00')",
            [&old_json],
        )
        .unwrap();
        mark_analysis_dirty(&conn, &[4, 5], utc("2026-08-20T01:00:00Z")).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER force_shelf_cache_publish_failure
             BEFORE UPDATE OF data ON shelf_analyses_cache
             WHEN OLD.shelf_id = 4
             BEGIN
                 SELECT RAISE(FAIL, 'forced publish failure');
             END;",
        )
        .unwrap();
        drop(conn);

        let report = run_due_analysis_maintenance(&path, utc("2026-08-20T05:05:00Z"));

        assert_eq!(report.succeeded, 1);
        assert_eq!(report.failed, 1);
        assert!(report.fatal_error.is_none());
        let conn = Connection::open(&path).unwrap();
        let preserved_json: String = conn
            .query_row(
                "SELECT data FROM shelf_analyses_cache WHERE shelf_id = 4",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(preserved_json, old_json);
        let dirty_at: Option<String> = conn
            .query_row(
                "SELECT dirty_at FROM analysis_shelf_jobs WHERE shelf_id = 4",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(dirty_at.is_some());
        let status = get_shelf_analysis_status(&conn, 4, utc("2026-08-20T06:00:00Z")).unwrap();
        assert!(matches!(
            status,
            ShelfAnalysisStatus::Ready {
                is_stale: true,
                last_error: Some(error),
                ..
            } if error.contains("forced publish failure")
        ));
        let later_job_dirty_at: Option<String> = conn
            .query_row(
                "SELECT dirty_at FROM analysis_shelf_jobs WHERE shelf_id = 5",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(later_job_dirty_at.is_none());
        let later_cache_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM shelf_analyses_cache WHERE shelf_id = 5",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(later_cache_count, 1);
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn empty_dirty_shelf_ids_leave_maintenance_clean() {
        let conn = setup_test_db();

        mark_analysis_dirty(&conn, &[], utc("2026-08-20T05:05:00Z")).unwrap();

        let snapshot = maintenance_snapshot(&conn).unwrap();
        assert_eq!(snapshot.dirty_at, None);
        assert!(claim_due_jobs(&conn, utc("2026-08-20T05:05:00Z"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn migration_creates_maintenance_tables_and_singleton_idempotently() {
        let conn = setup_test_db();
        crate::dictionary::schema::init_database(&conn).unwrap();

        let task_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM analysis_maintenance WHERE task = 'shelf_analysis'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let job_table: String = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'analysis_shelf_jobs'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(task_count, 1);
        assert_eq!(job_table, "analysis_shelf_jobs");
    }

    #[test]
    fn dirtying_preserves_an_earlier_timestamp() {
        let conn = setup_test_db();
        mark_analysis_dirty(&conn, &[7], utc("2026-08-20T04:00:00Z")).unwrap();
        mark_analysis_dirty(&conn, &[7], utc("2026-08-20T05:05:00Z")).unwrap();

        let snapshot = maintenance_snapshot(&conn).unwrap();
        assert_eq!(snapshot.dirty_at, Some(utc("2026-08-20T04:00:00Z")));
        let job_dirty_at: String = conn
            .query_row(
                "SELECT dirty_at FROM analysis_shelf_jobs WHERE shelf_id = 7",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(job_dirty_at, "2026-08-20T04:00:00+00:00");
    }

    #[test]
    fn requesting_an_uncached_shelf_registers_a_dirty_job() {
        let conn = setup_test_db();
        request_shelf_analysis(&conn, 7, utc("2026-08-20T05:05:00Z")).unwrap();

        let (requested_at, dirty_at): (String, String) = conn
            .query_row(
                "SELECT requested_at, dirty_at FROM analysis_shelf_jobs WHERE shelf_id = 7",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(requested_at, "2026-08-20T05:05:00+00:00");
        assert_eq!(dirty_at, "2026-08-20T05:05:00+00:00");
        assert_eq!(
            maintenance_snapshot(&conn).unwrap().dirty_at,
            Some(utc("2026-08-20T05:05:00Z"))
        );
    }

    #[test]
    fn polling_claimed_missing_job_does_not_create_post_cutoff_dirtiness() {
        let conn = setup_test_db();
        request_shelf_analysis(&conn, 7, utc("2026-08-20T01:00:00Z")).unwrap();
        assert_eq!(
            claim_due_jobs(&conn, utc("2026-08-20T05:05:00Z")).unwrap(),
            vec![7]
        );

        request_shelf_analysis(&conn, 7, utc("2026-08-20T06:00:00Z")).unwrap();

        let (requested_at, dirty_at): (String, String) = conn
            .query_row(
                "SELECT requested_at, dirty_at FROM analysis_shelf_jobs WHERE shelf_id = 7",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(requested_at, "2026-08-20T01:00:00+00:00");
        assert_eq!(dirty_at, "2026-08-20T01:00:00+00:00");

        complete_shelf_job(&conn, 7, utc("2026-08-20T05:05:00Z")).unwrap();
        let remaining_dirty_at: Option<String> = conn
            .query_row(
                "SELECT dirty_at FROM analysis_shelf_jobs WHERE shelf_id = 7",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(remaining_dirty_at.is_none());
    }

    #[test]
    fn request_after_publication_does_not_redirty_completed_job() {
        let conn = setup_test_db();
        request_shelf_analysis(&conn, 7, utc("2026-08-20T01:00:00Z")).unwrap();
        assert_eq!(
            claim_due_jobs(&conn, utc("2026-08-20T05:05:00Z")).unwrap(),
            vec![7]
        );
        conn.execute(
            "INSERT INTO shelf_analyses_cache (shelf_id, data, cached_at)
             VALUES (7, ?1, '2026-08-20T05:05:00+00:00')",
            [serde_json::to_string(&empty_analysis(7)).unwrap()],
        )
        .unwrap();
        complete_shelf_job(&conn, 7, utc("2026-08-20T05:05:00Z")).unwrap();

        request_shelf_analysis(&conn, 7, utc("2026-08-20T06:00:00Z")).unwrap();

        let dirty_at: Option<String> = conn
            .query_row(
                "SELECT dirty_at FROM analysis_shelf_jobs WHERE shelf_id = 7",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(dirty_at.is_none());
        assert!(maintenance_snapshot(&conn).unwrap().dirty_at.is_none());
    }

    #[test]
    fn claiming_jobs_selects_only_dirty_rows_at_or_before_cutoff() {
        let conn = setup_test_db();
        mark_analysis_dirty(&conn, &[7], utc("2026-08-20T04:00:00Z")).unwrap();
        mark_analysis_dirty(&conn, &[8], utc("2026-08-20T06:00:00Z")).unwrap();

        assert_eq!(
            claim_due_jobs(&conn, utc("2026-08-20T05:05:00Z")).unwrap(),
            vec![7]
        );
    }

    #[test]
    fn mutations_after_cutoff_remain_dirty() {
        let conn = setup_test_db();
        mark_analysis_dirty(&conn, &[7], utc("2026-08-20T04:00:00Z")).unwrap();
        let jobs = claim_due_jobs(&conn, utc("2026-08-20T05:05:00Z")).unwrap();
        assert_eq!(jobs, vec![7]);
        mark_analysis_dirty(&conn, &[7], utc("2026-08-20T06:00:00Z")).unwrap();
        complete_shelf_job(&conn, 7, utc("2026-08-20T05:05:00Z")).unwrap();
        assert!(maintenance_snapshot(&conn).unwrap().dirty_at.is_some());
    }

    #[test]
    fn failures_are_recorded_without_clearing_dirty_state() {
        let conn = setup_test_db();
        mark_analysis_dirty(&conn, &[7], utc("2026-08-20T04:00:00Z")).unwrap();

        fail_shelf_job(&conn, 7, "rebuild failed").unwrap();

        let snapshot = maintenance_snapshot(&conn).unwrap();
        assert_eq!(snapshot.dirty_at, Some(utc("2026-08-20T04:00:00Z")));
        assert_eq!(snapshot.last_error.as_deref(), Some("rebuild failed"));
        let job_error: String = conn
            .query_row(
                "SELECT last_error FROM analysis_shelf_jobs WHERE shelf_id = 7",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(job_error, "rebuild failed");
    }
}
