import type { Goal } from "./goals";
import { dayNumber, requiredGoalProgress, type goalProgress, type ReadingPoint, type ReadingProjection } from "./goal-projection";

export type ChartSeriesKey = "actual" | "constant" | "growth" | "required";
export type ChartValues = Record<ChartSeriesKey, number | null>;
export interface GoalChartSeries { key: ChartSeriesKey; label: string; points: ReadingPoint[]; step: boolean }
export interface GoalChartModel {
  start: string;
  end: string;
  today: string;
  deadline: string;
  yMin: number;
  yMax: number;
  series: GoalChartSeries[];
  tableDates: string[];
  valuesAt: (date: string) => ChartValues;
}
type Progress = ReturnType<typeof goalProgress>;

export function addCalendarMonths(date: string, months: number): string {
  const instant = new Date(dayNumber(date) * 86_400_000);
  const day = instant.getUTCDate();
  instant.setUTCDate(1);
  instant.setUTCMonth(instant.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth() + 1, 0)).getUTCDate();
  instant.setUTCDate(Math.min(day, lastDay));
  return instant.toISOString().slice(0, 10);
}

function fullEnd(goal: Goal, progress: Progress, constant: ReadingProjection, growth: ReadingProjection): string {
  return [goal.deadline, progress.today, constant.finishDate, growth.finishDate].filter((date): date is string => Boolean(date)).sort().at(-1)!;
}

export function needsNearTermChart(goal: Goal, progress: Progress, constant: ReadingProjection, growth: ReadingProjection): boolean {
  return fullEnd(goal, progress, constant, growth) > addCalendarMonths(progress.today, 6)
    || (progress.remaining > 0 && [constant, growth].some(projection => projection.reason === "horizon"));
}

/** Last daily value, including the final one when today has two model points. */
function lookup(points: ReadingPoint[], date: string): number {
  let lo = 0, hi = points.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid].date <= date) lo = mid + 1; else hi = mid; }
  return lo ? points[lo - 1].characters : 0;
}

export function createGoalChartModel(goal: Goal, progress: Progress, constant: ReadingProjection, growth: ReadingProjection, range: "full" | "near"): GoalChartModel {
  const { today, total, completed, baseline, history } = progress;
  const start = range === "near" ? today : [goal.startDate, today, history[0]?.date].filter(Boolean).sort()[0];
  const end = range === "near" ? addCalendarMonths(today, 3) : fullEnd(goal, progress, constant, growth);
  const projected = (projection: ReadingProjection, date: string): number | null => {
    if (date < today || projection.reason === "no-speed") return null;
    if (projection.reason === "no-time") return completed;
    if (!projection.finishDate && date > projection.points.at(-1)!.date) return null;
    return Math.min(total, completed + lookup(projection.points, date));
  };
  const valuesAt = (date: string): ChartValues => ({
    actual: date > today ? null : lookup(history, date),
    constant: projected(constant, date),
    growth: projected(growth, date),
    // End-of-day pace; the cursor, rendered line and table share this calculation.
    required: date < goal.startDate ? null : requiredGoalProgress(goal, total, baseline, date),
  });
  const series: GoalChartSeries[] = [
    { key: "actual", label: "Actual first reads", points: history, step: true },
    { key: "constant", label: "Current speed", points: constant.points, step: false },
    { key: "growth", label: "Changing speed", points: growth.points, step: false },
    { key: "required", label: "Deadline pace", points: [{ date: goal.startDate, characters: baseline }, { date: goal.deadline, characters: total }], step: false },
  ].map(series => {
    const dates = new Set([start, end, today, goal.startDate, goal.deadline, ...series.points.map(point => point.date)]);
    // Carry values at both clipping boundaries, and extend completed curves as a plateau.
    const points = [...dates].filter(date => date >= start && date <= end).sort().flatMap(date => {
      const value = valuesAt(date)[series.key as ChartSeriesKey];
      return value === null ? [] : [{ date, characters: value }];
    });
    if (series.key === "actual" && points.length && points[0].date > start) points.unshift({ date: start, characters: 0 });
    return { ...series, key: series.key as ChartSeriesKey, points };
  });
  let yMin = 0, yMax = Math.max(total, 1);
  if (range === "near") {
    let min = Infinity, max = -Infinity;
    for (const line of series) for (const point of line.points) { min = Math.min(min, point.characters); max = Math.max(max, point.characters); }
    if (Number.isFinite(min) && Number.isFinite(max)) {
      const padding = max - min > 1 ? (max - min) * 0.06 : Math.max(1, max * 0.05);
      yMin = Math.max(0, min - padding);
      yMax = Math.max(yMin + 1, max + padding);
    }
  }
  const tableDates = new Set([start, end, today, goal.deadline, constant.finishDate, growth.finishDate].filter((date): date is string => Boolean(date) && date! >= start && date! <= end));
  if (range === "near") for (let month = 1; month <= 3; month++) tableDates.add(addCalendarMonths(start, month));
  else for (let year = Number(start.slice(0, 4)); year <= Number(end.slice(0, 4)); year++) {
    const date = `${year}-12-31`;
    if (date >= start && date <= end) tableDates.add(date);
  }
  return { start, end, today, deadline: goal.deadline, yMin, yMax, series, tableDates: [...tableDates].sort(), valuesAt };
}
