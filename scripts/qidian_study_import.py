#!/usr/bin/env python3
"""Fetch a Qidian chapter and optionally import it into Chinese Reader."""

import argparse
import csv
import json
import re
import ssl
import sys
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

import jieba
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

URL = "https://www.qidian.com/chapter/107580/4631519/"
OUT_DIR = Path("study_texts")
DEFAULT_PARENT_SHELF = "Chinese Web Novels"
DEFAULT_BOOK_SHELF = "凡人修仙傳"
DEFAULT_VOLUME_SHELF = "第一冊"
DEFAULT_API_BASE = "https://localhost"
DEFAULT_PROFILE_DIR = Path("playwright-qidian-profile")

CHINESE_RE = re.compile(r"[\u4e00-\u9fff]+")
PUNCT_RE = re.compile(r"[^\u4e00-\u9fffA-Za-z0-9]+")


def fetch_rendered_html(
    url: str,
    profile_dir: Path | None = None,
    headless: bool = True,
    login: bool = False,
) -> str:
    with sync_playwright() as p:
        if profile_dir:
            context = p.chromium.launch_persistent_context(
                user_data_dir=str(profile_dir),
                headless=headless,
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/126.0 Safari/537.36"
                ),
            )
            page = context.new_page()
        else:
            browser = p.chromium.launch(headless=headless)
            context = browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/126.0 Safari/537.36"
                )
            )
            page = context.new_page()

        if login:
            page.goto("https://www.qidian.com/", wait_until="domcontentloaded", timeout=30000)
            print("Log in to Qidian in the opened browser, then press Enter here.")
            input()

        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(2500)
        html = page.content()
        context.close()
        return html


def extract_chapter_text(html: str) -> tuple[str, list[str]]:
    soup = BeautifulSoup(html, "html.parser")

    # Qidian currently renders chapter paragraphs as normal <p> elements
    # inside a chapter wrapper. This selector may need updating if the site changes.
    wrapper = (
        soup.select_one(".chapter-wrapper")
        or soup.select_one("#chapter-content")
        or soup.select_one(".chapter-content")
        or soup.select_one(".read-content")
        or soup.select_one(".main-text-wrap")
    )
    if not wrapper:
        raise RuntimeError("Could not find chapter content. The page structure may have changed.")

    title = wrapper.select_one("h1")
    title_text = title.get_text(" ", strip=True) if title else "chapter"

    paragraphs = []
    for p in wrapper.select("p"):
        text = p.get_text(" ", strip=True)

        # Qidian paragraph comments sometimes add trailing numbers like "999".
        text = re.sub(r"\s+\d+$", "", text)

        if CHINESE_RE.search(text):
            paragraphs.append(text)

    return title_text, paragraphs


def count_words(text: str) -> Counter:
    words = []
    for token in jieba.cut(text):
        token = token.strip()
        token = PUNCT_RE.sub("", token)
        if token and CHINESE_RE.search(token):
            words.append(token)
    return Counter(words)


def cjk_count(text: str) -> int:
    return len("".join(CHINESE_RE.findall(text)))


def invoke(api_base: str, command: str, payload: dict | None = None, insecure: bool = True):
    url = f"{api_base.rstrip('/')}/api/invoke/{command}"
    data = json.dumps(payload or {}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    context = ssl._create_unverified_context() if insecure and url.startswith("https://") else None

    try:
        with urllib.request.urlopen(request, context=context, timeout=60) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{command} failed ({exc.code}): {body}") from exc

    if raw == "" or raw == "null":
        return None
    return json.loads(raw)


def find_shelf(nodes: list[dict], name: str, parent_id: int | None) -> dict | None:
    for node in nodes:
        shelf = node["shelf"]
        if shelf["name"] == name and shelf["parent_id"] == parent_id:
            return shelf
        found = find_shelf(node.get("children", []), name, parent_id)
        if found:
            return found
    return None


def get_or_create_shelf(api_base: str, name: str, parent_id: int | None, dry_run: bool) -> int:
    tree = invoke(api_base, "get_shelf_tree")
    existing = find_shelf(tree, name, parent_id)
    if existing:
        print(f"Using shelf: {name} (id={existing['id']})")
        return int(existing["id"])

    if dry_run:
        parent_label = "root" if parent_id is None else str(parent_id)
        print(f"[DRY RUN] Would create shelf: {name} under {parent_label}")
        return -1

    shelf = invoke(api_base, "create_shelf", {
        "name": name,
        "description": None,
        "parent_id": parent_id,
    })
    print(f"Created shelf: {name} (id={shelf['id']})")
    return int(shelf["id"])


def import_to_chinese_reader(
    api_base: str,
    parent_shelf: str,
    book_shelf: str,
    volume_shelf: str | None,
    title: str,
    content: str,
    dry_run: bool,
    convert_traditional: bool,
) -> None:
    parent_id = get_or_create_shelf(api_base, parent_shelf, None, dry_run)
    book_id = get_or_create_shelf(api_base, book_shelf, parent_id, dry_run)
    target_id = book_id
    target_path = f"{parent_shelf}/{book_shelf}"
    if volume_shelf:
        target_id = get_or_create_shelf(api_base, volume_shelf, book_id, dry_run)
        target_path = f"{target_path}/{volume_shelf}"

    if dry_run:
        print(
            f"[DRY RUN] Would import text '{title}' to {target_path} "
            f"({cjk_count(content)} Chinese chars, convert_traditional={convert_traditional})"
        )
        return

    result = invoke(api_base, "create_text", {
        "shelf_id": target_id,
        "title": title,
        "content": content,
        "author": "忘語",
        "source_type": "web",
        "convert_to_traditional": convert_traditional,
    })
    created = result["text"]
    section_count = result.get("section_count", 1)
    print(f"Imported text id={created['id']} title={created['title']!r} sections={section_count}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=URL, help="Qidian chapter URL to import")
    parser.add_argument("--out-dir", default=str(OUT_DIR), help="Directory for fetched text and word-count files")
    parser.add_argument("--debug-html", action="store_true", help="Write the rendered HTML snapshot to out-dir")
    parser.add_argument("--import-app", action="store_true", help="Import the chapter into the running Chinese Reader daemon")
    parser.add_argument("--api-base", default=DEFAULT_API_BASE, help="Chinese Reader API base URL")
    parser.add_argument("--parent-shelf", default=DEFAULT_PARENT_SHELF, help="Root shelf for web novels")
    parser.add_argument("--book-shelf", default=DEFAULT_BOOK_SHELF, help="Series shelf under the parent shelf")
    parser.add_argument("--volume-shelf", default=DEFAULT_VOLUME_SHELF, help="Book/volume shelf under the series shelf")
    parser.add_argument("--no-volume-shelf", action="store_true", help="Import directly into the series shelf")
    parser.add_argument("--profile-dir", default=None, help=f"Persistent Playwright profile directory, e.g. {DEFAULT_PROFILE_DIR}")
    parser.add_argument("--headed", action="store_true", help="Run Chromium visibly instead of headless")
    parser.add_argument("--login", action="store_true", help="Open Qidian first and wait for login before fetching the chapter")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and report what would be imported without writing")
    parser.add_argument("--no-convert-traditional", action="store_true", help="Do not ask Chinese Reader to convert simplified text to traditional")
    return parser.parse_args()


def main():
    args = parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(exist_ok=True)

    profile_dir = Path(args.profile_dir) if args.profile_dir else None
    html = fetch_rendered_html(
        args.url,
        profile_dir=profile_dir,
        headless=not args.headed,
        login=args.login,
    )
    if args.debug_html:
        (out_dir / "qidian_debug.html").write_text(html, encoding="utf-8")

    try:
        title, paragraphs = extract_chapter_text(html)
    except Exception:
        debug_path = out_dir / "qidian_debug.html"
        debug_path.write_text(html, encoding="utf-8")
        print(f"Saved debug HTML: {debug_path}", file=sys.stderr)
        raise
    text = "\n\n".join(paragraphs)

    safe_title = re.sub(r"[^\w\u4e00-\u9fff-]+", "_", title).strip("_")
    text_path = out_dir / f"{safe_title}.txt"
    counts_path = out_dir / f"{safe_title}_word_counts.csv"

    text_path.write_text(text, encoding="utf-8")

    counts = count_words(text)
    with counts_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["word", "count"])
        for word, count in counts.most_common():
            writer.writerow([word, count])

    char_count = cjk_count(text)
    print(f"Saved text: {text_path}")
    print(f"Saved word counts: {counts_path}")
    print(f"Chinese characters: {char_count}")
    print(f"Unique segmented words: {len(counts)}")

    if args.import_app:
        import_to_chinese_reader(
            args.api_base,
            args.parent_shelf,
            args.book_shelf,
            None if args.no_volume_shelf else args.volume_shelf,
            title,
            text,
            args.dry_run,
            not args.no_convert_traditional,
        )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
