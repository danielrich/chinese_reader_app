use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Write};

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

#[derive(Debug, Clone)]
pub struct ExportedEpub {
    pub bytes: Vec<u8>,
    pub filename: String,
}

struct RenderedChapter {
    id: String,
    href: String,
    xhtml: String,
}

const MAX_EXPORT_BYTES: usize = 200 * 1024 * 1024;
const EPUB_CSS: &str = r#"body { font-family: serif; line-height: 1.65; margin: 5%; }
.unknown { text-decoration: underline; text-decoration-style: dotted; font-weight: 600; }
.definition-page-wrapper { break-before: page; page-break-before: always; break-after: page; page-break-after: always; }
.back-link { display: block; margin-top: 2em; font-weight: 700; }
.pinyin { font-style: italic; }
"#;

pub fn export_shelf_epub(conn: &Connection, shelf_id: i64) -> Result<ExportedEpub> {
    preflight_export_size(conn, shelf_id, MAX_EXPORT_BYTES)?;
    let book = load_export_book(conn, shelf_id)?;
    let bytes = build_epub(conn, &book)?;
    let filename = format!("{}.epub", sanitize_filename(&book.title));
    Ok(ExportedEpub { bytes, filename })
}

pub fn build_epub(conn: &Connection, book: &ExportBook) -> Result<Vec<u8>> {
    build_epub_with_limit(conn, book, MAX_EXPORT_BYTES)
}

fn build_epub_with_limit(conn: &Connection, book: &ExportBook, limit: usize) -> Result<Vec<u8>> {
    let estimated = estimated_content_bytes(&book.root);
    if estimated > limit {
        return Err(LibraryError::InvalidInput(
            "EPUB export is too large".into(),
        ));
    }
    let mut source = Vec::new();
    collect_chapters(&book.root, &mut source);
    let chapter_ids: HashMap<i64, String> = source
        .iter()
        .map(|chapter| (chapter.text_id, format!("chapter-{}", chapter.text_id)))
        .collect();
    let mut cache = HashMap::new();
    let mut generated_bytes = 0usize;
    let mut chapters = Vec::with_capacity(source.len());
    for chapter in source {
        let prepared = prepare_chapter(conn, chapter, &mut cache)?;
        generated_bytes = generated_bytes
            .checked_add(prepared_render_upper_bound(&prepared))
            .filter(|total| *total <= limit)
            .ok_or_else(|| LibraryError::InvalidInput("EPUB export is too large".into()))?;
        let rendered = RenderedChapter {
            id: format!("chapter-{}", chapter.text_id),
            href: format!("chapter-{}.xhtml", chapter.text_id),
            xhtml: render_chapter(&prepared),
        };
        chapters.push(rendered);
    }

    let modified = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let entries = [
        ("META-INF/container.xml", r#"<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#.to_string()),
        ("OEBPS/style.css", EPUB_CSS.to_string()),
        ("OEBPS/nav.xhtml", render_nav(book, &chapter_ids)),
        ("OEBPS/content.opf", render_package(book, &chapters, &modified)),
    ];
    let cursor = Cursor::new(Vec::with_capacity(estimated.min(limit)));
    let mut zip = zip::ZipWriter::new(cursor);
    zip.start_file(
        "mimetype",
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored),
    )
    .map_err(zip_error)?;
    zip.write_all(b"application/epub+zip")?;
    let deflated =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, content) in entries {
        zip.start_file(name, deflated).map_err(zip_error)?;
        zip.write_all(content.as_bytes())?;
    }
    for chapter in &chapters {
        zip.start_file(format!("OEBPS/{}", chapter.href), deflated)
            .map_err(zip_error)?;
        zip.write_all(chapter.xhtml.as_bytes())?;
    }
    Ok(zip.finish().map_err(zip_error)?.into_inner())
}

fn preflight_export_size(conn: &Connection, shelf_id: i64, limit: usize) -> Result<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM shelves WHERE id = ?)",
        [shelf_id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(LibraryError::ShelfNotFound(shelf_id));
    }
    let bytes: i64 = conn.query_row(
        "WITH RECURSIVE shelf_tree(id) AS (SELECT id FROM shelves WHERE id = ? UNION ALL SELECT s.id FROM shelves s JOIN shelf_tree st ON s.parent_id = st.id) SELECT COALESCE(SUM(LENGTH(CAST(t.content AS BLOB)) + LENGTH(CAST(t.title AS BLOB)) + COALESCE(LENGTH(CAST(t.author AS BLOB)), 0)), 0) FROM texts t WHERE t.shelf_id IN (SELECT id FROM shelf_tree)",
        [shelf_id], |row| row.get(0))?;
    if bytes as usize > limit {
        return Err(LibraryError::InvalidInput(
            "EPUB export is too large".into(),
        ));
    }
    Ok(())
}

fn prepared_render_upper_bound(prepared: &PreparedChapter) -> usize {
    let escaped = |value: &str| value.len().saturating_mul(6);
    let segment_bytes = prepared
        .segments
        .iter()
        .map(|segment| {
            escaped(&segment.text).saturating_add(if segment.definition_id.is_some() {
                256
            } else {
                0
            })
        })
        .sum::<usize>();
    let definition_bytes = prepared
        .definitions
        .iter()
        .map(|definition| {
            escaped(&definition.content.word)
                .saturating_add(definition.content.pinyin.as_deref().map_or(0, escaped))
                .saturating_add(escaped(&definition.content.definition))
                .saturating_add(512)
        })
        .sum::<usize>();
    segment_bytes
        .saturating_add(definition_bytes)
        .saturating_add(2048)
}

fn zip_error(error: zip::result::ZipError) -> LibraryError {
    LibraryError::Io(std::io::Error::new(std::io::ErrorKind::Other, error))
}

fn estimated_content_bytes(section: &ExportSection) -> usize {
    section.title.len()
        + section
            .chapters
            .iter()
            .map(|c| c.title.len() + c.author.as_ref().map_or(0, String::len) + c.content.len())
            .sum::<usize>()
        + section
            .children
            .iter()
            .map(estimated_content_bytes)
            .sum::<usize>()
}

fn collect_chapters<'a>(section: &'a ExportSection, output: &mut Vec<&'a ExportChapter>) {
    output.extend(section.chapters.iter());
    for child in &section.children {
        collect_chapters(child, output);
    }
}

fn sanitize_filename(value: &str) -> String {
    let value: String = value
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "shelf".into()
    } else {
        trimmed.into()
    }
}

fn sanitize_xml_text(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for character in value.chars().filter(|c| matches!(*c, '\u{9}' | '\u{A}' | '\u{D}' | '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..='\u{10FFFF}')) {
        match character {
            '&' => result.push_str("&amp;"), '<' => result.push_str("&lt;"), '>' => result.push_str("&gt;"),
            '"' => result.push_str("&quot;"), '\'' => result.push_str("&apos;"), _ => result.push(character),
        }
    }
    result
}

fn render_chapter(prepared: &PreparedChapter) -> String {
    let mut body = String::new();
    for segment in &prepared.segments {
        let text = sanitize_xml_text(&segment.text);
        if let Some(id) = &segment.definition_id {
            let ordinal = prepared
                .definitions
                .iter()
                .position(|d| &d.id == id)
                .unwrap()
                + 1;
            body.push_str(&format!("<a id=\"source-{}-{}\" class=\"unknown\" epub:type=\"noteref\" href=\"#{}\">{}</a>", prepared.chapter.text_id, ordinal, id, text));
        } else {
            body.push_str(&text);
        }
    }
    let definitions = prepared.definitions.iter().enumerate().map(|(index, definition)| {
        let pinyin = definition.content.pinyin.as_ref().map(|p| format!("<p class=\"pinyin\">{}</p>", sanitize_xml_text(p))).unwrap_or_default();
        format!("<section class=\"definition-page-wrapper\"><aside epub:type=\"footnote\" id=\"{}\"><h2>{}</h2>{}<p>{}</p><a class=\"back-link\" href=\"#source-{}-{}\">Back to reading</a></aside></section>", definition.id, sanitize_xml_text(&definition.content.word), pinyin, sanitize_xml_text(&definition.content.definition), prepared.chapter.text_id, index + 1)
    }).collect::<String>();
    let author = prepared
        .chapter
        .author
        .as_ref()
        .map(|a| format!("<p class=\"author\">{}</p>", sanitize_xml_text(a)))
        .unwrap_or_default();
    let paragraphs = body
        .split("\n\n")
        .map(|paragraph| format!("<p>{}</p>", paragraph.replace('\n', "<br/>")))
        .collect::<String>();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>{}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><article><h1>{}</h1>{}{}</article>{}</body></html>"#,
        sanitize_xml_text(&prepared.chapter.title),
        sanitize_xml_text(&prepared.chapter.title),
        author,
        paragraphs,
        definitions
    )
}

fn first_chapter_id(section: &ExportSection) -> Option<i64> {
    section
        .chapters
        .first()
        .map(|c| c.text_id)
        .or_else(|| section.children.iter().find_map(first_chapter_id))
}

fn render_nav(book: &ExportBook, chapter_ids: &HashMap<i64, String>) -> String {
    fn render_section(section: &ExportSection, ids: &HashMap<i64, String>) -> String {
        let link = first_chapter_id(section)
            .and_then(|id| ids.get(&id))
            .map(|id| format!("{}.xhtml", id))
            .unwrap_or_default();
        let mut items = section
            .chapters
            .iter()
            .map(|c| {
                format!(
                    "<li><a href=\"chapter-{}.xhtml\">{}</a></li>",
                    c.text_id,
                    sanitize_xml_text(&c.title)
                )
            })
            .collect::<String>();
        items.push_str(
            &section
                .children
                .iter()
                .map(|c| render_section(c, ids))
                .collect::<String>(),
        );
        format!(
            "<li><a href=\"{}\">{}</a><ol>{}</ol></li>",
            link,
            sanitize_xml_text(&section.title),
            items
        )
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>{}</title></head><body><nav epub:type="toc"><h1>{}</h1><ol>{}</ol></nav></body></html>"#,
        sanitize_xml_text(&book.title),
        sanitize_xml_text(&book.title),
        render_section(&book.root, chapter_ids)
    )
}

fn render_package(book: &ExportBook, chapters: &[RenderedChapter], modified: &str) -> String {
    let manifest = chapters
        .iter()
        .map(|c| {
            format!(
                "<item id=\"{}\" href=\"{}\" media-type=\"application/xhtml+xml\"/>",
                c.id, c.href
            )
        })
        .collect::<String>();
    let spine = chapters
        .iter()
        .map(|c| format!("<itemref idref=\"{}\"/>", c.id))
        .collect::<String>();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">shelf-{}</dc:identifier><dc:title>{}</dc:title><dc:language>zh-Hant</dc:language><meta property="dcterms:modified">{}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>{}</manifest><spine>{}</spine></package>"#,
        book.shelf_id,
        sanitize_xml_text(&book.title),
        modified,
        manifest,
        spine
    )
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
                let found = match crate::dictionary::lookup(conn, &segment.text, &options) {
                    Ok(result) => result.entries.into_iter().find_map(|entry| {
                        let definition = entry.definitions.first()?.text.trim().to_string();
                        if definition.is_empty() {
                            return None;
                        }
                        Some(DefinitionContent {
                            word: segment.text.clone(),
                            pinyin: entry
                                .pinyin_display
                                .filter(|value| !value.trim().is_empty())
                                .or_else(|| {
                                    (!entry.pinyin.trim().is_empty()).then_some(entry.pinyin)
                                }),
                            definition,
                        })
                    }),
                    Err(error) => {
                        eprintln!("Skipping EPUB definition for {:?}: {}", segment.text, error);
                        None
                    }
                };
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
    use std::io::{Cursor, Read};

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

    #[test]
    fn prepare_chapter_degrades_dictionary_errors_to_unlinked_text() {
        let conn = setup_export_db();
        crate::library::analysis::add_segmentation_word("救贖", Some(100));
        conn.execute("DROP TABLE definitions", []).unwrap();
        let chapter = ExportChapter {
            text_id: 79,
            title: "T".into(),
            author: None,
            content: "救贖".into(),
        };
        let prepared = prepare_chapter(&conn, &chapter, &mut HashMap::new()).unwrap();
        assert!(prepared.definitions.is_empty());
        assert!(prepared
            .segments
            .iter()
            .all(|segment| segment.definition_id.is_none()));
    }

    #[test]
    fn build_epub_preserves_paragraph_and_line_breaks() {
        let conn = setup_export_db();
        let mut book = load_export_book(&conn, 1).unwrap();
        book.root.chapters[0].content = "第一行\n第二行\n\n第二段".into();
        let bytes = build_epub(&conn, &book).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let chapter = read_entry(&mut archive, "OEBPS/chapter-11.xhtml");
        assert!(chapter.contains("<p>第一行<br/>第二行</p><p>第二段</p>"));
    }

    #[test]
    fn build_epub_accounts_for_generated_definition_content() {
        let conn = setup_export_db();
        crate::library::analysis::add_segmentation_word("救贖", Some(100));
        seed_definition(&conn, "救贖", "jiu4 shu2", "jiùshú");
        conn.execute("UPDATE definitions SET text = ?", ["&".repeat(200)])
            .unwrap();
        let book = ExportBook {
            shelf_id: 1,
            title: "T".into(),
            root: ExportSection {
                shelf_id: 1,
                title: "T".into(),
                chapters: vec![ExportChapter {
                    text_id: 1,
                    title: "T".into(),
                    author: None,
                    content: "救贖".into(),
                }],
                children: vec![],
            },
        };
        assert!(
            matches!(build_epub_with_limit(&conn, &book, 300), Err(LibraryError::InvalidInput(message)) if message == "EPUB export is too large")
        );
    }

    fn read_entry(archive: &mut zip::ZipArchive<Cursor<Vec<u8>>>, name: &str) -> String {
        let mut value = String::new();
        archive
            .by_name(name)
            .unwrap()
            .read_to_string(&mut value)
            .unwrap();
        value
    }

    #[test]
    fn build_epub_creates_kindle_footnotes_and_valid_archive() {
        let conn = setup_export_db();
        crate::library::analysis::add_segmentation_word("救贖", Some(100));
        seed_definition(&conn, "救贖", "jiu4 shu2", "jiùshú");
        let mut book = load_export_book(&conn, 1).unwrap();
        book.title = "Root & <Book> \"Title\"\u{0001}".into();
        book.root.chapters[0].content = "救贖 & < > \" '\u{0001}".into();
        let bytes = build_epub(&conn, &book).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert_eq!(archive.by_index(0).unwrap().name(), "mimetype");
        assert_eq!(
            archive.by_index(0).unwrap().compression(),
            zip::CompressionMethod::Stored
        );
        assert_eq!(read_entry(&mut archive, "mimetype"), "application/epub+zip");
        for required in [
            "META-INF/container.xml",
            "OEBPS/content.opf",
            "OEBPS/nav.xhtml",
            "OEBPS/style.css",
        ] {
            assert!(archive.by_name(required).is_ok());
        }
        let chapter = read_entry(&mut archive, "OEBPS/chapter-11.xhtml");
        assert!(chapter.contains("epub:type=\"noteref\""));
        assert!(chapter.contains("<section class=\"definition-page-wrapper\">"));
        assert!(chapter.contains("<aside epub:type=\"footnote\""));
        assert!(chapter.contains("href=\"#source-11-1\""));
        assert!(chapter.contains("&amp; &lt; &gt; &quot; &apos;"));
        assert!(!chapter.contains('\u{0001}'));
        let css = read_entry(&mut archive, "OEBPS/style.css");
        assert!(css.contains(".definition-page-wrapper"));
        assert!(!css.contains("aside { break-before"));
    }

    #[test]
    fn build_epub_renders_nested_navigation() {
        let conn = setup_export_db();
        let book = load_export_book(&conn, 1).unwrap();
        let bytes = build_epub(&conn, &book).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let nav = read_entry(&mut archive, "OEBPS/nav.xhtml");
        assert!(nav.contains("<a href=\"chapter-30.xhtml\">Alpha</a><ol>"));
        assert!(nav.contains("<a href=\"chapter-40.xhtml\">Grandchild</a><ol>"));
        assert!(nav.find("Root A").unwrap() < nav.find("Alpha").unwrap());
    }

    #[test]
    fn build_epub_rejects_oversized_content_before_zip_assembly() {
        let conn = setup_export_db();
        let mut book = load_export_book(&conn, 1).unwrap();
        book.root.chapters[0].content = "x".repeat(MAX_EXPORT_BYTES + 1);
        assert!(
            matches!(build_epub(&conn, &book), Err(LibraryError::InvalidInput(message)) if message == "EPUB export is too large")
        );
    }
}
