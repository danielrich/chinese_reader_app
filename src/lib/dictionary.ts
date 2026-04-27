/**
 * Dictionary Types and API for Chinese Reader
 *
 * This module provides TypeScript types and functions for interacting
 * with the dictionary backend via Tauri commands.
 */

import { invoke } from "./api";

// =============================================================================
// Types
// =============================================================================

/** Source of a dictionary entry */
export type DictionarySource =
  | "cc_cedict"
  | "moe_dict"
  | "kangxi"
  | "ctext"
  | "user";

/** A single definition with part of speech */
export interface Definition {
  /** The definition text */
  text: string;
  /** Part of speech (noun, verb, etc.) */
  part_of_speech: string | null;
  /** Language of the definition (e.g., "en", "zh") */
  language: string;
}

/** An example of word usage */
export interface UsageExample {
  /** The example sentence/phrase in Chinese */
  text: string;
  /** Translation or explanation */
  translation: string | null;
  /** Source of the example (e.g., "論語") */
  source: string | null;
  /** Source details (chapter, verse) */
  source_detail: string | null;
}

/** A complete dictionary entry */
export interface DictionaryEntry {
  /** Unique identifier */
  id: number;
  /** Traditional Chinese form */
  traditional: string;
  /** Simplified Chinese form */
  simplified: string;
  /** Pinyin with tone numbers */
  pinyin: string;
  /** Pinyin with tone marks for display */
  pinyin_display: string | null;
  /** Zhuyin/Bopomofo */
  zhuyin: string | null;
  /** List of definitions */
  definitions: Definition[];
  /** Usage examples */
  examples: UsageExample[];
  /** Dictionary source */
  source: DictionarySource;
  /** Frequency rank (lower = more common) */
  frequency_rank: number | null;
  /** HSK level (1-9) */
  hsk_level: number | null;
  /** TOCFL level */
  tocfl_level: number | null;
}

/** Character-specific information */
export interface CharacterEntry {
  /** The character */
  character: string;
  /** Kangxi radical number (1-214) */
  radical_number: number | null;
  /** The radical character */
  radical: string | null;
  /** Additional strokes beyond radical */
  additional_strokes: number | null;
  /** Total stroke count */
  total_strokes: number | null;
  /** Character decomposition (e.g., "⿰女子") */
  decomposition: string | null;
  /** Etymology information */
  etymology: string | null;
  /** Variant forms */
  variants: string[];
  /** Traditional form if simplified */
  traditional_form: string | null;
  /** Simplified form if traditional */
  simplified_form: string | null;
}

/** A user-defined dictionary */
export interface UserDictionary {
  /** Unique identifier */
  id: number;
  /** Dictionary name */
  name: string;
  /** Description */
  description: string | null;
  /** Domain (e.g., "classical", "book:紅樓夢") */
  domain: string | null;
  /** Creation timestamp */
  created_at: string;
  /** Last modified timestamp */
  updated_at: string;
}

/** A user dictionary entry */
export interface UserDictionaryEntry {
  /** Unique identifier */
  id: number;
  /** Parent dictionary ID */
  dictionary_id: number;
  /** The term */
  term: string;
  /** Pinyin (optional) */
  pinyin: string | null;
  /** User's definition */
  definition: string;
  /** Additional notes */
  notes: string | null;
  /** Tags for categorization */
  tags: string[];
  /** Creation timestamp */
  created_at: string;
  /** Last modified timestamp */
  updated_at: string;
}

/** Result of a dictionary lookup */
export interface LookupResult {
  /** The query searched */
  query: string;
  /** Dictionary entries found */
  entries: DictionaryEntry[];
  /** Character info (if single character) */
  character_info: CharacterEntry | null;
  /** User dictionary matches */
  user_entries: UserDictionaryEntry[];
}

/** Dictionary statistics */
export interface DictionaryStats {
  total_entries: number;
  cedict_entries: number;
  moedict_entries: number;
  kangxi_entries: number;
  character_count: number;
  user_dictionary_count: number;
  user_entry_count: number;
}

/** Import operation result */
export interface ImportResult {
  source: string;
  entries_added: number;
  errors: number;
}

// =============================================================================
// Lookup API
// =============================================================================

/** Options for dictionary lookup */
export interface LookupOptions {
  /** Include usage examples */
  includeExamples?: boolean;
  /** Include character decomposition info */
  includeCharacterInfo?: boolean;
  /** Search user dictionaries */
  includeUserDictionaries?: boolean;
  /** Specific sources to search (empty = all) */
  sources?: DictionarySource[];
}

/**
 * Look up a word or character in the dictionaries
 */
export async function lookup(
  query: string,
  options: LookupOptions = {}
): Promise<LookupResult> {
  return invoke<LookupResult>("dictionary_lookup", {
    query,
    includeExamples: options.includeExamples ?? true,
    includeCharacterInfo: options.includeCharacterInfo ?? true,
    includeUserDictionaries: options.includeUserDictionaries ?? true,
    sources: options.sources ?? [],
  });
}

/**
 * Full-text search across dictionaries
 */
export async function search(
  query: string,
  maxResults?: number
): Promise<DictionaryEntry[]> {
  return invoke<DictionaryEntry[]>("dictionary_search", {
    query,
    maxResults,
  });
}

/**
 * Get dictionary statistics
 */
export async function getStats(): Promise<DictionaryStats> {
  return invoke<DictionaryStats>("dictionary_stats");
}

// =============================================================================
// Import API
// =============================================================================

/**
 * Import CC-CEDICT from a file
 */
export async function importCedict(filePath: string): Promise<ImportResult> {
  return invoke<ImportResult>("import_cedict", { filePath });
}

/**
 * Import MOE Dictionary from a JSON file
 */
export async function importMoedict(filePath: string): Promise<ImportResult> {
  return invoke<ImportResult>("import_moedict", { filePath });
}

/**
 * Import Kangxi Dictionary from a text file
 */
export async function importKangxi(filePath: string): Promise<ImportResult> {
  return invoke<ImportResult>("import_kangxi", { filePath });
}

// =============================================================================
// User Dictionary API
// =============================================================================

/**
 * Create a new user dictionary
 */
export async function createUserDictionary(
  name: string,
  description?: string,
  domain?: string
): Promise<UserDictionary> {
  return invoke<UserDictionary>("create_user_dictionary", {
    name,
    description,
    domain,
  });
}

/**
 * List all user dictionaries
 */
export async function listUserDictionaries(): Promise<UserDictionary[]> {
  return invoke<UserDictionary[]>("list_user_dictionaries");
}

/**
 * Get a user dictionary by ID
 */
export async function getUserDictionary(id: number): Promise<UserDictionary> {
  return invoke<UserDictionary>("get_user_dictionary", { id });
}

/**
 * Delete a user dictionary
 */
export async function deleteUserDictionary(id: number): Promise<void> {
  return invoke<void>("delete_user_dictionary", { id });
}

/**
 * Add an entry to a user dictionary
 */
export async function addUserDictionaryEntry(
  dictionaryId: number,
  term: string,
  definition: string,
  pinyin?: string,
  notes?: string,
  tags?: string[]
): Promise<UserDictionaryEntry> {
  return invoke<UserDictionaryEntry>("add_user_dictionary_entry", {
    dictionaryId,
    term,
    definition,
    pinyin,
    notes,
    tags: tags ?? [],
  });
}

/**
 * List entries in a user dictionary
 */
export async function listUserDictionaryEntries(
  dictionaryId: number,
  limit?: number,
  offset?: number
): Promise<UserDictionaryEntry[]> {
  return invoke<UserDictionaryEntry[]>("list_user_dictionary_entries", {
    dictionaryId,
    limit,
    offset,
  });
}

/**
 * Update a user dictionary entry
 */
export async function updateUserDictionaryEntry(
  id: number,
  updates: {
    term?: string;
    definition?: string;
    pinyin?: string;
    notes?: string;
    tags?: string[];
  }
): Promise<void> {
  return invoke<void>("update_user_dictionary_entry", {
    id,
    ...updates,
  });
}

/**
 * Delete a user dictionary entry
 */
export async function deleteUserDictionaryEntry(id: number): Promise<void> {
  return invoke<void>("delete_user_dictionary_entry", { id });
}

/**
 * Import entries from tab-separated format
 * Format: term\tdefinition per line
 */
export async function importUserDictionaryEntries(
  dictionaryId: number,
  content: string
): Promise<ImportResult> {
  return invoke<ImportResult>("import_user_dictionary_entries", {
    dictionaryId,
    content,
  });
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get display name for a dictionary source
 */
export function getSourceDisplayName(source: DictionarySource): string {
  const names: Record<DictionarySource, string> = {
    cc_cedict: "CC-CEDICT",
    moe_dict: "教育部國語辭典",
    kangxi: "康熙字典",
    ctext: "Chinese Text Project",
    user: "User Dictionary",
  };
  return names[source] || source;
}

/**
 * Format pinyin for display (handle both numbered and marked)
 */
export function formatPinyin(entry: DictionaryEntry): string {
  return entry.pinyin_display || entry.pinyin;
}

/**
 * Check if an entry is from a user dictionary
 */
export function isUserEntry(entry: DictionaryEntry): boolean {
  return entry.source === "user";
}

/**
 * Group entries by source
 */
export function groupBySource(
  entries: DictionaryEntry[]
): Map<DictionarySource, DictionaryEntry[]> {
  const groups = new Map<DictionarySource, DictionaryEntry[]>();

  for (const entry of entries) {
    const existing = groups.get(entry.source) || [];
    existing.push(entry);
    groups.set(entry.source, existing);
  }

  return groups;
}
