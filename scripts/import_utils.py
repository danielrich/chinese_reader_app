"""
Shared utilities for importing scriptures into Chinese Reader.

This module provides common functions used by all scripture import scripts.
"""

import re
import sqlite3
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Callable

import requests
from bs4 import BeautifulSoup

try:
    import opencc
    HAS_OPENCC = True
except ImportError:
    HAS_OPENCC = False


# Default settings
DEFAULT_REQUEST_DELAY = 1.5  # Seconds between requests to be gentle on server
DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
}


@dataclass
class ImportStats:
    """Statistics from an import operation."""
    chapters_imported: int = 0
    total_characters: int = 0
    failed_chapters: int = 0


def get_db_path() -> Path:
    """Get the database path matching the Rust app's location."""
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "com.chinesereader.ChineseReader"
    elif sys.platform == "win32":
        import os
        base = Path(os.environ.get("APPDATA", "")) / "com.chinesereader.ChineseReader"
    else:
        base = Path.home() / ".local" / "share" / "com.chinesereader.ChineseReader"
    return base / "dictionary.db"


def connect_db() -> sqlite3.Connection:
    """Connect to the database, exiting if not found."""
    db_path = get_db_path()
    if not db_path.exists():
        print(f"Error: Database not found at {db_path}")
        print("Please run the app first to initialize the database.")
        sys.exit(1)
    print(f"Database: {db_path}")
    return sqlite3.connect(db_path)


def verify_parent_shelf(conn: sqlite3.Connection, parent_shelf_id: int) -> str:
    """Verify a parent shelf exists and return its name."""
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM shelves WHERE id = ?", (parent_shelf_id,))
    row = cursor.fetchone()
    if not row:
        print(f"Error: Parent shelf with ID {parent_shelf_id} not found.")
        sys.exit(1)
    return row[0]


def get_converter(convert_traditional: bool) -> Optional[object]:
    """Get an OpenCC converter if requested and available."""
    if convert_traditional and HAS_OPENCC:
        converter = opencc.OpenCC('s2twp')
        print("Converting simplified to traditional (Taiwan)")
        return converter
    elif convert_traditional and not HAS_OPENCC:
        print("Warning: opencc not available, skipping conversion")
    return None


def fetch_url(url: str, timeout: int = 30) -> Optional[str]:
    """Fetch content from a URL."""
    try:
        response = requests.get(url, headers=DEFAULT_HEADERS, timeout=timeout)
        response.raise_for_status()
        response.encoding = 'utf-8'
        return response.text
    except requests.RequestException as e:
        print(f"  Error fetching {url}: {e}")
        return None


def parse_scripture_content(html: str) -> str:
    """Parse scripture HTML and extract verse text."""
    soup = BeautifulSoup(html, "html.parser")

    # Find the main content area
    content_area = soup.find("div", class_="body-block")
    if not content_area:
        content_area = soup.find("article") or soup.find("main")

    if not content_area:
        return ""

    verses = []

    # Find all verse paragraphs
    verse_elements = content_area.find_all("p", class_="verse")

    if verse_elements:
        for verse_el in verse_elements:
            # Get verse number
            verse_num_el = verse_el.find("span", class_="verse-number")
            verse_num = verse_num_el.get_text(strip=True) if verse_num_el else ""

            # Get verse text
            verse_text = verse_el.get_text(strip=True)

            # Clean up: remove verse number from beginning if it's there
            if verse_num and verse_text.startswith(verse_num):
                verse_text = verse_text[len(verse_num):].strip()

            # Remove footnote markers (full-width letters)
            verse_text = re.sub(r'[ａ-ｚ]', '', verse_text)

            if verse_num and verse_text:
                verses.append(f"{verse_num} {verse_text}")
            elif verse_text:
                verses.append(verse_text)
    else:
        # Fallback: try to get all paragraph text
        paragraphs = content_area.find_all("p")
        for p in paragraphs:
            text = p.get_text(strip=True)
            if text and len(text) > 10 and not text.startswith("返回") and "版權" not in text:
                text = re.sub(r'[ａ-ｚ]', '', text)
                verses.append(text)

    return "\n\n".join(verses)


def parse_general_content(html: str) -> str:
    """Parse general HTML content (for General Conference talks, etc.)."""
    soup = BeautifulSoup(html, "html.parser")

    # Find the main content area
    content_area = soup.find("div", class_="body-block")
    if not content_area:
        content_area = soup.find("article") or soup.find("main")

    if not content_area:
        return ""

    paragraphs = []

    # Get all paragraphs
    for p in content_area.find_all("p"):
        text = p.get_text(strip=True)
        # Skip navigation, metadata, and empty paragraphs
        if text and len(text) > 5:
            # Skip common non-content text
            skip_patterns = ["返回", "版權", "下載", "分享", "相關"]
            if not any(pattern in text for pattern in skip_patterns):
                paragraphs.append(text)

    return "\n\n".join(paragraphs)


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
        return -1

    cursor = conn.cursor()
    cursor.execute(
        """INSERT INTO texts (shelf_id, title, source_type, content, character_count, sort_order)
           VALUES (?, ?, 'web', ?, ?, ?)""",
        (shelf_id, title, content, char_count, sort_order)
    )
    conn.commit()
    return cursor.lastrowid


def import_scripture(
    conn: sqlite3.Connection,
    parent_shelf_id: int,
    main_shelf_name: str,
    books: list[tuple[str, str, int]],  # (abbrev, chinese_name, chapter_count)
    base_url: str,
    converter: Optional[object] = None,
    dry_run: bool = False,
    request_delay: float = DEFAULT_REQUEST_DELAY,
    content_parser: Callable[[str], str] = parse_scripture_content,
) -> ImportStats:
    """
    Generic scripture import function.

    Args:
        conn: Database connection
        parent_shelf_id: ID of the parent shelf
        main_shelf_name: Name for the main shelf (e.g., "舊約")
        books: List of (abbreviation, chinese_name, chapter_count) tuples
        base_url: Base URL for the scripture (e.g., "https://www.churchofjesuschrist.org/study/scriptures/ot")
        converter: Optional OpenCC converter
        dry_run: If True, don't make any changes
        request_delay: Seconds to wait between requests
        content_parser: Function to parse HTML content

    Returns:
        ImportStats with import statistics
    """
    stats = ImportStats()

    # Convert main shelf name if needed
    display_main_name = main_shelf_name
    if converter:
        display_main_name = converter.convert(main_shelf_name)

    # Create main shelf
    main_shelf_id = get_or_create_shelf(
        conn, display_main_name, parent_shelf_id, sort_order=0, dry_run=dry_run
    )

    total_chapters = sum(b[2] for b in books)
    print(f"\nImporting {display_main_name}...")
    print(f"  Books: {len(books)}")
    print(f"  Total chapters: {total_chapters}")
    print(f"  Request delay: {request_delay}s")
    print()

    for book_idx, (abbrev, chinese_name, chapter_count) in enumerate(books):
        # Convert book name if needed
        display_name = chinese_name
        if converter:
            display_name = converter.convert(chinese_name)

        # Create shelf for this book
        book_shelf_id = get_or_create_shelf(
            conn, display_name, main_shelf_id, sort_order=book_idx, dry_run=dry_run
        )

        print(f"[{book_idx + 1}/{len(books)}] {display_name} ({chapter_count} chapters)")

        for chapter in range(1, chapter_count + 1):
            # Be gentle on the server
            if not dry_run:
                time.sleep(request_delay)

            # Build URL
            url = f"{base_url}/{abbrev}/{chapter}?lang=zho"

            # Fetch chapter
            html = fetch_url(url) if not dry_run else None

            if dry_run:
                print(f"  Chapter {chapter}: [DRY RUN]")
                continue

            if not html:
                print(f"  Chapter {chapter}: FAILED")
                stats.failed_chapters += 1
                continue

            # Parse content
            content = content_parser(html)

            if not content:
                print(f"  Chapter {chapter}: No content found")
                stats.failed_chapters += 1
                continue

            # Convert if needed
            if converter:
                content = converter.convert(content)

            # Create title
            title = f"第 {chapter} 章" if chapter_count > 1 else display_name

            # Create text
            char_count = count_cjk_characters(content)
            create_text(
                conn, book_shelf_id, title, content,
                sort_order=chapter - 1, dry_run=dry_run
            )

            stats.chapters_imported += 1
            stats.total_characters += char_count

            print(f"  Chapter {chapter}: {char_count} chars")

        if not dry_run:
            print(f"  Completed {display_name}")
        print()

    return stats


def print_import_summary(stats: ImportStats):
    """Print a summary of import statistics."""
    print(f"Import complete!")
    print(f"  Chapters imported: {stats.chapters_imported}")
    print(f"  Total characters: {stats.total_characters:,}")
    if stats.failed_chapters > 0:
        print(f"  Failed chapters: {stats.failed_chapters}")
