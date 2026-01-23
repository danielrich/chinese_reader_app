#!/usr/bin/env python3
"""
General Conference Import Tool for Chinese Reader

Imports Chinese General Conference talks from churchofjesuschrist.org into the library.
Can import a single conference or a range of conferences.

Usage:
    # Import a single conference
    uv run python import_gc.py <parent_shelf_id> --year 2024 --month 10

    # Import a range of conferences
    uv run python import_gc.py <parent_shelf_id> --from 2020-04 --to 2024-10

    # Import with options
    uv run python import_gc.py <parent_shelf_id> --year 2024 --month 4 --convert-traditional --dry-run

Example:
    uv run python import_gc.py 5 --year 2024 --month 10  # Import October 2024 conference
    uv run python import_gc.py 5 --from 2023-04 --to 2024-10  # Import multiple conferences
"""

import argparse
import re
import time
from dataclasses import dataclass
from typing import Optional

from bs4 import BeautifulSoup

from import_utils import (
    connect_db,
    verify_parent_shelf,
    get_converter,
    get_or_create_shelf,
    create_text,
    fetch_url,
    parse_general_content,
    count_cjk_characters,
    ImportStats,
    DEFAULT_REQUEST_DELAY,
)


BASE_URL = "https://www.churchofjesuschrist.org/study/general-conference"
MAIN_SHELF_NAME = "總會大會"


@dataclass
class Talk:
    """A General Conference talk."""
    slug: str
    title: str
    speaker: str


def get_conference_talks(year: int, month: int) -> list[Talk]:
    """Fetch the list of talks from a conference session page."""
    # Month should be 04 or 10
    month_str = f"{month:02d}"
    url = f"{BASE_URL}/{year}/{month_str}?lang=zho"

    html = fetch_url(url)
    if not html:
        return []

    soup = BeautifulSoup(html, "html.parser")
    talks = []

    # Find talk links in the conference page
    # The structure typically has links to individual talks
    for link in soup.find_all("a", href=True):
        href = link.get("href", "")

        # Match talk URLs like /study/general-conference/2024/10/talk-slug
        match = re.search(rf"/study/general-conference/{year}/{month_str}/([a-z0-9-]+)", href)
        if match:
            slug = match.group(1)

            # Skip non-talk pages
            skip_slugs = ["media", "watch", "about", "session", "index"]
            if any(skip in slug for skip in skip_slugs):
                continue

            # Get title from link text
            title = link.get_text(strip=True)
            if not title or len(title) < 3:
                continue

            # Try to find speaker info (usually in a nearby element)
            speaker = ""
            parent = link.find_parent(["li", "div", "article"])
            if parent:
                # Look for author/speaker class
                speaker_el = parent.find(class_=re.compile(r"(author|speaker|subtitle)"))
                if speaker_el:
                    speaker = speaker_el.get_text(strip=True)

            talk = Talk(slug=slug, title=title, speaker=speaker)

            # Avoid duplicates
            if not any(t.slug == slug for t in talks):
                talks.append(talk)

    return talks


def import_conference(
    conn,
    parent_shelf_id: int,
    year: int,
    month: int,
    converter=None,
    dry_run: bool = False,
    sort_order: int = 0,
) -> ImportStats:
    """Import a single General Conference."""
    stats = ImportStats()

    # Create conference name
    month_name = "四月" if month == 4 else "十月"
    conf_name = f"{year}年{month_name}總會大會"

    if converter:
        conf_name = converter.convert(conf_name)

    print(f"\nImporting {conf_name}...")

    # Fetch talk list
    talks = get_conference_talks(year, month)

    if not talks:
        print(f"  No talks found for {year}/{month:02d}")
        return stats

    print(f"  Found {len(talks)} talks")

    # Create conference shelf
    conf_shelf_id = get_or_create_shelf(
        conn, conf_name, parent_shelf_id, sort_order=sort_order, dry_run=dry_run
    )

    # Import each talk
    for talk_idx, talk in enumerate(talks):
        if not dry_run:
            time.sleep(DEFAULT_REQUEST_DELAY)

        url = f"{BASE_URL}/{year}/{month:02d}/{talk.slug}?lang=zho"
        html = fetch_url(url) if not dry_run else None

        if dry_run:
            print(f"  [{talk_idx + 1}/{len(talks)}] {talk.title}: [DRY RUN]")
            continue

        if not html:
            print(f"  [{talk_idx + 1}/{len(talks)}] {talk.title}: FAILED")
            stats.failed_chapters += 1
            continue

        content = parse_general_content(html)

        if not content:
            print(f"  [{talk_idx + 1}/{len(talks)}] {talk.title}: No content found")
            stats.failed_chapters += 1
            continue

        # Convert if needed
        title = talk.title
        if converter:
            content = converter.convert(content)
            title = converter.convert(title)

        char_count = count_cjk_characters(content)
        create_text(
            conn, conf_shelf_id, title, content,
            sort_order=talk_idx, dry_run=dry_run
        )

        stats.chapters_imported += 1
        stats.total_characters += char_count
        print(f"  [{talk_idx + 1}/{len(talks)}] {title}: {char_count} chars")

    return stats


def parse_conference_date(date_str: str) -> tuple[int, int]:
    """Parse a conference date string like '2024-04' into (year, month)."""
    parts = date_str.split("-")
    if len(parts) != 2:
        raise ValueError(f"Invalid date format: {date_str}. Use YYYY-MM (e.g., 2024-04)")

    year = int(parts[0])
    month = int(parts[1])

    if month not in (4, 10):
        raise ValueError(f"Month must be 04 (April) or 10 (October), got: {month:02d}")

    return year, month


def get_conference_range(from_date: str, to_date: str) -> list[tuple[int, int]]:
    """Get a list of conference (year, month) tuples in a date range."""
    from_year, from_month = parse_conference_date(from_date)
    to_year, to_month = parse_conference_date(to_date)

    conferences = []

    for year in range(from_year, to_year + 1):
        for month in [4, 10]:
            # Skip conferences before start
            if year == from_year and month < from_month:
                continue
            # Skip conferences after end
            if year == to_year and month > to_month:
                continue

            conferences.append((year, month))

    return conferences


def import_general_conference(
    parent_shelf_id: int,
    year: Optional[int] = None,
    month: Optional[int] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    convert_traditional: bool = False,
    dry_run: bool = False,
):
    """Import Chinese General Conference talks."""
    conn = connect_db()
    parent_name = verify_parent_shelf(conn, parent_shelf_id)
    print(f"Parent shelf: {parent_name} (ID: {parent_shelf_id})")

    converter = get_converter(convert_traditional)

    # Determine which conferences to import
    if from_date and to_date:
        conferences = get_conference_range(from_date, to_date)
    elif year and month:
        conferences = [(year, month)]
    else:
        print("Error: Must specify either --year/--month or --from/--to")
        return

    if not conferences:
        print("No conferences to import")
        return

    # Create main General Conference shelf
    main_shelf_name = MAIN_SHELF_NAME
    if converter:
        main_shelf_name = converter.convert(main_shelf_name)

    main_shelf_id = get_or_create_shelf(
        conn, main_shelf_name, parent_shelf_id, sort_order=0, dry_run=dry_run
    )

    print(f"\nImporting {len(conferences)} conference(s)...")
    print(f"  Request delay: {DEFAULT_REQUEST_DELAY}s")

    total_stats = ImportStats()

    for idx, (year, month) in enumerate(conferences):
        # Use reverse sort order so newest conferences appear first
        sort_order = len(conferences) - idx - 1

        stats = import_conference(
            conn=conn,
            parent_shelf_id=main_shelf_id,
            year=year,
            month=month,
            converter=converter,
            dry_run=dry_run,
            sort_order=sort_order,
        )

        total_stats.chapters_imported += stats.chapters_imported
        total_stats.total_characters += stats.total_characters
        total_stats.failed_chapters += stats.failed_chapters

    print()
    print("=" * 40)
    print(f"Import complete!")
    print(f"  Conferences: {len(conferences)}")
    print(f"  Talks imported: {total_stats.chapters_imported}")
    print(f"  Total characters: {total_stats.total_characters:,}")
    if total_stats.failed_chapters > 0:
        print(f"  Failed: {total_stats.failed_chapters}")

    conn.close()


def main():
    parser = argparse.ArgumentParser(
        description="Import Chinese General Conference talks into the library"
    )
    parser.add_argument("parent_shelf_id", type=int, help="ID of the parent shelf")

    # Single conference options
    parser.add_argument(
        "--year", "-y",
        type=int,
        help="Conference year (e.g., 2024)"
    )
    parser.add_argument(
        "--month", "-m",
        type=int,
        choices=[4, 10],
        help="Conference month: 4 (April) or 10 (October)"
    )

    # Range options
    parser.add_argument(
        "--from",
        dest="from_date",
        type=str,
        help="Start conference date (YYYY-MM, e.g., 2020-04)"
    )
    parser.add_argument(
        "--to",
        dest="to_date",
        type=str,
        help="End conference date (YYYY-MM, e.g., 2024-10)"
    )

    # Common options
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

    # Validate arguments
    single_conf = args.year is not None or args.month is not None
    range_conf = args.from_date is not None or args.to_date is not None

    if single_conf and range_conf:
        parser.error("Cannot use --year/--month with --from/--to")

    if single_conf and (args.year is None or args.month is None):
        parser.error("Must specify both --year and --month for single conference")

    if range_conf and (args.from_date is None or args.to_date is None):
        parser.error("Must specify both --from and --to for conference range")

    if not single_conf and not range_conf:
        parser.error("Must specify either --year/--month or --from/--to")

    import_general_conference(
        args.parent_shelf_id,
        year=args.year,
        month=args.month,
        from_date=args.from_date,
        to_date=args.to_date,
        convert_traditional=args.convert_traditional,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
