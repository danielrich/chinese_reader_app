# Chinese Reader

A desktop and web application for Chinese reading comprehension and vocabulary tracking, built with Tauri and TypeScript.

## Features (Planned)

- **Vocabulary Tracking**: Mark known and unknown words while reading
- **Anki Integration**: Export words to Anki for spaced repetition review
- **Text Analysis**: Analyze difficulty and vocabulary coverage of texts
- **Multiple Import Formats**: Support for web pages, EPUB files, and plain text
- **Reading Progress**: Track reading speed improvements over time
- **Vocabulary Domains**: Separate domains for book-specific, classical Chinese, religious, or other specialized vocabulary

## Dictionary Module

The app includes a comprehensive dictionary system with multiple sources:

### Supported Dictionary Sources

| Source | Description | Entries |
|--------|-------------|---------|
| **CC-CEDICT** | Community Chinese-English dictionary | ~124,000 |
| **MOE Dict** | Taiwan Ministry of Education dictionary (Traditional Chinese) | ~163,000 |
| **Word Frequencies** | Character/word frequency data with HSK levels | - |
| **HanDeDict** | German-Chinese dictionary (English translation) | ~84,000 |
| **MakeMeaHanzi** | Stroke order animations and character decomposition | ~9,000 |
| **User Dictionaries** | Custom dictionaries for book-specific terms | User-defined |

### Dictionary Features

- **Unified Lookup**: Search across all dictionaries simultaneously
- **Character Information**: Radical, stroke count, decomposition
- **Usage Examples**: Examples from classical and modern sources
- **Full-Text Search**: Search definitions and examples
- **User Dictionaries**: Create custom dictionaries for:
  - Book-specific terms (character names, locations)
  - Domain vocabulary (Buddhist, Daoist, Confucian)
  - Classical Chinese terms

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- [Rust](https://www.rust-lang.org/tools/install) (1.77 or later)
- [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/)

## Development

### Continuous Integration

This project uses GitHub Actions to automatically run unit tests on all pull requests. The tests must pass before a PR can be merged.

**To enable branch protection (requires repository admin access):**
1. Go to repository Settings → Branches
2. Click "Add branch protection rule"
3. Set "Branch name pattern" to `main` (or `master`)
4. Check "Require status checks to pass before merging"
5. Select the "test" check from the list
6. Check "Require branches to be up to date before merging" (optional)
7. Click "Create" or "Save changes"

### Install dependencies

```bash
npm install
```

### Download dictionary data

```bash
node scripts/download-dictionaries.js --all
```

This downloads:
- CC-CEDICT from MDBG (~9 MB)
- MOE Dictionary from g0v/moedict-data (~72 MB)
- Word Frequencies with HSK levels (~163 MB)
- HanDeDict English translations (~66 MB)
- MakeMeaHanzi stroke animations (~129 MB)

Available options: `--cedict`, `--moedict`, `--wordfreq`, `--handedict`, `--strokes`, `--all`

### Import dictionaries into database

After downloading, import the dictionaries into the SQLite database:

```bash
cd src-tauri
cargo run --bin import
```

This creates `src-tauri/data/dictionary.db` with all dictionary entries indexed for fast lookup.

Available options: `--cedict`, `--moedict`, `--all` (default)

### Import PDFs into the library

The `scripts/` directory contains a Python tool for importing PDFs with chapter structure into the library. It uses the PDF's table of contents to create a hierarchy of shelves and texts.

```bash
cd scripts

# First, find the parent shelf ID where you want to import:
sqlite3 ~/Library/Application\ Support/com.chinesereader.ChineseReader/dictionary.db "SELECT id, name FROM shelves;"

# Preview what will be imported (dry run):
uv run python import_pdf.py /path/to/book.pdf <parent_shelf_id> --dry-run

# Import the PDF:
uv run python import_pdf.py /path/to/book.pdf <parent_shelf_id>

# Import without simplified-to-traditional conversion:
uv run python import_pdf.py /path/to/book.pdf <parent_shelf_id> --no-convert
```

The importer:
- Creates shelves based on the PDF's table of contents hierarchy
- Extracts text for each chapter
- Converts simplified Chinese to traditional (Taiwan style) by default
- Skips metadata sections (character lists, glossaries, etc.)

### Import Book of Mormon (Chinese)

Import the Chinese Book of Mormon from churchofjesuschrist.org:

```bash
cd scripts

# Find the parent shelf ID:
sqlite3 ~/Library/Application\ Support/com.chinesereader.ChineseReader/dictionary.db "SELECT id, name FROM shelves;"

# Import (takes ~6 minutes due to rate limiting):
uv run python import_bofm.py <parent_shelf_id>

# Dry run to preview:
uv run python import_bofm.py <parent_shelf_id> --dry-run
```

The importer:
- Fetches all 239 chapters from the 15 books
- Creates a "摩爾門經" shelf with sub-shelves for each book
- Maintains proper chapter ordering
- Includes 1.5 second delay between requests to be gentle on the server

### Run in development mode

```bash
npm run tauri:dev
```

### Run tests

```bash
# Run Rust unit tests
cd src-tauri
cargo test --lib
```

### Build for production

```bash
npm run tauri:build
```

## Project Structure

```
chinese-reader/
├── src/                       # TypeScript frontend source
│   ├── lib/
│   │   └── dictionary.ts      # Dictionary API client
│   ├── main.ts                # Main entry point
│   └── style.css              # Global styles
├── src-tauri/                 # Rust backend source
│   ├── src/
│   │   ├── dictionary/        # Dictionary module
│   │   │   ├── mod.rs         # Module root
│   │   │   ├── models.rs      # Data models
│   │   │   ├── schema.rs      # Database schema
│   │   │   ├── lookup.rs      # Lookup functionality
│   │   │   ├── user.rs        # User dictionary management
│   │   │   ├── error.rs       # Error types
│   │   │   └── sources/       # Dictionary parsers
│   │   │       ├── cedict.rs  # CC-CEDICT parser
│   │   │       └── moedict.rs # MOE Dict parser
│   │   ├── bin/
│   │   │   └── import.rs      # CLI import tool
│   │   ├── commands.rs        # Tauri commands
│   │   ├── lib.rs             # Library entry point
│   │   └── main.rs            # Application entry point
│   ├── data/                  # Dictionary data files (after download)
│   ├── Cargo.toml             # Rust dependencies
│   └── tauri.conf.json        # Tauri configuration
├── scripts/
│   ├── download-dictionaries.js  # Dictionary download script
│   ├── import_pdf.py             # PDF import tool (uv project)
│   └── import_bofm.py            # Book of Mormon import tool
├── index.html                 # HTML entry point
├── package.json               # Node.js dependencies
└── tsconfig.json              # TypeScript configuration
```

## Dictionary API

### TypeScript Usage

```typescript
import * as dictionary from './lib/dictionary';

// Look up a word
const result = await dictionary.lookup('中文', {
  includeExamples: true,
  includeCharacterInfo: true,
});

// Create a user dictionary
const dict = await dictionary.createUserDictionary(
  '紅樓夢人物',
  'Character names from Dream of the Red Chamber',
  'book:紅樓夢'
);

// Add an entry
await dictionary.addUserDictionaryEntry(
  dict.id,
  '賈寶玉',
  'Main protagonist, son of Jia Zheng',
  'jiǎ bǎo yù',
  'Also called 寶二爺',
  ['character', 'protagonist']
);
```

### Rust Usage

```rust
use chinese_reader_lib::dictionary::{self, models::LookupOptions};

// Initialize database
let conn = dictionary::init_connection(&db_path)?;

// Lookup a word
let options = LookupOptions {
    include_examples: true,
    include_character_info: true,
    ..Default::default()
};
let result = dictionary::lookup(&conn, "中文", &options)?;
```

## License

MIT
