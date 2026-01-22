/**
 * Learning Types and API for Chinese Reader
 *
 * This module provides TypeScript types and functions for vocabulary
 * progress tracking and frequency analysis via Tauri commands.
 */

import { invoke } from "@tauri-apps/api/core";

// =============================================================================
// Types
// =============================================================================

/** A frequency data source */
export interface FrequencySource {
  /** Source name (e.g., "books_character") */
  name: string;
  /** Display name for UI */
  display_name: string;
  /** Number of terms in this source */
  term_count: number;
}

/** Coverage statistics for a percentile threshold */
export interface PercentileCoverage {
  /** Percentile threshold (e.g., 50, 60, 70, 80, 90, 95, 99) */
  percentile: number;
  /** Total terms in this percentile */
  total_terms: number;
  /** Known terms in this percentile */
  known_terms: number;
  /** Learning terms in this percentile */
  learning_terms: number;
  /** Coverage percentage (known / total * 100) */
  coverage_percent: number;
}

/** Aggregated learning statistics */
export interface LearningStats {
  /** Total known characters */
  total_known_characters: number;
  /** Total known words */
  total_known_words: number;
  /** Total characters in learning status */
  total_learning_characters: number;
  /** Total words in learning status */
  total_learning_words: number;
  /** Character percentile coverage */
  character_coverage: PercentileCoverage[];
  /** Word percentile coverage */
  word_coverage: PercentileCoverage[];
  /** Frequency source used for analysis */
  frequency_source: string;
}

/** Vocabulary progress snapshot */
export interface VocabularyProgress {
  /** Date of the snapshot (YYYY-MM-DD) */
  date: string;
  /** Known characters at this date */
  known_characters: number;
  /** Known words at this date */
  known_words: number;
  /** Learning characters at this date */
  learning_characters: number;
  /** Learning words at this date */
  learning_words: number;
}

/** Frequency analysis for a shelf */
export interface ShelfFrequencyAnalysis {
  /** Shelf ID */
  shelf_id: number;
  /** Shelf name */
  shelf_name: string;
  /** Character percentile coverage for this shelf */
  character_coverage: PercentileCoverage[];
  /** Word percentile coverage for this shelf */
  word_coverage: PercentileCoverage[];
  /** Unknown high-frequency terms to prioritize */
  unknown_high_frequency: TermFrequencyInfo[];
}

/** Information about a term's frequency */
export interface TermFrequencyInfo {
  /** The term (character or word) */
  term: string;
  /** Type: "character" or "word" */
  term_type: string;
  /** Rank in the general frequency list (lower = more common) */
  rank: number | null;
  /** Whether the user knows this term */
  is_known: boolean;
  /** Whether the user is learning this term */
  is_learning: boolean;
}

/** Statistics from importing frequency data */
export interface FrequencyImportStats {
  /** Number of terms imported */
  terms_imported: number;
  /** Number of terms skipped (duplicates) */
  terms_skipped: number;
  /** Number of errors */
  errors: number;
}

// =============================================================================
// API Functions
// =============================================================================

/**
 * Import frequency data from tab-separated content.
 *
 * Expected format: term\trank\tfrequency_count (one per line)
 */
export async function importFrequencyData(
  content: string,
  source: string,
  termType: string
): Promise<FrequencyImportStats> {
  return invoke<FrequencyImportStats>("import_frequency_data", {
    content,
    source,
    termType,
  });
}

/**
 * List available frequency sources.
 */
export async function listFrequencySources(): Promise<FrequencySource[]> {
  return invoke<FrequencySource[]>("list_frequency_sources");
}

/**
 * Get learning statistics.
 */
export async function getLearningStats(
  frequencySource?: string
): Promise<LearningStats> {
  return invoke<LearningStats>("get_learning_stats", { frequencySource });
}

/**
 * Get percentile coverage for a source and term type.
 */
export async function getPercentileCoverage(
  source: string,
  termType: string,
  percentiles: number[]
): Promise<PercentileCoverage[]> {
  return invoke<PercentileCoverage[]>("get_percentile_coverage", {
    source,
    termType,
    percentiles,
  });
}

/**
 * Get vocabulary progress over time.
 */
export async function getVocabularyProgress(
  days?: number
): Promise<VocabularyProgress[]> {
  return invoke<VocabularyProgress[]>("get_vocabulary_progress", { days });
}

/**
 * Record a vocabulary snapshot for today.
 */
export async function recordVocabularySnapshot(): Promise<void> {
  return invoke<void>("record_vocabulary_snapshot");
}

/**
 * Get frequency analysis for a shelf.
 */
export async function getShelfFrequencyAnalysis(
  shelfId: number,
  frequencySource: string
): Promise<ShelfFrequencyAnalysis> {
  return invoke<ShelfFrequencyAnalysis>("get_shelf_frequency_analysis", {
    shelfId,
    frequencySource,
  });
}

/**
 * Get study priorities - unknown terms sorted by frequency.
 */
export async function getStudyPriorities(
  source: string,
  termType?: string,
  limit?: number
): Promise<TermFrequencyInfo[]> {
  return invoke<TermFrequencyInfo[]>("get_study_priorities", {
    source,
    termType,
    limit,
  });
}

/**
 * Clear frequency data for a source.
 */
export async function clearFrequencySource(source: string): Promise<number> {
  return invoke<number>("clear_frequency_source", { source });
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Format coverage percentage for display.
 */
export function formatCoveragePercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

/**
 * Get coverage color class based on percentage.
 */
export function getCoverageColorClass(percent: number): string {
  if (percent >= 95) return "coverage-excellent";
  if (percent >= 85) return "coverage-good";
  if (percent >= 70) return "coverage-fair";
  if (percent >= 50) return "coverage-low";
  return "coverage-poor";
}

/**
 * Calculate progress difference from previous snapshot.
 */
export function calculateProgressDiff(
  current: VocabularyProgress,
  previous: VocabularyProgress | null
): {
  charsDiff: number;
  wordsDiff: number;
} {
  if (!previous) {
    return { charsDiff: 0, wordsDiff: 0 };
  }
  return {
    charsDiff: current.known_characters - previous.known_characters,
    wordsDiff: current.known_words - previous.known_words,
  };
}

/**
 * Get display name for a frequency source.
 */
export function getSourceDisplayName(source: string): string {
  const names: Record<string, string> = {
    books: "Books",
    movies: "Movies/TV",
    internet: "Internet",
    newswire: "News",
    spoken: "Spoken",
    fiction: "Fiction",
    nonfiction: "Non-fiction",
    social_media: "Social Media",
  };

  // Extract base source name (before _character or _word)
  const baseName = source.split("_")[0];
  return names[baseName] || source;
}
