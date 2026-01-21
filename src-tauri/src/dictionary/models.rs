//! Data models for the dictionary system.
//!
//! These models represent dictionary entries, definitions, and examples
//! from various sources (CC-CEDICT, MOE Dict, Kangxi, user dictionaries).

use serde::{Deserialize, Serialize};

/// Represents the source of a dictionary entry
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DictionarySource {
    /// CC-CEDICT community dictionary
    CcCedict,
    /// Taiwan MOE Revised Mandarin Dictionary
    MoeDict,
    /// Kangxi Dictionary (康熙字典)
    Kangxi,
    /// Chinese Text Project classical references
    Ctext,
    /// User-defined dictionary entries
    User,
}

impl DictionarySource {
    pub fn as_str(&self) -> &'static str {
        match self {
            DictionarySource::CcCedict => "cc_cedict",
            DictionarySource::MoeDict => "moe_dict",
            DictionarySource::Kangxi => "kangxi",
            DictionarySource::Ctext => "ctext",
            DictionarySource::User => "user",
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            DictionarySource::CcCedict => "CC-CEDICT",
            DictionarySource::MoeDict => "教育部國語辭典",
            DictionarySource::Kangxi => "康熙字典",
            DictionarySource::Ctext => "Chinese Text Project",
            DictionarySource::User => "User Dictionary",
        }
    }
}

/// A single definition with its part of speech and examples
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Definition {
    /// The definition text
    pub text: String,
    /// Part of speech (noun, verb, etc.) if available
    pub part_of_speech: Option<String>,
    /// Language of the definition (e.g., "en", "zh")
    pub language: String,
}

/// An example of word usage, often from classical texts
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageExample {
    /// The example sentence/phrase in Chinese
    pub text: String,
    /// Translation or explanation if available
    pub translation: Option<String>,
    /// Source of the example (e.g., "論語", "史記")
    pub source: Option<String>,
    /// Source work details (chapter, verse, etc.)
    pub source_detail: Option<String>,
}

/// A complete dictionary entry for a word or character
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DictionaryEntry {
    /// Unique identifier
    pub id: i64,
    /// Traditional Chinese form
    pub traditional: String,
    /// Simplified Chinese form
    pub simplified: String,
    /// Pinyin romanization with tone numbers (e.g., "zhong1 wen2")
    pub pinyin: String,
    /// Pinyin with tone marks (e.g., "zhōng wén")
    pub pinyin_display: Option<String>,
    /// Zhuyin/Bopomofo (e.g., "ㄓㄨㄥ ㄨㄣˊ")
    pub zhuyin: Option<String>,
    /// List of definitions
    pub definitions: Vec<Definition>,
    /// Usage examples
    pub examples: Vec<UsageExample>,
    /// Which dictionary this entry came from
    pub source: DictionarySource,
    /// Frequency rank if available (lower = more common)
    pub frequency_rank: Option<i32>,
    /// HSK level if applicable (1-6, or 7-9 for HSK 3.0)
    pub hsk_level: Option<i32>,
    /// TOCFL level if applicable
    pub tocfl_level: Option<i32>,
}

/// A character-specific entry with additional metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterEntry {
    /// The character itself
    pub character: String,
    /// Kangxi radical number (1-214)
    pub radical_number: Option<i32>,
    /// The radical character
    pub radical: Option<String>,
    /// Additional strokes beyond the radical
    pub additional_strokes: Option<i32>,
    /// Total stroke count
    pub total_strokes: Option<i32>,
    /// Character decomposition (e.g., "⿰女子" for 好)
    pub decomposition: Option<String>,
    /// Etymology information
    pub etymology: Option<String>,
    /// Variant forms of this character
    pub variants: Vec<String>,
    /// Traditional form if this is simplified
    pub traditional_form: Option<String>,
    /// Simplified form if this is traditional
    pub simplified_form: Option<String>,
}

/// User-defined dictionary for custom terms
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserDictionary {
    /// Unique identifier
    pub id: i64,
    /// Name of the dictionary (e.g., "紅樓夢人物", "Buddhist Terms")
    pub name: String,
    /// Description
    pub description: Option<String>,
    /// Domain/category (e.g., "classical", "religious", "book:紅樓夢")
    pub domain: Option<String>,
    /// Creation timestamp
    pub created_at: String,
    /// Last modified timestamp
    pub updated_at: String,
}

/// A user-defined dictionary entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserDictionaryEntry {
    /// Unique identifier
    pub id: i64,
    /// Which user dictionary this belongs to
    pub dictionary_id: i64,
    /// The term in Chinese
    pub term: String,
    /// Pinyin (optional, user-provided)
    pub pinyin: Option<String>,
    /// User's definition/note
    pub definition: String,
    /// Additional notes (e.g., "賈寶玉's sister")
    pub notes: Option<String>,
    /// Tags for categorization
    pub tags: Vec<String>,
    /// Creation timestamp
    pub created_at: String,
    /// Last modified timestamp
    pub updated_at: String,
}

/// Result of a dictionary lookup
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LookupResult {
    /// The query that was searched
    pub query: String,
    /// Entries found, grouped by source
    pub entries: Vec<DictionaryEntry>,
    /// Character-level information if query is a single character
    pub character_info: Option<CharacterEntry>,
    /// User dictionary matches
    pub user_entries: Vec<UserDictionaryEntry>,
}

/// Options for dictionary lookup
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LookupOptions {
    /// Which dictionaries to search (empty = all)
    pub sources: Vec<DictionarySource>,
    /// Include usage examples
    pub include_examples: bool,
    /// Include character decomposition info
    pub include_character_info: bool,
    /// Search in user dictionaries
    pub include_user_dictionaries: bool,
    /// Specific user dictionary IDs to search (empty = all)
    pub user_dictionary_ids: Vec<i64>,
    /// Maximum number of results per source
    pub max_results: Option<usize>,
}
