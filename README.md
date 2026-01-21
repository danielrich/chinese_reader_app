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
| **CC-CEDICT** | Community Chinese-English dictionary | ~160,000 |
| **MOE Dict** | Taiwan Ministry of Education dictionary (Traditional Chinese) | ~163,000 |
| **Kangxi** | Historical character dictionary (康熙字典) | ~47,000 |
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

### Install dependencies

```bash
npm install
```

### Download dictionary data

```bash
node scripts/download-dictionaries.js --all
```

This downloads:
- CC-CEDICT from MDBG
- MOE Dictionary from g0v/moedict-data
- Kangxi Dictionary text

### Run in development mode

```bash
npm run tauri:dev
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
│   │   │       ├── moedict.rs # MOE Dict parser
│   │   │       └── kangxi.rs  # Kangxi parser
│   │   ├── commands.rs        # Tauri commands
│   │   ├── lib.rs             # Library entry point
│   │   └── main.rs            # Application entry point
│   ├── data/                  # Dictionary data files (after download)
│   ├── Cargo.toml             # Rust dependencies
│   └── tauri.conf.json        # Tauri configuration
├── scripts/
│   └── download-dictionaries.js  # Dictionary download script
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
