//! Text analysis using jieba-rs for Chinese word segmentation.
//!
//! Provides character and word frequency analysis for texts.
//! Learning words (status='learning') are treated as unknown for analysis purposes.

use jieba_rs::Jieba;
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use super::error::{LibraryError, Result};
use super::known_words;
use super::models::{
    AnalysisReport, CharacterFrequency, FrequencySort, ShelfAnalysis, TextAnalysis, TextSegment,
    WordFrequency,
};
use super::text;

/// Helper struct for vocabulary sets
struct VocabularySets {
    /// Words with status='known'
    known: HashSet<String>,
    /// Words with status='learning'
    learning: HashSet<String>,
}

/// Build vocabulary sets from the database
fn build_vocabulary_sets(conn: &Connection) -> Result<VocabularySets> {
    let all_words = known_words::list_all_known_words(conn)?;

    let known: HashSet<String> = all_words
        .iter()
        .filter(|kw| kw.status == "known")
        .map(|kw| kw.word.clone())
        .collect();

    let learning: HashSet<String> = all_words
        .iter()
        .filter(|kw| kw.status == "learning")
        .map(|kw| kw.word.clone())
        .collect();

    Ok(VocabularySets { known, learning })
}

// Global jieba instance (loaded lazily, wrapped in Mutex for modification)
static JIEBA: OnceLock<Mutex<Jieba>> = OnceLock::new();

fn get_jieba() -> &'static Mutex<Jieba> {
    JIEBA.get_or_init(|| Mutex::new(Jieba::new()))
}

/// Add a word to the jieba segmentation dictionary at runtime
pub fn add_segmentation_word(word: &str, frequency: Option<i64>) {
    let jieba = get_jieba();
    let mut jieba = jieba.lock().unwrap();
    // Use the provided frequency or default to a high frequency to ensure the word is recognized
    let freq = frequency.unwrap_or(10000) as usize;
    jieba.add_word(word, Some(freq), None);
}

/// Load all user segmentation words from the database into jieba
pub fn load_user_segmentation_words(conn: &Connection) -> Result<usize> {
    let mut stmt = conn.prepare("SELECT word, frequency FROM user_segmentation_words")?;
    let words: Vec<(String, i64)> = stmt
        .query_map([], |row| {
            let word: String = row.get(0)?;
            let frequency: i64 = row.get(1)?;
            Ok((word, frequency))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let count = words.len();
    for (word, frequency) in words {
        add_segmentation_word(&word, Some(frequency));
    }

    Ok(count)
}

/// Check if a character is CJK
fn is_cjk_character(c: char) -> bool {
    matches!(c, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}')
}

/// Look up general frequency rank for a word/character from dictionary
fn get_general_frequency_rank(conn: &Connection, term: &str) -> Option<i64> {
    // Look up in dictionary entries by traditional or simplified form
    let result: std::result::Result<Option<i64>, _> = conn.query_row(
        "SELECT MIN(frequency_rank) FROM dictionary_entries
         WHERE (traditional = ? OR simplified = ?) AND frequency_rank IS NOT NULL",
        [term, term],
        |row| row.get(0),
    );

    result.ok().flatten()
}

/// Build a map of term -> general frequency rank for batch lookup
fn build_frequency_rank_map(conn: &Connection, terms: &[String]) -> HashMap<String, i64> {
    let mut map = HashMap::new();

    for term in terms {
        if let Some(rank) = get_general_frequency_rank(conn, term) {
            map.insert(term.clone(), rank);
        }
    }

    map
}

/// Analyze a text and store the results
pub fn analyze_text(conn: &Connection, text_id: i64) -> Result<TextAnalysis> {
    // Get the text
    let text = text::get_text(conn, text_id)?.ok_or(LibraryError::TextNotFound(text_id))?;

    // Get vocabulary sets - only status='known' counts as known for analysis
    let vocab = build_vocabulary_sets(conn)?;

    let jieba = get_jieba();
    let jieba = jieba.lock().unwrap();

    // Count character frequencies (CJK only)
    let mut char_freq: HashMap<char, i64> = HashMap::new();
    for c in text.content.chars() {
        if is_cjk_character(c) {
            *char_freq.entry(c).or_insert(0) += 1;
        }
    }

    // Segment text and count word frequencies (2+ char CJK words)
    let words = jieba.cut(&text.content, false);
    let mut word_freq: HashMap<String, i64> = HashMap::new();
    for word in words {
        let chars: Vec<char> = word.chars().collect();
        if chars.len() >= 2 && chars.iter().all(|c| is_cjk_character(*c)) {
            *word_freq.entry(word.to_string()).or_insert(0) += 1;
        }
    }

    // Calculate known counts (only status='known', not 'learning')
    let known_char_count = char_freq
        .keys()
        .filter(|c| vocab.known.contains(&c.to_string()))
        .count() as i64;

    let known_word_count = word_freq
        .keys()
        .filter(|w| vocab.known.contains(*w))
        .count() as i64;

    // Calculate total occurrences of known characters/words
    let known_char_occurrences: i64 = char_freq
        .iter()
        .filter(|(c, _)| vocab.known.contains(&c.to_string()))
        .map(|(_, freq)| freq)
        .sum();

    let known_word_occurrences: i64 = word_freq
        .iter()
        .filter(|(w, _)| vocab.known.contains(*w))
        .map(|(_, freq)| freq)
        .sum();

    let total_chars: i64 = char_freq.values().sum();
    let total_words: i64 = word_freq.values().sum();

    // Delete existing analysis if any
    conn.execute("DELETE FROM text_analyses WHERE text_id = ?", [text_id])?;
    conn.execute(
        "DELETE FROM text_character_freq WHERE text_id = ?",
        [text_id],
    )?;
    conn.execute("DELETE FROM text_word_freq WHERE text_id = ?", [text_id])?;

    // Insert analysis summary
    conn.execute(
        "INSERT INTO text_analyses (text_id, total_characters, unique_characters, known_characters,
         known_character_occurrences, total_words, unique_words, known_words, known_word_occurrences)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            text_id,
            total_chars,
            char_freq.len() as i64,
            known_char_count,
            known_char_occurrences,
            total_words,
            word_freq.len() as i64,
            known_word_count,
            known_word_occurrences,
        ],
    )?;

    // Insert character frequencies
    for (character, frequency) in &char_freq {
        conn.execute(
            "INSERT INTO text_character_freq (text_id, character, frequency) VALUES (?, ?, ?)",
            params![text_id, character.to_string(), frequency],
        )?;
    }

    // Insert word frequencies
    for (word, frequency) in &word_freq {
        conn.execute(
            "INSERT INTO text_word_freq (text_id, word, frequency) VALUES (?, ?, ?)",
            params![text_id, word, frequency],
        )?;
    }

    get_text_analysis(conn, text_id)
}

/// Get cached analysis for a text
pub fn get_text_analysis(conn: &Connection, text_id: i64) -> Result<TextAnalysis> {
    let result = conn.query_row(
        "SELECT text_id, total_characters, unique_characters, known_characters,
                known_character_occurrences, total_words, unique_words, known_words,
                known_word_occurrences, analyzed_at
         FROM text_analyses WHERE text_id = ?",
        [text_id],
        |row| {
            Ok(TextAnalysis {
                text_id: row.get(0)?,
                total_characters: row.get(1)?,
                unique_characters: row.get(2)?,
                known_characters: row.get(3)?,
                known_character_occurrences: row.get(4)?,
                total_words: row.get(5)?,
                unique_words: row.get(6)?,
                known_words: row.get(7)?,
                known_word_occurrences: row.get(8)?,
                analyzed_at: row.get(9)?,
            })
        },
    );

    match result {
        Ok(analysis) => Ok(analysis),
        Err(rusqlite::Error::QueryReturnedNoRows) => Err(LibraryError::AnalysisNotFound(text_id)),
        Err(e) => Err(e.into()),
    }
}

/// Get character frequencies for a text with optional sorting
pub fn get_character_frequencies(
    conn: &Connection,
    text_id: i64,
    limit: Option<usize>,
    sort: FrequencySort,
) -> Result<Vec<CharacterFrequency>> {
    // Get vocabulary sets - only status='known' counts as known
    let vocab = build_vocabulary_sets(conn)?;

    // Get all character frequencies from the text
    let mut stmt = conn.prepare(
        "SELECT character, frequency FROM text_character_freq WHERE text_id = ?",
    )?;

    let frequencies: Vec<(String, i64)> = stmt
        .query_map([text_id], |row| {
            let character: String = row.get(0)?;
            let frequency: i64 = row.get(1)?;
            Ok((character, frequency))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    // Get general frequency ranks
    let terms: Vec<String> = frequencies.iter().map(|(c, _)| c.clone()).collect();
    let rank_map = build_frequency_rank_map(conn, &terms);

    // Build result with general frequency
    let mut result: Vec<CharacterFrequency> = frequencies
        .into_iter()
        .map(|(character, frequency)| {
            let general_frequency_rank = rank_map.get(&character).copied();
            CharacterFrequency {
                is_known: vocab.known.contains(&character),
                general_frequency_rank,
                character,
                frequency,
            }
        })
        .collect();

    // Sort based on requested order
    match sort {
        FrequencySort::TextFrequency => {
            result.sort_by(|a, b| b.frequency.cmp(&a.frequency));
        }
        FrequencySort::GeneralFrequency => {
            // Sort by general frequency rank (lower = more common), items without rank go to end
            result.sort_by(|a, b| {
                match (a.general_frequency_rank, b.general_frequency_rank) {
                    (Some(ra), Some(rb)) => ra.cmp(&rb),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => b.frequency.cmp(&a.frequency), // Fall back to text frequency
                }
            });
        }
    }

    // Apply limit
    Ok(if let Some(limit) = limit {
        result.into_iter().take(limit).collect()
    } else {
        result
    })
}

/// Get word frequencies for a text with optional sorting
pub fn get_word_frequencies(
    conn: &Connection,
    text_id: i64,
    limit: Option<usize>,
    sort: FrequencySort,
) -> Result<Vec<WordFrequency>> {
    // Get vocabulary sets - only status='known' counts as known
    let vocab = build_vocabulary_sets(conn)?;

    // Get all word frequencies from the text
    let mut stmt =
        conn.prepare("SELECT word, frequency FROM text_word_freq WHERE text_id = ?")?;

    let frequencies: Vec<(String, i64)> = stmt
        .query_map([text_id], |row| {
            let word: String = row.get(0)?;
            let frequency: i64 = row.get(1)?;
            Ok((word, frequency))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    // Get general frequency ranks
    let terms: Vec<String> = frequencies.iter().map(|(w, _)| w.clone()).collect();
    let rank_map = build_frequency_rank_map(conn, &terms);

    // Build result with general frequency
    let mut result: Vec<WordFrequency> = frequencies
        .into_iter()
        .map(|(word, frequency)| {
            let general_frequency_rank = rank_map.get(&word).copied();
            WordFrequency {
                is_known: vocab.known.contains(&word),
                general_frequency_rank,
                word,
                frequency,
            }
        })
        .collect();

    // Sort based on requested order
    match sort {
        FrequencySort::TextFrequency => {
            result.sort_by(|a, b| b.frequency.cmp(&a.frequency));
        }
        FrequencySort::GeneralFrequency => {
            result.sort_by(|a, b| {
                match (a.general_frequency_rank, b.general_frequency_rank) {
                    (Some(ra), Some(rb)) => ra.cmp(&rb),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => b.frequency.cmp(&a.frequency),
                }
            });
        }
    }

    // Apply limit
    Ok(if let Some(limit) = limit {
        result.into_iter().take(limit).collect()
    } else {
        result
    })
}

/// Get unknown characters for a text
pub fn get_unknown_characters(
    conn: &Connection,
    text_id: i64,
    limit: Option<usize>,
    sort: FrequencySort,
) -> Result<Vec<CharacterFrequency>> {
    let all_chars = get_character_frequencies(conn, text_id, None, sort)?;
    let unknown: Vec<_> = all_chars.into_iter().filter(|cf| !cf.is_known).collect();

    Ok(if let Some(limit) = limit {
        unknown.into_iter().take(limit).collect()
    } else {
        unknown
    })
}

/// Get known characters for a text
pub fn get_known_characters(
    conn: &Connection,
    text_id: i64,
    limit: Option<usize>,
    sort: FrequencySort,
) -> Result<Vec<CharacterFrequency>> {
    let all_chars = get_character_frequencies(conn, text_id, None, sort)?;
    let known: Vec<_> = all_chars.into_iter().filter(|cf| cf.is_known).collect();

    Ok(if let Some(limit) = limit {
        known.into_iter().take(limit).collect()
    } else {
        known
    })
}

/// Get unknown words for a text
pub fn get_unknown_words(
    conn: &Connection,
    text_id: i64,
    limit: Option<usize>,
    sort: FrequencySort,
) -> Result<Vec<WordFrequency>> {
    let all_words = get_word_frequencies(conn, text_id, None, sort)?;
    let unknown: Vec<_> = all_words.into_iter().filter(|wf| !wf.is_known).collect();

    Ok(if let Some(limit) = limit {
        unknown.into_iter().take(limit).collect()
    } else {
        unknown
    })
}

/// Get known words for a text
pub fn get_known_words(
    conn: &Connection,
    text_id: i64,
    limit: Option<usize>,
    sort: FrequencySort,
) -> Result<Vec<WordFrequency>> {
    let all_words = get_word_frequencies(conn, text_id, None, sort)?;
    let known: Vec<_> = all_words.into_iter().filter(|wf| wf.is_known).collect();

    Ok(if let Some(limit) = limit {
        known.into_iter().take(limit).collect()
    } else {
        known
    })
}

/// Get a full analysis report for a text
pub fn get_analysis_report(
    conn: &Connection,
    text_id: i64,
    top_n: Option<usize>,
    sort: FrequencySort,
) -> Result<AnalysisReport> {
    let top_n = top_n.unwrap_or(20);

    // Ensure analysis exists, run if not
    let summary = match get_text_analysis(conn, text_id) {
        Ok(analysis) => analysis,
        Err(LibraryError::AnalysisNotFound(_)) => analyze_text(conn, text_id)?,
        Err(e) => return Err(e),
    };

    let top_characters = get_character_frequencies(conn, text_id, Some(top_n), sort)?;
    let unknown_characters = get_unknown_characters(conn, text_id, Some(top_n), sort)?;
    let known_characters = get_known_characters(conn, text_id, Some(top_n), sort)?;
    let top_words = get_word_frequencies(conn, text_id, Some(top_n), sort)?;
    let unknown_words = get_unknown_words(conn, text_id, Some(top_n), sort)?;
    let known_words_list = get_known_words(conn, text_id, Some(top_n), sort)?;

    Ok(AnalysisReport {
        summary,
        top_characters,
        unknown_characters,
        known_characters,
        top_words,
        unknown_words,
        known_words_list,
    })
}

/// Re-analyze a text (useful after vocabulary changes)
pub fn reanalyze_text(conn: &Connection, text_id: i64) -> Result<TextAnalysis> {
    analyze_text(conn, text_id)
}

/// Segment text content into words and characters with known/unknown/learning status
pub fn segment_text(conn: &Connection, content: &str) -> Result<Vec<TextSegment>> {
    let jieba = get_jieba();
    let jieba = jieba.lock().unwrap();

    // Get vocabulary sets
    let vocab = build_vocabulary_sets(conn)?;

    // Segment using jieba
    let words = jieba.cut(content, false);

    let mut segments = Vec::new();

    for word in words {
        let chars: Vec<char> = word.chars().collect();
        let all_cjk = chars.iter().all(|c| is_cjk_character(*c));

        if chars.len() >= 2 && all_cjk {
            // This is a multi-character CJK word
            let is_known = vocab.known.contains(word);
            let is_learning = vocab.learning.contains(word);
            segments.push(TextSegment {
                text: word.to_string(),
                is_cjk: true,
                is_known,
                is_learning,
                segment_type: "word".to_string(),
            });
        } else if chars.len() == 1 && is_cjk_character(chars[0]) {
            // Single CJK character
            let is_known = vocab.known.contains(word);
            let is_learning = vocab.learning.contains(word);
            segments.push(TextSegment {
                text: word.to_string(),
                is_cjk: true,
                is_known,
                is_learning,
                segment_type: "character".to_string(),
            });
        } else {
            // Non-CJK (punctuation, whitespace, etc.)
            segments.push(TextSegment {
                text: word.to_string(),
                is_cjk: false,
                is_known: false,
                is_learning: false,
                segment_type: "punctuation".to_string(),
            });
        }
    }

    Ok(segments)
}

/// Recursively get all shelf IDs including the given shelf and all descendants
fn get_all_descendant_shelf_ids(conn: &Connection, shelf_id: i64) -> Result<Vec<i64>> {
    let mut all_ids = vec![shelf_id];
    let mut to_process = vec![shelf_id];

    while let Some(current_id) = to_process.pop() {
        let mut stmt = conn.prepare("SELECT id FROM shelves WHERE parent_id = ?")?;
        let child_ids: Vec<i64> = stmt
            .query_map([current_id], |row| row.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        for child_id in child_ids {
            all_ids.push(child_id);
            to_process.push(child_id);
        }
    }

    Ok(all_ids)
}

/// Get aggregated analysis for all texts in a shelf and its sub-shelves
pub fn get_shelf_analysis(conn: &Connection, shelf_id: i64) -> Result<ShelfAnalysis> {
    // Get vocabulary sets - only status='known' counts as known
    let vocab = build_vocabulary_sets(conn)?;

    // Get all shelf IDs (this shelf + all descendants)
    let all_shelf_ids = get_all_descendant_shelf_ids(conn, shelf_id)?;

    // Get all text IDs in these shelves
    let placeholders: String = all_shelf_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let query = format!("SELECT id FROM texts WHERE shelf_id IN ({})", placeholders);
    let mut stmt = conn.prepare(&query)?;
    let text_ids: Vec<i64> = stmt
        .query_map(rusqlite::params_from_iter(&all_shelf_ids), |row| row.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    // Aggregate character and word frequencies across all texts
    let mut char_freq: HashMap<String, i64> = HashMap::new();
    let mut word_freq: HashMap<String, i64> = HashMap::new();
    let mut total_characters: i64 = 0;
    let mut total_words: i64 = 0;

    for text_id in &text_ids {
        // Ensure analysis exists
        if get_text_analysis(conn, *text_id).is_err() {
            analyze_text(conn, *text_id)?;
        }

        // Get character frequencies for this text
        let mut char_stmt = conn.prepare(
            "SELECT character, frequency FROM text_character_freq WHERE text_id = ?",
        )?;
        let char_rows = char_stmt.query_map([text_id], |row| {
            let character: String = row.get(0)?;
            let frequency: i64 = row.get(1)?;
            Ok((character, frequency))
        })?;

        for row in char_rows {
            let (character, frequency) = row?;
            *char_freq.entry(character).or_insert(0) += frequency;
            total_characters += frequency;
        }

        // Get word frequencies for this text
        let mut word_stmt =
            conn.prepare("SELECT word, frequency FROM text_word_freq WHERE text_id = ?")?;
        let word_rows = word_stmt.query_map([text_id], |row| {
            let word: String = row.get(0)?;
            let frequency: i64 = row.get(1)?;
            Ok((word, frequency))
        })?;

        for row in word_rows {
            let (word, frequency) = row?;
            *word_freq.entry(word).or_insert(0) += frequency;
            total_words += frequency;
        }
    }

    // Get general frequency ranks for characters
    let char_terms: Vec<String> = char_freq.keys().cloned().collect();
    let char_rank_map = build_frequency_rank_map(conn, &char_terms);

    // Build character frequency lists
    let mut all_char_freqs: Vec<CharacterFrequency> = char_freq
        .into_iter()
        .map(|(character, frequency)| {
            let general_frequency_rank = char_rank_map.get(&character).copied();
            CharacterFrequency {
                is_known: vocab.known.contains(&character),
                general_frequency_rank,
                character,
                frequency,
            }
        })
        .collect();

    // Sort by frequency descending
    all_char_freqs.sort_by(|a, b| b.frequency.cmp(&a.frequency));

    // Split into known and unknown
    let unknown_characters: Vec<CharacterFrequency> = all_char_freqs
        .iter()
        .filter(|cf| !cf.is_known)
        .cloned()
        .collect();
    let known_characters: Vec<CharacterFrequency> = all_char_freqs
        .iter()
        .filter(|cf| cf.is_known)
        .cloned()
        .collect();

    // Get general frequency ranks for words
    let word_terms: Vec<String> = word_freq.keys().cloned().collect();
    let word_rank_map = build_frequency_rank_map(conn, &word_terms);

    // Build word frequency lists
    let mut all_word_freqs: Vec<WordFrequency> = word_freq
        .into_iter()
        .map(|(word, frequency)| {
            let general_frequency_rank = word_rank_map.get(&word).copied();
            WordFrequency {
                is_known: vocab.known.contains(&word),
                general_frequency_rank,
                word,
                frequency,
            }
        })
        .collect();

    // Sort by frequency descending
    all_word_freqs.sort_by(|a, b| b.frequency.cmp(&a.frequency));

    // Split into known and unknown
    let unknown_words: Vec<WordFrequency> = all_word_freqs
        .iter()
        .filter(|wf| !wf.is_known)
        .cloned()
        .collect();
    let known_words_list: Vec<WordFrequency> = all_word_freqs
        .iter()
        .filter(|wf| wf.is_known)
        .cloned()
        .collect();

    Ok(ShelfAnalysis {
        shelf_id,
        text_count: text_ids.len() as i64,
        total_characters,
        unique_characters: all_char_freqs.len() as i64,
        known_characters_count: known_characters.len() as i64,
        total_words,
        unique_words: all_word_freqs.len() as i64,
        known_words_count: known_words_list.len() as i64,
        unknown_characters,
        known_characters,
        unknown_words,
        known_words: known_words_list,
    })
}

/// Statistics about auto-marking unknown words
#[derive(Debug)]
pub struct AutoMarkStats {
    /// Number of characters marked as known
    pub characters_marked: i64,
    /// Number of words marked as known
    pub words_marked: i64,
}

/// Auto-mark all unknown characters and words from a text as known.
///
/// This function:
/// 1. Gets all unique CJK characters and words from the text
/// 2. For each one that is NOT already known and NOT in learning status, marks it as known
/// 3. Learning words/characters maintain their status
///
/// Returns statistics about how many items were marked.
pub fn auto_mark_text_as_known(conn: &Connection, text_id: i64) -> Result<AutoMarkStats> {
    // Get the text
    let text = text::get_text(conn, text_id)?.ok_or(LibraryError::TextNotFound(text_id))?;

    // Get vocabulary sets
    let vocab = build_vocabulary_sets(conn)?;

    let jieba = get_jieba();
    let jieba = jieba.lock().unwrap();

    // Get unique CJK characters
    let unique_chars: HashSet<char> = text
        .content
        .chars()
        .filter(|c| is_cjk_character(*c))
        .collect();

    // Get unique multi-character CJK words
    let words = jieba.cut(&text.content, false);
    let unique_words: HashSet<String> = words
        .into_iter()
        .filter(|word| {
            let chars: Vec<char> = word.chars().collect();
            chars.len() >= 2 && chars.iter().all(|c| is_cjk_character(*c))
        })
        .map(|s| s.to_string())
        .collect();

    let mut characters_marked: i64 = 0;
    let mut words_marked: i64 = 0;

    // Mark unknown characters as known (skip if already known or learning)
    for c in unique_chars {
        let c_str = c.to_string();
        if !vocab.known.contains(&c_str) && !vocab.learning.contains(&c_str) {
            known_words::add_known_word(conn, &c_str, "character", Some("known"), None)?;
            characters_marked += 1;
        }
    }

    // Mark unknown words as known (skip if already known or learning)
    for word in unique_words {
        if !vocab.known.contains(&word) && !vocab.learning.contains(&word) {
            known_words::add_known_word(conn, &word, "word", Some("known"), None)?;
            words_marked += 1;
        }
    }

    // Invalidate the analysis cache since vocabulary changed
    if characters_marked > 0 || words_marked > 0 {
        conn.execute("DELETE FROM text_analyses WHERE text_id = ?", [text_id])?;
    }

    Ok(AutoMarkStats {
        characters_marked,
        words_marked,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictionary::schema::init_database;
    use crate::library::shelf::create_shelf;
    use crate::library::text::create_text;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn).unwrap();
        conn
    }

    #[test]
    fn test_analyze_text() {
        let conn = setup_test_db();

        let shelf = create_shelf(&conn, "Test", None, None).unwrap();
        let text = create_text(
            &conn,
            shelf.id,
            "Test",
            "我喜欢学习中文。中文很有趣。",
            None,
            "paste",
        )
        .unwrap();

        let analysis = analyze_text(&conn, text.id).unwrap();

        assert!(analysis.total_characters > 0);
        assert!(analysis.unique_characters > 0);
        assert!(analysis.total_words > 0);
    }

    #[test]
    fn test_character_frequencies() {
        let conn = setup_test_db();

        let shelf = create_shelf(&conn, "Test", None, None).unwrap();
        let text = create_text(&conn, shelf.id, "Test", "中中中文文文", None, "paste").unwrap();

        analyze_text(&conn, text.id).unwrap();
        let frequencies =
            get_character_frequencies(&conn, text.id, None, FrequencySort::TextFrequency).unwrap();

        assert_eq!(frequencies.len(), 2); // 中 and 文
        assert_eq!(frequencies[0].frequency, 3); // both appear 3 times
    }

    #[test]
    fn test_analysis_report() {
        let conn = setup_test_db();

        let shelf = create_shelf(&conn, "Test", None, None).unwrap();
        let text = create_text(&conn, shelf.id, "Test", "我喜欢学习中文", None, "paste").unwrap();

        let report =
            get_analysis_report(&conn, text.id, Some(10), FrequencySort::TextFrequency).unwrap();

        assert!(report.summary.total_characters > 0);
        assert!(!report.top_characters.is_empty());
    }
}
