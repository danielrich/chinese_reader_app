//! Dictionary and frequency data import CLI tool.
//!
//! Usage:
//!   cargo run --bin import -- [--all|--cedict|--moedict]
//!   cargo run --bin import -- --frequency <file> --source <name> --type <character|word>
//!
//! Imports dictionary data files into the SQLite database.

use chinese_reader_lib::dictionary::{self, sources};
use chinese_reader_lib::library::learning;
use std::env;
use std::fs::{self, File};
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.contains(&"--help".to_string()) || args.contains(&"-h".to_string()) {
        print_usage();
        return;
    }

    // Check if this is a frequency import
    if args.contains(&"--frequency".to_string()) {
        return import_frequency_cli(&args);
    }

    // Determine data directory (relative to src-tauri, where downloaded files are)
    let data_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("data");

    // Determine which dictionaries to import
    let import_all = args.len() == 1 || args.contains(&"--all".to_string());
    let import_cedict = import_all || args.contains(&"--cedict".to_string());
    let import_moedict = import_all || args.contains(&"--moedict".to_string());

    println!("Dictionary Import Tool");
    println!("======================\n");

    // Use the same database path as the app (in Application Support)
    let db_path = match dictionary::get_default_db_path() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Failed to determine database path: {}", e);
            std::process::exit(1);
        }
    };
    println!("Database: {:?}", db_path);
    println!("Data files: {:?}\n", data_dir);

    let mut conn = match dictionary::init_connection(&db_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Failed to initialize database: {}", e);
            std::process::exit(1);
        }
    };

    // Show current stats
    if let Ok(stats) = dictionary::get_stats(&conn) {
        println!("\nCurrent database stats:");
        println!("  Total entries: {}", stats.total_entries);
        println!("  CC-CEDICT: {}", stats.cedict_entries);
        println!("  MOE Dict: {}", stats.moedict_entries);
        println!();
    }

    let mut success = true;

    // Import CC-CEDICT
    if import_cedict {
        let cedict_path = data_dir.join("cedict.txt");
        if cedict_path.exists() {
            println!("Importing CC-CEDICT from {:?}...", cedict_path);
            match import_cedict_file(&mut conn, &cedict_path) {
                Ok(count) => println!("  Added {} entries\n", count),
                Err(e) => {
                    eprintln!("  Error: {}\n", e);
                    success = false;
                }
            }
        } else {
            println!("Skipping CC-CEDICT (file not found: {:?})\n", cedict_path);
        }
    }

    // Import MOE Dict
    if import_moedict {
        let moedict_path = data_dir.join("moedict.json");
        if moedict_path.exists() {
            println!("Importing MOE Dictionary from {:?}...", moedict_path);
            match import_moedict_file(&mut conn, &moedict_path) {
                Ok(count) => println!("  Added {} entries\n", count),
                Err(e) => {
                    eprintln!("  Error: {}\n", e);
                    success = false;
                }
            }
        } else {
            println!("Skipping MOE Dictionary (file not found: {:?})\n", moedict_path);
        }
    }

    // Show final stats
    if let Ok(stats) = dictionary::get_stats(&conn) {
        println!("Final database stats:");
        println!("  Total entries: {}", stats.total_entries);
        println!("  CC-CEDICT: {}", stats.cedict_entries);
        println!("  MOE Dict: {}", stats.moedict_entries);
    }

    if success {
        println!("\nImport completed successfully!");
    } else {
        println!("\nImport completed with errors.");
        std::process::exit(1);
    }
}

fn import_cedict_file(
    conn: &mut rusqlite::Connection,
    path: &PathBuf,
) -> Result<usize, Box<dyn std::error::Error>> {
    let file = File::open(path)?;
    let stats = sources::import_cedict(conn, file)?;
    Ok(stats.entries_added)
}

fn import_moedict_file(
    conn: &mut rusqlite::Connection,
    path: &PathBuf,
) -> Result<usize, Box<dyn std::error::Error>> {
    let file = File::open(path)?;
    let stats = sources::import_moedict(conn, file)?;
    Ok(stats.entries_added)
}

fn import_frequency_cli(args: &[String]) {
    // Parse arguments
    let file_path = get_arg_value(args, "--frequency");
    let source = get_arg_value(args, "--source");
    let term_type = get_arg_value(args, "--type");

    let file_path = match file_path {
        Some(p) => PathBuf::from(p),
        None => {
            eprintln!("Error: --frequency <file> is required");
            std::process::exit(1);
        }
    };

    let source = match source {
        Some(s) => s,
        None => {
            eprintln!("Error: --source <name> is required (e.g., 'books', 'movies')");
            std::process::exit(1);
        }
    };

    let term_type = match term_type {
        Some(t) if t == "character" || t == "word" => t,
        Some(t) => {
            eprintln!("Error: --type must be 'character' or 'word', got '{}'", t);
            std::process::exit(1);
        }
        None => {
            eprintln!("Error: --type <character|word> is required");
            std::process::exit(1);
        }
    };

    if !file_path.exists() {
        eprintln!("Error: File not found: {:?}", file_path);
        std::process::exit(1);
    }

    println!("Frequency Data Import");
    println!("=====================\n");

    // Use the same database path as the app
    let db_path = match dictionary::get_default_db_path() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Failed to determine database path: {}", e);
            std::process::exit(1);
        }
    };
    println!("Database: {:?}", db_path);
    println!("File: {:?}", file_path);
    println!("Source: {}", source);
    println!("Type: {}\n", term_type);

    let conn = match dictionary::init_connection(&db_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Failed to initialize database: {}", e);
            std::process::exit(1);
        }
    };

    // Read file content
    let content = match fs::read_to_string(&file_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Failed to read file: {}", e);
            std::process::exit(1);
        }
    };

    println!("Importing frequency data...");

    match learning::import_frequency_data(&conn, &content, &source, &term_type) {
        Ok(stats) => {
            println!("\nImport completed:");
            println!("  Terms imported: {}", stats.terms_imported);
            println!("  Terms skipped (duplicates): {}", stats.terms_skipped);
            println!("  Errors: {}", stats.errors);
        }
        Err(e) => {
            eprintln!("Import failed: {}", e);
            std::process::exit(1);
        }
    }
}

fn get_arg_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn print_usage() {
    let db_path = dictionary::get_default_db_path()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "<unknown>".to_string());

    println!(
        r#"Dictionary and Frequency Import Tool

Usage:
    cargo run --bin import -- [OPTIONS]
    cargo run --bin import -- --frequency <file> --source <name> --type <character|word>

Dictionary Import Options:
    --all       Import all available dictionaries (default)
    --cedict    Import CC-CEDICT only
    --moedict   Import MOE Dictionary only

Frequency Import Options:
    --frequency <file>    Path to frequency data file (tab-separated)
    --source <name>       Source name (e.g., 'books', 'movies', 'internet')
    --type <type>         Term type: 'character' or 'word'

General Options:
    -h, --help  Show this help message

Dictionary files should be in src-tauri/data/:
    - cedict.txt   (CC-CEDICT)
    - moedict.json (MOE Dictionary)

Frequency file format (tab-separated):
    term<TAB>rank[<TAB>frequency_count]
    Example:
        我	1	1000000
        你	2	900000

Database location: {}

Run 'node scripts/download-dictionaries.js --all' first to download dictionary files.
"#,
        db_path
    );
}
