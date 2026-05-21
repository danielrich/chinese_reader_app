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

## Service Helpers

- `install-service.sh` installs the Linux systemd service.
- `sync-db-to-linux.sh` copies a database to a Linux host for older one-way sync
  workflows.
