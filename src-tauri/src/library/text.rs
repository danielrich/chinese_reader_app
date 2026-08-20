//! Text management for the library.
//!
//! Provides CRUD operations for texts stored in shelves.

use rusqlite::{params, Connection};
use std::fs;
use std::path::Path;

use super::error::{LibraryError, Result};
use super::models::{Text, TextSummary};
use super::shelf;

/// Maximum CJK characters per text section before splitting
pub const MAX_SECTION_CHARS: i64 = 1500;

/// Check if a character is CJK
fn is_cjk_character(c: char) -> bool {
    matches!(c, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}')
}

/// Count CJK characters in text
fn count_cjk_characters(content: &str) -> i64 {
    content.chars().filter(|c| is_cjk_character(*c)).count() as i64
}

/// Check if a character is a sentence-ending punctuation
fn is_sentence_end(c: char) -> bool {
    matches!(
        c,
        '。' | '！' | '？' | '；' | '\n' | '」' | '』' | '"' | '\'' | '…'
    )
}

/// Split text content into chunks of approximately max_chars CJK characters each.
/// Tries to split at sentence boundaries for cleaner sections.
fn split_text_content(content: &str, max_chars: i64) -> Vec<String> {
    let total_cjk = count_cjk_characters(content);

    // If content is small enough, return as-is
    if total_cjk <= max_chars {
        return vec![content.to_string()];
    }

    let mut sections = Vec::new();
    let mut current_section = String::new();
    let mut current_cjk_count: i64 = 0;
    let chars: Vec<char> = content.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        current_section.push(c);

        if is_cjk_character(c) {
            current_cjk_count += 1;
        }

        // Check if we've hit the target and are at a good breaking point
        if current_cjk_count >= max_chars {
            // Look for the next sentence end within a reasonable window
            let mut break_found = false;

            // First check if current char is a sentence end
            if is_sentence_end(c) {
                sections.push(current_section.trim().to_string());
                current_section = String::new();
                current_cjk_count = 0;
                break_found = true;
            }

            // Look ahead up to 200 chars for a sentence boundary
            if !break_found {
                let lookahead_limit = (i + 200).min(chars.len());
                for j in (i + 1)..lookahead_limit {
                    current_section.push(chars[j]);
                    if is_cjk_character(chars[j]) {
                        current_cjk_count += 1;
                    }

                    if is_sentence_end(chars[j]) {
                        sections.push(current_section.trim().to_string());
                        current_section = String::new();
                        current_cjk_count = 0;
                        i = j;
                        break_found = true;
                        break;
                    }
                }
            }

            // If no sentence boundary found, just break here
            if !break_found {
                sections.push(current_section.trim().to_string());
                current_section = String::new();
                current_cjk_count = 0;
            }
        }

        i += 1;
    }

    // Don't forget the last section
    let trimmed = current_section.trim().to_string();
    if !trimmed.is_empty() {
        sections.push(trimmed);
    }

    sections
}

/// Convert simplified Chinese to traditional Chinese (Taiwan with local idioms)
pub fn convert_to_traditional(content: &str) -> String {
    hanconv::s2twp(content)
}

/// Result of creating a text (may be split into multiple sections)
#[derive(Debug)]
pub struct CreateTextResult {
    /// The created text (or first section if split)
    pub text: Text,
    /// If the text was split, the shelf containing all sections
    pub section_shelf_id: Option<i64>,
    /// Total number of sections created (1 if not split)
    pub section_count: usize,
}

/// Create a new text
pub fn create_text(
    conn: &Connection,
    shelf_id: i64,
    title: &str,
    content: &str,
    author: Option<&str>,
    source_type: &str,
) -> Result<Text> {
    create_text_with_options(conn, shelf_id, title, content, author, source_type, false)
}

/// Create a new text with auto-splitting for large texts
pub fn create_text_with_splitting(
    conn: &Connection,
    shelf_id: i64,
    title: &str,
    content: &str,
    author: Option<&str>,
    source_type: &str,
    convert_to_trad: bool,
) -> Result<CreateTextResult> {
    // Optionally convert to traditional first
    let final_content = if convert_to_trad {
        convert_to_traditional(content)
    } else {
        content.to_string()
    };

    let cjk_count = count_cjk_characters(&final_content);

    // If small enough, create normally
    if cjk_count <= MAX_SECTION_CHARS {
        let text = create_text_internal(conn, shelf_id, title, &final_content, author, source_type)?;
        return Ok(CreateTextResult {
            text,
            section_shelf_id: None,
            section_count: 1,
        });
    }

    // Split into sections
    let sections = split_text_content(&final_content, MAX_SECTION_CHARS);

    // Create a sub-shelf for the sections
    let section_shelf = shelf::create_shelf(conn, title, None, Some(shelf_id))?;

    // Create texts for each section
    let mut first_text: Option<Text> = None;
    for (i, section_content) in sections.iter().enumerate() {
        let section_title = format!("{} section {}", title, i + 1);
        let text = create_text_internal(
            conn,
            section_shelf.id,
            &section_title,
            section_content,
            author,
            source_type,
        )?;

        // Set sort_order to maintain section ordering
        conn.execute(
            "UPDATE texts SET sort_order = ? WHERE id = ?",
            params![i as i64, text.id],
        )?;

        if first_text.is_none() {
            first_text = Some(text);
        }
    }

    Ok(CreateTextResult {
        text: first_text.unwrap(),
        section_shelf_id: Some(section_shelf.id),
        section_count: sections.len(),
    })
}

/// Internal function to create a single text without splitting
fn create_text_internal(
    conn: &Connection,
    shelf_id: i64,
    title: &str,
    content: &str,
    author: Option<&str>,
    source_type: &str,
) -> Result<Text> {
    let character_count = count_cjk_characters(content);

    conn.execute(
        "INSERT INTO texts (shelf_id, title, author, source_type, content, character_count)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![shelf_id, title, author, source_type, content, character_count],
    )?;

    let id = conn.last_insert_rowid();
    get_text(conn, id)?.ok_or(LibraryError::TextNotFound(id))
}

/// Create a new text with optional simplified-to-traditional conversion
/// Note: This does NOT auto-split large texts. Use create_text_with_splitting for that.
pub fn create_text_with_options(
    conn: &Connection,
    shelf_id: i64,
    title: &str,
    content: &str,
    author: Option<&str>,
    source_type: &str,
    convert_to_trad: bool,
) -> Result<Text> {
    // Validate shelf exists
    if shelf::get_shelf(conn, shelf_id)?.is_none() {
        return Err(LibraryError::ShelfNotFound(shelf_id));
    }

    // Optionally convert to traditional
    let final_content = if convert_to_trad {
        convert_to_traditional(content)
    } else {
        content.to_string()
    };

    create_text_internal(conn, shelf_id, title, &final_content, author, source_type)
}

/// Get a text by ID
pub fn get_text(conn: &Connection, id: i64) -> Result<Option<Text>> {
    let result = conn.query_row(
        "SELECT id, shelf_id, title, author, source_type, content, character_count, created_at, updated_at
         FROM texts WHERE id = ?",
        [id],
        |row| {
            Ok(Text {
                id: row.get(0)?,
                shelf_id: row.get(1)?,
                title: row.get(2)?,
                author: row.get(3)?,
                source_type: row.get(4)?,
                content: row.get(5)?,
                character_count: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        },
    );

    match result {
        Ok(text) => Ok(Some(text)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Search texts across all shelves by title substring. Returns up to 50 results.
pub fn search_texts(conn: &Connection, query: &str) -> Result<Vec<TextSummary>> {
    let pattern = format!("%{}%", query);
    let mut stmt = conn.prepare(
        "SELECT t.id, t.shelf_id, t.title, t.author, t.character_count, t.created_at,
                EXISTS(SELECT 1 FROM text_analyses WHERE text_id = t.id) as has_analysis
         FROM texts t
         WHERE t.title LIKE ?1
         ORDER BY t.title
         LIMIT 50",
    )?;

    let rows = stmt.query_map([&pattern], |row| {
        Ok(TextSummary {
            id: row.get(0)?,
            shelf_id: row.get(1)?,
            title: row.get(2)?,
            author: row.get(3)?,
            character_count: row.get(4)?,
            created_at: row.get(5)?,
            has_analysis: row.get(6)?,
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

/// List texts in a shelf (summaries only, without full content)
pub fn list_texts_in_shelf(conn: &Connection, shelf_id: i64) -> Result<Vec<TextSummary>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.shelf_id, t.title, t.author, t.character_count, t.created_at,
                EXISTS(SELECT 1 FROM text_analyses WHERE text_id = t.id) as has_analysis
         FROM texts t
         WHERE t.shelf_id = ?
         ORDER BY t.sort_order, t.created_at DESC",
    )?;

    let texts = stmt
        .query_map([shelf_id], |row| {
            Ok(TextSummary {
                id: row.get(0)?,
                shelf_id: row.get(1)?,
                title: row.get(2)?,
                author: row.get(3)?,
                character_count: row.get(4)?,
                created_at: row.get(5)?,
                has_analysis: row.get(6)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(texts)
}

/// Update a text's metadata (not content)
pub fn update_text(
    conn: &Connection,
    id: i64,
    title: Option<&str>,
    author: Option<Option<&str>>,
) -> Result<()> {
    // Check text exists
    if get_text(conn, id)?.is_none() {
        return Err(LibraryError::TextNotFound(id));
    }

    if let Some(new_title) = title {
        conn.execute(
            "UPDATE texts SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            params![new_title, id],
        )?;
    }

    if let Some(new_author) = author {
        conn.execute(
            "UPDATE texts SET author = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            params![new_author, id],
        )?;
    }

    Ok(())
}

/// Delete a text (cascades to analysis data)
pub fn delete_text(conn: &Connection, id: i64) -> Result<()> {
    // Check text exists
    if get_text(conn, id)?.is_none() {
        return Err(LibraryError::TextNotFound(id));
    }

    conn.execute("DELETE FROM texts WHERE id = ?", [id])?;
    Ok(())
}

/// Import a text from a file (auto-splits large texts)
pub fn import_text_file(conn: &Connection, shelf_id: i64, file_path: &str) -> Result<Text> {
    import_text_file_with_options(conn, shelf_id, file_path, false)
}

/// Import a text from a file with options (auto-splits large texts)
pub fn import_text_file_with_options(
    conn: &Connection,
    shelf_id: i64,
    file_path: &str,
    convert_to_trad: bool,
) -> Result<Text> {
    let path = Path::new(file_path);

    if !path.exists() {
        return Err(LibraryError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("File not found: {}", file_path),
        )));
    }

    let content = fs::read_to_string(path)?;

    // Use filename as title (without extension)
    let title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled");

    let result = create_text_with_splitting(conn, shelf_id, title, &content, None, "file", convert_to_trad)?;
    Ok(result.text)
}

/// Move a text to a different shelf
pub fn move_text(conn: &Connection, text_id: i64, new_shelf_id: i64) -> Result<()> {
    // Check text exists
    if get_text(conn, text_id)?.is_none() {
        return Err(LibraryError::TextNotFound(text_id));
    }

    // Check shelf exists
    if shelf::get_shelf(conn, new_shelf_id)?.is_none() {
        return Err(LibraryError::ShelfNotFound(new_shelf_id));
    }

    conn.execute(
        "UPDATE texts SET shelf_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        params![new_shelf_id, text_id],
    )?;

    Ok(())
}

/// Result of migrating large texts
#[derive(Debug, Default, serde::Serialize)]
pub struct MigrateLargeTextsResult {
    pub texts_migrated: usize,
    pub sections_created: usize,
    pub shelves_created: usize,
}

/// Migrate texts over MAX_SECTION_CHARS into shelves with sections
/// If shelf_id is provided, only migrate texts in that shelf (and sub-shelves)
pub fn migrate_large_texts(conn: &Connection, shelf_id: Option<i64>) -> Result<MigrateLargeTextsResult> {
    // Build query based on whether we're filtering by shelf
    let query = if let Some(sid) = shelf_id {
        format!(
            "SELECT id, shelf_id, title, author, content, source_type, sort_order
             FROM texts
             WHERE character_count > ?
             AND shelf_id IN (
                 WITH RECURSIVE shelf_tree AS (
                     SELECT id FROM shelves WHERE id = {}
                     UNION ALL
                     SELECT s.id FROM shelves s
                     JOIN shelf_tree st ON s.parent_id = st.id
                 )
                 SELECT id FROM shelf_tree
             )
             ORDER BY shelf_id, sort_order, id",
            sid
        )
    } else {
        "SELECT id, shelf_id, title, author, content, source_type, sort_order
         FROM texts
         WHERE character_count > ?
         ORDER BY shelf_id, sort_order, id".to_string()
    };

    let mut stmt = conn.prepare(&query)?;

    let large_texts: Vec<(i64, i64, String, Option<String>, String, String, i64)> = stmt
        .query_map([MAX_SECTION_CHARS], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut result = MigrateLargeTextsResult::default();

    for (text_id, shelf_id, title, author, content, source_type, sort_order) in large_texts {
        // Split the content
        let sections = split_text_content(&content, MAX_SECTION_CHARS);

        if sections.len() <= 1 {
            // Shouldn't happen, but skip if it does
            continue;
        }

        // Create a sub-shelf for the sections, preserving the original sort order
        let section_shelf = shelf::create_shelf(conn, &title, None, Some(shelf_id))?;

        // Update the section shelf's sort_order to match the original text's position
        conn.execute(
            "UPDATE shelves SET sort_order = ? WHERE id = ?",
            params![sort_order, section_shelf.id],
        )?;

        result.shelves_created += 1;

        // Create texts for each section
        for (i, section_content) in sections.iter().enumerate() {
            let section_title = format!("{} section {}", title, i + 1);
            let text = create_text_internal(
                conn,
                section_shelf.id,
                &section_title,
                section_content,
                author.as_deref(),
                &source_type,
            )?;

            // Set sort_order to maintain section ordering
            conn.execute(
                "UPDATE texts SET sort_order = ? WHERE id = ?",
                params![i as i64, text.id],
            )?;

            result.sections_created += 1;
        }

        // Delete the original large text
        conn.execute("DELETE FROM texts WHERE id = ?", [text_id])?;

        result.texts_migrated += 1;
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictionary::schema::init_database;
    use crate::library::shelf::create_shelf;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn).unwrap();
        conn
    }

    #[test]
    fn test_create_and_get_text() {
        let conn = setup_test_db();

        let shelf = create_shelf(&conn, "Test Shelf", None, None).unwrap();
        let text = create_text(
            &conn,
            shelf.id,
            "Test Text",
            "这是一个测试文本。",
            Some("Author"),
            "paste",
        )
        .unwrap();

        assert_eq!(text.title, "Test Text");
        assert_eq!(text.author, Some("Author".to_string()));
        assert_eq!(text.character_count, 8); // 8 CJK characters (这是一个测试文本)

        let retrieved = get_text(&conn, text.id).unwrap().unwrap();
        assert_eq!(retrieved.content, "这是一个测试文本。");
    }

    #[test]
    fn test_list_texts_in_shelf() {
        let conn = setup_test_db();

        let shelf = create_shelf(&conn, "Test Shelf", None, None).unwrap();
        create_text(&conn, shelf.id, "Text 1", "内容一", None, "paste").unwrap();
        create_text(&conn, shelf.id, "Text 2", "内容二", None, "paste").unwrap();

        let texts = list_texts_in_shelf(&conn, shelf.id).unwrap();
        assert_eq!(texts.len(), 2);
    }

    #[test]
    fn test_delete_text() {
        let conn = setup_test_db();

        let shelf = create_shelf(&conn, "Test Shelf", None, None).unwrap();
        let text = create_text(&conn, shelf.id, "To Delete", "删除测试", None, "paste").unwrap();

        delete_text(&conn, text.id).unwrap();
        assert!(get_text(&conn, text.id).unwrap().is_none());
    }

    #[test]
    fn test_cjk_character_count() {
        assert_eq!(count_cjk_characters("Hello 世界!"), 2);
        assert_eq!(count_cjk_characters("这是中文测试"), 6);
        assert_eq!(count_cjk_characters("No Chinese"), 0);
    }

    #[test]
    fn test_search_texts_by_title() {
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn).unwrap();
        conn.execute("INSERT INTO shelves (id, name, sort_order) VALUES (1, 'S', 0)", []).unwrap();
        conn.execute("INSERT INTO texts (shelf_id, title, content, character_count) VALUES (1, '復活節講話', 'x', 50)", []).unwrap();
        conn.execute("INSERT INTO texts (shelf_id, title, content, character_count) VALUES (1, '信心與希望', 'x', 60)", []).unwrap();

        let results = search_texts(&conn, "復活").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "復活節講話");
    }
}
