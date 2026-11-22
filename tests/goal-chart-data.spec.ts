import { expect, test } from "@playwright/test";
import { addCalendarMonths, createGoalChartModel, needsNearTermChart } from "../src/lib/goal-chart-data";
import { goalProgress, projectReading } from "../src/lib/goal-projection";
import type { Goal, GoalReadingData } from "../src/lib/goals";

const goal: Goal = { id: "chart", name: "Read", shelfIds: [1], startDate: "2026-11-16", deadline: "2027-11-16", timeZone: "America/Chicago", assumptions: { dailyMinutes: 30, startingCpm: 100, milestones: [{ characters: 600_000, cpm: 200 }] } };
const data: GoalReadingData = { texts: [{ id: 1, character_count: 1000, first_completed_at: "2026-11-15T15:00:00Z" }, { id: 2, character_count: 999000, first_completed_at: null }], activity: [], lifetime_characters: 1000, recent_speeds: [100], missing_shelf_ids: [] };
const progress = goalProgress(goal, data, new Date("2026-11-16T18:00:00Z"));
const inputs = { remaining: progress.remaining, experience: 1000, cpm: 100, dailyMinutes: 30, todayMinutes: 0, today: progress.today };
const constant = projectReading({ ...inputs, milestones: [] });
const growth = projectReading({ ...inputs, milestones: goal.assumptions.milestones });

test("calendar zoom boundaries clamp month ends and use a strict six-month threshold", () => {
  expect(addCalendarMonths("2026-11-30", 3)).toBe("2027-02-28");
  expect(addCalendarMonths("2023-11-30", 3)).toBe("2024-02-29");
  expect(addCalendarMonths("2026-08-31", 6)).toBe("2027-02-28");
  const early = { ...constant, finishDate: "2026-12-01" };
  expect(needsNearTermChart({ ...goal, deadline: "2027-05-16" }, progress, early, early)).toBe(false);
  expect(needsNearTermChart({ ...goal, deadline: "2027-05-17" }, progress, early, early)).toBe(true);
  expect(needsNearTermChart({ ...goal, deadline: "2027-01-01" }, progress, { ...early, finishDate: "2027-06-01" }, early)).toBe(true);
});

test("selected-day values use daily facts and projections, with no future actual reading", () => {
  const model = createGoalChartModel(goal, progress, constant, growth, "full");
  const values = model.valuesAt("2027-02-10");
  expect(values.actual).toBeNull();
  // 87 reading days at 3,000 characters/day, plus 1,000 already read.
  expect(values.constant).toBeCloseTo(262000);
  expect(values.growth!).toBeGreaterThan(values.constant!);
  expect(values.required).toBeCloseTo(1000 + 999000 * 86 / 365);
  expect(model.valuesAt(progress.today).actual).toBe(1000);
});

test("near-term chart carries boundary values, clips all series and uses a useful vertical scale", () => {
  const model = createGoalChartModel(goal, progress, constant, growth, "near");
  expect(model.start).toBe("2026-11-16");
  expect(model.end).toBe("2027-02-16");
  expect(model.yMax).toBeLessThan(progress.total);
  for (const series of model.series) {
    expect(series.points.every(point => point.date >= model.start && point.date <= model.end)).toBe(true);
    expect(series.points.every(point => point.characters >= model.yMin && point.characters <= model.yMax)).toBe(true);
  }
  const deadline = model.series.find(series => series.key === "required")!;
  expect(deadline.points[0].date).toBe(model.start);
  expect(deadline.points.at(-1)!.date).toBe(model.end);
});

test("completed projections plateau and unavailable speeds stay unavailable", () => {
  const fast = projectReading({ ...inputs, cpm: 10000, dailyMinutes: 1440, milestones: [] });
  const absent = projectReading({ ...inputs, cpm: null, milestones: [] });
  const model = createGoalChartModel(goal, progress, fast, absent, "full");
  expect(model.valuesAt("2027-02-10").constant).toBe(progress.total);
  expect(model.valuesAt("2027-02-10").growth).toBeNull();
  expect(model.series.find(series => series.key === "constant")!.points.at(-1)!.date).toBe(model.end);
  const zero = projectReading({ ...inputs, dailyMinutes: 0, milestones: [] });
  expect(createGoalChartModel(goal, progress, zero, zero, "near").valuesAt("2027-02-10").constant).toBe(progress.completed);
});

test("today's summary and both charts use the same pace instead of differing by a day", () => {
  const shortGoal = { ...goal, deadline: "2026-11-21" };
  const reading: GoalReadingData = { ...data, texts: [
    { id: 1, character_count: 1000, first_completed_at: "2026-11-15T15:00:00Z" },
    { id: 2, character_count: 2766, first_completed_at: "2026-11-17T15:00:00Z" },
    { id: 3, character_count: 6234, first_completed_at: null },
  ] };
  const status = goalProgress(shortGoal, reading, new Date("2026-11-17T18:00:00Z"));
  // Previously this was reported as 1,266 ahead, while the chart target was 4,000.
  expect(status.completed).toBeGreaterThan(status.expected);
  const forecast = projectReading({ ...inputs, remaining: status.remaining, today: status.today, milestones: [] });
  for (const range of ["full", "near"] as const) {
    const chart = createGoalChartModel(shortGoal, status, forecast, forecast, range);
    expect(chart.valuesAt(status.today).required).toBe(status.expected);
    expect(chart.valuesAt(shortGoal.startDate).required).toBe(status.baseline);
    expect(chart.valuesAt(shortGoal.deadline).required).toBe(status.total);
  }
});
