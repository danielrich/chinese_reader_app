import { expect, test } from "@playwright/test";
import { addDays, goalProgress, localDate, projectReading } from "../src/lib/goal-projection";
import { validateGoal, type Goal, type GoalReadingData } from "../src/lib/goals";

const base = { remaining: 1000, experience: 0, cpm: 100, dailyMinutes: 5, todayMinutes: 0, today: "2026-11-16", milestones: [] };
const goal: Goal = { id: "test", name: "Read both", shelfIds: [1, 2], startDate: "2026-11-01", deadline: "2026-12-01", timeZone: "America/Chicago", assumptions: { dailyMinutes: 30, startingCpm: null, milestones: [{ characters: 6_000_000, cpm: 200 }, { characters: 12_000_000, cpm: 250 }] } };

test("constant forecasts use daily minutes and subtract today's completed reading", () => {
  expect(projectReading(base).finishDate).toBe("2026-11-17");
  const partial = projectReading({ ...base, dailyMinutes: 10, todayMinutes: 8 });
  expect(partial.points.find(p => p.characters > 0)?.characters).toBeCloseTo(200);
  expect(partial.finishDate).toBe("2026-11-17");
  expect(projectReading({ ...base, dailyMinutes: 0 }).finishDate).toBeNull();
  expect(projectReading({ ...base, remaining: 0, cpm: null, dailyMinutes: 0 }).finishDate).toBe(base.today);
  expect(projectReading({ ...base, cpm: null }).finishDate).toBeNull();
});

test("speed grows linearly with experience and integrates within and across milestones", () => {
  const result = projectReading({ ...base, dailyMinutes: 5, milestones: [{ characters: 1000, cpm: 200 }] });
  // dx/dt = 100 + 0.1x, so five minutes reads 1000*(exp(0.5)-1).
  expect(result.points.find(p => p.characters > 0)?.characters).toBeCloseTo(1000 * Math.expm1(0.5), 6);
  expect(result.finishDate).toBe("2026-11-17");
  const crossing = projectReading({ ...base, remaining: 3000, dailyMinutes: 20, milestones: [{ characters: 1000, cpm: 200 }, { characters: 2000, cpm: 300 }] });
  expect(crossing.finishDate).toBe(base.today);
  expect(crossing.points.at(-1)?.characters).toBe(3000);
  const slower = projectReading({ ...base, remaining: 500, dailyMinutes: 5, milestones: [{ characters: 1000, cpm: 50 }] });
  expect(slower.points.find(p => p.characters > 0)?.characters).toBeCloseTo(2000 * (1 - Math.exp(-0.25)), 6);
});

test("passed milestones do not replace the starting speed and forecasts have a finite horizon", () => {
  const result = projectReading({ ...base, experience: 2000, milestones: [{ characters: 1000, cpm: 200 }] });
  expect(result.finishDate).toBe("2026-11-17");
  expect(projectReading({ ...base, remaining: 1e12, cpm: 1, dailyMinutes: 1 }).finishDate).toBeNull();
  expect(() => projectReading({ ...base, milestones: [{ characters: 10, cpm: 0 }] })).toThrow();
  expect(() => projectReading({ ...base, milestones: [{ characters: 20, cpm: 100 }, { characters: 10, cpm: 200 }] })).toThrow();
});

test("calendar dates respect local time and cross DST without changing the daily budget", () => {
  expect(localDate("2026-11-16T02:00:00Z", "America/Chicago")).toBe("2026-11-15");
  expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
  expect(projectReading({ ...base, today: "2026-03-08" }).finishDate).toBe("2026-03-09");
  expect(validateGoal({ ...goal, deadline: "2035-02-30" })).toBeTruthy();
});

test("goal facts separate unique progress, the global habit, and a stable deadline schedule", () => {
  const data: GoalReadingData = {
    texts: [{ id: 1, character_count: 1000, first_completed_at: "2026-10-30T10:00:00Z" }, { id: 2, character_count: 2000, first_completed_at: null }],
    activity: [{ finished_at: "2026-11-16T15:00:00Z", duration_seconds: 600, character_count: 500, in_scope: false }],
    lifetime_characters: 5000, recent_speeds: [100, 120], missing_shelf_ids: [],
  };
  const progress = goalProgress(goal, data, new Date("2026-11-16T18:00:00Z"));
  expect(progress.completed).toBe(1000);
  expect(progress.remaining).toBe(2000);
  expect(progress.todayMinutes).toBe(10);
  expect(progress.cpm).toBe(110);
  expect(progress.baseline).toBe(1000);
  expect(progress.expected).toBeGreaterThan(1000);
  expect(goalProgress({ ...goal, assumptions: { ...goal.assumptions, dailyMinutes: 60 } }, data, new Date("2026-11-16T18:00:00Z")).expected).toBe(progress.expected);
});

test("persisted goals require an explicit timezone and reject malformed milestones safely", () => {
  const missingZone = JSON.parse(JSON.stringify(goal));
  delete missingZone.timeZone;
  expect(validateGoal(missingZone)).toBeTruthy();
  expect(validateGoal({ ...goal, assumptions: { ...goal.assumptions, milestones: [null] } } as unknown as Goal)).toBeTruthy();
});
