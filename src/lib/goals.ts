import { invoke } from "./api";

export interface Milestone { characters: number; cpm: number }
export interface GoalAssumptions { dailyMinutes: number; startingCpm: number | null; milestones: Milestone[] }
export interface Goal {
  id: string;
  name: string;
  shelfIds: number[];
  startDate: string;
  deadline: string;
  timeZone: string;
  assumptions: GoalAssumptions;
}
export interface GoalReadingData {
  texts: { id: number; character_count: number; first_completed_at: string | null }[];
  activity: { finished_at: string; duration_seconds: number | null; character_count: number; in_scope: boolean }[];
  lifetime_characters: number;
  recent_speeds: number[];
  missing_shelf_ids: number[];
}

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = new Date(value + "T00:00:00Z");
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}

export function validateAssumptions(value: GoalAssumptions): string | null {
  if (!value || typeof value !== "object") return "Reading assumptions are missing.";
  if (!Number.isFinite(value.dailyMinutes) || value.dailyMinutes < 0 || value.dailyMinutes > 1440) return "Daily minutes must be between 0 and 1440.";
  if (value.startingCpm !== null && (!Number.isFinite(value.startingCpm) || value.startingCpm <= 0)) return "Starting speed must be positive, or leave it blank to use your measured speed.";
  if (!Array.isArray(value.milestones)) return "Milestones must be a list.";
  let previous = 0;
  for (const milestone of value.milestones) {
    if (!milestone || !Number.isFinite(milestone.characters) || milestone.characters <= previous || !Number.isFinite(milestone.cpm) || milestone.cpm <= 0) return "Milestones need increasing character counts and positive speeds.";
    previous = milestone.characters;
  }
  return null;
}

export function validateGoal(goal: Goal): string | null {
  if (!goal || typeof goal.id !== "string" || !goal.id || typeof goal.name !== "string" || !goal.name.trim()) return "Give this goal a name.";
  if (!Array.isArray(goal.shelfIds) || !goal.shelfIds.length || goal.shelfIds.some(id => !Number.isSafeInteger(id) || id <= 0)) return "Select at least one shelf.";
  if (!validDate(goal.startDate) || !validDate(goal.deadline)) return "Choose a valid start date and deadline.";
  if (goal.deadline < goal.startDate) return "The deadline must be on or after the goal's start date.";
  if (typeof goal.timeZone !== "string" || !goal.timeZone.trim()) return "Choose a valid time zone.";
  try { new Intl.DateTimeFormat("en", { timeZone: goal.timeZone }).format(); }
  catch { return "Choose a valid time zone."; }
  if (!goal.assumptions) return "Reading assumptions are missing.";
  return validateAssumptions(goal.assumptions);
}

const SETTINGS_KEY = "reading_goals_v1";
export async function loadGoals(): Promise<Goal[]> {
  const value = await invoke<string | null>("get_setting", { key: SETTINGS_KEY });
  if (!value) return [];
  let parsed: { version: number; goals: Goal[] };
  try { parsed = JSON.parse(value); }
  catch { throw new Error("Saved goals could not be read. They have not been overwritten."); }
  if (parsed?.version !== 1 || !Array.isArray(parsed.goals) || parsed.goals.some(goal => validateGoal(goal))) throw new Error("Saved goals have an unsupported or invalid format. They have not been overwritten.");
  if (new Set(parsed.goals.map(goal => goal.id)).size !== parsed.goals.length) throw new Error("Saved goals contain duplicate IDs. They have not been overwritten.");
  return parsed.goals;
}

export async function saveGoals(goals: Goal[]): Promise<void> {
  for (const goal of goals) {
    const error = validateGoal(goal);
    if (error) throw new Error(error);
  }
  await invoke("set_setting", { key: SETTINGS_KEY, value: JSON.stringify({ version: 1, goals }) });
}

export function getGoalReadingData(shelfIds: number[]): Promise<GoalReadingData> {
  return invoke("get_goal_reading_data", { shelfIds });
}
