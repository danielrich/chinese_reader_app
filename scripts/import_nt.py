#!/usr/bin/env python3
"""
New Testament Import Tool for Chinese Reader

Imports the Chinese New Testament from churchofjesuschrist.org into the library.

Usage:
    uv run python import_nt.py <parent_shelf_id> [--dry-run] [--convert-traditional]

Example:
    uv run python import_nt.py 5  # Import under shelf ID 5
"""

import argparse
from import_utils import (
    connect_db,
    verify_parent_shelf,
    get_converter,
    import_scripture,
    print_import_summary,
)


# New Testament structure: (abbreviation, chinese_name, chapter_count)
# Based on churchofjesuschrist.org URL structure
BOOKS = [
    # Gospels
    ("matt", "馬太福音", 28),
    ("mark", "馬可福音", 16),
    ("luke", "路加福音", 24),
    ("john", "約翰福音", 21),
    # History
    ("acts", "使徒行傳", 28),
    # Pauline Epistles
    ("rom", "羅馬書", 16),
    ("1-cor", "哥林多前書", 16),
    ("2-cor", "哥林多後書", 13),
    ("gal", "加拉太書", 6),
    ("eph", "以弗所書", 6),
    ("philip", "腓立比書", 4),
    ("col", "歌羅西書", 4),
    ("1-thes", "帖撒羅尼迦前書", 5),
    ("2-thes", "帖撒羅尼迦後書", 3),
    ("1-tim", "提摩太前書", 6),
    ("2-tim", "提摩太後書", 4),
    ("titus", "提多書", 3),
    ("philem", "腓利門書", 1),
    # General Epistles
    ("heb", "希伯來書", 13),
    ("james", "雅各書", 5),
    ("1-pet", "彼得前書", 5),
    ("2-pet", "彼得後書", 3),
    ("1-jn", "約翰一書", 5),
    ("2-jn", "約翰二書", 1),
    ("3-jn", "約翰三書", 1),
    ("jude", "猶大書", 1),
    # Apocalyptic
    ("rev", "啟示錄", 22),
]

BASE_URL = "https://www.churchofjesuschrist.org/study/scriptures/nt"
MAIN_SHELF_NAME = "新約"


def import_new_testament(
    parent_shelf_id: int,
    convert_traditional: bool = False,
    dry_run: bool = False,
):
    """Import the Chinese New Testament."""
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
        description="Import the Chinese New Testament into the library"
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

    import_new_testament(
        args.parent_shelf_id,
        convert_traditional=args.convert_traditional,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
