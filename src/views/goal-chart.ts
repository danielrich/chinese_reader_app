import { addDays, dayNumber } from "../lib/goal-projection";
import type { GoalChartModel } from "../lib/goal-chart-data";
import { escapeHtml } from "../utils";

export function formatGoalCount(count: number): string {
  return count >= 1e6 ? `${(count / 1e6).toFixed(2)}M` : Math.round(count).toLocaleString();
}
export function formatGoalDate(date: string): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(date + "T00:00:00Z"));
}

export function renderGoalChart(model: GoalChartModel, id: string, label: string): string {
  const { start, end, today, yMin, yMax, series } = model;
  const firstDay = dayNumber(start);
  const days = Math.max(1, dayNumber(end) - firstDay);
  const x = (date: string) => 78 + (dayNumber(date) - firstDay) / days * 890;
  const y = (value: number) => 335 - (value - yMin) / (yMax - yMin) * 300;
  const path = (points: { date: string; characters: number }[], step: boolean) => points.map((point, i) => `${i === 0 ? "M" : step ? "H" : "L"}${x(point.date).toFixed(2)}${i > 0 && step ? " V" : ","}${y(point.characters).toFixed(2)}`).join(" ");
  const initialDate = today < start ? start : today > end ? end : today;
  let grid = "";
  for (let i = 0; i <= 4; i++) {
    const value = yMin + (yMax - yMin) * i / 4;
    grid += `<line x1="78" x2="968" y1="${y(value)}" y2="${y(value)}" class="goal-chart-grid"/><text x="66" y="${y(value) + 5}" text-anchor="end">${formatGoalCount(value)}</text>`;
    const date = addDays(start, Math.round(days * i / 4));
    grid += `<text x="${x(date)}" y="365" text-anchor="${i === 0 ? "start" : i === 4 ? "end" : "middle"}">${escapeHtml(formatGoalDate(date))}</text>`;
  }
  const importantDates = new Set(model.tableDates);
  const lines = series.map(line => {
    const points = line.points.filter((point, i, all) => line.step || importantDates.has(point.date) || i === 0 || i === all.length - 1 || i % Math.max(1, Math.ceil(all.length / 600)) === 0);
    return `<path d="${path(points, line.step)}" class="goal-line ${line.key}" fill="none"/>`;
  }).join("");
  return `<div class="goal-chart-legend">${series.map(line => `<span><i class="${line.key}"></i>${line.label}</span>`).join("")}</div>
    <p class="goal-note goal-chart-help">Hover or drag to inspect a day. Arrow keys move one day; Shift moves one week.</p>
    <div class="goal-chart-scroll" tabindex="0" aria-label="${label}; scroll horizontally on small screens">
      <svg viewBox="0 0 1000 390" role="group" aria-labelledby="${id}-title ${id}-description" data-y-min="${yMin}" data-y-max="${yMax}">
        <title id="${id}-title">${label}: reading goal progress and projections</title>
        <desc id="${id}-description">Completed goal characters over time. Solid actual first reads, dashed constant and changing speed scenarios, dotted deadline pace. Use the date cursor or the date field to inspect end-of-day values. A data table follows.</desc>
        ${grid}${today >= start && today <= end ? `<line x1="${x(today)}" x2="${x(today)}" y1="22" y2="335" class="goal-today-marker"/><text x="${x(today) + 5}" y="18">Today</text>` : ""}
        ${model.deadline >= start && model.deadline <= end ? `<line x1="${x(model.deadline)}" x2="${x(model.deadline)}" y1="35" y2="335" class="goal-deadline-marker"/><text x="${x(model.deadline) - 5}" y="32" text-anchor="end">Deadline</text>` : ""}
        ${lines}
        <rect class="goal-chart-hitarea" x="78" y="35" width="890" height="300" tabindex="0" role="slider" aria-label="${label}: inspect day" aria-orientation="horizontal" aria-valuemin="${firstDay}" aria-valuemax="${dayNumber(end)}" aria-valuenow="${dayNumber(initialDate)}"/>
        <g class="goal-chart-cursor" visibility="hidden" pointer-events="none">
          <line class="goal-cursor-line" x1="78" x2="78" y1="35" y2="335"/>
          ${series.map(line => `<circle class="goal-cursor-point ${line.key}" data-cursor-point="${line.key}" cx="78" cy="335" r="5" visibility="hidden"/>`).join("")}
        </g>
      </svg>
    </div>
    <div class="goal-chart-inspector" role="group" aria-label="${label}: selected day values">
      <label class="goal-inspect-date" for="${id}-date">Inspect day<input id="${id}-date" data-inspect-date type="date" min="${start}" max="${end}" value="${initialDate}"></label>
      <p class="goal-note">Cumulative characters at the end of the selected day; actuals reflect recorded reading.</p>
      <dl class="goal-inspector-values">${series.map(line => `<div><dt><i class="${line.key}"></i>${line.label}</dt><dd data-cursor-value="${line.key}">—</dd></div>`).join("")}</dl>
    </div>
    <details class="goal-chart-table"><summary>Chart data table</summary><div class="goal-table-scroll"><table><thead><tr><th>Date</th>${series.map(line => `<th>${line.label}</th>`).join("")}</tr></thead><tbody>${model.tableDates.map(date => {
      const values = model.valuesAt(date);
      return `<tr><th>${formatGoalDate(date)}</th>${series.map(line => `<td>${values[line.key] === null ? "—" : formatGoalCount(values[line.key]!)}</td>`).join("")}</tr>`;
    }).join("")}</tbody></table></div></details>`;
}
