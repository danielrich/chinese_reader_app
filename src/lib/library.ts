/**
 * Library Types and API for Chinese Reader
 *
 * This module provides TypeScript types and functions for interacting
 * with the library backend via Tauri commands.
 */

import { invoke, fetchJson } from "./api";
import { ingestTextVocabCache } from "./idb";

// =============================================================================
// Types
// =============================================================================

/** A shelf for organizing texts */
export interface Shelf {
  /** Unique identifier */
  id: number;
  /** Shelf name */
  name: string;
  /** Optional description */
  description: string | null;
  /** Parent shelf ID (null = root) */
  parent_id: number | null;
  /** Sort order within parent */
  sort_order: number;
  /** Creation timestamp */
  created_at: string;
  /** Last modified timestamp */
  updated_at: string;
}

/** A shelf with children and text count (for tree display) */
export interface ShelfTree {
  /** The shelf */
  shelf: Shelf;
  /** Child shelves */
  children: ShelfTree[];
  /** Number of texts in this shelf */
  text_count: number;
  /** Number of unread texts in this shelf */
  unread_count: number;
}

/** A text stored in a shelf */
export interface Text {
  /** Unique identifier */
  id: number;
  /** Parent shelf ID */
  shelf_id: number;
  /** Text title */
  title: string;
  /** Optional author */
  author: string | null;
  /** Source type ("paste" or "file") */
  source_type: string;
  /** The actual text content */
  content: string;
  /** CJK character count */
  character_count: number;
  /** Creation timestamp */
  created_at: string;
  /** Last modified timestamp */
  updated_at: string;
}

/** Summary of a text (without content) */
export interface TextSummary {
  /** Unique identifier */
  id: number;
  /** Parent shelf ID */
  shelf_id: number;
  /** Text title */
  title: string;
  /** Optional author */
  author: string | null;
  /** CJK character count */
  character_count: number;
  /** Whether analysis has been performed */
  has_analysis: boolean;
  /** Creation timestamp */
  created_at: string;
}

/** Cached analysis results */
export interface TextAnalysis {
  /** Text ID */
  text_id: number;
  /** Total CJK characters */
  total_characters: number;
  /** Unique characters */
  unique_characters: number;
  /** Unique known characters */
  known_characters: number;
  /** Total occurrences of known characters */
  known_character_occurrences: number;
  /** Total words (segmented) */
  total_words: number;
  /** Unique words */
  unique_words: number;
  /** Unique known words */
  known_words: number;
  /** Total occurrences of known words */
  known_word_occurrences: number;
  /** Analysis timestamp */
  analyzed_at: string;
}

/** Character frequency in a text */
export interface CharacterFrequency {
  /** The character */
  character: string;
  /** Frequency count in this text */
  frequency: number;
  /** General frequency rank (lower = more common, null if not in dictionary) */
  general_frequency_rank: number | null;
  /** Whether user knows it */
  is_known: boolean;
}

/** Word frequency in a text */
export interface WordFrequency {
  /** The word */
  word: string;
  /** Frequency count in this text */
  frequency: number;
  /** General frequency rank (lower = more common, null if not in dictionary) */
  general_frequency_rank: number | null;
  /** Whether user knows it */
  is_known: boolean;
}

/** Sort order for frequency lists */
export type FrequencySort = "text_frequency" | "general_frequency";

/** Full analysis report */
export interface AnalysisReport {
  /** Summary statistics */
  summary: TextAnalysis;
  /** Top characters by frequency */
  top_characters: CharacterFrequency[];
  /** Unknown characters by frequency */
  unknown_characters: CharacterFrequency[];
  /** Known characters by frequency */
  known_characters: CharacterFrequency[];
  /** Top words by frequency */
  top_words: WordFrequency[];
  /** Unknown words by frequency */
  unknown_words: WordFrequency[];
  /** Known words by frequency */
  known_words_list: WordFrequency[];
}

/** A known word in user's vocabulary */
export interface KnownWord {
  /** Unique identifier */
  id: number;
  /** The word or character */
  word: string;
  /** Type: "character" or "word" */
  word_type: string;
  /** Status: "known" or "learning" */
  status: string;
  /** Proficiency level (1-5) */
  proficiency: number;
  /** Creation timestamp */
  created_at: string;
}

/** Import statistics */
export interface ImportStats {
  /** Words successfully added */
  words_added: number;
  /** Words skipped (already existed) */
  words_skipped: number;
  /** Number of errors */
  errors: number;
}

/** Result of creating a text (may be split into sections) */
export interface CreateTextResult {
  /** The created text (or first section if split) */
  text: Text;
  /** If the text was split, the shelf containing all sections */
  section_shelf_id: number | null;
  /** Total number of sections created (1 if not split) */
  section_count: number;
}

/** Result of migrating large texts */
export interface MigrateLargeTextsResult {
  /** Number of texts that were migrated */
  texts_migrated: number;
  /** Number of sections created */
  sections_created: number;
  /** Number of shelves created */
  shelves_created: number;
}

/** Aggregated analysis for a shelf */
export interface ShelfAnalysis {
  /** Shelf ID */
  shelf_id: number;
  /** Number of texts analyzed */
  text_count: number;
  /** Total CJK characters across all texts */
  total_characters: number;
  /** Unique characters across all texts */
  unique_characters: number;
  /** Known unique characters count */
  known_characters_count: number;
  /** Total words across all texts */
  total_words: number;
  /** Unique words across all texts */
  unique_words: number;
  /** Known unique words count */
  known_words_count: number;
  /** Unknown characters by frequency */
  unknown_characters: CharacterFrequency[];
  /** Known characters by frequency */
  known_characters: CharacterFrequency[];
  /** Unknown words by frequency */
  unknown_words: WordFrequency[];
  /** Known words by frequency */
  known_words: WordFrequency[];
}

/** A segment of text with known/unknown/learning status */
export interface TextSegment {
  /** The text content */
  text: string;
  /** Whether this is a CJK word/character */
  is_cjk: boolean;
  /** Whether this is known (meaningful only if is_cjk) */
  is_known: boolean;
  /** Whether this is in learning status (meaningful only if is_cjk) */
  is_learning: boolean;
  /** Segment type: "word", "character", or "punctuation" */
  segment_type: string;
}

/** A character for pre-study with frequency and coverage info */
export interface PreStudyCharacter {
  /** The character */
  character: string;
  /** Occurrences in the shelf's texts */
  frequency: number;
  /** Percentage contribution to coverage if learned */
  coverage_contribution: number;
  /** Cumulative coverage after learning this and previous characters */
  cumulative_coverage: number;
  /** Whether this character is in "learning" status */
  is_learning: boolean;
}

/** Result of pre-study analysis for a shelf */
export interface PreStudyResult {
  /** Shelf ID analyzed */
  shelf_id: number;
  /** Current known character rate (0-100) */
  current_known_rate: number;
  /** Target known rate (e.g., 90) */
  target_rate: number;
  /** Whether pre-study is needed */
  needs_prestudy: boolean;
  /** Characters to study, ordered by priority */
  characters_to_study: PreStudyCharacter[];
  /** Number of characters needed to reach target */
  characters_needed: number;
  /** Total characters in the shelf (by occurrence) */
  total_character_occurrences: number;
}

/** A context snippet showing a character in use */
export interface ContextSnippet {
  /** Text ID this snippet is from */
  text_id: number;
  /** Text title */
  text_title: string;
  /** The snippet content */
  snippet: string;
  /** Position of target character in snippet */
  character_position: number;
}

/** Context snippets for a character from a shelf's texts */
export interface CharacterContext {
  /** The character being looked up */
  character: string;
  /** Context snippets */
  snippets: ContextSnippet[];
}

// =============================================================================
// Shelf API
// =============================================================================

/**
 * Create a new shelf
 */
export async function createShelf(
  name: string,
  description?: string,
  parentId?: number
): Promise<Shelf> {
  return invoke<Shelf>("create_shelf", {
    name,
    description,
    parentId,
  });
}

/**
 * List root shelves (no parent)
 */
export async function listRootShelves(): Promise<Shelf[]> {
  return invoke<Shelf[]>("list_root_shelves");
}

/**
 * Get the full shelf tree
 */
export async function getShelfTree(): Promise<ShelfTree[]> {
  return invoke<ShelfTree[]>("get_shelf_tree");
}

/**
 * Update a shelf
 */
export async function updateShelf(
  id: number,
  updates: { name?: string; description?: string }
): Promise<void> {
  return invoke<void>("update_shelf", {
    id,
    ...updates,
  });
}

/**
 * Delete a shelf
 */
export async function deleteShelf(id: number): Promise<void> {
  return invoke<void>("delete_shelf", { id });
}

/**
 * Move a shelf to a new parent
 */
export async function moveShelf(
  id: number,
  newParentId?: number
): Promise<void> {
  return invoke<void>("move_shelf", { id, newParentId });
}

// =============================================================================
// Text API
// =============================================================================

/**
 * Create a new text (auto-splits large texts into sections)
 * Returns the text and info about whether it was split
 */
export async function createText(
  shelfId: number,
  title: string,
  content: string,
  author?: string,
  sourceType: string = "paste",
  convertToTraditional: boolean = false
): Promise<CreateTextResult> {
  return invoke<CreateTextResult>("create_text", {
    shelfId,
    title,
    content,
    author,
    sourceType,
    convertToTraditional,
  });
}

/**
 * Get a text by ID
 */
export async function getText(id: number): Promise<Text> {
  return fetchJson<Text>(`/api/texts/${id}`);
}

/** A vocab cache entry for offline dictionary lookup */
export interface VocabCacheEntry {
  term: string;
  pinyin: string;
  definitions: string[];
  source: string;
}

/** Cached vocab data for a text (words + characters) */
export interface TextVocabCache {
  text_id: number;
  words: VocabCacheEntry[];
  characters: VocabCacheEntry[];
}

/**
 * Get the vocab cache for a text (words + characters with definitions)
 */
export async function getTextVocabCache(textId: number): Promise<TextVocabCache> {
  const cache = await fetchJson<TextVocabCache>(`/api/texts/${textId}/vocab-cache`);
  // Fire-and-forget: persist for offline lookup
  ingestTextVocabCache(cache).catch((err) =>
    console.warn("ingest vocab-cache failed:", err),
  );
  return cache;
}

/**
 * List texts in a shelf
 */
export async function listTextsInShelf(shelfId: number): Promise<TextSummary[]> {
  return invoke<TextSummary[]>("list_texts_in_shelf", { shelfId });
}

/**
 * Update a text
 */
export async function updateText(
  id: number,
  updates: { title?: string; author?: string }
): Promise<void> {
  return invoke<void>("update_text", {
    id,
    ...updates,
  });
}

/**
 * Delete a text
 */
export async function deleteText(id: number): Promise<void> {
  return invoke<void>("delete_text", { id });
}

/**
 * Import a text from a file (auto-splits large texts)
 */
export async function importTextFile(
  shelfId: number,
  filePath: string,
  convertToTraditional: boolean = false
): Promise<Text> {
  return invoke<Text>("import_text_file", { shelfId, filePath, convertToTraditional });
}

/**
 * Migrate large texts (>1500 characters) into shelves with sections
 * If shelfId is provided, only migrate texts in that shelf (and sub-shelves)
 */
export async function migrateLargeTexts(shelfId?: number): Promise<MigrateLargeTextsResult> {
  return invoke<MigrateLargeTextsResult>("migrate_large_texts", { shelfId });
}

/**
 * Search texts by query string (title, author, or content)
 */
export async function searchTexts(query: string): Promise<TextSummary[]> {
  return invoke<TextSummary[]>("search_texts", { query });
}

// =============================================================================
// Analysis API
// =============================================================================

/**
 * Get text analysis (runs if not cached)
 */
export async function getTextAnalysis(textId: number): Promise<TextAnalysis> {
  return invoke<TextAnalysis>("get_text_analysis", { textId });
}

/**
 * Get full analysis report
 */
export async function getAnalysisReport(
  textId: number,
  topN?: number,
  sort?: FrequencySort
): Promise<AnalysisReport> {
  return invoke<AnalysisReport>("get_analysis_report", { textId, topN, sort });
}

/**
 * Re-analyze a text
 */
export async function reanalyzeText(textId: number): Promise<TextAnalysis> {
  return invoke<TextAnalysis>("reanalyze_text", { textId });
}

/**
 * Get aggregated analysis for a shelf
 */
export async function getShelfAnalysis(shelfId: number): Promise<ShelfAnalysis> {
  return invoke<ShelfAnalysis>("get_shelf_analysis", { shelfId });
}

/**
 * Segment text content with known/unknown status
 */
export async function segmentText(content: string): Promise<TextSegment[]> {
  return invoke<TextSegment[]>("segment_text", { content });
}

/**
 * Get pre-study characters needed to reach target known rate
 */
export async function getPrestudy(
  shelfId: number,
  targetRate: number = 90
): Promise<PreStudyResult> {
  return invoke<PreStudyResult>("get_prestudy_characters", { shelfId, targetRate });
}

/**
 * Get context snippets for a character from texts in a shelf
 */
export async function getCharacterContext(
  shelfId: number,
  character: string,
  maxSnippets: number = 3
): Promise<CharacterContext> {
  return invoke<CharacterContext>("get_character_context", { shelfId, character, maxSnippets });
}

/**
 * Get context snippets for a word/character from all texts in the library
 */
export async function getWordContextAll(
  word: string,
  maxSnippets: number = 5
): Promise<CharacterContext> {
  return invoke<CharacterContext>("get_word_context_all", { word, maxSnippets });
}

// =============================================================================
// Known Words API
// =============================================================================

/**
 * Add a known word
 */
export async function addKnownWord(
  word: string,
  wordType: string,
  status?: string,
  proficiency?: number
): Promise<KnownWord> {
  return invoke<KnownWord>("add_known_word", {
    word,
    wordType,
    status,
    proficiency,
  });
}

/**
 * Update the status of a known word
 */
export async function updateWordStatus(
  word: string,
  status: string
): Promise<void> {
  return invoke<void>("update_word_status", {
    word,
    status,
  });
}

/**
 * Remove a known word
 */
export async function removeKnownWord(word: string): Promise<void> {
  return invoke<void>("remove_known_word", { word });
}

/**
 * List known words
 */
export async function listKnownWords(
  wordType?: string,
  status?: string,
  limit?: number,
  offset?: number
): Promise<KnownWord[]> {
  return invoke<KnownWord[]>("list_known_words", {
    wordType,
    status,
    limit,
    offset,
  });
}

/**
 * Import known words from content (one word per line)
 */
export async function importKnownWords(
  content: string,
  wordType: string
): Promise<ImportStats> {
  return invoke<ImportStats>("import_known_words", {
    content,
    wordType,
  });
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Calculate known character rate percentage
 */
export function calculateKnownCharacterRate(analysis: TextAnalysis): number {
  if (analysis.unique_characters === 0) return 100;
  return Math.round((analysis.known_characters / analysis.unique_characters) * 100);
}

/**
 * Calculate known word rate percentage
 */
export function calculateKnownWordRate(analysis: TextAnalysis): number {
  if (analysis.unique_words === 0) return 100;
  return Math.round((analysis.known_words / analysis.unique_words) * 100);
}

/**
 * @deprecated Use calculateKnownCharacterRate instead
 */
export function calculateDifficulty(analysis: TextAnalysis): number {
  return 100 - calculateKnownCharacterRate(analysis);
}

/**
 * Format character count for display
 */
export function formatCharacterCount(count: number): string {
  if (count >= 10000) {
    return `${(count / 10000).toFixed(1)}万`;
  }
  return count.toLocaleString();
}

/**
 * Get shelf path from tree (for breadcrumbs)
 */
export function getShelfPath(
  tree: ShelfTree[],
  shelfId: number
): Shelf[] {
  const path: Shelf[] = [];

  function findPath(nodes: ShelfTree[], targetId: number): boolean {
    for (const node of nodes) {
      if (node.shelf.id === targetId) {
        path.push(node.shelf);
        return true;
      }
      if (findPath(node.children, targetId)) {
        path.unshift(node.shelf);
        return true;
      }
    }
    return false;
  }

  findPath(tree, shelfId);
  return path;
}

/**
 * Flatten shelf tree to array
 */
export function flattenShelfTree(tree: ShelfTree[]): ShelfTree[] {
  const result: ShelfTree[] = [];

  function traverse(nodes: ShelfTree[]) {
    for (const node of nodes) {
      result.push(node);
      traverse(node.children);
    }
  }

  traverse(tree);
  return result;
}

// =============================================================================
// Settings API
// =============================================================================

/** Setting keys */
export const SETTING_AUTO_MARK_ON_COMPLETE = "auto_mark_on_complete";

/**
 * Get a user setting
 */
export async function getSetting(key: string): Promise<string | null> {
  return invoke<string | null>("get_setting", { key });
}

/**
 * Set a user setting
 */
export async function setSetting(key: string, value: string): Promise<void> {
  return invoke<void>("set_setting", { key, value });
}

/**
 * Get auto-mark on complete setting
 */
export async function isAutoMarkEnabled(): Promise<boolean> {
  const value = await getSetting(SETTING_AUTO_MARK_ON_COMPLETE);
  return value === "true";
}

/**
 * Set auto-mark on complete setting
 */
export async function setAutoMarkEnabled(enabled: boolean): Promise<void> {
  return setSetting(SETTING_AUTO_MARK_ON_COMPLETE, enabled ? "true" : "false");
}

// =============================================================================
// Auto-Mark API
// =============================================================================

/** Auto-mark statistics */
export interface AutoMarkStats {
  /** Characters marked as known */
  characters_marked: number;
  /** Words marked as known */
  words_marked: number;
}

/**
 * Auto-mark all unknown characters and words from a text as known.
 * Learning words/characters maintain their status.
 */
export async function autoMarkTextAsKnown(textId: number): Promise<AutoMarkStats> {
  return invoke<AutoMarkStats>("auto_mark_text_as_known", { textId });
}

// =============================================================================
// Custom Segmentation API
// =============================================================================

/** Result of adding a custom segmentation word */
export interface AddCustomWordResult {
  /** The word that was added */
  word: string;
  /** Whether the word was added to jieba segmentation */
  added_to_segmentation: boolean;
  /** The known word entry if added to vocabulary */
  known_word: KnownWord | null;
}

/**
 * Add a custom segmentation word.
 * This adds the word to jieba's dictionary so it will be recognized during segmentation.
 * Optionally also adds it to the known_words table.
 *
 * @param word The word to add to segmentation
 * @param addToVocabulary Whether to also add this word to known_words
 * @param status Optional status ("known" or "learning") if adding to vocabulary
 */
export async function addCustomSegmentationWord(
  word: string,
  addToVocabulary: boolean,
  status?: string
): Promise<AddCustomWordResult> {
  return invoke<AddCustomWordResult>("add_custom_segmentation_word", {
    word,
    addToVocabulary,
    status,
  });
}

/** Result of defining a custom word with user dictionary entry */
export interface DefineCustomWordResult {
  /** The word that was defined */
  word: string;
  /** The user dictionary ID the entry was added to */
  dictionary_id: number;
  /** The user dictionary name */
  dictionary_name: string;
  /** The entry ID in the user dictionary */
  entry_id: number;
  /** Whether the word was added to jieba segmentation */
  added_to_segmentation: boolean;
  /** The known word entry if added to vocabulary */
  known_word: KnownWord | null;
}

/**
 * Define a custom word with a user-provided definition.
 * Creates a user dictionary entry and adds the word to segmentation.
 * If shelfId is provided, creates/uses a shelf-specific dictionary.
 *
 * @param word The word to define
 * @param definition The user's definition for the word
 * @param pinyin Optional pinyin for the word
 * @param notes Optional notes about the word
 * @param shelfId Optional shelf ID for shelf-specific dictionary
 * @param addToVocabulary Whether to also add this word to known_words
 * @param status Optional status ("known" or "learning") if adding to vocabulary
 */
export async function defineCustomWord(
  word: string,
  definition: string,
  pinyin?: string,
  notes?: string,
  shelfId?: number,
  addToVocabulary: boolean = true,
  status?: string
): Promise<DefineCustomWordResult> {
  return invoke<DefineCustomWordResult>("define_custom_word", {
    word,
    definition,
    pinyin,
    notes,
    shelfId,
    addToVocabulary,
    status,
  });
}
