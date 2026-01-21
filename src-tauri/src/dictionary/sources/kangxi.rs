//! Kangxi Dictionary (康熙字典) parser and importer.
//!
//! Parses various Kangxi dictionary formats including the text format
//! from kangxiDictText and structured JSON formats.

use crate::dictionary::models::DictionarySource;
use rusqlite::{Connection, Result, Transaction};
use std::io::{BufRead, BufReader, Read};

/// A parsed Kangxi dictionary entry
#[derive(Debug)]
pub struct KangxiEntry {
    pub character: String,
    pub radical_number: Option<i32>,
    pub stroke_count: Option<i32>,
    pub definition: String,
    pub pronunciation: Option<String>,
}

/// Parse Kangxi dictionary in text format (kangxiDictText format)
/// Format varies but generally: character\tdefinition or character: definition
pub fn parse_text_line(line: &str) -> Option<KangxiEntry> {
    let line = line.trim();

    if line.is_empty() || line.starts_with('#') {
        return None;
    }

    // Try tab-separated format first
    if let Some((char_part, def_part)) = line.split_once('\t') {
        let character = char_part.trim().to_string();
        if character.is_empty() || character.chars().count() != 1 {
            return None;
        }

        return Some(KangxiEntry {
            character,
            radical_number: None,
            stroke_count: None,
            definition: def_part.trim().to_string(),
            pronunciation: None,
        });
    }

    // Try colon-separated format
    if let Some((char_part, def_part)) = line.split_once(':') {
        let character = char_part.trim().to_string();
        if character.is_empty() {
            return None;
        }

        // Might have multiple characters for variant entries
        let first_char: String = character.chars().take(1).collect();

        return Some(KangxiEntry {
            character: first_char,
            radical_number: None,
            stroke_count: None,
            definition: def_part.trim().to_string(),
            pronunciation: None,
        });
    }

    None
}

/// Import Kangxi dictionary from text format
pub fn import_kangxi_text<R: Read>(conn: &mut Connection, reader: R) -> Result<ImportStats> {
    let buf_reader = BufReader::new(reader);
    let mut stats = ImportStats::default();

    let tx = conn.transaction()?;

    for line in buf_reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => {
                stats.errors += 1;
                continue;
            }
        };

        stats.lines_processed += 1;

        if let Some(entry) = parse_text_line(&line) {
            if let Err(_) = insert_kangxi_entry(&tx, &entry) {
                stats.errors += 1;
            } else {
                stats.entries_added += 1;
            }
        }
    }

    tx.commit()?;
    Ok(stats)
}

/// Insert a single Kangxi entry
fn insert_kangxi_entry(tx: &Transaction, entry: &KangxiEntry) -> Result<i64> {
    // Insert into dictionary_entries
    tx.execute(
        r#"INSERT INTO dictionary_entries
           (traditional, simplified, pinyin, source)
           VALUES (?, ?, ?, ?)"#,
        (
            &entry.character,
            &entry.character,
            entry.pronunciation.as_deref().unwrap_or(""),
            DictionarySource::Kangxi.as_str(),
        ),
    )?;

    let entry_id = tx.last_insert_rowid();

    // Insert definition (in Classical Chinese)
    tx.execute(
        r#"INSERT INTO definitions (entry_id, text, language, sort_order)
           VALUES (?, ?, 'zh-classical', 0)"#,
        (entry_id, &entry.definition),
    )?;

    // Update or insert character info
    tx.execute(
        r#"INSERT INTO characters (character, radical_number, total_strokes)
           VALUES (?, ?, ?)
           ON CONFLICT(character) DO UPDATE SET
               radical_number = COALESCE(excluded.radical_number, characters.radical_number),
               total_strokes = COALESCE(excluded.total_strokes, characters.total_strokes)"#,
        (
            &entry.character,
            &entry.radical_number,
            &entry.stroke_count,
        ),
    )?;

    Ok(entry_id)
}

/// Statistics from import
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
    fn test_parse_tab_format() {
        let line = "一\t惟初太始，道立於一，造分天地，化成萬物。";
        let entry = parse_text_line(line).unwrap();

        assert_eq!(entry.character, "一");
        assert!(entry.definition.contains("惟初太始"));
    }

    #[test]
    fn test_parse_colon_format() {
        let line = "一: 惟初太始";
        let entry = parse_text_line(line).unwrap();

        assert_eq!(entry.character, "一");
        assert_eq!(entry.definition, "惟初太始");
    }

    #[test]
    fn test_skip_empty_lines() {
        assert!(parse_text_line("").is_none());
        assert!(parse_text_line("# comment").is_none());
    }
}
