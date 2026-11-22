//! Read-only reading facts for browser-side goal projections.

use std::collections::{BTreeSet, HashMap, HashSet};

use chrono::DateTime;
use rusqlite::{params, Connection};
use serde::Serialize;

use super::error::Result;

#[derive(Debug, Serialize)]
pub struct GoalText {
    pub id: i64,
    pub character_count: i64,
    pub first_completed_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GoalActivity {
    pub finished_at: String,
    pub duration_seconds: Option<i64>,
    pub character_count: i64,
    pub in_scope: bool,
}

#[derive(Debug, Default, Serialize)]
pub struct GoalReadingData {
    pub texts: Vec<GoalText>,
    pub activity: Vec<GoalActivity>,
    pub lifetime_characters: i64,
    pub recent_speeds: Vec<f64>,
    pub missing_shelf_ids: Vec<i64>,
}

/// Selected shelves form a recursive union. Activity and experience always cover
/// the whole library, including rereads; only actual first completions advance a goal.
pub fn get_goal_reading_data(conn: &Connection, shelf_ids: &[i64]) -> Result<GoalReadingData> {
    let roots: BTreeSet<_> = shelf_ids.iter().copied().collect();
    // A bound JSON array avoids interpolating IDs or SQLite's variable-count limit.
    let roots_json = serde_json::json!(roots).to_string();
    let mut missing_stmt = conn.prepare(
        "SELECT value FROM json_each(?1)
         WHERE NOT EXISTS (SELECT 1 FROM shelves WHERE id = value)
         ORDER BY value",
    )?;
    let missing_shelf_ids = missing_stmt
        .query_map(params![&roots_json], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<i64>>>()?;

    let mut texts_stmt = conn.prepare(
        "WITH RECURSIVE scope(id) AS (
            SELECT id FROM shelves WHERE id IN (SELECT value FROM json_each(?1))
            UNION
            SELECT child.id FROM shelves child JOIN scope ON child.parent_id = scope.id
         )
         SELECT id, MAX(character_count, 0) FROM texts
         WHERE shelf_id IN (SELECT id FROM scope) ORDER BY id",
    )?;
    let mut texts = texts_stmt
        .query_map(params![&roots_json], |row| {
            Ok(GoalText {
                id: row.get(0)?,
                character_count: row.get(1)?,
                first_completed_at: None,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let scoped_text_ids: HashSet<_> = texts.iter().map(|text| text.id).collect();

    let mut sessions_stmt = conn.prepare(
        "SELECT id, text_id, finished_at, character_count, duration_seconds,
                characters_per_minute FROM reading_sessions WHERE is_complete = 1",
    )?;
    let sessions = sessions_stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, i64>(3)?.max(0),
            row.get::<_, Option<i64>>(4)?.filter(|seconds| *seconds > 0),
            row.get::<_, Option<f64>>(5)?
                .filter(|speed| speed.is_finite() && *speed > 0.0),
        ))
    })?;
    let mut lifetime_characters = 0_i64;
    let mut dated_sessions = Vec::new();
    for session in sessions {
        let (id, text_id, finished_at, character_count, duration_seconds, speed) = session?;
        lifetime_characters = lifetime_characters.saturating_add(character_count);
        // Malformed dates cannot be placed on a calendar or used as speed baselines.
        // Their completed characters still contribute to lifetime experience.
        let Some(finished_at) = finished_at else {
            continue;
        };
        let Ok(instant) = DateTime::parse_from_rfc3339(&finished_at) else {
            continue;
        };
        dated_sessions.push((
            instant,
            id,
            text_id,
            finished_at,
            character_count,
            duration_seconds,
            speed,
        ));
    }
    // RFC3339 strings with different offsets cannot be sorted lexicographically.
    // Session ID breaks equal-instant ties so a text contributes exactly one sample.
    dated_sessions.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut first_completions = HashMap::new();
    for session in &dated_sessions {
        first_completions.entry(session.2).or_insert(session);
    }
    for text in &mut texts {
        text.first_completed_at = first_completions
            .get(&text.id)
            .map(|session| session.3.clone());
    }
    let recent_speeds = dated_sessions
        .iter()
        .rev()
        .filter(|session| first_completions[&session.2].1 == session.1)
        .filter_map(|session| session.6)
        .take(5)
        .collect();
    let activity = dated_sessions
        .into_iter()
        .map(
            |(_, _, text_id, finished_at, character_count, duration_seconds, _)| GoalActivity {
                finished_at,
                duration_seconds,
                character_count,
                in_scope: scoped_text_ids.contains(&text_id),
            },
        )
        .collect();
    Ok(GoalReadingData {
        texts,
        activity,
        lifetime_characters,
        recent_speeds,
        missing_shelf_ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictionary::init_memory_connection;
    use rusqlite::params;

    fn database() -> Connection {
        let conn = init_memory_connection().unwrap();
        conn.execute_batch(
            "INSERT INTO shelves (id, name, parent_id) VALUES
                (1, 'Root', NULL), (2, 'Child', 1), (3, 'Grandchild', 2),
                (4, 'Second root', NULL), (5, 'Outside', NULL);
             INSERT INTO texts (id, shelf_id, title, content, character_count) VALUES
                (10, 1, 'Root text', '', 100), (20, 2, 'Child text', '', 200),
                (30, 3, 'Grandchild text', '', 300), (40, 4, 'Second text', '', 400),
                (50, 5, 'Other text', '', 500);",
        )
        .unwrap();
        conn
    }

    fn session(
        conn: &Connection,
        text: i64,
        finished: Option<&str>,
        complete: bool,
        first: bool,
        count: i64,
        duration: Option<i64>,
        speed: Option<f64>,
    ) {
        conn.execute(
            "INSERT INTO reading_sessions (text_id, started_at, finished_at, is_complete,
                is_first_read, character_count, duration_seconds, characters_per_minute)
             VALUES (?, '2026-01-01T00:00:00Z', ?, ?, ?, ?, ?, ?)",
            params![text, finished, complete, first, count, duration, speed],
        )
        .unwrap();
    }

    // Catches summing overlapping descendants or treating selected IDs as SQL text.
    #[test]
    fn recursive_union_deduplicates_roots_and_reports_missing_shelves() {
        let conn = database();
        let data = get_goal_reading_data(&conn, &[1, 2, 4, 1, 999, 999]).unwrap();
        assert_eq!(
            data.texts.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![10, 20, 30, 40]
        );
        assert_eq!(
            data.texts.iter().map(|t| t.character_count).sum::<i64>(),
            1000
        );
        assert!(data.texts.iter().all(|t| t.first_completed_at.is_none()));
        assert_eq!(data.missing_shelf_ids, vec![999]);
    }

    // Catches falling back to all texts when no real roots were requested.
    #[test]
    fn empty_and_missing_scopes_still_return_global_reading_facts() {
        let conn = database();
        session(
            &conn,
            50,
            Some("2026-01-01T12:00:00Z"),
            true,
            true,
            500,
            None,
            None,
        );
        for roots in [vec![], vec![999]] {
            let data = get_goal_reading_data(&conn, &roots).unwrap();
            assert!(data.texts.is_empty());
            assert_eq!(data.lifetime_characters, 500);
            assert_eq!(data.activity.len(), 1);
            assert!(!data.activity[0].in_scope);
            assert!(data.recent_speeds.is_empty());
            assert_eq!(data.missing_shelf_ids, roots);
        }
    }

    // Catches stale flags, lexical offset ordering, reread progress, and scope-only experience.
    #[test]
    fn actual_first_completions_are_chronological_but_all_reading_builds_experience() {
        let conn = database();
        session(
            &conn,
            10,
            Some("2026-01-01T00:30:00Z"),
            true,
            true,
            100,
            Some(60),
            Some(100.0),
        );
        session(
            &conn,
            10,
            Some("2026-01-01T01:00:00+02:00"),
            true,
            false,
            100,
            Some(120),
            Some(50.0),
        );
        session(
            &conn,
            10,
            Some("2026-01-02T00:00:00Z"),
            true,
            true,
            100,
            Some(30),
            Some(200.0),
        );
        session(
            &conn,
            50,
            Some("2026-01-03T00:00:00Z"),
            true,
            false,
            500,
            Some(300),
            Some(100.0),
        );
        session(
            &conn,
            20,
            Some("2026-01-04T00:00:00Z"),
            false,
            true,
            200,
            Some(60),
            Some(200.0),
        );
        let data = get_goal_reading_data(&conn, &[1]).unwrap();
        assert_eq!(
            data.texts[0].first_completed_at.as_deref(),
            Some("2026-01-01T01:00:00+02:00")
        );
        assert!(data.texts[1].first_completed_at.is_none());
        assert_eq!(data.lifetime_characters, 800);
        assert_eq!(data.activity.len(), 4);
        assert_eq!(data.activity.iter().filter(|a| a.in_scope).count(), 3);
        assert_eq!(data.activity[0].duration_seconds, Some(120));
        assert_eq!(data.activity[3].character_count, 500);
        assert_eq!(data.recent_speeds, vec![100.0, 50.0]);
        let payload = serde_json::to_value(data).unwrap();
        assert_eq!(
            payload["texts"][1]["first_completed_at"],
            serde_json::Value::Null
        );
        assert_eq!(payload["activity"][3]["in_scope"], false);
    }

    // Catches taking five rows before filtering invalid speeds, or using reread speeds.
    #[test]
    fn recent_speeds_are_five_valid_actual_first_completions() {
        let conn = database();
        for day in 1..=10 {
            conn.execute(
                "INSERT INTO texts (id, shelf_id, title, content, character_count)
                VALUES (?, 5, 'Speed text', '', 100)",
                [100 + day],
            )
            .unwrap();
            let speed = match day {
                8 => None,
                9 => Some(0.0),
                10 => Some(f64::INFINITY),
                _ => Some(day as f64 * 10.0),
            };
            let timestamp = format!("2026-02-{:02}T00:00:00Z", day);
            session(
                &conn,
                100 + day,
                Some(&timestamp),
                true,
                false,
                100,
                Some(60),
                speed,
            );
        }
        session(
            &conn,
            101,
            Some("2026-03-01T00:00:00Z"),
            true,
            true,
            100,
            Some(60),
            Some(999.0),
        );
        let data = get_goal_reading_data(&conn, &[]).unwrap();
        assert_eq!(data.recent_speeds, vec![70.0, 60.0, 50.0, 40.0, 30.0]);
    }

    // Catches malformed dates poisoning ordering and negative values reaching projection inputs.
    #[test]
    fn invalid_history_is_safe_and_does_not_hide_a_valid_first_completion() {
        let conn = database();
        session(
            &conn,
            10,
            Some("invalid"),
            true,
            true,
            100,
            Some(60),
            Some(900.0),
        );
        session(&conn, 10, None, true, true, 100, Some(60), Some(800.0));
        session(
            &conn,
            10,
            Some("2026-01-01T00:00:00Z"),
            true,
            false,
            100,
            Some(-30),
            Some(-20.0),
        );
        session(
            &conn,
            20,
            Some("2026-01-02T00:00:00Z"),
            true,
            false,
            -5,
            Some(0),
            None,
        );
        let data = get_goal_reading_data(&conn, &[1]).unwrap();
        assert_eq!(data.lifetime_characters, 300);
        assert_eq!(data.activity.len(), 2);
        assert!(data.activity.iter().all(|a| a.duration_seconds.is_none()));
        assert_eq!(data.activity[1].character_count, 0);
        assert_eq!(
            data.texts[0].first_completed_at.as_deref(),
            Some("2026-01-01T00:00:00Z")
        );
        assert!(data.recent_speeds.is_empty());
    }
}
