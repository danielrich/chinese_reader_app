//! Data models for the library system.
//!
//! These models represent shelves, texts, and analysis results
//! for organizing and analyzing Chinese reading materials.

use serde::{Deserialize, Serialize};

/// A shelf for organizing texts (can be hierarchical)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shelf {
    /// Unique identifier
    pub id: i64,
    /// Shelf name
    pub name: String,
    /// Optional description
    pub description: Option<String>,
    /// Parent shelf ID for nesting (None = root shelf)
    pub parent_id: Option<i64>,
    /// Sort order within parent
    pub sort_order: i64,
    /// Creation timestamp
    pub created_at: String,
    /// Last modified timestamp
    pub updated_at: String,
}

/// A shelf with its children and text count (for tree display)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShelfTree {
    /// The shelf itself
    pub shelf: Shelf,
    /// Child shelves
    pub children: Vec<ShelfTree>,
    /// Number of texts directly in this shelf
    pub text_count: i64,
    /// Number of unread texts in this shelf and all descendant shelves
    pub unread_count: i64,
}

/// A text stored in a shelf
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Text {
    /// Unique identifier
    pub id: i64,
    /// Parent shelf ID
    pub shelf_id: i64,
    /// Text title
    pub title: String,
    /// Optional author
    pub author: Option<String>,
    /// How the text was added ("paste" or "file")
    pub source_type: String,
    /// The actual text content
    pub content: String,
    /// Character count (CJK characters only)
    pub character_count: i64,
    /// Creation timestamp
    pub created_at: String,
    /// Last modified timestamp
    pub updated_at: String,
}

/// Summary of a text (without full content, for list views)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextSummary {
    /// Unique identifier
    pub id: i64,
    /// Parent shelf ID
    pub shelf_id: i64,
    /// Text title
    pub title: String,
    /// Optional author
    pub author: Option<String>,
    /// Character count
    pub character_count: i64,
    /// Whether analysis has been performed
    pub has_analysis: bool,
    /// Creation timestamp
    pub created_at: String,
}

/// Cached analysis results for a text
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextAnalysis {
    /// Text ID this analysis belongs to
    pub text_id: i64,
    /// Total CJK characters in the text
    pub total_characters: i64,
    /// Number of unique characters
    pub unique_characters: i64,
    /// Unique characters that are in the user's known vocabulary
    pub known_characters: i64,
    /// Total occurrences of known characters in the text
    pub known_character_occurrences: i64,
    /// Total words (jieba-segmented)
    pub total_words: i64,
    /// Number of unique words
    pub unique_words: i64,
    /// Unique words that are in the user's known vocabulary
    pub known_words: i64,
    /// Total occurrences of known words in the text
    pub known_word_occurrences: i64,
    /// When the analysis was performed
    pub analyzed_at: String,
}

/// Character frequency in a text
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterFrequency {
    /// The character
    pub character: String,
    /// How many times it appears in this text
    pub frequency: i64,
    /// General frequency rank (lower = more common, None if not in dictionary)
    pub general_frequency_rank: Option<i64>,
    /// Whether the user knows this character
    pub is_known: bool,
}

/// Word frequency in a text
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WordFrequency {
    /// The word
    pub word: String,
    /// How many times it appears in this text
    pub frequency: i64,
    /// General frequency rank (lower = more common, None if not in dictionary)
    pub general_frequency_rank: Option<i64>,
    /// Whether the user knows this word
    pub is_known: bool,
}

/// Sort order for frequency lists
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FrequencySort {
    /// Sort by frequency in the text (default)
    #[default]
    TextFrequency,
    /// Sort by general frequency rank
    GeneralFrequency,
}

/// Status of a known word
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum WordStatus {
    /// Fully learned
    #[default]
    Known,
    /// Currently learning (counts as unknown for analysis)
    Learning,
}

impl WordStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            WordStatus::Known => "known",
            WordStatus::Learning => "learning",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "learning" => WordStatus::Learning,
            _ => WordStatus::Known,
        }
    }
}

/// A known word in the user's vocabulary
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownWord {
    /// Unique identifier
    pub id: i64,
    /// The word or character
    pub word: String,
    /// Type: "character" or "word"
    pub word_type: String,
    /// Status: "known" or "learning"
    pub status: String,
    /// Proficiency level (1-5)
    pub proficiency: i64,
    /// When it was added
    pub created_at: String,
}

/// Full analysis report for a text
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisReport {
    /// Summary statistics
    pub summary: TextAnalysis,
    /// Top characters by frequency
    pub top_characters: Vec<CharacterFrequency>,
    /// Unknown characters (sorted by frequency)
    pub unknown_characters: Vec<CharacterFrequency>,
    /// Known characters (sorted by frequency)
    pub known_characters: Vec<CharacterFrequency>,
    /// Top words by frequency
    pub top_words: Vec<WordFrequency>,
    /// Unknown words (sorted by frequency)
    pub unknown_words: Vec<WordFrequency>,
    /// Known words (sorted by frequency)
    pub known_words_list: Vec<WordFrequency>,
}

/// Statistics from importing known words
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportStats {
    /// Number of words successfully added
    pub words_added: usize,
    /// Number of words skipped (already existed)
    pub words_skipped: usize,
    /// Number of errors
    pub errors: usize,
}

/// Aggregated analysis for a shelf (across all texts)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShelfAnalysis {
    /// Shelf ID
    pub shelf_id: i64,
    /// Number of texts analyzed
    pub text_count: i64,
    /// Total CJK characters across all texts
    pub total_characters: i64,
    /// Unique characters across all texts
    pub unique_characters: i64,
    /// Known unique characters
    pub known_characters_count: i64,
    /// Total words across all texts
    pub total_words: i64,
    /// Unique words across all texts
    pub unique_words: i64,
    /// Known unique words
    pub known_words_count: i64,
    /// Unknown characters (sorted by frequency)
    pub unknown_characters: Vec<CharacterFrequency>,
    /// Known characters (sorted by frequency)
    pub known_characters: Vec<CharacterFrequency>,
    /// Unknown words (sorted by frequency)
    pub unknown_words: Vec<WordFrequency>,
    /// Known words (sorted by frequency)
    pub known_words: Vec<WordFrequency>,
}

/// A segment of text (word or punctuation) with known/unknown status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextSegment {
    /// The text content of this segment
    pub text: String,
    /// Whether this segment is a CJK word/character
    pub is_cjk: bool,
    /// Whether this is known (only meaningful if is_cjk is true)
    pub is_known: bool,
    /// Whether this is in learning status (only meaningful if is_cjk is true)
    pub is_learning: bool,
    /// Segment type: "word" (2+ chars), "character" (single CJK), or "punctuation"
    pub segment_type: String,
}

// =============================================================================
// Learning Module Models
// =============================================================================

/// A frequency data source
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrequencySource {
    /// Source name (e.g., "books", "movies")
    pub name: String,
    /// Display name for UI
    pub display_name: String,
    /// Number of terms in this source
    pub term_count: i64,
}

/// Coverage statistics for a percentile threshold
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PercentileCoverage {
    /// Percentile threshold (e.g., 50, 60, 70, 80, 90, 95, 99)
    pub percentile: i64,
    /// Total terms in this percentile
    pub total_terms: i64,
    /// Known terms in this percentile
    pub known_terms: i64,
    /// Learning terms in this percentile
    pub learning_terms: i64,
    /// Coverage percentage (known / total * 100)
    pub coverage_percent: f64,
}

/// Aggregated learning statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearningStats {
    /// Total known characters
    pub total_known_characters: i64,
    /// Total known words
    pub total_known_words: i64,
    /// Total characters in learning status
    pub total_learning_characters: i64,
    /// Total words in learning status
    pub total_learning_words: i64,
    /// Character percentile coverage (by selected source)
    pub character_coverage: Vec<PercentileCoverage>,
    /// Word percentile coverage (by selected source)
    pub word_coverage: Vec<PercentileCoverage>,
    /// Frequency source used for this analysis
    pub frequency_source: String,
}

/// Vocabulary progress over time
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VocabularyProgress {
    /// Date of the snapshot (YYYY-MM-DD)
    pub date: String,
    /// Known characters at this date
    pub known_characters: i64,
    /// Known words at this date
    pub known_words: i64,
    /// Learning characters at this date
    pub learning_characters: i64,
    /// Learning words at this date
    pub learning_words: i64,
}

/// Frequency analysis for a specific shelf
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShelfFrequencyAnalysis {
    /// Shelf ID
    pub shelf_id: i64,
    /// Shelf name
    pub shelf_name: String,
    /// Percentile coverage for characters in this shelf
    pub character_coverage: Vec<PercentileCoverage>,
    /// Percentile coverage for words in this shelf
    pub word_coverage: Vec<PercentileCoverage>,
    /// Unknown high-frequency terms to prioritize
    pub unknown_high_frequency: Vec<TermFrequencyInfo>,
}

/// Information about a term's frequency
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TermFrequencyInfo {
    /// The term (character or word)
    pub term: String,
    /// Type: "character" or "word"
    pub term_type: String,
    /// Rank in the general frequency list (lower = more common)
    pub rank: Option<i64>,
    /// Whether the user knows this term
    pub is_known: bool,
    /// Whether the user is learning this term
    pub is_learning: bool,
}

/// Statistics from importing frequency data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrequencyImportStats {
    /// Number of terms imported
    pub terms_imported: usize,
    /// Number of terms skipped (duplicates)
    pub terms_skipped: usize,
    /// Number of errors
    pub errors: usize,
}

/// A character for pre-study with its frequency and cumulative contribution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreStudyCharacter {
    /// The character
    pub character: String,
    /// Occurrences in the shelf's texts
    pub frequency: i64,
    /// Percentage contribution to coverage if learned
    pub coverage_contribution: f64,
    /// Cumulative coverage after learning this and previous characters
    pub cumulative_coverage: f64,
    /// Whether this character is in "learning" status
    pub is_learning: bool,
}

/// Result of pre-study analysis for a shelf
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreStudyResult {
    /// Shelf ID analyzed
    pub shelf_id: i64,
    /// Current known character rate (0-100)
    pub current_known_rate: f64,
    /// Target known rate (e.g., 90)
    pub target_rate: f64,
    /// Whether pre-study is needed
    pub needs_prestudy: bool,
    /// Characters to study, ordered by priority (highest frequency first)
    pub characters_to_study: Vec<PreStudyCharacter>,
    /// Number of characters needed to reach target
    pub characters_needed: i64,
    /// Total characters in the shelf (by occurrence)
    pub total_character_occurrences: i64,
}

/// A word to study in word-level pre-study
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreStudyWord {
    /// The word
    pub word: String,
    /// Occurrences in the shelf's texts
    pub frequency: i64,
    /// Percentage coverage contribution if learned
    pub coverage_contribution: f64,
    /// Cumulative coverage after learning this and previous words
    pub cumulative_coverage: f64,
    /// Whether this word is in "learning" status
    pub is_learning: bool,
}

/// Result of word-level pre-study analysis for a shelf
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreStudyWordResult {
    pub shelf_id: i64,
    /// Current known word rate (0-100) by occurrence
    pub current_known_rate: f64,
    pub target_rate: f64,
    pub needs_prestudy: bool,
    pub words_to_study: Vec<PreStudyWord>,
    pub words_needed: i64,
    pub total_word_occurrences: i64,
}

/// A context snippet showing a character in use
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextSnippet {
    /// The text ID this snippet is from
    pub text_id: i64,
    /// The text title
    pub text_title: String,
    /// The snippet content (character + surrounding context)
    pub snippet: String,
    /// Position of the target character in the snippet
    pub character_position: usize,
}

/// Context snippets for a character from a shelf's texts
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterContext {
    /// The character being looked up
    pub character: String,
    /// Context snippets from various texts
    pub snippets: Vec<ContextSnippet>,
}
