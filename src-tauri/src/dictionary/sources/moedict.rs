//! Taiwan MOE Dictionary (萌典/教育部國語辭典) parser and importer.
//!
//! Parses the JSON format from g0v/moedict-data.

use crate::dictionary::models::DictionarySource;
use rusqlite::{Connection, Result, Transaction};
use serde::Deserialize;
use std::io::Read;

/// A heteronym (different pronunciation) for a word
#[derive(Debug, Deserialize)]
pub struct MoeDictHeteronym {
    /// Bopomofo/Zhuyin pronunciation
    #[serde(rename = "bopomofo")]
    pub bopomofo: Option<String>,
    /// Bopomofo variant
    #[serde(rename = "bopomofo2")]
    pub bopomofo2: Option<String>,
    /// Pinyin pronunciation
    #[serde(rename = "pinyin")]
    pub pinyin: Option<String>,
    /// Definitions for this pronunciation
    #[serde(rename = "definitions")]
    pub definitions: Option<Vec<MoeDictDefinition>>,
}

/// A definition in MOE Dict format
#[derive(Debug, Deserialize)]
pub struct MoeDictDefinition {
    /// The definition text
    #[serde(rename = "def")]
    pub def: Option<String>,
    /// Part of speech type
    #[serde(rename = "type")]
    pub def_type: Option<String>,
    /// Example sentences/quotes
    #[serde(rename = "quote")]
    pub quote: Option<Vec<String>>,
    /// Example usage
    #[serde(rename = "example")]
    pub example: Option<Vec<String>>,
    /// Cross-references to other entries
    #[serde(rename = "link")]
    pub link: Option<Vec<String>>,
}

/// A complete MOE Dict entry
#[derive(Debug, Deserialize)]
pub struct MoeDictEntry {
    /// The word/term (title)
    #[serde(rename = "title")]
    pub title: String,
    /// Radical if single character
    #[serde(rename = "radical")]
    pub radical: Option<String>,
    /// Stroke count
    #[serde(rename = "stroke_count")]
    pub stroke_count: Option<i32>,
    /// Non-radical stroke count
    #[serde(rename = "non_radical_stroke_count")]
    pub non_radical_stroke_count: Option<i32>,
    /// Different pronunciations and their definitions
    #[serde(rename = "heteronyms")]
    pub heteronyms: Option<Vec<MoeDictHeteronym>>,
}

/// Import MOE Dict data from JSON reader
pub fn import_moedict<R: Read>(conn: &mut Connection, reader: R) -> Result<ImportStats> {
    let entries: Vec<MoeDictEntry> = serde_json::from_reader(reader)
        .map_err(|e| rusqlite::Error::InvalidParameterName(e.to_string()))?;

    let mut stats = ImportStats::default();
    let tx = conn.transaction()?;

    for entry in entries {
        stats.lines_processed += 1;

        if let Err(e) = insert_moedict_entry(&tx, &entry) {
            log::warn!("Error inserting entry '{}': {}", entry.title, e);
            stats.errors += 1;
        } else {
            stats.entries_added += 1;
        }
    }

    tx.commit()?;
    Ok(stats)
}

/// Insert a single MOE Dict entry
fn insert_moedict_entry(tx: &Transaction, entry: &MoeDictEntry) -> Result<()> {
    let heteronyms = match &entry.heteronyms {
        Some(h) if !h.is_empty() => h,
        _ => return Ok(()), // Skip entries without pronunciations
    };

    for heteronym in heteronyms {
        let pinyin = heteronym.pinyin.clone().unwrap_or_default();
        let zhuyin = heteronym.bopomofo.clone();

        // Insert the main entry
        tx.execute(
            r#"INSERT INTO dictionary_entries
               (traditional, simplified, pinyin, zhuyin, source)
               VALUES (?, ?, ?, ?, ?)"#,
            (
                &entry.title,
                &entry.title, // MOE Dict is Traditional, simplified same for now
                &pinyin,
                &zhuyin,
                DictionarySource::MoeDict.as_str(),
            ),
        )?;

        let entry_id = tx.last_insert_rowid();

        // Insert definitions
        if let Some(definitions) = &heteronym.definitions {
            for (idx, def) in definitions.iter().enumerate() {
                if let Some(def_text) = &def.def {
                    let part_of_speech = def.def_type.clone();

                    tx.execute(
                        r#"INSERT INTO definitions (entry_id, text, part_of_speech, language, sort_order)
                           VALUES (?, ?, ?, 'zh', ?)"#,
                        (entry_id, def_text, &part_of_speech, idx as i32),
                    )?;
                }

                // Insert examples
                if let Some(examples) = &def.example {
                    for (ex_idx, example) in examples.iter().enumerate() {
                        tx.execute(
                            r#"INSERT INTO usage_examples (entry_id, text, sort_order)
                               VALUES (?, ?, ?)"#,
                            (entry_id, example, (idx * 100 + ex_idx) as i32),
                        )?;
                    }
                }

                // Insert quotes as examples with source indication
                if let Some(quotes) = &def.quote {
                    for (q_idx, quote) in quotes.iter().enumerate() {
                        tx.execute(
                            r#"INSERT INTO usage_examples (entry_id, text, source, sort_order)
                               VALUES (?, ?, '引文', ?)"#,
                            (entry_id, quote, (idx * 100 + 50 + q_idx) as i32),
                        )?;
                    }
                }
            }
        }
    }

    // Insert character information if available
    if entry.title.chars().count() == 1 {
        let char = entry.title.chars().next().unwrap();
        tx.execute(
            r#"INSERT OR IGNORE INTO characters (character, radical, total_strokes, additional_strokes)
               VALUES (?, ?, ?, ?)"#,
            (
                char.to_string(),
                &entry.radical,
                &entry.stroke_count,
                &entry.non_radical_stroke_count,
            ),
        )?;
    }

    Ok(())
}

/// Statistics from an import operation
#[derive(Debug, Default)]
pub struct ImportStats {
    pub lines_processed: usize,
    pub entries_added: usize,
    pub errors: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_moedict_json() {
        let json = r#"[
            {
                "title": "測試",
                "heteronyms": [{
                    "bopomofo": "ㄘㄜˋ ㄕˋ",
                    "pinyin": "cè shì",
                    "definitions": [{
                        "def": "測量試驗。",
                        "type": "動",
                        "example": ["進行測試"]
                    }]
                }]
            }
        ]"#;

        let entries: Vec<MoeDictEntry> = serde_json::from_str(json).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "測試");

        let heteronyms = entries[0].heteronyms.as_ref().unwrap();
        assert_eq!(heteronyms[0].pinyin, Some("cè shì".to_string()));
    }
}
