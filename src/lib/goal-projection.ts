import { validateAssumptions, validDate, type Goal, type GoalReadingData, type Milestone } from "./goals";

export interface ReadingPoint { date: string; characters: number }
export interface ProjectionInput {
  remaining: number;
  experience: number;
  cpm: number | null;
  dailyMinutes: number;
  todayMinutes: number;
  today: string;
  milestones: Milestone[];
}
export interface ReadingProjection { points: ReadingPoint[]; finishDate: string | null; reason: "complete" | "no-speed" | "no-time" | "horizon" }
const DAY_MS = 86_400_000;
export const PROJECTION_DAYS = 36_525;

export function localDate(instant: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function dayNumber(date: string): number {
  if (!validDate(date)) throw new Error("Invalid calendar date.");
  return Date.parse(date + "T00:00:00Z") / DAY_MS;
}
export function addDays(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** Starting progress already includes reads on the start date (day zero). */
export function requiredGoalProgress(goal: Pick<Goal, "startDate" | "deadline">, total: number, baseline: number, date: string): number {
  const day = dayNumber(date), start = dayNumber(goal.startDate), deadline = dayNumber(goal.deadline);
  if (day >= deadline) return total;
  const fraction = Math.max(0, (day - start) / Math.max(1, deadline - start));
  return baseline + (total - baseline) * fraction;
}

/** Integrates dx/dt = speed(x) exactly on each linear experience segment. */
export function projectReading(input: ProjectionInput): ReadingProjection {
  const invalid = validateAssumptions({ dailyMinutes: input.dailyMinutes, startingCpm: input.cpm, milestones: input.milestones });
  if (invalid) throw new Error(invalid);
  if (!validDate(input.today) || !Number.isFinite(input.remaining) || input.remaining < 0 || !Number.isFinite(input.experience) || input.experience < 0 || !Number.isFinite(input.todayMinutes) || input.todayMinutes < 0) throw new Error("Invalid reading facts.");
  const points = [{ date: input.today, characters: 0 }];
  if (input.remaining === 0) return { points, finishDate: input.today, reason: "complete" };
  if (input.cpm === null) return { points, finishDate: null, reason: "no-speed" };
  if (input.dailyMinutes === 0) return { points, finishDate: null, reason: "no-time" };
  const nodes = [{ characters: input.experience, cpm: input.cpm }, ...input.milestones.filter(point => point.characters > input.experience)];
  let experience = input.experience;
  let read = 0;
  let segment = 0;
  for (let day = 0; day < PROJECTION_DAYS; day++) {
    let minutes = day === 0 ? Math.max(0, input.dailyMinutes - input.todayMinutes) : input.dailyMinutes;
    while (minutes > 1e-10 && read < input.remaining) {
      const from = nodes[segment];
      const to = nodes[segment + 1];
      const slope = to ? (to.cpm - from.cpm) / (to.characters - from.characters) : 0;
      const speed = from.cpm + slope * (experience - from.characters);
      const distance = Math.min(input.remaining - read, to ? to.characters - experience : Infinity);
      const needed = Math.abs(slope) < 1e-12 ? distance / speed : Math.log1p(slope * distance / speed) / slope;
      if (needed <= minutes + 1e-9) {
        read += distance;
        experience += distance;
        minutes = Math.max(0, minutes - needed);
        if (to && experience >= to.characters - 1e-7) segment++;
      } else {
        const advanced = Math.abs(slope) < 1e-12 ? speed * minutes : speed * Math.expm1(slope * minutes) / slope;
        read += Math.min(distance, Math.max(0, advanced));
        experience = input.experience + read;
        minutes = 0;
      }
    }
    const date = addDays(input.today, day);
    points.push({ date, characters: Math.min(input.remaining, read) });
    if (input.remaining - read < 1e-6) {
      points[points.length - 1].characters = input.remaining;
      return { points, finishDate: date, reason: "complete" };
    }
  }
  return { points, finishDate: null, reason: "horizon" };
}

export function goalProgress(goal: Goal, data: GoalReadingData, now = new Date()) {
  const today = localDate(now, goal.timeZone);
  const daily = new Map<string, number>();
  let total = 0;
  let completed = 0;
  let baseline = 0;
  for (const text of data.texts) {
    total += Math.max(0, text.character_count);
    if (!text.first_completed_at || !Number.isFinite(Date.parse(text.first_completed_at)) || Date.parse(text.first_completed_at) > now.getTime()) continue;
    const date = localDate(text.first_completed_at, goal.timeZone);
    completed += Math.max(0, text.character_count);
    if (date <= goal.startDate) baseline += Math.max(0, text.character_count);
    daily.set(date, (daily.get(date) ?? 0) + Math.max(0, text.character_count));
  }
  let cumulative = 0;
  const history = [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, characters: cumulative += count }));
  const todayMinutes = data.activity.reduce((sum, activity) => {
    if (!Number.isFinite(Date.parse(activity.finished_at)) || Date.parse(activity.finished_at) > now.getTime()) return sum;
    return localDate(activity.finished_at, goal.timeZone) === today ? sum + Math.max(0, activity.duration_seconds ?? 0) / 60 : sum;
  }, 0);
  const speeds = data.recent_speeds.filter(speed => Number.isFinite(speed) && speed > 0);
  const cpm = goal.assumptions.startingCpm ?? (speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null);
  return { today, total, completed, remaining: Math.max(0, total - completed), baseline, history, todayMinutes, cpm, expected: requiredGoalProgress(goal, total, baseline, today) };
}
