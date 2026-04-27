/**
 * Speed Tracking Types and API for Chinese Reader
 *
 * This module provides TypeScript types and functions for tracking
 * reading speed and correlating it with vocabulary progress.
 */

import { invoke } from "./api";

// =============================================================================
// Types
// =============================================================================

/** A reading session for a text */
export interface ReadingSession {
  /** Unique identifier */
  id: number;
  /** Text being read */
  text_id: number;
  /** Session start time (ISO 8601) */
  started_at: string;
  /** Session finish time (ISO 8601), null if ongoing */
  finished_at: string | null;
  /** Character count of the text */
  character_count: number;
  /** Whether this is the first time reading this text */
  is_first_read: boolean;
  /** Whether the session has been completed */
  is_complete: boolean;
  /** Known character count at session start */
  known_characters_count: number;
  /** Known word count at session start */
  known_words_count: number;
  /** Total characters read before this session */
  cumulative_characters_read: number;
  /** Duration in seconds (calculated on completion) */
  duration_seconds: number | null;
  /** Characters per minute (calculated on completion) */
  characters_per_minute: number | null;
  /** Auto-marked characters when session completed */
  auto_marked_characters: number;
  /** Auto-marked words when session completed */
  auto_marked_words: number;
  /** Percentage of known characters in this specific text at session start (0-100) */
  text_known_char_percentage: number | null;
  /** Session creation timestamp */
  created_at: string;
  /** Whether this session was manually logged (offline) */
  is_manual_log: boolean;
  /** Source identifier for manually logged sessions */
  source: string | null;
}

/** A data point for speed correlation graphs */
export interface SpeedDataPoint {
  /** Session ID */
  session_id: number;
  /** Text ID */
  text_id: number;
  /** Text title */
  text_title: string;
  /** Shelf ID */
  shelf_id: number;
  /** When the session finished */
  finished_at: string;
  /** Reading speed */
  characters_per_minute: number;
  /** Characters in the text */
  character_count: number;
  /** Total characters read before this session */
  cumulative_characters_read: number;
  /** Known character count at session start */
  known_characters_count: number;
  /** Known word count at session start */
  known_words_count: number;
  /** Auto-marked characters when session completed */
  auto_marked_characters: number;
  /** Auto-marked words when session completed */
  auto_marked_words: number;
  /** Percentage of known characters in this specific text at session start (0-100) */
  text_known_char_percentage: number | null;
}

/** Aggregated speed statistics */
export interface SpeedStats {
  /** Total completed sessions (first reads only) */
  total_sessions: number;
  /** Total characters read */
  total_characters_read: number;
  /** Total reading time in seconds */
  total_reading_time_seconds: number;
  /** Average reading speed (chars/min) */
  average_speed: number;
  /** Fastest reading speed */
  fastest_speed: number;
  /** Slowest reading speed */
  slowest_speed: number;
  /** Average of last 5 sessions */
  recent_average_speed: number;
  /** Characters in texts not yet read */
  unread_characters: number;
  /** Estimated seconds to complete unread texts */
  estimated_completion_seconds: number | null;
}

/** Daily reading volume data point */
export interface DailyReadingVolume {
  /** Date in YYYY-MM-DD format */
  date: string;
  /** Total characters read on this day */
  characters_read: number;
  /** Total reading time in seconds */
  reading_seconds: number;
  /** Number of sessions completed */
  sessions_count: number;
}

/** Reading streak information */
export interface ReadingStreak {
  /** Current consecutive days with reading */
  current_streak: number;
  /** Longest streak ever */
  longest_streak: number;
  /** Whether the user has read today */
  read_today: boolean;
  /** Date of the last reading session (YYYY-MM-DD) */
  last_reading_date: string | null;
}

/** Input for logging an offline reading session */
export interface ManualLogInput {
  /** Text IDs read in this session */
  text_ids: number[];
  /** When the session was finished (ISO 8601) */
  finished_at: string;
  /** Total duration of the session in seconds */
  total_duration_seconds: number;
  /** Source identifier for this offline session */
  source: string | null;
}

// =============================================================================
// Session API
// =============================================================================

/**
 * Start a new reading session for a text
 */
export async function startReadingSession(textId: number): Promise<ReadingSession> {
  return invoke<ReadingSession>("start_reading_session", { textId });
}

/**
 * Finish an active reading session
 */
export async function finishReadingSession(sessionId: number): Promise<ReadingSession> {
  return invoke<ReadingSession>("finish_reading_session", { sessionId });
}

/**
 * Discard (delete) an incomplete reading session
 */
export async function discardReadingSession(sessionId: number): Promise<void> {
  return invoke<void>("discard_reading_session", { sessionId });
}

/**
 * Delete a reading session (any session, complete or not)
 */
export async function deleteReadingSession(sessionId: number): Promise<void> {
  return invoke<void>("delete_reading_session", { sessionId });
}

/**
 * Update auto-marked vocabulary counts for a session
 */
export async function updateSessionAutoMarked(
  sessionId: number,
  autoMarkedCharacters: number,
  autoMarkedWords: number
): Promise<void> {
  return invoke<void>("update_session_auto_marked", {
    sessionId,
    autoMarkedCharacters,
    autoMarkedWords,
  });
}

/**
 * Get the active (incomplete) reading session for a text
 */
export async function getActiveReadingSession(textId: number): Promise<ReadingSession | null> {
  return invoke<ReadingSession | null>("get_active_reading_session", { textId });
}

/**
 * Get reading history for a text
 */
export async function getTextReadingHistory(textId: number): Promise<ReadingSession[]> {
  return invoke<ReadingSession[]>("get_text_reading_history", { textId });
}

// =============================================================================
// Analysis API
// =============================================================================

/**
 * Get speed data points for graphing
 */
export async function getSpeedData(
  shelfId?: number,
  firstReadsOnly?: boolean,
  limit?: number
): Promise<SpeedDataPoint[]> {
  return invoke<SpeedDataPoint[]>("get_speed_data", {
    shelfId,
    firstReadsOnly,
    limit,
  });
}

/**
 * Get aggregated speed statistics
 */
export async function getSpeedStats(shelfId?: number): Promise<SpeedStats> {
  return invoke<SpeedStats>("get_speed_stats", { shelfId });
}

/**
 * Get daily reading volume for the past N days
 */
export async function getDailyReadingVolume(days: number): Promise<DailyReadingVolume[]> {
  return invoke<DailyReadingVolume[]>("get_daily_reading_volume", { days });
}

/**
 * Get reading streak information
 */
export async function getReadingStreak(): Promise<ReadingStreak> {
  return invoke<ReadingStreak>("get_reading_streak");
}

/**
 * Log an offline reading session for one or more texts
 */
export async function logOfflineRead(input: ManualLogInput): Promise<ReadingSession[]> {
  return invoke<ReadingSession[]>("log_offline_read", { input });
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Format duration in seconds to a human-readable string
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (remainingMinutes > 0) {
    return `${hours}h ${remainingMinutes}m`;
  }
  return `${hours}h`;
}

/**
 * Format reading speed (characters per minute) to a human-readable string
 */
export function formatSpeed(cpm: number): string {
  if (cpm < 10) {
    return cpm.toFixed(1);
  }
  return Math.round(cpm).toString();
}

/**
 * Calculate elapsed time in seconds from a start time
 */
export function getElapsedSeconds(startedAt: string): number {
  const start = new Date(startedAt).getTime();
  const now = Date.now();
  return Math.floor((now - start) / 1000);
}

/**
 * Format elapsed time for display (updating timer)
 */
export function formatElapsedTime(startedAt: string): string {
  const elapsed = getElapsedSeconds(startedAt);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Format a date for display
 */
export function formatSessionDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Check if a session has high auto-marked percentage (>10%)
 * High auto-mark suggests content was already known, making speed vs. knowledge data unreliable
 */
export function hasHighAutoMarked(
  dataPoint: SpeedDataPoint,
  threshold: number = 0.1
): boolean {
  const totalAutoMarked = dataPoint.auto_marked_characters + dataPoint.auto_marked_words;
  if (totalAutoMarked === 0) return false;

  // Use known counts as denominator (what was known at start + what was auto-marked)
  const totalKnown = dataPoint.known_characters_count + dataPoint.known_words_count;
  if (totalKnown === 0) return totalAutoMarked > 0;

  // Calculate auto-marked as percentage of total vocabulary at end of session
  const autoMarkRate = totalAutoMarked / (totalKnown + totalAutoMarked);
  return autoMarkRate > threshold;
}

/**
 * Filter speed data to exclude sessions with high auto-marked percentage
 */
export function filterHighAutoMarked(
  data: SpeedDataPoint[],
  threshold: number = 0.1
): SpeedDataPoint[] {
  return data.filter(d => !hasHighAutoMarked(d, threshold));
}
