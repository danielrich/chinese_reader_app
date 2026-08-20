//! Learning module for vocabulary progress tracking and frequency analysis.
//!
//! This module provides functionality for:
//! - Importing word frequency data from external sources
//! - Calculating percentile coverage (what % of top N words do you know)
//! - Tracking vocabulary progress over time
//! - Analyzing shelf-specific vocabulary needs

use crate::library::{
    FrequencyImportStats, FrequencySource, LearningStats, PercentileCoverage,
    ShelfFrequencyAnalysis, TermFrequencyInfo, VocabularyProgress,
};
use rusqlite::{Connection, Result, params};

/// Import frequency data from tab-separated content.
///
/// Expected format: term\trank\tfrequency_count (one per line)
/// Or: term\trank (frequency_count optional)
pub fn import_frequency_data(
    conn: &Connection,
    content: &str,
    source: &str,
    term_type: &str,
) -> Result<FrequencyImportStats> {
    let mut terms_imported = 0;
    let mut terms_skipped = 0;
    let mut errors = 0;

    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO word_frequencies (term, term_type, source, rank, frequency_count)
         VALUES (?, ?, ?, ?, ?)",
    )?;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 2 {
            errors += 1;
            continue;
        }

        let term = parts[0].trim();
        let rank: i64 = match parts[1].trim().parse() {
            Ok(r) => r,
            Err(_) => {
                errors += 1;
                continue;
            }
        };

        let frequency_count: Option<i64> = if parts.len() > 2 {
            parts[2].trim().parse().ok()
        } else {
            None
        };

        match stmt.execute(params![term, term_type, source, rank, frequency_count]) {
            Ok(1) => terms_imported += 1,
            Ok(_) => terms_skipped += 1, // Already exists
            Err(_) => errors += 1,
        }
    }

    Ok(FrequencyImportStats {
        terms_imported,
        terms_skipped,
        errors,
    })
}

/// List available frequency sources with their term counts.
pub fn list_frequency_sources(conn: &Connection) -> Result<Vec<FrequencySource>> {
    let mut stmt = conn.prepare(
        "SELECT source, term_type, COUNT(*) as count
         FROM word_frequencies
         GROUP BY source, term_type
         ORDER BY source, term_type",
    )?;

    let mut sources: Vec<FrequencySource> = Vec::new();
    let mut rows = stmt.query([])?;

    while let Some(row) = rows.next()? {
        let source: String = row.get(0)?;
        let term_type: String = row.get(1)?;
        let count: i64 = row.get(2)?;

        // Create display name
        let display_name = format!(
            "{} ({})",
            source
                .chars()
                .next()
                .map(|c| c.to_uppercase().to_string())
                .unwrap_or_default()
                + &source[1..],
            term_type
        );

        sources.push(FrequencySource {
            name: format!("{}_{}", source, term_type),
            display_name,
            term_count: count,
        });
    }

    Ok(sources)
}

/// Get percentile coverage for a specific source and term type.
///
/// Returns coverage for percentiles: 50, 60, 70, 80, 90, 95, 99
pub fn get_percentile_coverage(
    conn: &Connection,
    source: &str,
    term_type: &str,
    percentiles: &[i64],
) -> Result<Vec<PercentileCoverage>> {
    // First, get total count for this source/type
    let total_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM word_frequencies WHERE source = ? AND term_type = ?",
        params![source, term_type],
        |row| row.get(0),
    )?;

    if total_count == 0 {
        return Ok(percentiles
            .iter()
            .map(|&p| PercentileCoverage {
                percentile: p,
                total_terms: 0,
                known_terms: 0,
                learning_terms: 0,
                coverage_percent: 0.0,
            })
            .collect());
    }

    let mut results = Vec::new();

    for &percentile in percentiles {
        // Calculate how many terms are in this percentile
        let terms_in_percentile = (total_count * percentile) / 100;

        // Count known and learning terms in this percentile
        let (known, learning): (i64, i64) = conn.query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN kw.status = 'known' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN kw.status = 'learning' THEN 1 ELSE 0 END), 0)
             FROM word_frequencies wf
             LEFT JOIN known_words kw ON wf.term = kw.word
             WHERE wf.source = ? AND wf.term_type = ? AND wf.rank <= ?",
            params![source, term_type, terms_in_percentile],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let coverage_percent = if terms_in_percentile > 0 {
            (known as f64 / terms_in_percentile as f64) * 100.0
        } else {
            0.0
        };

        results.push(PercentileCoverage {
            percentile,
            total_terms: terms_in_percentile,
            known_terms: known,
            learning_terms: learning,
            coverage_percent,
        });
    }

    Ok(results)
}

/// Get aggregated learning statistics.
pub fn get_learning_stats(conn: &Connection, frequency_source: Option<&str>) -> Result<LearningStats> {
    // Count known vocabulary by type and status
    let (known_chars, learning_chars): (i64, i64) = conn.query_row(
        "SELECT
            COALESCE(SUM(CASE WHEN status = 'known' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN status = 'learning' THEN 1 ELSE 0 END), 0)
         FROM known_words WHERE word_type = 'character'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    let (known_words, learning_words): (i64, i64) = conn.query_row(
        "SELECT
            COALESCE(SUM(CASE WHEN status = 'known' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN status = 'learning' THEN 1 ELSE 0 END), 0)
         FROM known_words WHERE word_type = 'word'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    // Determine which frequency source to use
    let source = frequency_source.unwrap_or("").to_string();

    // If a source is specified, get percentile coverage
    let percentiles = vec![50, 60, 70, 80, 90, 95, 99];

    let (character_coverage, word_coverage) = if !source.is_empty() {
        // Check if this is a combined source (source_termtype format)
        let parts: Vec<&str> = source.split('_').collect();
        if parts.len() == 2 {
            let base_source = parts[0];
            let char_coverage = get_percentile_coverage(conn, base_source, "character", &percentiles)?;
            let word_cov = get_percentile_coverage(conn, base_source, "word", &percentiles)?;
            (char_coverage, word_cov)
        } else {
            let char_coverage = get_percentile_coverage(conn, &source, "character", &percentiles)?;
            let word_cov = get_percentile_coverage(conn, &source, "word", &percentiles)?;
            (char_coverage, word_cov)
        }
    } else {
        // No source specified, try to find a default
        let default_source: Option<String> = conn
            .query_row(
                "SELECT DISTINCT source FROM word_frequencies LIMIT 1",
                [],
                |row| row.get(0),
            )
            .ok();

        if let Some(src) = default_source {
            let char_coverage = get_percentile_coverage(conn, &src, "character", &percentiles)?;
            let word_cov = get_percentile_coverage(conn, &src, "word", &percentiles)?;
            (char_coverage, word_cov)
        } else {
            (Vec::new(), Vec::new())
        }
    };

    Ok(LearningStats {
        total_known_characters: known_chars,
        total_known_words: known_words,
        total_learning_characters: learning_chars,
        total_learning_words: learning_words,
        character_coverage,
        word_coverage,
        frequency_source: source,
    })
}

/// Get vocabulary progress over a number of days.
pub fn get_vocabulary_progress(conn: &Connection, days: Option<i64>) -> Result<Vec<VocabularyProgress>> {
    let limit = days.unwrap_or(30);

    let mut stmt = conn.prepare(
        "SELECT snapshot_date, known_characters, known_words, learning_characters, learning_words
         FROM vocabulary_snapshots
         ORDER BY snapshot_date DESC
         LIMIT ?",
    )?;

    let mut progress = Vec::new();
    let mut rows = stmt.query(params![limit])?;

    while let Some(row) = rows.next()? {
        progress.push(VocabularyProgress {
            date: row.get(0)?,
            known_characters: row.get(1)?,
            known_words: row.get(2)?,
            learning_characters: row.get(3)?,
            learning_words: row.get(4)?,
        });
    }

    // Reverse to get chronological order
    progress.reverse();
    Ok(progress)
}

/// Record a vocabulary snapshot for today.
pub fn record_vocabulary_snapshot(conn: &Connection) -> Result<()> {
    // Count current vocabulary
    let (known_chars, learning_chars): (i64, i64) = conn.query_row(
        "SELECT
            COALESCE(SUM(CASE WHEN status = 'known' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN status = 'learning' THEN 1 ELSE 0 END), 0)
         FROM known_words WHERE word_type = 'character'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    let (known_words, learning_words): (i64, i64) = conn.query_row(
        "SELECT
            COALESCE(SUM(CASE WHEN status = 'known' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN status = 'learning' THEN 1 ELSE 0 END), 0)
         FROM known_words WHERE word_type = 'word'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    // Insert or update today's snapshot
    conn.execute(
        "INSERT OR REPLACE INTO vocabulary_snapshots
         (snapshot_date, known_characters, known_words, learning_characters, learning_words)
         VALUES (date('now'), ?, ?, ?, ?)",
        params![known_chars, known_words, learning_chars, learning_words],
    )?;

    Ok(())
}

/// Get frequency analysis for a specific shelf.
pub fn get_shelf_frequency_analysis(
    conn: &Connection,
    shelf_id: i64,
    source: &str,
) -> Result<ShelfFrequencyAnalysis> {
    // Get shelf name
    let shelf_name: String = conn.query_row(
        "SELECT name FROM shelves WHERE id = ?",
        params![shelf_id],
        |row| row.get(0),
    )?;

    // Get unique characters from shelf's texts
    let mut char_stmt = conn.prepare(
        "SELECT DISTINCT tcf.character
         FROM text_character_freq tcf
         JOIN texts t ON tcf.text_id = t.id
         WHERE t.shelf_id = ?",
    )?;

    let shelf_chars: Vec<String> = char_stmt
        .query_map(params![shelf_id], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();

    // Get unique words from shelf's texts
    let mut word_stmt = conn.prepare(
        "SELECT DISTINCT twf.word
         FROM text_word_freq twf
         JOIN texts t ON twf.text_id = t.id
         WHERE t.shelf_id = ?",
    )?;

    let shelf_words: Vec<String> = word_stmt
        .query_map(params![shelf_id], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();

    // Calculate percentile coverage for shelf vocabulary
    let percentiles = vec![50, 60, 70, 80, 90, 95, 99];

    // For characters
    let character_coverage = calculate_shelf_coverage(conn, source, "character", &shelf_chars, &percentiles)?;

    // For words
    let word_coverage = calculate_shelf_coverage(conn, source, "word", &shelf_words, &percentiles)?;

    // Get unknown high-frequency terms from the shelf
    let unknown_high_frequency = get_unknown_high_frequency_terms(conn, source, &shelf_chars, &shelf_words, 50)?;

    Ok(ShelfFrequencyAnalysis {
        shelf_id,
        shelf_name,
        character_coverage,
        word_coverage,
        unknown_high_frequency,
    })
}

/// Calculate coverage for shelf-specific vocabulary.
fn calculate_shelf_coverage(
    conn: &Connection,
    source: &str,
    term_type: &str,
    shelf_terms: &[String],
    percentiles: &[i64],
) -> Result<Vec<PercentileCoverage>> {
    if shelf_terms.is_empty() {
        return Ok(percentiles
            .iter()
            .map(|&p| PercentileCoverage {
                percentile: p,
                total_terms: 0,
                known_terms: 0,
                learning_terms: 0,
                coverage_percent: 0.0,
            })
            .collect());
    }

    // Get total count for source
    let total_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM word_frequencies WHERE source = ? AND term_type = ?",
        params![source, term_type],
        |row| row.get(0),
    )?;

    if total_count == 0 {
        return Ok(percentiles
            .iter()
            .map(|&p| PercentileCoverage {
                percentile: p,
                total_terms: 0,
                known_terms: 0,
                learning_terms: 0,
                coverage_percent: 0.0,
            })
            .collect());
    }

    let mut results = Vec::new();

    for &percentile in percentiles {
        let terms_in_percentile = (total_count * percentile) / 100;

        // Count shelf terms that are in this percentile
        let shelf_terms_placeholder = shelf_terms
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");

        let query = format!(
            "SELECT
                COUNT(*) as total,
                COALESCE(SUM(CASE WHEN kw.status = 'known' THEN 1 ELSE 0 END), 0) as known,
                COALESCE(SUM(CASE WHEN kw.status = 'learning' THEN 1 ELSE 0 END), 0) as learning
             FROM word_frequencies wf
             LEFT JOIN known_words kw ON wf.term = kw.word
             WHERE wf.source = ? AND wf.term_type = ? AND wf.rank <= ?
             AND wf.term IN ({})",
            shelf_terms_placeholder
        );

        let mut stmt = conn.prepare(&query)?;

        // Build params: source, term_type, rank, then all shelf_terms
        let mut params_vec: Vec<&dyn rusqlite::ToSql> = Vec::new();
        params_vec.push(&source);
        params_vec.push(&term_type);
        params_vec.push(&terms_in_percentile);
        for term in shelf_terms {
            params_vec.push(term);
        }

        let (total, known, learning): (i64, i64, i64) =
            stmt.query_row(params_vec.as_slice(), |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?;

        let coverage_percent = if total > 0 {
            (known as f64 / total as f64) * 100.0
        } else {
            100.0 // If no shelf terms in this percentile, consider it covered
        };

        results.push(PercentileCoverage {
            percentile,
            total_terms: total,
            known_terms: known,
            learning_terms: learning,
            coverage_percent,
        });
    }

    Ok(results)
}

/// Get unknown high-frequency terms from the shelf vocabulary.
fn get_unknown_high_frequency_terms(
    conn: &Connection,
    source: &str,
    shelf_chars: &[String],
    shelf_words: &[String],
    limit: usize,
) -> Result<Vec<TermFrequencyInfo>> {
    let mut results = Vec::new();

    // Get unknown high-frequency characters
    if !shelf_chars.is_empty() {
        let placeholders = shelf_chars.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let query = format!(
            "SELECT wf.term, wf.rank, kw.status
             FROM word_frequencies wf
             LEFT JOIN known_words kw ON wf.term = kw.word
             WHERE wf.source = ? AND wf.term_type = 'character'
             AND wf.term IN ({})
             AND (kw.status IS NULL OR kw.status != 'known')
             ORDER BY wf.rank ASC
             LIMIT ?",
            placeholders
        );

        let mut stmt = conn.prepare(&query)?;
        let mut params_vec: Vec<&dyn rusqlite::ToSql> = vec![&source];
        for term in shelf_chars {
            params_vec.push(term);
        }
        let limit_i64 = limit as i64;
        params_vec.push(&limit_i64);

        let mut rows = stmt.query(params_vec.as_slice())?;
        while let Some(row) = rows.next()? {
            let term: String = row.get(0)?;
            let rank: i64 = row.get(1)?;
            let status: Option<String> = row.get(2)?;

            results.push(TermFrequencyInfo {
                term,
                term_type: "character".to_string(),
                rank: Some(rank),
                is_known: false,
                is_learning: status.as_deref() == Some("learning"),
            });
        }
    }

    // Get unknown high-frequency words
    if !shelf_words.is_empty() {
        let placeholders = shelf_words.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let query = format!(
            "SELECT wf.term, wf.rank, kw.status
             FROM word_frequencies wf
             LEFT JOIN known_words kw ON wf.term = kw.word
             WHERE wf.source = ? AND wf.term_type = 'word'
             AND wf.term IN ({})
             AND (kw.status IS NULL OR kw.status != 'known')
             ORDER BY wf.rank ASC
             LIMIT ?",
            placeholders
        );

        let mut stmt = conn.prepare(&query)?;
        let mut params_vec: Vec<&dyn rusqlite::ToSql> = vec![&source];
        for term in shelf_words {
            params_vec.push(term);
        }
        let limit_i64 = limit as i64;
        params_vec.push(&limit_i64);

        let mut rows = stmt.query(params_vec.as_slice())?;
        while let Some(row) = rows.next()? {
            let term: String = row.get(0)?;
            let rank: i64 = row.get(1)?;
            let status: Option<String> = row.get(2)?;

            results.push(TermFrequencyInfo {
                term,
                term_type: "word".to_string(),
                rank: Some(rank),
                is_known: false,
                is_learning: status.as_deref() == Some("learning"),
            });
        }
    }

    // Sort by rank and limit
    results.sort_by(|a, b| {
        let rank_a = a.rank.unwrap_or(i64::MAX);
        let rank_b = b.rank.unwrap_or(i64::MAX);
        rank_a.cmp(&rank_b)
    });
    results.truncate(limit);

    Ok(results)
}

/// Get study priorities - unknown terms sorted by general frequency.
pub fn get_study_priorities(
    conn: &Connection,
    source: &str,
    term_type: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<TermFrequencyInfo>> {
    let limit = limit.unwrap_or(100);

    let type_filter = term_type
        .map(|t| format!("AND wf.term_type = '{}'", t))
        .unwrap_or_default();

    let query = format!(
        "SELECT wf.term, wf.term_type, wf.rank, kw.status
         FROM word_frequencies wf
         LEFT JOIN known_words kw ON wf.term = kw.word
         WHERE wf.source = ?
         AND (kw.status IS NULL OR kw.status != 'known')
         {}
         ORDER BY wf.rank ASC
         LIMIT ?",
        type_filter
    );

    let mut stmt = conn.prepare(&query)?;
    let limit_i64 = limit as i64;
    let mut rows = stmt.query(params![source, limit_i64])?;

    let mut results = Vec::new();
    while let Some(row) = rows.next()? {
        let term: String = row.get(0)?;
        let t_type: String = row.get(1)?;
        let rank: i64 = row.get(2)?;
        let status: Option<String> = row.get(3)?;

        results.push(TermFrequencyInfo {
            term,
            term_type: t_type,
            rank: Some(rank),
            is_known: false,
            is_learning: status.as_deref() == Some("learning"),
        });
    }

    Ok(results)
}

/// Clear all frequency data for a specific source.
pub fn clear_frequency_source(conn: &Connection, source: &str) -> Result<usize> {
    let count = conn.execute(
        "DELETE FROM word_frequencies WHERE source = ?",
        params![source],
    )?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictionary::schema::init_database;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn).unwrap();
        conn
    }

    #[test]
    fn test_import_frequency_data() {
        let conn = setup_test_db();

        let content = "我\t1\t1000000\n你\t2\t900000\n他\t3\t800000";
        let stats = import_frequency_data(&conn, content, "test", "character").unwrap();

        assert_eq!(stats.terms_imported, 3);
        assert_eq!(stats.terms_skipped, 0);
        assert_eq!(stats.errors, 0);

        // Verify data
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM word_frequencies WHERE source = 'test'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 3);
    }

    #[test]
    fn test_list_frequency_sources() {
        let conn = setup_test_db();

        // Import some data
        let content = "我\t1\n你\t2";
        import_frequency_data(&conn, content, "books", "character").unwrap();
        import_frequency_data(&conn, content, "books", "word").unwrap();

        let sources = list_frequency_sources(&conn).unwrap();
        assert_eq!(sources.len(), 2);
    }

    #[test]
    fn test_get_percentile_coverage() {
        let conn = setup_test_db();

        // Import frequency data
        let mut content = String::new();
        for i in 1..=100 {
            content.push_str(&format!("char{}\t{}\n", i, i));
        }
        import_frequency_data(&conn, &content, "test", "character").unwrap();

        // Mark some as known
        conn.execute(
            "INSERT INTO known_words (word, word_type, status) VALUES ('char1', 'character', 'known')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO known_words (word, word_type, status) VALUES ('char2', 'character', 'known')",
            [],
        )
        .unwrap();

        let coverage = get_percentile_coverage(&conn, "test", "character", &[50, 90]).unwrap();
        assert_eq!(coverage.len(), 2);
        assert_eq!(coverage[0].percentile, 50);
        assert_eq!(coverage[0].total_terms, 50);
        assert_eq!(coverage[0].known_terms, 2);
    }

    #[test]
    fn test_record_vocabulary_snapshot() {
        let conn = setup_test_db();

        // Add some known words
        conn.execute(
            "INSERT INTO known_words (word, word_type, status) VALUES ('我', 'character', 'known')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO known_words (word, word_type, status) VALUES ('你', 'character', 'learning')",
            [],
        )
        .unwrap();

        record_vocabulary_snapshot(&conn).unwrap();

        let progress = get_vocabulary_progress(&conn, Some(1)).unwrap();
        assert_eq!(progress.len(), 1);
        assert_eq!(progress[0].known_characters, 1);
        assert_eq!(progress[0].learning_characters, 1);
    }
}
