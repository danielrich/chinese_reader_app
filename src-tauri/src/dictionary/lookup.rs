//! Dictionary lookup functionality.
//!
//! Provides unified search across all dictionary sources.

use crate::dictionary::models::*;
use rusqlite::{Connection, Result};

/// Lookup a term across all configured dictionaries
pub fn lookup(conn: &Connection, query: &str, options: &LookupOptions) -> Result<LookupResult> {
    let mut result = LookupResult {
        query: query.to_string(),
        entries: Vec::new(),
        character_info: None,
        user_entries: Vec::new(),
    };

    // Lookup in main dictionaries
    let entries = lookup_entries(conn, query, options)?;
    result.entries = entries;

    // Get character info if single character and requested
    if options.include_character_info && query.chars().count() == 1 {
        result.character_info = lookup_character(conn, query)?;
    }

    // Lookup in user dictionaries if requested
    if options.include_user_dictionaries {
        result.user_entries = lookup_user_entries(conn, query, options)?;
    }

    Ok(result)
}

/// Lookup entries in the main dictionaries
fn lookup_entries(
    conn: &Connection,
    query: &str,
    options: &LookupOptions,
) -> Result<Vec<DictionaryEntry>> {
    let mut entries = Vec::new();

    // Build source filter
    let source_filter = if options.sources.is_empty() {
        String::new()
    } else {
        let sources: Vec<String> = options
            .sources
            .iter()
            .map(|s| format!("'{}'", s.as_str()))
            .collect();
        format!("AND source IN ({})", sources.join(", "))
    };

    let limit = options.max_results.unwrap_or(100);

    // Search by exact Han forms or case-insensitive pinyin prefix.
    let sql = lookup_entries_sql(query, &source_filter);

    let mut stmt = conn.prepare(&sql)?;
    let rows = if contains_han(query) {
        stmt.query_map((query, query, query, limit as i64), entry_row)?
    } else {
        let pinyin_query = query.to_lowercase();
        let pinyin_upper_bound = format!("{pinyin_query}\u{10FFFF}");
        stmt.query_map(
            (
                &pinyin_query,
                &pinyin_upper_bound,
                &pinyin_query,
                query,
                limit as i64,
            ),
            entry_row,
        )?
    };

    for row in rows {
        let row = row?;
        let entry = build_entry(conn, row, options.include_examples)?;
        entries.push(entry);
    }

    Ok(entries)
}

/// Returns whether a query contains a Han ideograph.
pub fn contains_han(query: &str) -> bool {
    query.chars().any(|character| {
        matches!(
            character,
            '\u{3400}'..='\u{4DBF}'
                | '\u{4E00}'..='\u{9FFF}'
                | '\u{F900}'..='\u{FAFF}'
                | '\u{20000}'..='\u{2EBEF}'
                | '\u{2EBF0}'..='\u{2EE5D}'
                | '\u{2F800}'..='\u{2FA1F}'
                | '\u{30000}'..='\u{3134A}'
                | '\u{31350}'..='\u{323AF}'
        )
    })
}

fn lookup_entries_sql(query: &str, source_filter: &str) -> String {
    let select = r#"SELECT id, traditional, simplified, pinyin, pinyin_display, zhuyin,
                  source, frequency_rank, hsk_level, tocfl_level
           FROM dictionary_entries"#;
    let ordering = r#"ORDER BY
               CASE WHEN traditional = ? THEN 0 ELSE 1 END,
               frequency_rank NULLS LAST
           LIMIT ?"#;

    if contains_han(query) {
        format!(
            r#"{select}
           WHERE (traditional = ? OR simplified = ?)
           {source_filter}
           {ordering}"#
        )
    } else {
        format!(
            r#"{select}
           WHERE pinyin COLLATE NOCASE >= ?
             AND pinyin COLLATE NOCASE < ?
             AND pinyin LIKE (? || '%') COLLATE NOCASE
           {source_filter}
           {ordering}"#
        )
    }
}

fn entry_row(row: &rusqlite::Row<'_>) -> Result<EntryRow> {
    Ok(EntryRow {
        id: row.get(0)?,
        traditional: row.get(1)?,
        simplified: row.get(2)?,
        pinyin: row.get(3)?,
        pinyin_display: row.get(4)?,
        zhuyin: row.get(5)?,
        source: row.get(6)?,
        frequency_rank: row.get(7)?,
        hsk_level: row.get(8)?,
        tocfl_level: row.get(9)?,
    })
}

struct EntryRow {
    id: i64,
    traditional: String,
    simplified: String,
    pinyin: String,
    pinyin_display: Option<String>,
    zhuyin: Option<String>,
    source: String,
    frequency_rank: Option<i32>,
    hsk_level: Option<i32>,
    tocfl_level: Option<i32>,
}

fn build_entry(
    conn: &Connection,
    row: EntryRow,
    include_examples: bool,
) -> Result<DictionaryEntry> {
    // Get definitions
    let definitions = get_definitions(conn, row.id)?;

    // Get examples if requested
    let examples = if include_examples {
        get_examples(conn, row.id)?
    } else {
        Vec::new()
    };

    let source = match row.source.as_str() {
        "cc_cedict" => DictionarySource::CcCedict,
        "moe_dict" => DictionarySource::MoeDict,
        "kangxi" => DictionarySource::Kangxi,
        "ctext" => DictionarySource::Ctext,
        "user" => DictionarySource::User,
        _ => DictionarySource::User,
    };

    Ok(DictionaryEntry {
        id: row.id,
        traditional: row.traditional,
        simplified: row.simplified,
        pinyin: row.pinyin,
        pinyin_display: row.pinyin_display,
        zhuyin: row.zhuyin,
        definitions,
        examples,
        source,
        frequency_rank: row.frequency_rank,
        hsk_level: row.hsk_level,
        tocfl_level: row.tocfl_level,
    })
}

fn get_definitions(conn: &Connection, entry_id: i64) -> Result<Vec<Definition>> {
    let mut stmt = conn.prepare(
        r#"SELECT text, part_of_speech, language
           FROM definitions
           WHERE entry_id = ?
           ORDER BY sort_order"#,
    )?;

    let rows = stmt.query_map([entry_id], |row| {
        Ok(Definition {
            text: row.get(0)?,
            part_of_speech: row.get(1)?,
            language: row.get(2)?,
        })
    })?;

    rows.collect()
}

fn get_examples(conn: &Connection, entry_id: i64) -> Result<Vec<UsageExample>> {
    let mut stmt = conn.prepare(
        r#"SELECT text, translation, source, source_detail
           FROM usage_examples
           WHERE entry_id = ?
           ORDER BY sort_order
           LIMIT 10"#,
    )?;

    let rows = stmt.query_map([entry_id], |row| {
        Ok(UsageExample {
            text: row.get(0)?,
            translation: row.get(1)?,
            source: row.get(2)?,
            source_detail: row.get(3)?,
        })
    })?;

    rows.collect()
}

/// Lookup character-specific information
fn lookup_character(conn: &Connection, character: &str) -> Result<Option<CharacterEntry>> {
    let result = conn.query_row(
        r#"SELECT character, radical_number, radical, additional_strokes,
                  total_strokes, decomposition, etymology, traditional_form, simplified_form
           FROM characters
           WHERE character = ?"#,
        [character],
        |row| {
            Ok(CharacterEntry {
                character: row.get(0)?,
                radical_number: row.get(1)?,
                radical: row.get(2)?,
                additional_strokes: row.get(3)?,
                total_strokes: row.get(4)?,
                decomposition: row.get(5)?,
                etymology: row.get(6)?,
                variants: Vec::new(), // Will be filled below
                traditional_form: row.get(7)?,
                simplified_form: row.get(8)?,
            })
        },
    );

    match result {
        Ok(mut entry) => {
            // Get variants
            entry.variants = get_character_variants(conn, character)?;
            Ok(Some(entry))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

fn get_character_variants(conn: &Connection, character: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(r#"SELECT variant FROM character_variants WHERE character = ?"#)?;

    let rows = stmt.query_map([character], |row| row.get(0))?;
    rows.collect()
}

/// Lookup entries in user dictionaries
fn lookup_user_entries(
    conn: &Connection,
    query: &str,
    options: &LookupOptions,
) -> Result<Vec<UserDictionaryEntry>> {
    let dict_filter = if options.user_dictionary_ids.is_empty() {
        String::new()
    } else {
        let ids: Vec<String> = options
            .user_dictionary_ids
            .iter()
            .map(|id| id.to_string())
            .collect();
        format!("AND dictionary_id IN ({})", ids.join(", "))
    };

    let sql = format!(
        r#"SELECT id, dictionary_id, term, pinyin, definition, notes, created_at, updated_at
           FROM user_dictionary_entries
           WHERE term = ?
           {}
           LIMIT 50"#,
        dict_filter
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([query], |row| {
        Ok(UserDictionaryEntry {
            id: row.get(0)?,
            dictionary_id: row.get(1)?,
            term: row.get(2)?,
            pinyin: row.get(3)?,
            definition: row.get(4)?,
            notes: row.get(5)?,
            tags: Vec::new(), // Filled below
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    })?;

    let mut entries = Vec::new();
    for row in rows {
        let mut entry = row?;
        entry.tags = get_user_entry_tags(conn, entry.id)?;
        entries.push(entry);
    }

    Ok(entries)
}

fn get_user_entry_tags(conn: &Connection, entry_id: i64) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(r#"SELECT tag FROM user_entry_tags WHERE entry_id = ?"#)?;

    let rows = stmt.query_map([entry_id], |row| row.get(0))?;
    rows.collect()
}

/// Full-text search across all entries
pub fn search_fulltext(
    conn: &Connection,
    query: &str,
    options: &LookupOptions,
) -> Result<Vec<DictionaryEntry>> {
    let limit = options.max_results.unwrap_or(50);

    let mut stmt = conn.prepare(
        r#"SELECT e.id, e.traditional, e.simplified, e.pinyin, e.pinyin_display, e.zhuyin,
                  e.source, e.frequency_rank, e.hsk_level, e.tocfl_level
           FROM entries_fts f
           JOIN dictionary_entries e ON f.rowid = e.id
           WHERE entries_fts MATCH ?
           ORDER BY rank
           LIMIT ?"#,
    )?;

    let rows = stmt.query_map((query, limit as i64), |row| {
        Ok(EntryRow {
            id: row.get(0)?,
            traditional: row.get(1)?,
            simplified: row.get(2)?,
            pinyin: row.get(3)?,
            pinyin_display: row.get(4)?,
            zhuyin: row.get(5)?,
            source: row.get(6)?,
            frequency_rank: row.get(7)?,
            hsk_level: row.get(8)?,
            tocfl_level: row.get(9)?,
        })
    })?;

    let mut entries = Vec::new();
    for row in rows {
        let row = row?;
        let entry = build_entry(conn, row, options.include_examples)?;
        entries.push(entry);
    }

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictionary::schema::init_database;
    fn dictionary_entries_query_plan(
        conn: &Connection,
        query: &str,
        source_filter: &str,
    ) -> Vec<String> {
        let sql = lookup_entries_sql(query, source_filter);
        let explain_sql = format!("EXPLAIN QUERY PLAN {sql}");
        let mut stmt = conn.prepare(&explain_sql).unwrap();

        if contains_han(query) {
            stmt.query_map((query, query, query, 100_i64), |row| row.get(3))
                .unwrap()
                .collect::<Result<Vec<String>, _>>()
                .unwrap()
        } else {
            let pinyin_query = query.to_lowercase();
            let upper_bound = format!("{pinyin_query}\u{10FFFF}");
            stmt.query_map(
                (&pinyin_query, &upper_bound, &pinyin_query, query, 100_i64),
                |row| row.get(3),
            )
            .unwrap()
            .collect::<Result<Vec<String>, _>>()
            .unwrap()
        }
    }

    fn setup_test_db() -> Connection {
        fn insert_entry(
            conn: &Connection,
            traditional: &str,
            simplified: &str,
            pinyin: &str,
            source: &str,
            frequency_rank: i32,
        ) -> i64 {
            conn.execute(
                r#"INSERT INTO dictionary_entries
                   (traditional, simplified, pinyin, pinyin_display, source, frequency_rank)
                   VALUES (?, ?, ?, ?, ?, ?)"#,
                (
                    traditional,
                    simplified,
                    pinyin,
                    pinyin,
                    source,
                    frequency_rank,
                ),
            )
            .unwrap();
            conn.last_insert_rowid()
        }

        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn).unwrap();

        // Insert test data
        let entry_id = insert_entry(&conn, "測試", "测试", "ce4 shi4", "cc_cedict", 1);

        conn.execute(
            r#"INSERT INTO definitions (entry_id, text, language) VALUES (?, 'test', 'en')"#,
            [entry_id],
        )
        .unwrap();

        conn.execute(
            r#"INSERT INTO usage_examples (entry_id, text, translation, sort_order)
               VALUES (?, '這是測試', 'This is a test.', 0)"#,
            [entry_id],
        )
        .unwrap();

        let query_id = insert_entry(&conn, "查詢", "查询", "Cha2 xun2", "cc_cedict", 2);
        conn.execute(
            r#"INSERT INTO definitions (entry_id, text, language) VALUES (?, 'query', 'en')"#,
            [query_id],
        )
        .unwrap();

        let traditional_id = insert_entry(&conn, "傳統", "传统", "Chuan2 tong3", "moe_dict", 3);
        conn.execute(
            r#"INSERT INTO definitions (entry_id, text, language) VALUES (?, 'tradition', 'en')"#,
            [traditional_id],
        )
        .unwrap();

        let tone_id = insert_entry(&conn, "側", "侧", "cè", "cc_cedict", 4);
        conn.execute(
            r#"INSERT INTO definitions (entry_id, text, language) VALUES (?, 'side', 'en')"#,
            [tone_id],
        )
        .unwrap();

        let er_id = insert_entry(&conn, "兒", "儿", "èr", "cc_cedict", 5);
        conn.execute(
            r#"INSERT INTO definitions (entry_id, text, language) VALUES (?, 'child', 'en')"#,
            [er_id],
        )
        .unwrap();

        insert_entry(&conn, "\u{30000}", "\u{30000}", "extension g", "kangxi", 6);
        insert_entry(&conn, "\u{31350}", "\u{31350}", "extension h", "kangxi", 7);

        conn
    }

    #[test]
    fn test_basic_lookup() {
        let conn = setup_test_db();
        let options = LookupOptions::default();

        let result = lookup(&conn, "測試", &options).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].traditional, "測試");
    }

    #[test]
    fn test_simplified_lookup() {
        let conn = setup_test_db();
        let options = LookupOptions::default();

        let result = lookup(&conn, "测试", &options).unwrap();
        assert_eq!(result.entries.len(), 1);
    }

    #[test]
    fn test_lookup_preserves_han_results_and_case_insensitive_pinyin_prefixes() {
        let conn = setup_test_db();
        let options = LookupOptions {
            include_examples: true,
            ..LookupOptions::default()
        };

        let traditional = lookup(&conn, "測試", &options).unwrap();
        assert_eq!(traditional.entries.len(), 1);
        assert_eq!(traditional.entries[0].traditional, "測試");
        assert_eq!(traditional.entries[0].definitions[0].text, "test");
        assert_eq!(traditional.entries[0].examples[0].text, "這是測試");

        let simplified = lookup(&conn, "测试", &options).unwrap();
        assert_eq!(simplified.entries.len(), 1);
        assert_eq!(simplified.entries[0].simplified, "测试");

        let pinyin = lookup(&conn, "cHa2", &options).unwrap();
        assert_eq!(pinyin.entries.len(), 1);
        assert_eq!(pinyin.entries[0].traditional, "查詢");
    }

    #[test]
    fn test_contains_han_includes_unified_and_compatibility_ideographs() {
        assert!(contains_han("測試"));
        assert!(contains_han("\u{2F800}"));
        assert!(contains_han("\u{2EBF0}"));
        assert!(contains_han("\u{30000}"));
        assert!(contains_han("\u{31350}"));
        assert!(!contains_han("cHa2 xun2"));
    }

    #[test]
    fn test_lookup_normalizes_unicode_tone_case_for_pinyin_prefixes() {
        let conn = setup_test_db();
        let options = LookupOptions::default();

        let ce = lookup(&conn, "cÈ", &options).unwrap();
        assert_eq!(ce.entries.len(), 1);
        assert_eq!(ce.entries[0].traditional, "側");

        let er = lookup(&conn, "Èr", &options).unwrap();
        assert_eq!(er.entries.len(), 1);
        assert_eq!(er.entries[0].traditional, "兒");
    }

    #[test]
    fn test_lookup_uses_exact_han_path_for_extension_g_and_h() {
        let conn = setup_test_db();
        let options = LookupOptions::default();

        let extension_g = lookup(&conn, "\u{30000}", &options).unwrap();
        assert_eq!(extension_g.entries.len(), 1);
        assert_eq!(extension_g.entries[0].traditional, "\u{30000}");

        let extension_h = lookup(&conn, "\u{31350}", &options).unwrap();
        assert_eq!(extension_h.entries.len(), 1);
        assert_eq!(extension_h.entries[0].traditional, "\u{31350}");
    }

    #[test]
    fn test_lookup_query_plans_use_dictionary_indexes_without_full_scans() {
        let conn = setup_test_db();

        let han_plan = dictionary_entries_query_plan(&conn, "測試", "");
        assert!(
            !han_plan
                .iter()
                .any(|detail| detail.contains("SCAN dictionary_entries")),
            "Han lookup full-scanned dictionary_entries:\n{}",
            han_plan.join("\n")
        );
        assert!(
            han_plan
                .iter()
                .any(|detail| detail.contains("idx_entries_traditional")),
            "Han lookup did not use idx_entries_traditional:\n{}",
            han_plan.join("\n")
        );
        assert!(
            han_plan
                .iter()
                .any(|detail| detail.contains("idx_entries_simplified")),
            "Han lookup did not use idx_entries_simplified:\n{}",
            han_plan.join("\n")
        );

        let pinyin_plan = dictionary_entries_query_plan(&conn, "cHa2", "");
        assert!(
            !pinyin_plan
                .iter()
                .any(|detail| detail.contains("SCAN dictionary_entries")),
            "Pinyin lookup full-scanned dictionary_entries:\n{}",
            pinyin_plan.join("\n")
        );
        assert!(
            pinyin_plan
                .iter()
                .any(|detail| detail.contains("idx_entries_pinyin_nocase")),
            "Pinyin lookup did not use idx_entries_pinyin_nocase:\n{}",
            pinyin_plan.join("\n")
        );

        let unicode_tone_plan = dictionary_entries_query_plan(&conn, "cÈ", "");
        assert!(
            !unicode_tone_plan
                .iter()
                .any(|detail| detail.contains("SCAN dictionary_entries")),
            "Unicode-tone pinyin lookup full-scanned dictionary_entries:\n{}",
            unicode_tone_plan.join("\n")
        );
        assert!(
            unicode_tone_plan
                .iter()
                .any(|detail| detail.contains("idx_entries_pinyin_nocase")),
            "Unicode-tone pinyin lookup did not use idx_entries_pinyin_nocase:\n{}",
            unicode_tone_plan.join("\n")
        );
    }
}
