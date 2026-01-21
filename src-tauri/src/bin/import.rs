//! Dictionary import CLI tool.
//!
//! Usage:
//!   cargo run --bin import -- [--all|--cedict|--moedict]
//!
//! Imports dictionary data files into the SQLite database.

use chinese_reader_lib::dictionary::{self, sources};
use std::env;
use std::fs::File;
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = env::args().collect();

    // Determine data directory (relative to src-tauri)
    let data_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("data");

    // Determine which dictionaries to import
    let import_all = args.len() == 1 || args.contains(&"--all".to_string());
    let import_cedict = import_all || args.contains(&"--cedict".to_string());
    let import_moedict = import_all || args.contains(&"--moedict".to_string());

    if args.contains(&"--help".to_string()) || args.contains(&"-h".to_string()) {
        print_usage();
        return;
    }

    println!("Dictionary Import Tool");
    println!("======================\n");

    // Initialize database
    let db_path = data_dir.join("dictionary.db");
    println!("Database: {:?}", db_path);

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

fn print_usage() {
    println!(
        r#"Dictionary Import Tool

Usage: cargo run --bin import -- [OPTIONS]

Options:
    --all       Import all available dictionaries (default)
    --cedict    Import CC-CEDICT only
    --moedict   Import MOE Dictionary only
    -h, --help  Show this help message

The tool looks for dictionary files in src-tauri/data/:
    - cedict.txt   (CC-CEDICT)
    - moedict.json (MOE Dictionary)

Run 'node scripts/download-dictionaries.js --all' first to download the files.
"#
    );
}
