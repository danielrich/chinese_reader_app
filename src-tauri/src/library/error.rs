//! Error types for the library module.

use thiserror::Error;

/// Errors that can occur in library operations
#[derive(Debug, Error)]
pub enum LibraryError {
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("Shelf not found: {0}")]
    ShelfNotFound(i64),

    #[error("Text not found: {0}")]
    TextNotFound(i64),

    #[error("Invalid input: {0}")]
    InvalidInput(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Analysis not found for text: {0}")]
    AnalysisNotFound(i64),

    #[error("Session not found: {0}")]
    SessionNotFound(i64),

    #[error("Session already complete: {0}")]
    SessionAlreadyComplete(i64),

    #[error("Active session already exists for text: {0}")]
    ActiveSessionExists(i64),
}

/// Result type for library operations
pub type Result<T> = std::result::Result<T, LibraryError>;
