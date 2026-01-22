//! User settings management.
//!
//! This module provides functions for storing and retrieving user preferences.

use crate::library::error::Result;
use rusqlite::{Connection, OptionalExtension};

/// Get a user setting value
pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    let result: Option<String> = conn
        .query_row(
            "SELECT value FROM user_settings WHERE key = ?",
            [key],
            |row| row.get(0),
        )
        .optional()?;

    Ok(result)
}

/// Set a user setting value
pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO user_settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        "#,
        [key, value],
    )?;

    Ok(())
}

/// Get a boolean setting with a default value
pub fn get_bool_setting(conn: &Connection, key: &str, default: bool) -> Result<bool> {
    match get_setting(conn, key)? {
        Some(value) => Ok(value == "true" || value == "1"),
        None => Ok(default),
    }
}

/// Set a boolean setting
pub fn set_bool_setting(conn: &Connection, key: &str, value: bool) -> Result<()> {
    set_setting(conn, key, if value { "true" } else { "false" })
}

// Setting keys
pub const SETTING_AUTO_MARK_ON_COMPLETE: &str = "auto_mark_on_complete";

/// Check if auto-mark on complete is enabled (default: false)
pub fn is_auto_mark_enabled(conn: &Connection) -> Result<bool> {
    get_bool_setting(conn, SETTING_AUTO_MARK_ON_COMPLETE, false)
}

/// Set auto-mark on complete setting
pub fn set_auto_mark_enabled(conn: &Connection, enabled: bool) -> Result<()> {
    set_bool_setting(conn, SETTING_AUTO_MARK_ON_COMPLETE, enabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictionary::schema::init_database;
    use rusqlite::Connection;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn).unwrap();
        conn
    }

    #[test]
    fn test_get_set_setting() {
        let conn = setup_test_db();

        // Initially should be None
        assert_eq!(get_setting(&conn, "test_key").unwrap(), None);

        // Set a value
        set_setting(&conn, "test_key", "test_value").unwrap();
        assert_eq!(
            get_setting(&conn, "test_key").unwrap(),
            Some("test_value".to_string())
        );

        // Update the value
        set_setting(&conn, "test_key", "new_value").unwrap();
        assert_eq!(
            get_setting(&conn, "test_key").unwrap(),
            Some("new_value".to_string())
        );
    }

    #[test]
    fn test_bool_settings() {
        let conn = setup_test_db();

        // Default value
        assert_eq!(get_bool_setting(&conn, "flag", true).unwrap(), true);
        assert_eq!(get_bool_setting(&conn, "flag", false).unwrap(), false);

        // Set to true
        set_bool_setting(&conn, "flag", true).unwrap();
        assert_eq!(get_bool_setting(&conn, "flag", false).unwrap(), true);

        // Set to false
        set_bool_setting(&conn, "flag", false).unwrap();
        assert_eq!(get_bool_setting(&conn, "flag", true).unwrap(), false);
    }

    #[test]
    fn test_auto_mark_setting() {
        let conn = setup_test_db();

        // Default is false
        assert_eq!(is_auto_mark_enabled(&conn).unwrap(), false);

        // Enable it
        set_auto_mark_enabled(&conn, true).unwrap();
        assert_eq!(is_auto_mark_enabled(&conn).unwrap(), true);

        // Disable it
        set_auto_mark_enabled(&conn, false).unwrap();
        assert_eq!(is_auto_mark_enabled(&conn).unwrap(), false);
    }
}
