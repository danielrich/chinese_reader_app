//! Apply Chinese Reader SQLite schema migrations and exit.

use chinese_reader_lib::dictionary;
use std::env;

fn main() {
    let args: Vec<String> = env::args().collect();
    let db_path = if let Some(idx) = args.iter().position(|a| a == "--db-path") {
        args.get(idx + 1)
            .cloned()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                eprintln!("--db-path requires a value");
                std::process::exit(1);
            })
    } else {
        dictionary::get_default_db_path().unwrap_or_else(|e| {
            eprintln!("Failed to determine default db path: {}", e);
            std::process::exit(1);
        })
    };

    let conn = dictionary::init_connection(&db_path).unwrap_or_else(|e| {
        eprintln!("Failed to initialize database: {}", e);
        std::process::exit(1);
    });

    let schema_version: String = conn
        .query_row(
            "SELECT value FROM dictionary_metadata WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| "unknown".to_string());

    println!("Database migrated: {}", db_path.display());
    println!("Schema version: {}", schema_version);
}
