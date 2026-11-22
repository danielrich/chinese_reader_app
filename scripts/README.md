# Import And Maintenance Scripts

This directory contains Python and Node scripts for populating the Chinese
Reader database. The scripts operate directly on the same SQLite database used
by the Rust server.

## Database Path

Most examples assume the Linux default:

```text
~/.local/share/com.chinesereader.ChineseReader/dictionary.db
```

Find shelf IDs before importing:

```bash
sqlite3 ~/.local/share/com.chinesereader.ChineseReader/dictionary.db \
  "SELECT id, name FROM shelves ORDER BY id;"
```

## Dictionary Downloads

From the repo root:

```bash
node scripts/download-dictionaries.js --all
```

Then import from Rust:

```bash
cd src-tauri
cargo run --bin import
```

## Ebook Import

Imports EPUB files directly. AZW3 requires Calibre's `ebook-convert`.

```bash
uv run python import_ebook.py /path/to/book.epub <parent_shelf_id> --dry-run
uv run python import_ebook.py /path/to/book.epub <parent_shelf_id>
uv run python import_ebook.py /path/to/book.epub <parent_shelf_id> --convert-traditional
```

## PDF Import

Uses the PDF table of contents to create shelves/text sections.

```bash
uv run python import_pdf.py /path/to/book.pdf <parent_shelf_id> --dry-run
uv run python import_pdf.py /path/to/book.pdf <parent_shelf_id>
uv run python import_pdf.py /path/to/book.pdf <parent_shelf_id> --no-convert
```

## Book Of Mormon Import

Fetches Chinese chapters from churchofjesuschrist.org and creates a shelf tree.

```bash
uv run python import_bofm.py <parent_shelf_id> --dry-run
uv run python import_bofm.py <parent_shelf_id>
```

## Other Importers

The remaining `import_*.py` scripts are source-specific importers used for
particular corpora or book collections. Prefer running them with `--dry-run`
when available and inspect the script arguments before writing to the database.

## Qidian Web Novel Import

`qidian_study_import.py` fetches a rendered Qidian chapter with Playwright,
writes a local text/word-count snapshot, and can import the chapter through the
running Chinese Reader daemon. By default it imports the first chapter URL in
the script as traditional Chinese under:

```text
Chinese Web Novels / 凡人修仙傳 / 第一冊
```

Dry run:

```bash
uv run python qidian_study_import.py --import-app --dry-run
```

Import:

```bash
uv run python qidian_study_import.py --import-app
```

For purchased chapters, create or reuse a persistent Playwright profile:

```bash
uv run python qidian_study_import.py \
  --profile-dir playwright-qidian-profile \
  --headed \
  --login \
  --dry-run
```

After logging in once, later runs can reuse the same profile directory:

```bash
uv run python qidian_study_import.py \
  --profile-dir playwright-qidian-profile \
  --headed \
  --import-app
```

## Service Helpers

- `install-service.sh` installs the Linux systemd service.
- `sync-db-to-linux.sh` copies a database to a Linux host for older one-way sync
  workflows.

## Repair Mixed Chapter Levels

`repair_chapter_structure.py` moves each book's direct texts into individual
chapter shelves alongside the already-split chapters. It preserves existing
text IDs, titles, content, section boundaries, timestamps, and reading sessions.
It does **not** split or merge content or change future import behavior.
Use Python 3; no packages are required. Select book shelves explicitly, rather
than an author/series shelf. Each `--shelf-id` selects one level, not a subtree.

Preview first (read-only):

```bash
python3 scripts/repair_chapter_structure.py \
  --db-path /path/to/dictionary.db --shelf-id 208
```

After checking the chapter sequence against the source book, repeat with
`--apply`. A timestamped SQLite backup is created in the database's `backups/`
folder before any changes; override with `--backup-dir /path/to/backups`.
All selected books are repaired in one transaction. Rerunning an already
organized book makes no changes. Refresh the app online afterward so shelf
navigation caches pick up the new structure.

Original imported `sort_order` values determine the chapter sequence, including
interludes and front matter. Ambiguous positions, duplicate titles, unexpected
child shelves, and nested collections are rejected instead of guessed. If
positions are ambiguous, supply `--source-orders source-orders.json` with the
complete ordered title list verified against the EPUB for each affected book:

```json
{"208": ["楔子", "序曲.殺戮", "1、受颶風祝福"]}
```

The example shows the format only; the actual list must include **every**
existing chapter title for that book exactly once.

Run maintenance tests:

```bash
python3 -m unittest discover -s scripts -p 'test_*.py'
```
