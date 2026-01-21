//! CC-CEDICT dictionary parser and importer.
//!
//! CC-CEDICT format: Traditional Simplified [pin1yin1] /definition1/definition2/
//! Example: 中文 中文 [Zhong1 wen2] /Chinese language/Chinese writing/

use crate::dictionary::models::{Definition, DictionarySource};
use rusqlite::{Connection, Result, Transaction};
use std::io::{BufRead, BufReader, Read};

/// A parsed CC-CEDICT entry before database insertion
#[derive(Debug)]
pub struct CedictEntry {
    pub traditional: String,
    pub simplified: String,
    pub pinyin: String,
    pub pinyin_display: String,
    pub definitions: Vec<String>,
}

/// Parse a single CC-CEDICT line
pub fn parse_line(line: &str) -> Option<CedictEntry> {
    let line = line.trim();

    // Skip comments and empty lines
    if line.is_empty() || line.starts_with('#') {
        return None;
    }

    // Format: Traditional Simplified [pinyin] /def1/def2/
    let parts: Vec<&str> = line.splitn(2, ' ').collect();
    if parts.len() < 2 {
        return None;
    }

    let traditional = parts[0].to_string();
    let rest = parts[1];

    let parts: Vec<&str> = rest.splitn(2, ' ').collect();
    if parts.len() < 2 {
        return None;
    }

    let simplified = parts[0].to_string();
    let rest = parts[1];

    // Extract pinyin between [ and ]
    let pinyin_start = rest.find('[')?;
    let pinyin_end = rest.find(']')?;
    let pinyin = rest[pinyin_start + 1..pinyin_end].to_string();

    // Extract definitions between / markers
    let defs_start = rest.find('/')?;
    let defs_str = &rest[defs_start..];
    let definitions: Vec<String> = defs_str
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    if definitions.is_empty() {
        return None;
    }

    let pinyin_display = convert_pinyin_to_display(&pinyin);

    Some(CedictEntry {
        traditional,
        simplified,
        pinyin,
        pinyin_display,
        definitions,
    })
}

/// Convert numbered pinyin to display pinyin with tone marks
/// e.g., "zhong1" -> "zhōng"
pub fn convert_pinyin_to_display(pinyin: &str) -> String {
    let mut result = String::new();

    for syllable in pinyin.split_whitespace() {
        if !result.is_empty() {
            result.push(' ');
        }
        result.push_str(&convert_syllable(syllable));
    }

    result
}

fn convert_syllable(syllable: &str) -> String {
    let syllable = syllable.to_lowercase();

    // Extract tone number if present
    let (base, tone) = if let Some(last) = syllable.chars().last() {
        if last.is_ascii_digit() {
            let tone = last.to_digit(10).unwrap_or(5) as usize;
            (&syllable[..syllable.len() - 1], tone)
        } else {
            (syllable.as_str(), 5) // neutral tone
        }
    } else {
        return syllable;
    };

    if tone == 5 || tone == 0 {
        return base.to_string();
    }

    // Tone mark mappings
    let tone_marks: [&[char]; 5] = [
        &['a', 'e', 'i', 'o', 'u', 'ü'],      // base
        &['ā', 'ē', 'ī', 'ō', 'ū', 'ǖ'],      // 1st tone
        &['á', 'é', 'í', 'ó', 'ú', 'ǘ'],      // 2nd tone
        &['ǎ', 'ě', 'ǐ', 'ǒ', 'ǔ', 'ǚ'],      // 3rd tone
        &['à', 'è', 'ì', 'ò', 'ù', 'ǜ'],      // 4th tone
    ];

    // Find vowel to mark (simplified rules)
    // 1. 'a' or 'e' always gets the mark
    // 2. 'ou' - mark the 'o'
    // 3. Otherwise mark the last vowel
    let base_chars: Vec<char> = base.chars().collect();
    let mut result: Vec<char> = base_chars.clone();

    let vowels = ['a', 'e', 'i', 'o', 'u', 'ü'];

    // Find which vowel to mark
    let mark_idx = if let Some(idx) = base_chars.iter().position(|&c| c == 'a' || c == 'e') {
        Some(idx)
    } else if base.contains("ou") {
        base_chars.iter().position(|&c| c == 'o')
    } else {
        // Find last vowel
        base_chars.iter().rposition(|c| vowels.contains(c))
    };

    if let Some(idx) = mark_idx {
        let vowel = base_chars[idx];
        if let Some(vowel_idx) = vowels.iter().position(|&v| v == vowel) {
            if tone >= 1 && tone <= 4 {
                result[idx] = tone_marks[tone][vowel_idx];
            }
        }
    }

    // Handle ü -> v in input
    result.iter().collect::<String>().replace("v", "ü")
}

/// Import CC-CEDICT data from a reader into the database
pub fn import_cedict<R: Read>(conn: &mut Connection, reader: R) -> Result<ImportStats> {
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

        if let Some(entry) = parse_line(&line) {
            if let Err(_) = insert_entry(&tx, &entry) {
                stats.errors += 1;
            } else {
                stats.entries_added += 1;
            }
        }
    }

    tx.commit()?;
    Ok(stats)
}

/// Insert a single entry into the database
fn insert_entry(tx: &Transaction, entry: &CedictEntry) -> Result<i64> {
    tx.execute(
        r#"INSERT INTO dictionary_entries
           (traditional, simplified, pinyin, pinyin_display, source)
           VALUES (?, ?, ?, ?, ?)"#,
        (
            &entry.traditional,
            &entry.simplified,
            &entry.pinyin,
            &entry.pinyin_display,
            DictionarySource::CcCedict.as_str(),
        ),
    )?;

    let entry_id = tx.last_insert_rowid();

    // Insert definitions
    for (idx, def) in entry.definitions.iter().enumerate() {
        tx.execute(
            r#"INSERT INTO definitions (entry_id, text, language, sort_order)
               VALUES (?, ?, 'en', ?)"#,
            (entry_id, def, idx as i32),
        )?;
    }

    Ok(entry_id)
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
    fn test_parse_basic_entry() {
        let line = "中文 中文 [Zhong1 wen2] /Chinese language/Chinese writing/";
        let entry = parse_line(line).unwrap();

        assert_eq!(entry.traditional, "中文");
        assert_eq!(entry.simplified, "中文");
        assert_eq!(entry.pinyin, "Zhong1 wen2");
        assert_eq!(entry.definitions.len(), 2);
        assert_eq!(entry.definitions[0], "Chinese language");
    }

    #[test]
    fn test_parse_different_forms() {
        let line = "傳統 传统 [chuan2 tong3] /tradition/traditional/";
        let entry = parse_line(line).unwrap();

        assert_eq!(entry.traditional, "傳統");
        assert_eq!(entry.simplified, "传统");
    }

    #[test]
    fn test_skip_comments() {
        let line = "# This is a comment";
        assert!(parse_line(line).is_none());
    }

    #[test]
    fn test_pinyin_conversion() {
        assert_eq!(convert_syllable("zhong1"), "zhōng");
        assert_eq!(convert_syllable("wen2"), "wén");
        assert_eq!(convert_syllable("ni3"), "nǐ");
        assert_eq!(convert_syllable("hao4"), "hào");
        assert_eq!(convert_syllable("ma5"), "ma");
    }

    #[test]
    fn test_pinyin_display() {
        assert_eq!(convert_pinyin_to_display("Zhong1 wen2"), "zhōng wén");
        assert_eq!(convert_pinyin_to_display("ni3 hao3"), "nǐ hǎo");
    }
}
