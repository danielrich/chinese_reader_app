#!/usr/bin/env python3
"""
Parse wordfreq.tab and extract frequency rankings.

Usage:
    python scripts/parse_wordfreq.py

Outputs tab-separated files in src-tauri/data/:
    - freq_movies_char.txt
    - freq_movies_word.txt
    - freq_books_char.txt
    - freq_books_word.txt

Terms are converted from simplified to traditional Chinese.
"""

import re
from pathlib import Path
from collections import defaultdict
from opencc import OpenCC

# Simplified to Traditional converter
s2t = OpenCC('s2t')

def to_traditional(text: str) -> str:
    """Convert simplified Chinese to traditional."""
    return s2t.convert(text)

def extract_rank(html: str, pattern: str) -> int | None:
    """Extract a rank number from HTML using a pattern."""
    match = re.search(pattern + r".*?>(\d+)<sup>", html, re.DOTALL)
    if match:
        return int(match.group(1))
    return None

def parse_wordfreq(input_path: Path) -> dict[str, dict[str, list[tuple[str, int]]]]:
    """Parse wordfreq.tab and extract frequency data."""

    # Structure: {source: {type: [(term, rank), ...]}}
    data = {
        "movies": {"character": [], "word": []},
        "books": {"character": [], "word": []},
    }

    with open(input_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or "|" in line.split("\t")[0]:
                # Skip header/metadata lines
                continue

            parts = line.split("\t", 1)
            if len(parts) != 2:
                continue

            term, html = parts
            term = term.strip()

            if not term or len(term) > 10:  # Skip very long entries
                continue

            # Extract movie frequencies
            movies_char = extract_rank(html, r"Movies.*?Character freq\.")
            movies_word = extract_rank(html, r"Movies.*?Word freq\.")

            # Extract books frequencies
            books_char = extract_rank(html, r"Character freq\. \(Books\)")
            books_word = extract_rank(html, r"Word freq\. \(Books\)")

            # Convert to traditional Chinese
            trad_term = to_traditional(term)

            if movies_char:
                data["movies"]["character"].append((trad_term, movies_char))
            if movies_word:
                data["movies"]["word"].append((trad_term, movies_word))
            if books_char:
                data["books"]["character"].append((trad_term, books_char))
            if books_word:
                data["books"]["word"].append((trad_term, books_word))

    return data

def write_frequency_file(path: Path, items: list[tuple[str, int]]):
    """Write frequency data to a tab-separated file."""
    # Sort by rank
    items.sort(key=lambda x: x[1])

    with open(path, "w", encoding="utf-8") as f:
        for term, rank in items:
            f.write(f"{term}\t{rank}\n")

    print(f"  Wrote {len(items)} entries to {path.name}")

def main():
    base_dir = Path(__file__).parent.parent
    input_path = base_dir / "src-tauri" / "data" / "wordfreq.tab"
    output_dir = base_dir / "src-tauri" / "data"

    if not input_path.exists():
        print(f"Error: {input_path} not found")
        return 1

    print(f"Parsing {input_path}...")
    data = parse_wordfreq(input_path)

    print("\nWriting frequency files:")
    write_frequency_file(output_dir / "freq_movies_char.txt", data["movies"]["character"])
    write_frequency_file(output_dir / "freq_movies_word.txt", data["movies"]["word"])
    write_frequency_file(output_dir / "freq_books_char.txt", data["books"]["character"])
    write_frequency_file(output_dir / "freq_books_word.txt", data["books"]["word"])

    print("\nDone! Now import with:")
    print("  cargo run --bin import -- --frequency data/freq_movies_char.txt --source movies --type character")
    print("  cargo run --bin import -- --frequency data/freq_movies_word.txt --source movies --type word")
    print("  cargo run --bin import -- --frequency data/freq_books_char.txt --source books --type character")
    print("  cargo run --bin import -- --frequency data/freq_books_word.txt --source books --type word")

    return 0

if __name__ == "__main__":
    exit(main())
