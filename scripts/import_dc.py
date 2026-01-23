#!/usr/bin/env python3
"""
Doctrine and Covenants Import Tool for Chinese Reader

Imports the Chinese Doctrine and Covenants from churchofjesuschrist.org into the library.

Usage:
    uv run python import_dc.py <parent_shelf_id> [--dry-run] [--convert-traditional]

Example:
    uv run python import_dc.py 5  # Import under shelf ID 5
"""

import argparse
import time
from import_utils import (
    connect_db,
    verify_parent_shelf,
    get_converter,
    get_or_create_shelf,
    create_text,
    fetch_url,
    parse_scripture_content,
    count_cjk_characters,
    print_import_summary,
    ImportStats,
    DEFAULT_REQUEST_DELAY,
)


BASE_URL = "https://www.churchofjesuschrist.org/study/scriptures/dc-testament"
MAIN_SHELF_NAME = "教義和聖約"

# D&C has 138 sections plus 2 Official Declarations
SECTION_COUNT = 138


def import_doctrine_and_covenants(
    parent_shelf_id: int,
    convert_traditional: bool = False,
    dry_run: bool = False,
):
    """Import the Chinese Doctrine and Covenants."""
    conn = connect_db()
    parent_name = verify_parent_shelf(conn, parent_shelf_id)
    print(f"Parent shelf: {parent_name} (ID: {parent_shelf_id})")

    converter = get_converter(convert_traditional)
    stats = ImportStats()

    # Convert main shelf name if needed
    display_main_name = MAIN_SHELF_NAME
    if converter:
        display_main_name = converter.convert(MAIN_SHELF_NAME)

    # Create main D&C shelf
    main_shelf_id = get_or_create_shelf(
        conn, display_main_name, parent_shelf_id, sort_order=0, dry_run=dry_run
    )

    print(f"\nImporting {display_main_name}...")
    print(f"  Sections: {SECTION_COUNT}")
    print(f"  Official Declarations: 2")
    print(f"  Request delay: {DEFAULT_REQUEST_DELAY}s")
    print()

    # Import sections
    print("Importing Sections...")
    for section in range(1, SECTION_COUNT + 1):
        if not dry_run:
            time.sleep(DEFAULT_REQUEST_DELAY)

        url = f"{BASE_URL}/dc/{section}?lang=zho"
        html = fetch_url(url) if not dry_run else None

        if dry_run:
            print(f"  Section {section}: [DRY RUN]")
            continue

        if not html:
            print(f"  Section {section}: FAILED")
            stats.failed_chapters += 1
            continue

        content = parse_scripture_content(html)

        if not content:
            print(f"  Section {section}: No content found")
            stats.failed_chapters += 1
            continue

        if converter:
            content = converter.convert(content)

        title = f"第 {section} 篇"
        char_count = count_cjk_characters(content)
        create_text(
            conn, main_shelf_id, title, content,
            sort_order=section - 1, dry_run=dry_run
        )

        stats.chapters_imported += 1
        stats.total_characters += char_count
        print(f"  Section {section}: {char_count} chars")

    print()

    # Import Official Declarations
    print("Importing Official Declarations...")
    for od_num in range(1, 3):
        if not dry_run:
            time.sleep(DEFAULT_REQUEST_DELAY)

        url = f"{BASE_URL}/od/{od_num}?lang=zho"
        html = fetch_url(url) if not dry_run else None

        if dry_run:
            print(f"  Official Declaration {od_num}: [DRY RUN]")
            continue

        if not html:
            print(f"  Official Declaration {od_num}: FAILED")
            stats.failed_chapters += 1
            continue

        content = parse_scripture_content(html)

        if not content:
            print(f"  Official Declaration {od_num}: No content found")
            stats.failed_chapters += 1
            continue

        if converter:
            content = converter.convert(content)

        title = f"正式宣言—{od_num}"
        if converter:
            title = converter.convert(title)

        char_count = count_cjk_characters(content)
        create_text(
            conn, main_shelf_id, title, content,
            sort_order=SECTION_COUNT + od_num - 1, dry_run=dry_run
        )

        stats.chapters_imported += 1
        stats.total_characters += char_count
        print(f"  Official Declaration {od_num}: {char_count} chars")

    print()
    print_import_summary(stats)
    conn.close()


def main():
    parser = argparse.ArgumentParser(
        description="Import the Chinese Doctrine and Covenants into the library"
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

    import_doctrine_and_covenants(
        args.parent_shelf_id,
        convert_traditional=args.convert_traditional,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
