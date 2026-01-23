#!/usr/bin/env python3
"""
Old Testament Import Tool for Chinese Reader

Imports the Chinese Old Testament from churchofjesuschrist.org into the library.

Usage:
    uv run python import_ot.py <parent_shelf_id> [--dry-run] [--convert-traditional]

Example:
    uv run python import_ot.py 5  # Import under shelf ID 5
"""

import argparse
from import_utils import (
    connect_db,
    verify_parent_shelf,
    get_converter,
    import_scripture,
    print_import_summary,
)


# Old Testament structure: (abbreviation, chinese_name, chapter_count)
# Based on churchofjesuschrist.org URL structure
BOOKS = [
    # Pentateuch (Torah)
    ("gen", "創世記", 50),
    ("ex", "出埃及記", 40),
    ("lev", "利未記", 27),
    ("num", "民數記", 36),
    ("deut", "申命記", 34),
    # Historical Books
    ("josh", "約書亞記", 24),
    ("judg", "士師記", 21),
    ("ruth", "路得記", 4),
    ("1-sam", "撒母耳記上", 31),
    ("2-sam", "撒母耳記下", 24),
    ("1-kgs", "列王紀上", 22),
    ("2-kgs", "列王紀下", 25),
    ("1-chr", "歷代志上", 29),
    ("2-chr", "歷代志下", 36),
    ("ezra", "以斯拉記", 10),
    ("neh", "尼希米記", 13),
    ("esth", "以斯帖記", 10),
    # Wisdom Literature
    ("job", "約伯記", 42),
    ("ps", "詩篇", 150),
    ("prov", "箴言", 31),
    ("eccl", "傳道書", 12),
    ("song", "雅歌", 8),
    # Major Prophets
    ("isa", "以賽亞書", 66),
    ("jer", "耶利米書", 52),
    ("lam", "耶利米哀歌", 5),
    ("ezek", "以西結書", 48),
    ("dan", "但以理書", 12),
    # Minor Prophets
    ("hosea", "何西阿書", 14),
    ("joel", "約珥書", 3),
    ("amos", "阿摩司書", 9),
    ("obad", "俄巴底亞書", 1),
    ("jonah", "約拿書", 4),
    ("micah", "彌迦書", 7),
    ("nahum", "那鴻書", 3),
    ("hab", "哈巴谷書", 3),
    ("zeph", "西番雅書", 3),
    ("hag", "哈該書", 2),
    ("zech", "撒迦利亞書", 14),
    ("mal", "瑪拉基書", 4),
]

BASE_URL = "https://www.churchofjesuschrist.org/study/scriptures/ot"
MAIN_SHELF_NAME = "舊約"


def import_old_testament(
    parent_shelf_id: int,
    convert_traditional: bool = False,
    dry_run: bool = False,
):
    """Import the Chinese Old Testament."""
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
        description="Import the Chinese Old Testament into the library"
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

    import_old_testament(
        args.parent_shelf_id,
        convert_traditional=args.convert_traditional,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
