//! Error types for the dictionary module.

use thiserror::Error;

/// Errors that can occur in dictionary operations
#[derive(Error, Debug)]
pub enum DictionaryError {
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("Dictionary not found: {0}")]
    NotFound(String),

    #[error("Dictionary already exists: {0}")]
    AlreadyExists(String),

    #[error("Invalid dictionary format: {0}")]
    InvalidFormat(String),

    #[error("Download failed: {0}")]
    DownloadFailed(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON parsing error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Network error: {0}")]
    Network(String),
}

/// Result type for dictionary operations
pub type Result<T> = std::result::Result<T, DictionaryError>;
