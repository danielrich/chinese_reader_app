import type { Goal } from "../lib/goals";
import { addDays, dayNumber, type goalProgress, type ReadingPoint, type ReadingProjection } from "../lib/goal-projection";
import { escapeHtml } from "../utils";

export function formatGoalCount(count: number): string {
  return count >= 1e6 ? `${(count / 1e6).toFixed(2)}M` : Math.round(count).toLocaleString();
}
export function formatGoalDate(date: string): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(date + "T00:00:00Z"));
}
type Progress = ReturnType<typeof goalProgress>;

export function renderGoalChart(goal: Goal, progress: Progress, constant: ReadingProjection, growth: ReadingProjection): string {
  const { today, total, completed, baseline, history } = progress;
  const start = [goal.startDate, today, history[0]?.date].filter(Boolean).sort()[0];
  const end = [goal.deadline, today, constant.finishDate, growth.finishDate].filter((s): s is string => Boolean(s)).sort().at(-1)!;
  const firstDay = dayNumber(start);
  const days = Math.max(1, dayNumber(end) - firstDay);
  const x = (date: string) => 78 + (dayNumber(date) - firstDay) / days * 890;
  const y = (value: number) => 335 - value / Math.max(total, 1) * 300;
  const path = (points: ReadingPoint[], step = false) => points.map((point, i) => `${i === 0 ? "M" : step ? "H" : "L"}${x(point.date).toFixed(2)}${i > 0 && step ? " V" : ","}${y(point.characters).toFixed(2)}`).join(" ");
  const sample = (projection: ReadingProjection) => projection.points.filter(p => p.date <= end).filter((_, i, all) => i === 0 || i === all.length - 1 || i % Math.max(1, Math.ceil(all.length / 600)) === 0).map(p => ({ date: p.date, characters: Math.min(total, completed + p.characters) }));
  const actual = history.length ? [{ date: addDays(history[0].date, -1), characters: 0 }, ...history, { date: today, characters: completed }] : [{ date: goal.startDate, characters: 0 }, { date: today, characters: 0 }];
  // Keep the actual path within the chart, including its initial zero step.
  actual[0].date = actual[0].date < start ? start : actual[0].date;
  const series = [
    { name: "Actual first reads", style: "actual", points: actual, step: true },
    { name: "Current speed", style: "constant", points: constant.reason === "no-speed" || constant.reason === "no-time" ? [] : sample(constant), step: false },
    { name: "Changing speed", style: "growth", points: growth.reason === "no-speed" || growth.reason === "no-time" ? [] : sample(growth), step: false },
    { name: "Deadline pace", style: "required", points: [{ date: goal.startDate, characters: baseline }, { date: goal.deadline, characters: total }], step: false },
  ];
  let grid = "";
  for (let i = 0; i <= 4; i++) {
    const value = total * i / 4;
    grid += `<line x1="78" x2="968" y1="${y(value)}" y2="${y(value)}" class="goal-chart-grid"/><text x="66" y="${y(value) + 5}" text-anchor="end">${formatGoalCount(value)}</text>`;
    const date = addDays(start, Math.round(days * i / 4));
    grid += `<text x="${x(date)}" y="365" text-anchor="${i === 0 ? "start" : i === 4 ? "end" : "middle"}">${escapeHtml(formatGoalDate(date))}</text>`;
  }
  const lines = series.map(s => `<path d="${path(s.points, s.step)}" class="goal-line ${s.style}" fill="none"/>${s.points.filter((_, i, all) => i === all.length - 1 || i % Math.max(1, Math.ceil(all.length / 24)) === 0).map(p => `<circle cx="${x(p.date)}" cy="${y(p.characters)}" r="5" tabindex="0" class="goal-chart-point ${s.style}" aria-label="${escapeHtml(`${s.name}, ${formatGoalDate(p.date)}, ${Math.round(p.characters).toLocaleString()} characters`)}"><title>${escapeHtml(`${s.name}: ${formatGoalDate(p.date)} — ${Math.round(p.characters).toLocaleString()} characters`)}</title></circle>`).join("")}`).join("");
  const lookup = (points: ReadingPoint[], date: string) => {
    let lo = 0, hi = points.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid].date <= date) lo = mid + 1; else hi = mid; }
    return lo ? points[lo - 1].characters : 0;
  };
  const tableDates = new Set([today, goal.deadline, ...(constant.finishDate ? [constant.finishDate] : []), ...(growth.finishDate ? [growth.finishDate] : [])]);
  for (let year = Number(start.slice(0, 4)); year <= Number(end.slice(0, 4)); year++) {
    const date = `${year}-12-31`;
    if (date >= start && date <= end) tableDates.add(date);
  }
  const projected = (projection: ReadingProjection, date: string) => date < today || projection.reason === "no-speed" || projection.reason === "no-time" || (!projection.finishDate && date > projection.points.at(-1)!.date) ? "—" : formatGoalCount(Math.min(total, completed + lookup(projection.points, date)));
  const required = (date: string) => date < goal.startDate ? "—" : formatGoalCount(baseline + (total - baseline) * Math.min(1, Math.max(0, (dayNumber(date) - dayNumber(goal.startDate) + 1) / Math.max(1, dayNumber(goal.deadline) - dayNumber(goal.startDate) + 1))));
  return `<div class="goal-chart-legend">${series.map(s => `<span><i class="${s.style}"></i>${s.name}</span>`).join("")}</div>
    <div class="goal-chart-scroll" tabindex="0" aria-label="Reading progress chart; scroll horizontally on small screens">
      <svg viewBox="0 0 1000 390" role="img" aria-labelledby="goal-chart-title goal-chart-description">
        <title id="goal-chart-title">Reading goal progress and projections</title>
        <desc id="goal-chart-description">Completed goal characters over time. Solid actual first reads, dashed constant-speed and changing-speed scenarios, and dotted deadline pace. Forecasts assume your planned minutes are spent on unread goal material. A data table follows.</desc>
        ${grid}<line x1="${x(today)}" x2="${x(today)}" y1="22" y2="335" class="goal-today-marker"/><text x="${x(today) + 5}" y="18">Today</text>
        <line x1="${x(goal.deadline)}" x2="${x(goal.deadline)}" y1="35" y2="335" class="goal-deadline-marker"/><text x="${x(goal.deadline) - 5}" y="32" text-anchor="end">Deadline</text>
        ${lines}
      </svg>
    </div>
    <details class="goal-chart-table"><summary>Chart data table</summary><div class="goal-table-scroll"><table><thead><tr><th>Date</th><th>Actual first reads</th><th>Current speed</th><th>Changing speed</th><th>Deadline pace</th></tr></thead><tbody>${[...tableDates].sort().map(date => `<tr><th>${formatGoalDate(date)}</th><td>${date <= today ? formatGoalCount(lookup(history, date)) : "—"}</td><td>${projected(constant, date)}</td><td>${projected(growth, date)}</td><td>${required(date)}</td></tr>`).join("")}</tbody></table></div></details>`;
}
