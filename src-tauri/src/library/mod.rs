//! Library module for organizing and analyzing Chinese texts.
//!
//! Provides functionality for:
//! - Hierarchical shelves for organizing texts
//! - Text storage and retrieval
//! - Text analysis (character/word frequency)
//! - Known vocabulary tracking
//! - Learning progress and frequency analysis

pub mod analysis;
pub mod error;
pub mod known_words;
pub mod learning;
pub mod models;
pub mod settings;
pub mod shelf;
pub mod speed;
pub mod text;

pub use error::{LibraryError, Result};
pub use models::*;
pub use speed::{DailyReadingVolume, ReadingSession, ReadingStreak, SpeedDataPoint, SpeedStats};
pub use text::{CreateTextResult, MigrateLargeTextsResult, MAX_SECTION_CHARS};
