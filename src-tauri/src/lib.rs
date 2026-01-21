//! Chinese Reader - A desktop application for Chinese reading comprehension.
//!
//! This library provides the backend functionality for the Chinese Reader app,
//! including dictionary lookup, vocabulary tracking, and text analysis.

pub mod commands;
pub mod dictionary;

use commands::AppState;
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Initialize logging in debug mode
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Initialize database
            let db_path = dictionary::get_default_db_path()
                .expect("Failed to determine database path");

            log::info!("Database path: {:?}", db_path);

            let conn = dictionary::init_connection(&db_path)
                .expect("Failed to initialize database");

            // Store connection in app state
            app.manage(AppState {
                db: Mutex::new(conn),
            });

            log::info!("Chinese Reader initialized successfully");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Dictionary lookup
            commands::dictionary_lookup,
            commands::dictionary_search,
            commands::dictionary_stats,
            // Dictionary import
            commands::import_cedict,
            commands::import_moedict,
            commands::import_kangxi,
            // User dictionaries
            commands::create_user_dictionary,
            commands::list_user_dictionaries,
            commands::get_user_dictionary,
            commands::delete_user_dictionary,
            commands::add_user_dictionary_entry,
            commands::list_user_dictionary_entries,
            commands::update_user_dictionary_entry,
            commands::delete_user_dictionary_entry,
            commands::import_user_dictionary_entries,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
