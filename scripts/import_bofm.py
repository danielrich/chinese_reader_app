#!/usr/bin/env python3
"""
Book of Mormon Import Tool for Chinese Reader

Imports the Chinese Book of Mormon from churchofjesuschrist.org into the library.

Usage:
    uv run python import_bofm.py <parent_shelf_id> [--dry-run] [--no-convert]

Example:
    uv run python import_bofm.py 5  # Import under shelf ID 5
"""

import argparse
import re
import sqlite3
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import requests
from bs4 import BeautifulSoup

try:
    import opencc
    HAS_OPENCC = True
except ImportError:
    HAS_OPENCC = False


# Book of Mormon structure: (abbreviation, chinese_name, chapter_count)
BOOKS = [
    ("1-ne", "尼腓一書", 22),
    ("2-ne", "尼腓二書", 33),
    ("jacob", "雅各書", 7),
    ("enos", "以挪士書", 1),
    ("jarom", "雅龍書", 1),
    ("omni", "奧姆乃書", 1),
    ("w-of-m", "摩爾門語", 1),
    ("mosiah", "摩賽亞書", 29),
    ("alma", "阿爾瑪書", 63),
    ("hel", "希拉曼書", 16),
    ("3-ne", "尼腓三書", 30),
    ("4-ne", "尼腓四書", 1),
    ("morm", "摩爾門書", 9),
    ("ether", "以帖書", 15),
    ("moro", "摩羅乃書", 10),
]

BASE_URL = "https://www.churchofjesuschrist.org/study/scriptures/bofm"
REQUEST_DELAY = 1.5  # Seconds between requests to be gentle on server


@dataclass
class Chapter:
    """A chapter to import."""
    book_name: str
    chapter_num: int
    title: str
    content: str


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


def fetch_chapter(book_abbrev: str, chapter: int) -> Optional[str]:
    """Fetch a chapter's content from the website."""
    url = f"{BASE_URL}/{book_abbrev}/{chapter}?lang=zho"

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    }

    try:
        response = requests.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        response.encoding = 'utf-8'
        return response.text
    except requests.RequestException as e:
        print(f"  Error fetching {url}: {e}")
        return None


def parse_chapter_content(html: str) -> str:
    """Parse the chapter HTML and extract verse text."""
    soup = BeautifulSoup(html, "html.parser")

    # Find the main content area
    content_area = soup.find("div", class_="body-block")
    if not content_area:
        # Try alternative selectors
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

            # Get verse text (remove footnote markers)
            verse_text = verse_el.get_text(strip=True)

            # Clean up: remove verse number from beginning if it's there
            if verse_num and verse_text.startswith(verse_num):
                verse_text = verse_text[len(verse_num):].strip()

            # Remove footnote markers (ａ, ｂ, ｃ, etc.)
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
            # Skip navigation and metadata
            if text and len(text) > 10 and not text.startswith("返回") and "版權" not in text:
                # Clean footnote markers
                text = re.sub(r'[ａ-ｚ]', '', text)
                verses.append(text)

    return "\n\n".join(verses)


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


def import_book_of_mormon(
    parent_shelf_id: int,
    convert_traditional: bool = False,
    dry_run: bool = False,
):
    """Import the Chinese Book of Mormon."""

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

    # Set up converter if needed
    converter = None
    if convert_traditional and HAS_OPENCC:
        converter = opencc.OpenCC('s2twp')
        print("Converting simplified to traditional (Taiwan)")
    elif convert_traditional and not HAS_OPENCC:
        print("Warning: opencc not available, skipping conversion")

    # Create main Book of Mormon shelf
    bofm_shelf_id = get_or_create_shelf(
        conn, "摩爾門經", parent_shelf_id, sort_order=0, dry_run=dry_run
    )

    print(f"\nImporting Book of Mormon...")
    print(f"  Books: {len(BOOKS)}")
    total_chapters = sum(b[2] for b in BOOKS)
    print(f"  Total chapters: {total_chapters}")
    print(f"  Request delay: {REQUEST_DELAY}s")
    print()

    imported_chapters = 0
    total_chars = 0

    for book_idx, (abbrev, chinese_name, chapter_count) in enumerate(BOOKS):
        # Convert book name if needed
        display_name = chinese_name
        if converter:
            display_name = converter.convert(chinese_name)

        # Create shelf for this book
        book_shelf_id = get_or_create_shelf(
            conn, display_name, bofm_shelf_id, sort_order=book_idx, dry_run=dry_run
        )

        print(f"[{book_idx + 1}/{len(BOOKS)}] {display_name} ({chapter_count} chapters)")

        for chapter in range(1, chapter_count + 1):
            # Be gentle on the server
            if not dry_run:
                time.sleep(REQUEST_DELAY)

            # Fetch chapter
            html = fetch_chapter(abbrev, chapter) if not dry_run else None

            if dry_run:
                print(f"  Chapter {chapter}: [DRY RUN]")
                continue

            if not html:
                print(f"  Chapter {chapter}: FAILED")
                continue

            # Parse content
            content = parse_chapter_content(html)

            if not content:
                print(f"  Chapter {chapter}: No content found")
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

            imported_chapters += 1
            total_chars += char_count

            print(f"  Chapter {chapter}: {char_count} chars")

        # Progress summary for this book
        if not dry_run:
            print(f"  Completed {display_name}")
        print()

    print(f"Import complete!")
    print(f"  Chapters imported: {imported_chapters}")
    print(f"  Total characters: {total_chars:,}")

    conn.close()


def main():
    parser = argparse.ArgumentParser(
        description="Import the Chinese Book of Mormon into the library"
    )
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

    import_book_of_mormon(
        args.parent_shelf_id,
        convert_traditional=args.convert_traditional,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
