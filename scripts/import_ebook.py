#!/usr/bin/env python3
"""
EPUB/AZW3 Import Tool for Chinese Reader

Imports EPUB or AZW3 ebook files into the library.
Creates chapters based on the ebook's table of contents.

For AZW3 files, requires Calibre's ebook-convert tool to be installed.

Usage:
    uv run python import_ebook.py <ebook_path> <parent_shelf_id> [--convert-traditional] [--dry-run]

Example:
    uv run python import_ebook.py ../harry_potter.azw3 1 --convert-traditional
    uv run python import_ebook.py ../the_martian.epub 1 -t
"""

import argparse
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup

try:
    import opencc
    HAS_OPENCC = True
except ImportError:
    HAS_OPENCC = False


@dataclass
class Chapter:
    """A chapter from the ebook."""
    title: str
    content: str
    href: str  # Original href in the ebook


def get_db_path() -> Path:
    """Get the database path matching the Rust app's location."""
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "com.chinesereader.ChineseReader"
    elif sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", "")) / "com.chinesereader.ChineseReader"
    else:  # Linux
        base = Path.home() / ".local" / "share" / "com.chinesereader.ChineseReader"

    return base / "dictionary.db"


def convert_azw3_to_epub(azw3_path: Path) -> Path:
    """Convert AZW3 to EPUB using Calibre's ebook-convert."""
    # Check if ebook-convert is available
    ebook_convert = shutil.which("ebook-convert")
    if not ebook_convert:
        # Try common Calibre installation paths
        if sys.platform == "darwin":
            mac_path = "/Applications/calibre.app/Contents/MacOS/ebook-convert"
            if os.path.exists(mac_path):
                ebook_convert = mac_path
        elif sys.platform == "win32":
            win_paths = [
                r"C:\Program Files\Calibre2\ebook-convert.exe",
                r"C:\Program Files (x86)\Calibre2\ebook-convert.exe",
            ]
            for path in win_paths:
                if os.path.exists(path):
                    ebook_convert = path
                    break

    if not ebook_convert:
        print("Error: ebook-convert not found.")
        print("Please install Calibre from https://calibre-ebook.com/")
        print("Or add Calibre to your PATH.")
        sys.exit(1)

    # Create temp file for converted EPUB
    temp_dir = tempfile.mkdtemp()
    epub_path = Path(temp_dir) / f"{azw3_path.stem}.epub"

    print(f"Converting AZW3 to EPUB using Calibre...")
    print(f"  Source: {azw3_path}")
    print(f"  Output: {epub_path}")

    try:
        result = subprocess.run(
            [ebook_convert, str(azw3_path), str(epub_path)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            print(f"Error converting file: {result.stderr}")
            sys.exit(1)
    except Exception as e:
        print(f"Error running ebook-convert: {e}")
        sys.exit(1)

    return epub_path


def extract_text_from_html(html_content: str) -> str:
    """Extract clean text from HTML content."""
    soup = BeautifulSoup(html_content, "html.parser")

    # Remove script and style elements
    for element in soup(["script", "style", "head", "nav", "footer"]):
        element.decompose()

    # Get text
    text = soup.get_text(separator="\n")

    # Clean up whitespace
    lines = []
    for line in text.split("\n"):
        line = line.strip()
        if line:
            lines.append(line)

    return "\n\n".join(lines)


def parse_epub(epub_path: Path) -> tuple[str, list[Chapter]]:
    """Parse an EPUB file and extract chapters."""
    book = epub.read_epub(str(epub_path))

    # Get book title
    title = "Unknown"
    dc_title = book.get_metadata("DC", "title")
    if dc_title:
        title = dc_title[0][0]

    print(f"  Book title: {title}")

    # Get TOC
    toc = book.toc
    chapters = []

    # Build a map of href -> content
    content_map = {}
    for item in book.get_items():
        if item.get_type() == ebooklib.ITEM_DOCUMENT:
            href = item.get_name()
            content = item.get_content().decode("utf-8", errors="ignore")
            content_map[href] = content

    def process_toc_item(item, depth=0):
        """Process a TOC item (can be nested)."""
        if isinstance(item, epub.Link):
            href = item.href
            # Remove anchor from href
            if "#" in href:
                href = href.split("#")[0]

            chapter_title = item.title or f"Chapter {len(chapters) + 1}"

            # Get content
            if href in content_map:
                text = extract_text_from_html(content_map[href])
                if text.strip():
                    chapters.append(Chapter(
                        title=chapter_title,
                        content=text,
                        href=href,
                    ))
        elif isinstance(item, tuple):
            # Nested TOC: (Section, [children])
            section = item[0]
            children = item[1]

            # Process section itself if it's a Link
            if isinstance(section, epub.Link):
                href = section.href
                if "#" in href:
                    href = href.split("#")[0]

                section_title = section.title or f"Section {len(chapters) + 1}"

                if href in content_map:
                    text = extract_text_from_html(content_map[href])
                    if text.strip():
                        chapters.append(Chapter(
                            title=section_title,
                            content=text,
                            href=href,
                        ))

            # Process children
            for child in children:
                process_toc_item(child, depth + 1)

    # Process all TOC items
    for item in toc:
        process_toc_item(item)

    # If no chapters from TOC, fall back to spine order
    if not chapters:
        print("  No TOC found, using spine order...")
        seen_hrefs = set()
        chapter_num = 1

        for item_id, _ in book.spine:
            item = book.get_item_with_id(item_id)
            if item and item.get_type() == ebooklib.ITEM_DOCUMENT:
                href = item.get_name()
                if href not in seen_hrefs:
                    seen_hrefs.add(href)
                    content = item.get_content().decode("utf-8", errors="ignore")
                    text = extract_text_from_html(content)

                    if text.strip() and len(text) > 100:  # Skip very short content
                        # Try to extract title from content
                        soup = BeautifulSoup(content, "html.parser")
                        h1 = soup.find("h1")
                        h2 = soup.find("h2")
                        chapter_title = None
                        if h1:
                            chapter_title = h1.get_text(strip=True)
                        elif h2:
                            chapter_title = h2.get_text(strip=True)

                        if not chapter_title or len(chapter_title) > 100:
                            chapter_title = f"第{chapter_num}章"

                        chapters.append(Chapter(
                            title=chapter_title,
                            content=text,
                            href=href,
                        ))
                        chapter_num += 1

    return title, chapters


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


def import_ebook(
    ebook_path: Path,
    parent_shelf_id: int,
    convert_traditional: bool = False,
    dry_run: bool = False,
):
    """Import an EPUB or AZW3 file into the library."""

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

    # Handle file type
    suffix = ebook_path.suffix.lower()
    epub_path = ebook_path
    temp_epub = None

    if suffix == ".azw3":
        epub_path = convert_azw3_to_epub(ebook_path)
        temp_epub = epub_path
    elif suffix not in [".epub"]:
        print(f"Error: Unsupported file format: {suffix}")
        print("Supported formats: .epub, .azw3")
        sys.exit(1)

    print(f"\nOpening ebook: {epub_path}")

    # Parse EPUB
    book_title, chapters = parse_epub(epub_path)
    print(f"  Chapters found: {len(chapters)}")

    if not chapters:
        print("Error: No chapters found in ebook.")
        sys.exit(1)

    # Set up converter if needed
    converter = None
    if convert_traditional:
        if HAS_OPENCC:
            converter = opencc.OpenCC('s2twp')  # Simplified to Traditional (Taiwan) with phrases
            print("  Converting simplified to traditional (Taiwan)")
        else:
            print("  Warning: opencc not available, skipping conversion")

    # Convert book title if needed
    if converter:
        book_title = converter.convert(book_title)

    # Create shelf for the book
    book_shelf_id = get_or_create_shelf(conn, book_title, parent_shelf_id, dry_run=dry_run)

    # Import chapters
    print("\nImporting chapters...")
    imported_count = 0
    total_chars = 0

    for i, chapter in enumerate(chapters):
        # Convert title and content if needed
        title = chapter.title
        content = chapter.content

        if converter:
            title = converter.convert(title)
            content = converter.convert(content)

        char_count = count_cjk_characters(content)

        if dry_run:
            print(f"  [{i+1}/{len(chapters)}] {title} ({char_count} chars)")
        else:
            create_text(conn, book_shelf_id, title, content, sort_order=i, dry_run=dry_run)

            # Progress update
            if (i + 1) % 20 == 0:
                print(f"  Progress: {i + 1}/{len(chapters)} chapters")

        imported_count += 1
        total_chars += char_count

    print(f"\nImport complete!")
    print(f"  Chapters imported: {imported_count}")
    print(f"  Total characters: {total_chars:,}")

    conn.close()

    # Clean up temp file
    if temp_epub:
        try:
            temp_epub.unlink()
            temp_epub.parent.rmdir()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(
        description="Import an EPUB or AZW3 ebook into the Chinese Reader library"
    )
    parser.add_argument("ebook_path", type=Path, help="Path to the ebook file (.epub or .azw3)")
    parser.add_argument("parent_shelf_id", type=int, help="ID of the parent shelf")
    parser.add_argument(
        "--convert-traditional", "-t",
        action="store_true",
        help="Convert simplified Chinese to traditional"
    )
    parser.add_argument(
        "--dry-run", "-n",
        action="store_true",
        help="Show what would be imported without making changes"
    )

    args = parser.parse_args()

    if not args.ebook_path.exists():
        print(f"Error: Ebook file not found: {args.ebook_path}")
        sys.exit(1)

    import_ebook(
        args.ebook_path,
        args.parent_shelf_id,
        convert_traditional=args.convert_traditional,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
