use std::collections::{HashMap, HashSet};

use rusqlite::Connection;

use super::error::{LibraryError, Result};

#[derive(Debug, Clone)]
pub struct ExportBook {
    pub shelf_id: i64,
    pub title: String,
    pub root: ExportSection,
}

#[derive(Debug, Clone)]
pub struct ExportSection {
    pub shelf_id: i64,
    pub title: String,
    pub chapters: Vec<ExportChapter>,
    pub children: Vec<ExportSection>,
}

#[derive(Debug, Clone)]
pub struct ExportChapter {
    pub text_id: i64,
    pub title: String,
    pub author: Option<String>,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct DefinitionContent {
    pub word: String,
    pub pinyin: Option<String>,
    pub definition: String,
}

#[derive(Debug, Clone)]
pub struct ExportDefinition {
    pub id: String,
    pub content: DefinitionContent,
}

#[derive(Debug, Clone)]
pub struct PreparedSegment {
    pub text: String,
    pub definition_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PreparedChapter {
    pub chapter: ExportChapter,
    pub segments: Vec<PreparedSegment>,
    pub definitions: Vec<ExportDefinition>,
}

pub fn prepare_chapter(
    conn: &Connection,
    chapter: &ExportChapter,
    cache: &mut HashMap<String, Option<DefinitionContent>>,
) -> Result<PreparedChapter> {
    let source_segments = super::analysis::segment_text(conn, &chapter.content)?;
    let mut linked_words = HashSet::new();
    let mut definitions = Vec::new();
    let mut segments = Vec::with_capacity(source_segments.len());

    for segment in source_segments {
        let eligible = segment.segment_type == "word" && !segment.is_known;
        let mut definition_id = None;
        if eligible && !linked_words.contains(&segment.text) {
            let content = if let Some(cached) = cache.get(&segment.text) {
                cached.clone()
            } else {
                let options = crate::dictionary::LookupOptions {
                    include_examples: false,
                    include_character_info: false,
                    include_user_dictionaries: false,
                    max_results: Some(10),
                    ..Default::default()
                };
                let result = crate::dictionary::lookup(conn, &segment.text, &options)?;
                let found = result.entries.into_iter().find_map(|entry| {
                    let definition = entry.definitions.first()?.text.trim().to_string();
                    if definition.is_empty() {
                        return None;
                    }
                    Some(DefinitionContent {
                        word: segment.text.clone(),
                        pinyin: entry
                            .pinyin_display
                            .filter(|value| !value.trim().is_empty())
                            .or_else(|| (!entry.pinyin.trim().is_empty()).then_some(entry.pinyin)),
                        definition,
                    })
                });
                cache.insert(segment.text.clone(), found.clone());
                found
            };
            if let Some(content) = content {
                let id = format!("def-{}-{}", chapter.text_id, definitions.len() + 1);
                definition_id = Some(id.clone());
                definitions.push(ExportDefinition { id, content });
                linked_words.insert(segment.text.clone());
            }
        }
        segments.push(PreparedSegment {
            text: segment.text,
            definition_id,
        });
    }

    Ok(PreparedChapter {
        chapter: chapter.clone(),
        segments,
        definitions,
    })
}

pub fn load_export_book(conn: &Connection, shelf_id: i64) -> Result<ExportBook> {
    let title: String = conn
        .query_row("SELECT name FROM shelves WHERE id = ?", [shelf_id], |row| {
            row.get(0)
        })
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => LibraryError::ShelfNotFound(shelf_id),
            other => other.into(),
        })?;
    let root = load_section(conn, shelf_id, title.clone())?;
    if chapter_count(&root) == 0 {
        return Err(LibraryError::InvalidInput("Shelf contains no texts".into()));
    }
    Ok(ExportBook {
        shelf_id,
        title,
        root,
    })
}

fn load_section(conn: &Connection, shelf_id: i64, title: String) -> Result<ExportSection> {
    let mut text_stmt = conn.prepare(
        "SELECT id, title, author, content FROM texts WHERE shelf_id = ? ORDER BY sort_order, created_at DESC, id",
    )?;
    let chapters = text_stmt
        .query_map([shelf_id], |row| {
            Ok(ExportChapter {
                text_id: row.get(0)?,
                title: row.get(1)?,
                author: row.get(2)?,
                content: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut child_stmt = conn.prepare(
        "SELECT id, name FROM shelves WHERE parent_id = ? ORDER BY sort_order, name, id",
    )?;
    let child_rows = child_stmt
        .query_map([shelf_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let children = child_rows
        .into_iter()
        .map(|(id, name)| load_section(conn, id, name))
        .collect::<Result<Vec<_>>>()?;

    Ok(ExportSection {
        shelf_id,
        title,
        chapters,
        children,
    })
}

fn chapter_count(section: &ExportSection) -> usize {
    section.chapters.len() + section.children.iter().map(chapter_count).sum::<usize>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictionary::schema::init_database;

    fn setup_export_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO shelves (id, name, sort_order) VALUES (1, 'Root', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO shelves (id, name, parent_id, sort_order) VALUES (2, 'Beta', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO shelves (id, name, parent_id, sort_order) VALUES (3, 'Alpha', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO shelves (id, name, parent_id, sort_order) VALUES (4, 'Grandchild', 3, 0)",
            [],
        )
        .unwrap();
        for (id, shelf_id, title, sort_order) in [
            (10, 1, "Root B", 2),
            (11, 1, "Root A", 1),
            (20, 2, "Beta Text", 0),
            (30, 3, "Alpha Text", 0),
            (40, 4, "Grand Text", 0),
        ] {
            conn.execute("INSERT INTO texts (id, shelf_id, title, content, character_count, sort_order) VALUES (?, ?, ?, ?, 1, ?)", rusqlite::params![id, shelf_id, title, title, sort_order]).unwrap();
        }
        conn
    }

    fn flatten(section: &ExportSection, ids: &mut Vec<i64>) {
        ids.extend(section.chapters.iter().map(|chapter| chapter.text_id));
        for child in &section.children {
            flatten(child, ids);
        }
    }

    #[test]
    fn load_export_preserves_text_first_depth_first_order() {
        let book = load_export_book(&setup_export_db(), 1).unwrap();
        assert_eq!(book.shelf_id, 1);
        assert_eq!(book.title, "Root");
        assert_eq!(
            book.root
                .chapters
                .iter()
                .map(|c| c.text_id)
                .collect::<Vec<_>>(),
            vec![11, 10]
        );
        assert_eq!(
            book.root
                .children
                .iter()
                .map(|s| s.title.as_str())
                .collect::<Vec<_>>(),
            vec!["Alpha", "Beta"]
        );
        let mut ids = Vec::new();
        flatten(&book.root, &mut ids);
        assert_eq!(ids, vec![11, 10, 30, 40, 20]);
    }

    #[test]
    fn load_export_rejects_missing_and_empty_shelves() {
        let conn = setup_export_db();
        assert!(matches!(
            load_export_book(&conn, 99),
            Err(LibraryError::ShelfNotFound(99))
        ));
        conn.execute(
            "INSERT INTO shelves (id, name, sort_order) VALUES (50, 'Empty', 0)",
            [],
        )
        .unwrap();
        assert!(
            matches!(load_export_book(&conn, 50), Err(LibraryError::InvalidInput(message)) if message == "Shelf contains no texts")
        );
    }

    fn seed_definition(conn: &Connection, word: &str, pinyin: &str, display: &str) {
        conn.execute("INSERT INTO dictionary_entries (traditional, simplified, pinyin, pinyin_display, source) VALUES (?, ?, ?, ?, 'cc_cedict')", rusqlite::params![word, word, pinyin, display]).unwrap();
        let id = conn.last_insert_rowid();
        conn.execute("INSERT INTO definitions (entry_id, text, language) VALUES (?, 'test definition', 'en')", [id]).unwrap();
    }

    #[test]
    fn prepare_chapter_links_first_unknown_word_and_preserves_misses() {
        let conn = setup_export_db();
        for word in ["救贖", "聖約", "未收錄詞語"] {
            crate::library::analysis::add_segmentation_word(word, Some(100));
        }
        seed_definition(&conn, "救贖", "jiu4 shu2", "jiùshú");
        seed_definition(&conn, "聖約", "sheng4 yue1", "shèngyuē");
        conn.execute(
            "INSERT INTO known_words (word, word_type, status) VALUES ('聖約', 'word', 'known')",
            [],
        )
        .unwrap();
        let chapter = ExportChapter {
            text_id: 77,
            title: "T".into(),
            author: None,
            content: "救贖帶來希望，救贖使人平安，聖約帶來力量，未收錄詞語。".into(),
        };
        let prepared =
            prepare_chapter(&conn, &chapter, &mut std::collections::HashMap::new()).unwrap();
        assert_eq!(
            prepared
                .definitions
                .iter()
                .map(|d| d.content.word.as_str())
                .collect::<Vec<_>>(),
            vec!["救贖"]
        );
        assert_eq!(
            prepared
                .segments
                .iter()
                .filter(|s| s.definition_id.is_some())
                .count(),
            1
        );
        assert_eq!(
            prepared.definitions[0].content.pinyin.as_deref(),
            Some("jiùshú")
        );
        assert!(prepared
            .segments
            .iter()
            .any(|s| s.text == "未收錄詞語" && s.definition_id.is_none()));
    }

    #[test]
    fn prepare_chapter_treats_learning_words_as_unknown() {
        let conn = setup_export_db();
        crate::library::analysis::add_segmentation_word("救贖", Some(100));
        seed_definition(&conn, "救贖", "jiu4 shu2", "jiùshú");
        conn.execute(
            "INSERT INTO known_words (word, word_type, status) VALUES ('救贖', 'word', 'learning')",
            [],
        )
        .unwrap();
        let chapter = ExportChapter {
            text_id: 78,
            title: "T".into(),
            author: None,
            content: "救贖".into(),
        };
        let prepared =
            prepare_chapter(&conn, &chapter, &mut std::collections::HashMap::new()).unwrap();
        assert_eq!(prepared.definitions.len(), 1);
    }
}
