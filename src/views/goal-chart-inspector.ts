import type { GoalChartModel } from "../lib/goal-chart-data";
import { addDays, dayNumber } from "../lib/goal-projection";
import { validDate } from "../lib/goals";
import { formatGoalDate } from "./goal-chart";

/** Local SVG interactions: no requests, curve redraws or document-level listeners. */
export function attachGoalChartInspector(root: HTMLElement, model: GoalChartModel, options: { selectedDate?: string; onDateChange: (date: string) => void }): void {
  const svg = root.querySelector<SVGSVGElement>("svg")!;
  const hit = root.querySelector<SVGRectElement>(".goal-chart-hitarea")!;
  const group = root.querySelector<SVGGElement>(".goal-chart-cursor")!;
  const line = root.querySelector<SVGLineElement>(".goal-cursor-line")!;
  const input = root.querySelector<HTMLInputElement>("[data-inspect-date]")!;
  const first = dayNumber(model.start), last = dayNumber(model.end);
  let selected = options.selectedDate && validDate(options.selectedDate) ? options.selectedDate : model.today;
  let dragging = false;
  let frame: number | null = null;
  let pending: string | null = null;
  const cancelPending = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    pending = null;
  };

  const select = (date: string, visible = true, notify = true) => {
    cancelPending();
    selected = date < model.start ? model.start : date > model.end ? model.end : date;
    const day = dayNumber(selected);
    const x = 78 + (day - first) / Math.max(1, last - first) * 890;
    const values = model.valuesAt(selected);
    input.value = selected;
    line.setAttribute("x1", String(x)); line.setAttribute("x2", String(x));
    group.setAttribute("visibility", visible ? "visible" : "hidden");
    const descriptions: string[] = [];
    for (const series of model.series) {
      const value = values[series.key];
      const readout = root.querySelector<HTMLElement>(`[data-cursor-value="${series.key}"]`)!;
      readout.textContent = value === null ? series.key === "actual" ? "Not recorded" : "Unavailable" : Math.round(value).toLocaleString();
      const point = root.querySelector<SVGCircleElement>(`[data-cursor-point="${series.key}"]`)!;
      point.setAttribute("visibility", value === null || !visible ? "hidden" : "visible");
      point.setAttribute("cx", String(x));
      if (value !== null) point.setAttribute("cy", String(335 - (value - model.yMin) / (model.yMax - model.yMin) * 300));
      descriptions.push(`${series.label}: ${readout.textContent}`);
    }
    hit.setAttribute("aria-valuenow", String(day));
    hit.setAttribute("aria-valuetext", `${formatGoalDate(selected)}. ${descriptions.join(". ")}`);
    if (notify) options.onDateChange(selected);
  };
  const schedule = (event: PointerEvent) => {
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const fraction = Math.max(0, Math.min(1, (position.x - 78) / 890));
    pending = addDays(model.start, Math.round(fraction * (last - first)));
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const date = pending;
      pending = null;
      if (root.isConnected && date) select(date);
    });
  };
  hit.addEventListener("pointerdown", event => {
    dragging = true;
    hit.focus({ preventScroll: true });
    try { hit.setPointerCapture(event.pointerId); } catch { /* Synthetic events need no capture. */ }
    schedule(event);
  });
  hit.addEventListener("pointermove", event => { if (event.pointerType === "mouse" || dragging) schedule(event); });
  hit.addEventListener("pointerup", event => {
    if (dragging) schedule(event);
    dragging = false;
    if (hit.hasPointerCapture(event.pointerId)) hit.releasePointerCapture(event.pointerId);
  });
  hit.addEventListener("pointercancel", () => { dragging = false; cancelPending(); });
  hit.addEventListener("lostpointercapture", () => { dragging = false; });
  hit.addEventListener("keydown", event => {
    const step = event.shiftKey ? 7 : 1;
    const offset = event.key === "ArrowRight" || event.key === "ArrowUp" ? step : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -step : null;
    if (offset === null && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    select(event.key === "Home" ? model.start : event.key === "End" ? model.end : addDays(selected, offset!));
  });
  hit.addEventListener("focus", () => select(selected));
  input.addEventListener("input", () => { if (validDate(input.value)) select(input.value); });
  input.addEventListener("change", () => { if (!validDate(input.value)) input.value = selected; });
  select(selected, Boolean(options.selectedDate), false);
}
