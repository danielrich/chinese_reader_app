# Chinese Reader

A desktop and web application for Chinese reading comprehension and vocabulary tracking, built with Tauri and TypeScript.

## Features (Planned)

- **Vocabulary Tracking**: Mark known and unknown words while reading
- **Anki Integration**: Export words to Anki for spaced repetition review
- **Text Analysis**: Analyze difficulty and vocabulary coverage of texts
- **Multiple Import Formats**: Support for web pages, EPUB files, and plain text
- **Reading Progress**: Track reading speed improvements over time
- **Vocabulary Domains**: Separate domains for book-specific, classical Chinese, religious, or other specialized vocabulary

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- [Rust](https://www.rust-lang.org/tools/install) (1.77 or later)
- [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/)

## Development

### Install dependencies

```bash
npm install
```

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
├── src/                    # TypeScript frontend source
│   ├── main.ts            # Main entry point
│   └── style.css          # Global styles
├── src-tauri/             # Rust backend source
│   ├── src/
│   │   ├── lib.rs         # Library entry point
│   │   └── main.rs        # Application entry point
│   ├── Cargo.toml         # Rust dependencies
│   └── tauri.conf.json    # Tauri configuration
├── index.html             # HTML entry point
├── package.json           # Node.js dependencies
└── tsconfig.json          # TypeScript configuration
```

## License

MIT
