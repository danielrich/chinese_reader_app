#!/usr/bin/env python3
"""
Pearl of Great Price Import Tool for Chinese Reader

Imports the Chinese Pearl of Great Price from churchofjesuschrist.org into the library.

Usage:
    uv run python import_pgp.py <parent_shelf_id> [--dry-run] [--convert-traditional]

Example:
    uv run python import_pgp.py 5  # Import under shelf ID 5
"""

import argparse
from import_utils import (
    connect_db,
    verify_parent_shelf,
    get_converter,
    import_scripture,
    print_import_summary,
)


# Pearl of Great Price structure: (abbreviation, chinese_name, chapter_count)
# Based on churchofjesuschrist.org URL structure
BOOKS = [
    ("moses", "摩西書", 8),
    ("abr", "亞伯拉罕書", 5),
    ("js-m", "約瑟·斯密—馬太", 1),
    ("js-h", "約瑟·斯密—歷史", 1),
    ("a-of-f", "信條", 1),
]

BASE_URL = "https://www.churchofjesuschrist.org/study/scriptures/pgp"
MAIN_SHELF_NAME = "無價珍珠"


def import_pearl_of_great_price(
    parent_shelf_id: int,
    convert_traditional: bool = False,
    dry_run: bool = False,
):
    """Import the Chinese Pearl of Great Price."""
    conn = connect_db()
    parent_name = verify_parent_shelf(conn, parent_shelf_id)
    print(f"Parent shelf: {parent_name} (ID: {parent_shelf_id})")

    converter = get_converter(convert_traditional)

    stats = import_scripture(
        conn=conn,
        parent_shelf_id=parent_shelf_id,
        main_shelf_name=MAIN_SHELF_NAME,
        books=BOOKS,
        base_url=BASE_URL,
        converter=converter,
        dry_run=dry_run,
    )

    print_import_summary(stats)
    conn.close()


def main():
    parser = argparse.ArgumentParser(
        description="Import the Chinese Pearl of Great Price into the library"
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

    import_pearl_of_great_price(
        args.parent_shelf_id,
        convert_traditional=args.convert_traditional,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
