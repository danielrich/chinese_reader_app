#!/usr/bin/env python3
"""
PDF Import Tool for Chinese Reader

Imports a PDF file with hierarchical chapters into the library.
Creates shelves based on the PDF's table of contents structure.

Usage:
    uv run python import_pdf.py <pdf_path> <parent_shelf_id> [--convert-traditional] [--dry-run]

Example:
    uv run python import_pdf.py ../wheel_time_zhong.pdf 1 --convert-traditional
"""

import argparse
import os
import re
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import fitz  # PyMuPDF
import opencc


@dataclass
class TOCEntry:
    """A table of contents entry."""
    level: int
    title: str
    page: int
    children: list["TOCEntry"]


@dataclass
class ChapterContent:
    """Content for a chapter to be imported."""
    title: str
    content: str
    shelf_path: list[str]  # Path of shelf names from root


def get_db_path() -> Path:
    """Get the database path matching the Rust app's location."""
    # On macOS: ~/Library/Application Support/com.chinesereader.ChineseReader/
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "com.chinesereader.ChineseReader"
    elif sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", "")) / "com.chinesereader.ChineseReader"
    else:  # Linux
        base = Path.home() / ".local" / "share" / "com.chinesereader.ChineseReader"

    return base / "dictionary.db"


def build_toc_tree(toc: list[tuple[int, str, int]]) -> list[TOCEntry]:
    """Build a tree structure from flat TOC list."""
    if not toc:
        return []

    root_entries: list[TOCEntry] = []
    stack: list[TOCEntry] = []

    for level, title, page in toc:
        entry = TOCEntry(level=level, title=title, page=page, children=[])

        # Pop stack until we find the parent level
        while stack and stack[-1].level >= level:
            stack.pop()

        if stack:
            stack[-1].children.append(entry)
        else:
            root_entries.append(entry)

        stack.append(entry)

    return root_entries


def is_chapter_entry(title: str) -> bool:
    """Check if a TOC entry is a chapter (vs metadata like character list)."""
    # Match patterns like "第1章", "第10章", "序言", "终章", "尾声"
    chapter_patterns = [
        r"^第\d+章",  # Standard chapter
        r"^序[言章]?",  # Preface
        r"^终章",  # Final chapter
        r"^尾[声章]",  # Epilogue
        r"^前情提要",  # Previously
    ]

    skip_patterns = [
        r"^主要人物",  # Character list
        r"^大事记",  # Timeline
        r"^名词解释",  # Glossary
        r"^编后记",  # Editor's note
        r"^译后记",  # Translator's note
        r"^各界赞誉",  # Reviews/praise
        r"^作者简介",  # Author bio
        r"^目录",  # Table of contents
        r"^中英译名",  # Translation table
        r"^附录",  # Appendix
        r"^读者热评",  # Reader reviews
        r"^献词",  # Dedication
        r"^作者序",  # Author preface
        r"^译者序",  # Translator preface
    ]

    # Check if it matches skip patterns
    for pattern in skip_patterns:
        if re.match(pattern, title):
            return False

    # Check if it looks like a chapter
    for pattern in chapter_patterns:
        if re.match(pattern, title):
            return True

    # Default: if it's not in skip list and has Chinese characters, treat as chapter
    return bool(re.search(r'[\u4e00-\u9fff]', title))


def extract_chapters_from_toc(
    doc: fitz.Document,
    toc_tree: list[TOCEntry],
    parent_path: list[str],
    flat_toc: list[tuple[int, str, int]],
) -> list[ChapterContent]:
    """
    Extract chapter content from TOC tree.

    For books with nested structure (L1 book > L2 sub-book > L3 chapters),
    we want to create:
    - A shelf for the L1 book
    - A shelf for each L2 sub-book
    - Text entries for L3 chapters

    For books with flat structure (L1 book > L2 chapters),
    we want to create:
    - A shelf for the L1 book
    - Text entries for L2 chapters
    """
    chapters: list[ChapterContent] = []
    total_pages = len(doc)

    # Build a flat list of all TOC entries with their page numbers for finding end pages
    all_entries = [(level, title, page) for level, title, page in flat_toc]

    def find_end_page(start_page: int, start_idx: int) -> int:
        """Find the end page for a chapter (page before next chapter starts)."""
        for i in range(start_idx + 1, len(all_entries)):
            if all_entries[i][2] > start_page:
                return all_entries[i][2] - 1
        return total_pages

    def get_toc_index(title: str, page: int) -> int:
        """Find the index of this entry in the flat TOC."""
        for i, (_, t, p) in enumerate(all_entries):
            if t == title and p == page:
                return i
        return -1

    def process_entry(entry: TOCEntry, path: list[str]):
        current_path = path + [entry.title]

        # If this entry has children, it's a container (book/sub-book)
        if entry.children:
            # Check if children are chapters (leaf nodes) or sub-containers
            has_chapter_children = any(
                not child.children and is_chapter_entry(child.title)
                for child in entry.children
            )

            if has_chapter_children:
                # Children are chapters - this is the shelf level
                for child in entry.children:
                    if is_chapter_entry(child.title):
                        toc_idx = get_toc_index(child.title, child.page)
                        end_page = find_end_page(child.page, toc_idx)

                        # Extract text from pages
                        text = extract_text_range(doc, child.page - 1, end_page - 1)
                        if text.strip():
                            chapters.append(ChapterContent(
                                title=child.title,
                                content=text,
                                shelf_path=current_path,
                            ))
            else:
                # Children are sub-containers - recurse
                for child in entry.children:
                    process_entry(child, current_path)
        else:
            # Leaf node - check if it's a chapter
            if is_chapter_entry(entry.title):
                toc_idx = get_toc_index(entry.title, entry.page)
                end_page = find_end_page(entry.page, toc_idx)

                text = extract_text_range(doc, entry.page - 1, end_page - 1)
                if text.strip():
                    chapters.append(ChapterContent(
                        title=entry.title,
                        content=text,
                        shelf_path=path,  # Parent path, not including this entry
                    ))

    for entry in toc_tree:
        # Skip front matter
        if entry.title in ["作者简介", "各界的赞誉", "目录"]:
            continue
        process_entry(entry, parent_path)

    return chapters


def extract_text_range(doc: fitz.Document, start_page: int, end_page: int) -> str:
    """Extract text from a range of pages."""
    text_parts = []
    for page_num in range(start_page, min(end_page + 1, len(doc))):
        page = doc[page_num]
        text_parts.append(page.get_text())
    return "\n".join(text_parts)


def count_cjk_characters(text: str) -> int:
    """Count CJK characters in text."""
    return sum(1 for c in text if '\u4e00' <= c <= '\u9fff' or '\u3400' <= c <= '\u4dbf')


def get_or_create_shelf(
    conn: sqlite3.Connection,
    name: str,
    parent_id: Optional[int],
    sort_order: int = 0,
    dry_run: bool = False,
) -> int:
    """Get existing shelf or create new one."""
    cursor = conn.cursor()

    # Check if shelf exists
    if parent_id is None:
        cursor.execute(
            "SELECT id FROM shelves WHERE name = ? AND parent_id IS NULL",
            (name,)
        )
    else:
        cursor.execute(
            "SELECT id FROM shelves WHERE name = ? AND parent_id = ?",
            (name, parent_id)
        )

    row = cursor.fetchone()
    if row:
        return row[0]

    # Create new shelf
    if dry_run:
        print(f"  [DRY RUN] Would create shelf: {name} (parent={parent_id}, order={sort_order})")
        return -1

    cursor.execute(
        "INSERT INTO shelves (name, parent_id, sort_order) VALUES (?, ?, ?)",
        (name, parent_id, sort_order)
    )
    conn.commit()
    return cursor.lastrowid


def create_text(
    conn: sqlite3.Connection,
    shelf_id: int,
    title: str,
    content: str,
    sort_order: int = 0,
    dry_run: bool = False,
) -> int:
    """Create a text entry in a shelf."""
    char_count = count_cjk_characters(content)

    if dry_run:
        print(f"  [DRY RUN] Would create text: {title} ({char_count} chars)")
        return -1

    cursor = conn.cursor()
    cursor.execute(
        """INSERT INTO texts (shelf_id, title, source_type, content, character_count, sort_order)
           VALUES (?, ?, 'file', ?, ?, ?)""",
        (shelf_id, title, content, char_count, sort_order)
    )
    conn.commit()
    return cursor.lastrowid


def import_pdf(
    pdf_path: Path,
    parent_shelf_id: int,
    convert_traditional: bool = True,
    dry_run: bool = False,
):
    """Import a PDF file into the library."""

    # Open database
    db_path = get_db_path()
    if not db_path.exists():
        print(f"Error: Database not found at {db_path}")
        print("Please run the app first to initialize the database.")
        sys.exit(1)

    print(f"Database: {db_path}")
    conn = sqlite3.connect(db_path)

    # Verify parent shelf exists
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM shelves WHERE id = ?", (parent_shelf_id,))
    parent_row = cursor.fetchone()
    if not parent_row:
        print(f"Error: Parent shelf with ID {parent_shelf_id} not found.")
        sys.exit(1)

    print(f"Parent shelf: {parent_row[0]} (ID: {parent_shelf_id})")

    # Open PDF
    print(f"Opening PDF: {pdf_path}")
    doc = fitz.open(pdf_path)
    print(f"  Pages: {len(doc)}")

    # Get TOC
    toc = doc.get_toc()
    print(f"  TOC entries: {len(toc)}")

    if not toc:
        print("Error: PDF has no table of contents.")
        sys.exit(1)

    # Build TOC tree
    toc_tree = build_toc_tree(toc)

    # Set up converter if needed
    converter = None
    if convert_traditional:
        converter = opencc.OpenCC('s2twp')  # Simplified to Traditional (Taiwan) with phrases
        print("  Converting simplified to traditional (Taiwan)")

    # Extract chapters
    print("\nExtracting chapters...")
    chapters = extract_chapters_from_toc(doc, toc_tree, [], toc)
    print(f"  Found {len(chapters)} chapters")

    # Import chapters
    print("\nImporting chapters...")
    shelf_cache: dict[tuple, int] = {}  # (parent_id, name) -> shelf_id
    shelf_order_counter: dict[int, int] = {}  # parent_id -> next sort_order for shelves
    text_order_counter: dict[int, int] = {}  # shelf_id -> next sort_order for texts

    imported_count = 0
    total_chars = 0

    for i, chapter in enumerate(chapters):
        # Build shelf hierarchy
        current_parent_id = parent_shelf_id

        # Convert shelf path names if needed
        shelf_path = chapter.shelf_path
        if converter:
            shelf_path = [converter.convert(name) for name in shelf_path]

        for shelf_name in shelf_path:
            cache_key = (current_parent_id, shelf_name)
            if cache_key in shelf_cache:
                current_parent_id = shelf_cache[cache_key]
            else:
                # Get next sort order for this parent
                sort_order = shelf_order_counter.get(current_parent_id, 0)
                shelf_order_counter[current_parent_id] = sort_order + 1

                shelf_id = get_or_create_shelf(conn, shelf_name, current_parent_id, sort_order, dry_run)
                shelf_cache[cache_key] = shelf_id
                current_parent_id = shelf_id

        # Convert title and content if needed
        title = chapter.title
        content = chapter.content
        if converter:
            title = converter.convert(title)
            content = converter.convert(content)

        # Get next sort order for texts in this shelf
        text_sort_order = text_order_counter.get(current_parent_id, 0)
        text_order_counter[current_parent_id] = text_sort_order + 1

        # Create text
        char_count = count_cjk_characters(content)
        if not dry_run:
            create_text(conn, current_parent_id, title, content, text_sort_order, dry_run)
        else:
            shelf_path_str = " > ".join(shelf_path) if shelf_path else "(root)"
            print(f"  [{i+1}/{len(chapters)}] {shelf_path_str} > {title} ({char_count} chars)")

        imported_count += 1
        total_chars += char_count

        # Progress update
        if not dry_run and (i + 1) % 50 == 0:
            print(f"  Progress: {i + 1}/{len(chapters)} chapters")

    print(f"\nImport complete!")
    print(f"  Chapters imported: {imported_count}")
    print(f"  Total characters: {total_chars:,}")

    conn.close()
    doc.close()


def main():
    parser = argparse.ArgumentParser(
        description="Import a PDF file into the Chinese Reader library"
    )
    parser.add_argument("pdf_path", type=Path, help="Path to the PDF file")
    parser.add_argument("parent_shelf_id", type=int, help="ID of the parent shelf")
    parser.add_argument(
        "--convert-traditional", "-t",
        action="store_true",
        default=True,
        help="Convert simplified Chinese to traditional (default: True)"
    )
    parser.add_argument(
        "--no-convert",
        action="store_true",
        help="Do not convert to traditional Chinese"
    )
    parser.add_argument(
        "--dry-run", "-n",
        action="store_true",
        help="Show what would be imported without making changes"
    )

    args = parser.parse_args()

    if not args.pdf_path.exists():
        print(f"Error: PDF file not found: {args.pdf_path}")
        sys.exit(1)

    convert_traditional = args.convert_traditional and not args.no_convert

    import_pdf(
        args.pdf_path,
        args.parent_shelf_id,
        convert_traditional=convert_traditional,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
