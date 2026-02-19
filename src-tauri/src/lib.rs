//! Chinese Reader - A desktop application for Chinese reading comprehension.
//!
//! This library provides the backend functionality for the Chinese Reader app,
//! including dictionary lookup, vocabulary tracking, and text analysis.

pub mod commands;
pub mod dictionary;
pub mod library;

use commands::AppState;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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

            // Load user segmentation words into jieba
            match library::analysis::load_user_segmentation_words(&conn) {
                Ok(count) => {
                    if count > 0 {
                        log::info!("Loaded {} user segmentation words into jieba", count);
                    }
                }
                Err(e) => {
                    log::warn!("Failed to load user segmentation words: {}", e);
                }
            }

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
            // Library shelves
            commands::create_shelf,
            commands::list_root_shelves,
            commands::get_shelf_tree,
            commands::update_shelf,
            commands::delete_shelf,
            commands::move_shelf,
            // Library texts
            commands::create_text,
            commands::get_text,
            commands::list_texts_in_shelf,
            commands::update_text,
            commands::delete_text,
            commands::import_text_file,
            commands::migrate_large_texts,
            // Library analysis
            commands::get_text_analysis,
            commands::get_analysis_report,
            commands::reanalyze_text,
            commands::get_shelf_analysis,
            commands::segment_text,
            commands::get_prestudy_characters,
            commands::get_character_context,
            commands::get_word_context_all,
            // Known words
            commands::add_known_word,
            commands::update_word_status,
            commands::remove_known_word,
            commands::list_known_words,
            commands::import_known_words,
            // Speed tracking
            commands::start_reading_session,
            commands::finish_reading_session,
            commands::discard_reading_session,
            commands::delete_reading_session,
            commands::update_session_auto_marked,
            commands::get_active_reading_session,
            commands::get_text_reading_history,
            commands::get_speed_data,
            commands::get_speed_stats,
            commands::get_daily_reading_volume,
            commands::get_reading_streak,
            // Settings
            commands::get_setting,
            commands::set_setting,
            // Auto-mark
            commands::auto_mark_text_as_known,
            // Learning
            commands::import_frequency_data,
            commands::list_frequency_sources,
            commands::get_learning_stats,
            commands::get_percentile_coverage,
            commands::get_vocabulary_progress,
            commands::record_vocabulary_snapshot,
            commands::get_shelf_frequency_analysis,
            commands::get_study_priorities,
            commands::clear_frequency_source,
            // Custom segmentation
            commands::add_custom_segmentation_word,
            commands::define_custom_word,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
