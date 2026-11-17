import * as library from "../lib/library";
import { getGoalReadingData, loadGoals, saveGoals, validateAssumptions, validateGoal, type Goal, type GoalAssumptions, type GoalReadingData } from "../lib/goals";
import { dayNumber, goalProgress, localDate, projectReading, type ReadingProjection } from "../lib/goal-projection";
import { escapeHtml, uuid } from "../utils";
import { formatGoalCount, formatGoalDate, renderGoalChart } from "./goal-chart";
import { createGoalChartModel, needsNearTermChart } from "../lib/goal-chart-data";
import { attachGoalChartInspector } from "./goal-chart-inspector";

let goals: Goal[] = [];
let shelves: library.ShelfTree[] = [];
let selectedId: string | null = null;
let editing: Goal | null = null;
let requestVersion = 0;
let message = "";
let syncWarning = "";
const drafts = new Map<string, GoalAssumptions>();
const facts = new Map<string, GoalReadingData>();
const inspectedDates = new Map<string, { full?: string; near?: string }>();
let pendingSave: Promise<void> | null = null;
const clone = <T>(value: T): T => structuredClone(value);
const attribute = (value: string): string => escapeHtml(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const container = () => document.getElementById("goals-main");
const currentGoal = () => goals.find(goal => goal.id === selectedId);

async function syncGoalSessions(): Promise<void> {
  const { flushPendingSessions } = await import("../lib/sync");
  await flushPendingSessions();
}

async function persistGoals(next: Goal[]): Promise<void> {
  if (pendingSave) throw new Error("Please wait for the current save to finish.");
  const selector = "#new-goal, #goal-picker, #edit-goal, #delete-goal, #refresh-goal, #save-goal-assumptions, #goal-editor button";
  const lock = (disabled: boolean) => container()?.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(selector).forEach(control => { control.disabled = disabled; });
  pendingSave = saveGoals(next);
  lock(true);
  try { await pendingSave; goals = next; }
  finally { pendingSave = null; lock(false); }
}

function flatShelves(nodes = shelves, parents: string[] = []): { id: number; name: string; path: string }[] {
  return nodes.flatMap(node => [{ id: node.shelf.id, name: node.shelf.name, path: [...parents, node.shelf.name].join(" / ") }, ...flatShelves(node.children, [...parents, node.shelf.name])]);
}

function defaultGoal(): Goal {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    id: uuid(), name: "Wheel of Time & Stormlight by 50", shelfIds: flatShelves().filter(shelf => /^(wheel of time|stormlight)$/i.test(shelf.name.trim())).map(shelf => shelf.id),
    startDate: localDate(new Date(), timeZone), deadline: "2035-07-23", timeZone,
    assumptions: { dailyMinutes: 30, startingCpm: null, milestones: [{ characters: 6_000_000, cpm: 200 }, { characters: 12_000_000, cpm: 250 }] },
  };
}

export async function loadGoalsView(): Promise<void> {
  const target = container();
  if (!target) return;
  const version = ++requestVersion;
  target.innerHTML = '<p class="loading">Loading reading goals…</p>';
  try {
    await pendingSave?.catch(() => {});
    syncWarning = "";
    await syncGoalSessions().catch(() => { syncWarning = "Some local reading sessions have not synced yet and are not reflected below."; });
    const [savedGoals, tree] = await Promise.all([loadGoals(), library.getShelfTree()]);
    if (version !== requestVersion) return;
    const scopeKey = (goal: Goal) => JSON.stringify([...new Set(goal.shelfIds)].sort((a, b) => a - b));
    for (const saved of savedGoals) {
      const previous = goals.find(goal => goal.id === saved.id);
      if (!previous || scopeKey(previous) !== scopeKey(saved)) facts.delete(saved.id);
    }
    goals = savedGoals;
    shelves = tree;
    selectedId = goals.some(goal => goal.id === selectedId) ? selectedId : goals[0]?.id ?? null;
    editing = goals.length ? null : defaultGoal();
    message = "";
    renderShell();
    if (!editing) await refreshFacts();
  } catch (error) {
    if (version !== requestVersion) return;
    target.innerHTML = `<div class="goals-view"><h2>Reading Goals</h2><p class="error">${escapeHtml(String(error))}</p><button id="retry-goals" class="btn-secondary">Retry loading goals</button></div>`;
    document.getElementById("retry-goals")?.addEventListener("click", loadGoalsView);
  }
}

function renderShell(): void {
  const target = container();
  if (!target) return;
  const goal = currentGoal();
  target.innerHTML = `<div class="goals-view">
    <div class="goals-header"><div><p class="goal-eyebrow">A little reading, every day</p><h2>Reading Goals</h2></div>
      <div class="goal-actions">${goals.length ? `<label class="sr-only" for="goal-picker">Choose goal</label><select id="goal-picker">${goals.map(g => `<option value="${attribute(g.id)}" ${g.id === selectedId ? "selected" : ""}>${escapeHtml(g.name)}</option>`).join("")}</select>` : ""}<button id="new-goal" class="btn-primary">New goal</button></div>
    </div>
    <p id="goal-message" role="status" aria-live="polite">${escapeHtml(message)}</p>
    <div id="goal-editor-slot"></div>
    <div id="goal-dashboard" ${editing || !goal ? "hidden" : ""}>
      <div class="goal-heading"><div><h3>${escapeHtml(goal?.name ?? "")}</h3><p>Finish by <strong>${goal ? formatGoalDate(goal.deadline) : ""}</strong> · ${escapeHtml(goal?.timeZone ?? "")}</p><p class="goal-scope-names">${goal ? scopeNames(goal) : ""}</p></div>
        <div class="goal-actions"><button id="edit-goal" class="btn-secondary">Edit goal</button><button id="refresh-goal" class="btn-secondary">Refresh facts</button><button id="delete-goal" class="btn-secondary">Delete goal</button></div></div>
      <p id="goal-data-note" class="goal-note">${escapeHtml(syncWarning)}</p>
      <div id="goal-results"><p class="loading">Loading reading history…</p></div>
      <section id="goal-scenario"></section>
    </div>
  </div>`;
  document.getElementById("new-goal")?.addEventListener("click", () => { ++requestVersion; editing = defaultGoal(); message = ""; renderShell(); });
  document.getElementById("goal-picker")?.addEventListener("change", (event) => {
    selectedId = (event.target as HTMLSelectElement).value;
    editing = null; message = ""; ++requestVersion; renderShell(); void refreshFacts();
  });
  document.getElementById("edit-goal")?.addEventListener("click", () => { if (goal) { ++requestVersion; editing = clone(goal); renderShell(); } });
  document.getElementById("refresh-goal")?.addEventListener("click", () => void refreshFacts());
  document.getElementById("delete-goal")?.addEventListener("click", () => void deleteGoal());
  if (editing) renderEditor(editing);
  else if (goal) { renderScenario(goal); renderResults(); }
}

function scopeNames(goal: Goal): string {
  const names = new Map(flatShelves().map(shelf => [shelf.id, shelf.name]));
  return goal.shelfIds.map(id => `<span>${escapeHtml(names.get(id) ?? `Missing shelf #${id}`)}</span>`).join(" ");
}

function renderEditor(goal: Goal): void {
  const slot = document.getElementById("goal-editor-slot");
  if (!slot) return;
  const exists = goals.some(g => g.id === goal.id);
  const options = flatShelves();
  slot.innerHTML = `<form id="goal-editor" class="goal-panel">
    <h3>${exists ? "Edit goal" : "Create a reading goal"}</h3>
    <div class="goal-form-grid">
      <label>Goal name<input id="goal-name" type="text" required maxlength="200" value="${attribute(goal.name)}"></label>
      <label>Deadline<input id="goal-deadline" type="date" required value="${goal.deadline}"></label>
      <label>Daily reading target (minutes)<input id="goal-default-minutes" type="number" min="0" max="1440" step="any" required value="${goal.assumptions.dailyMinutes}"></label>
    </div>
    <fieldset class="goal-shelf-fieldset"><legend>Shelves to finish</legend>
      <p class="goal-note">Select multiple shelves. All sub-shelves are included, and overlapping selections count once.</p>
      <label>Search shelves<input id="goal-shelf-search" type="search" placeholder="Search by shelf or book name"></label>
      <div class="goal-shelf-list">${options.map(shelf => `<label class="goal-shelf-option" data-search="${attribute(shelf.path.toLocaleLowerCase())}"><input type="checkbox" data-goal-shelf="${shelf.id}" aria-label="${attribute(shelf.path)}" ${goal.shelfIds.includes(shelf.id) ? "checked" : ""}><span>${escapeHtml(shelf.name)}<small>${escapeHtml(shelf.path)}</small></span></label>`).join("") || '<p>No shelves yet. Add some in Library first.</p>'}</div>
      <p id="goal-selected-shelves" class="goal-note"></p>
      ${goal.shelfIds.some(id => !options.some(s => s.id === id)) ? '<p class="goal-warning">Some saved shelves are missing. Select their replacements before saving.</p>' : ""}
    </fieldset>
    <p class="goal-note">Dates use ${escapeHtml(goal.timeZone)}. Progress includes existing first reads. Targets follow the current contents of the selected shelves.</p>
    <p id="goal-editor-error" role="alert" class="goal-error"></p>
    <div class="goal-actions"><button type="submit" class="btn-primary">${exists ? "Save goal" : "Create goal"}</button>${goals.length ? '<button type="button" id="cancel-goal-edit" class="btn-secondary">Cancel</button>' : ""}</div>
  </form>`;
  const updateSelected = () => {
    const selected = [...slot.querySelectorAll<HTMLInputElement>("[data-goal-shelf]:checked")].map(input => options.find(s => s.id === Number(input.dataset.goalShelf))!.name);
    document.getElementById("goal-selected-shelves")!.textContent = selected.length ? `Selected: ${selected.join(", ")}` : "No shelves selected.";
  };
  slot.querySelectorAll("[data-goal-shelf]").forEach(input => input.addEventListener("change", updateSelected));
  updateSelected();
  document.getElementById("goal-shelf-search")?.addEventListener("input", event => {
    const query = (event.target as HTMLInputElement).value.trim().toLocaleLowerCase();
    slot.querySelectorAll<HTMLElement>(".goal-shelf-option").forEach(option => { option.hidden = !option.dataset.search!.includes(query); });
  });
  document.getElementById("cancel-goal-edit")?.addEventListener("click", () => { editing = null; renderShell(); void refreshFacts(); });
  document.getElementById("goal-editor")?.addEventListener("submit", event => { event.preventDefault(); void saveEditor(goal); });
}

async function saveEditor(original: Goal): Promise<void> {
  const goal = clone(original);
  goal.name = (document.getElementById("goal-name") as HTMLInputElement).value.trim();
  goal.deadline = (document.getElementById("goal-deadline") as HTMLInputElement).value;
  goal.shelfIds = [...document.querySelectorAll<HTMLInputElement>("[data-goal-shelf]:checked")].map(input => Number(input.dataset.goalShelf));
  goal.assumptions.dailyMinutes = (document.getElementById("goal-default-minutes") as HTMLInputElement).valueAsNumber;
  const errorElement = document.getElementById("goal-editor-error")!;
  const invalid = validateGoal(goal);
  if (invalid) { errorElement.textContent = invalid; return; }
  const button = document.querySelector<HTMLButtonElement>('#goal-editor button[type="submit"]')!;
  const version = requestVersion;
  button.disabled = true;
  try {
    const next = goals.some(g => g.id === goal.id) ? goals.map(g => g.id === goal.id ? goal : g) : [...goals, goal];
    await persistGoals(next);
    drafts.delete(goal.id); facts.delete(goal.id);
    if (version !== requestVersion) return;
    selectedId = goal.id; editing = null; message = "Goal saved.";
    renderShell(); await refreshFacts();
  } catch (error) {
    if (version === requestVersion) { errorElement.textContent = String(error); button.disabled = false; }
  }
}

async function refreshFacts(): Promise<void> {
  if (pendingSave) return;
  const goal = currentGoal();
  if (!goal) return;
  const version = ++requestVersion;
  const button = document.getElementById("refresh-goal") as HTMLButtonElement | null;
  if (button) { button.disabled = true; button.textContent = "Refreshing…"; }
  try {
    syncWarning = "";
    await syncGoalSessions().catch(() => { syncWarning = "Some local reading sessions have not synced yet and are not reflected below."; });
    const data = await getGoalReadingData(goal.shelfIds);
    if (version !== requestVersion || selectedId !== goal.id || editing) return;
    facts.set(goal.id, data);
    document.getElementById("goal-data-note")!.textContent = `${syncWarning} Based on current shelf contents. All Chinese reading builds experience; first reads in these shelves advance this goal.`.trim();
    renderResults();
  } catch (error) {
    if (version !== requestVersion) return;
    const note = document.getElementById("goal-data-note");
    if (note) note.textContent = `Could not refresh reading facts: ${String(error)}${facts.has(goal.id) ? " Showing the previous snapshot." : " Try Refresh facts again."}`;
    if (!facts.has(goal.id)) document.getElementById("goal-results")!.innerHTML = '<p class="goal-warning">Reading facts are unavailable. Try Refresh facts again. Your planning controls are still available.</p>';
  } finally {
    if (version === requestVersion && button) { button.disabled = false; button.textContent = "Refresh facts"; }
  }
}

function scenario(goal: Goal): GoalAssumptions {
  if (!drafts.has(goal.id)) drafts.set(goal.id, clone(goal.assumptions));
  return drafts.get(goal.id)!;
}

function renderScenario(goal: Goal): void {
  const value = scenario(goal);
  const target = document.getElementById("goal-scenario")!;
  target.innerHTML = `<div class="goal-panel goal-scenario-panel"><div><p class="goal-eyebrow">Explore your plan</p><h3>What if…</h3><p class="goal-note">Adjust these assumptions to compare outcomes instantly. Your reading history stays the same.</p></div>
    <div class="goal-scenario-grid">
      <div><label for="scenario-minutes">Daily minutes</label><div class="goal-number-unit"><input id="scenario-minutes" type="number" min="0" max="1440" step="any" value="${value.dailyMinutes}"><span>min / day</span></div><input id="scenario-minutes-slider" type="range" min="0" max="180" step="5" value="${Math.min(180, value.dailyMinutes)}" aria-label="Adjust daily minutes"></div>
      <div><label for="scenario-speed">Starting speed (CPM)</label><input id="scenario-speed" type="number" min="0.1" step="any" placeholder="Auto: recent first-read average" value="${value.startingCpm ?? ""}"><p class="goal-note">Leave blank to use your five most recent valid first reads.</p></div>
      ${value.milestones.map((point, index) => `<div class="goal-milestone"><label for="milestone-${index}-characters">Milestone ${index + 1} characters</label><input id="milestone-${index}-characters" data-milestone="${index}" data-field="characters" type="number" min="1" step="100000" value="${point.characters}"><label for="milestone-${index}-cpm">Milestone ${index + 1} speed (CPM)</label><div class="goal-number-unit"><input id="milestone-${index}-cpm" data-milestone="${index}" data-field="cpm" type="number" min="0.1" step="any" value="${point.cpm}"><span>CPM</span></div><input type="range" data-milestone-slider="${index}" min="10" max="500" step="5" value="${Math.min(500, Math.max(10, point.cpm))}" aria-label="Adjust milestone ${index + 1} speed"></div>`).join("")}
    </div>
    <p class="goal-note">Speed changes linearly with lifetime characters read, including rereads and other shelves. After the final milestone, speed holds steady. Future reading time is assumed to go toward unread goal material.</p>
    <p id="goal-scenario-error" class="goal-error" role="alert"></p>
    <div class="goal-actions"><button id="save-goal-assumptions" class="btn-primary">Save assumptions</button><button id="reset-goal-assumptions" class="btn-secondary">Reset</button><span id="goal-draft-label" class="goal-note"></span></div></div>`;
  target.querySelectorAll<HTMLInputElement>("input").forEach(input => input.addEventListener("input", () => {
    if (input.id === "scenario-minutes-slider") (document.getElementById("scenario-minutes") as HTMLInputElement).value = input.value;
    if (input.id === "scenario-minutes") (document.getElementById("scenario-minutes-slider") as HTMLInputElement).value = input.value;
    if (input.dataset.milestoneSlider !== undefined) (document.getElementById(`milestone-${input.dataset.milestoneSlider}-cpm`) as HTMLInputElement).value = input.value;
    if (input.dataset.field === "cpm") (target.querySelector(`[data-milestone-slider="${input.dataset.milestone}"]`) as HTMLInputElement).value = input.value;
    const speed = document.getElementById("scenario-speed") as HTMLInputElement;
    const draft: GoalAssumptions = {
      dailyMinutes: (document.getElementById("scenario-minutes") as HTMLInputElement).valueAsNumber,
      startingCpm: speed.value.trim() === "" ? null : speed.valueAsNumber,
      milestones: value.milestones.map((_, i) => ({ characters: (document.getElementById(`milestone-${i}-characters`) as HTMLInputElement).valueAsNumber, cpm: (document.getElementById(`milestone-${i}-cpm`) as HTMLInputElement).valueAsNumber })),
    };
    drafts.set(goal.id, draft);
    message = ""; document.getElementById("goal-message")!.textContent = "";
    renderResults();
  }));
  document.getElementById("reset-goal-assumptions")?.addEventListener("click", () => {
    const saved = currentGoal();
    if (saved) { drafts.set(saved.id, clone(saved.assumptions)); renderScenario(saved); renderResults(); }
  });
  document.getElementById("save-goal-assumptions")?.addEventListener("click", () => void saveAssumptions(goal.id));
}

async function saveAssumptions(id: string): Promise<void> {
  const goal = goals.find(g => g.id === id);
  if (!goal) return;
  const assumptions = clone(scenario(goal));
  const invalid = validateAssumptions(assumptions);
  if (invalid) return;
  const version = requestVersion;
  const button = document.getElementById("save-goal-assumptions") as HTMLButtonElement;
  button.disabled = true;
  try {
    const next = goals.map(g => g.id === id ? { ...g, assumptions } : g);
    await persistGoals(next);
    if (version !== requestVersion || selectedId !== id) return;
    message = "Assumptions saved.";
    document.getElementById("goal-message")!.textContent = message;
    renderResults();
  } catch (error) {
    if (version === requestVersion) document.getElementById("goal-message")!.textContent = String(error);
  } finally {
    if (version === requestVersion) button.disabled = Boolean(validateAssumptions(scenario(goals.find(g => g.id === id)!)));
  }
}

async function deleteGoal(): Promise<void> {
  const goal = currentGoal();
  if (!goal || !window.confirm(`Delete the goal “${goal.name}”? Your reading history will be kept.`)) return;
  const version = requestVersion;
  try {
    const next = goals.filter(g => g.id !== goal.id);
    await persistGoals(next); drafts.delete(goal.id); facts.delete(goal.id); inspectedDates.delete(goal.id);
    if (version !== requestVersion) return;
    selectedId = next[0]?.id ?? null; editing = next.length ? null : defaultGoal();
    message = "Goal deleted."; renderShell(); if (next.length) await refreshFacts();
  } catch (error) {
    if (version === requestVersion) document.getElementById("goal-message")!.textContent = String(error);
  }
}

function forecastDescription(projection: ReadingProjection, deadline: string): string {
  if (!projection.finishDate) return projection.reason === "no-speed" ? "No measured speed yet. Enter a starting CPM to explore." : projection.reason === "no-time" ? "No completion at 0 minutes/day." : "No completion within the 100-year projection horizon.";
  const difference = dayNumber(deadline) - dayNumber(projection.finishDate);
  return `${formatGoalDate(projection.finishDate)}<small>${difference >= 0 ? `${difference.toLocaleString()} days before the deadline` : `${(-difference).toLocaleString()} days after the deadline`}</small>`;
}

function renderResults(): void {
  const goal = currentGoal();
  if (!goal || editing) return;
  const assumptions = scenario(goal);
  const invalid = validateAssumptions(assumptions);
  const error = document.getElementById("goal-scenario-error");
  if (error) error.textContent = invalid ?? "";
  const save = document.getElementById("save-goal-assumptions") as HTMLButtonElement | null;
  if (save) save.disabled = Boolean(invalid) || Boolean(pendingSave);
  const label = document.getElementById("goal-draft-label");
  if (label) label.textContent = JSON.stringify(assumptions) === JSON.stringify(goal.assumptions) ? "Saved plan" : "Unsaved what-if scenario";
  if (invalid) return;
  const data = facts.get(goal.id);
  if (!data) return;
  const target = document.getElementById("goal-results")!;
  if (data.missing_shelf_ids.length) { target.innerHTML = `<p class="goal-warning">Missing shelves: ${data.missing_shelf_ids.join(", ")}. Edit this goal to replace them before projecting completion.</p>`; return; }
  if (!data.texts.length) { target.innerHTML = '<p class="goal-warning">These shelves have no texts yet. Add texts in Library or edit the selected shelves.</p>'; return; }
  const progress = goalProgress({ ...goal, assumptions }, data);
  const inputs = { remaining: progress.remaining, experience: data.lifetime_characters, cpm: progress.cpm, dailyMinutes: assumptions.dailyMinutes, todayMinutes: progress.todayMinutes, today: progress.today };
  const constant = projectReading({ ...inputs, milestones: [] });
  const growth = projectReading({ ...inputs, milestones: assumptions.milestones });
  const fullChart = createGoalChartModel(goal, progress, constant, growth, "full");
  const nearChart = needsNearTermChart(goal, progress, constant, growth) ? createGoalChartModel(goal, progress, constant, growth, "near") : null;
  const difference = progress.completed - progress.expected;
  const complete = progress.remaining === 0;
  const status = complete ? "Goal complete" : difference >= -1 ? "On track with deadline pace" : "Behind deadline pace";
  const percent = progress.total ? progress.completed / progress.total * 100 : 0;
  target.innerHTML = `<div class="goal-overview">
    <div class="goal-progress-summary"><div><span class="goal-status ${complete || difference >= -1 ? "on-track" : "behind"}">${status}</span><p class="goal-progress-number">${formatGoalCount(progress.completed)} <span>of ${formatGoalCount(progress.total)} characters</span></p><p class="goal-note">${percent.toFixed(2)}% complete · ${formatGoalCount(progress.remaining)} remaining</p></div>
      <div class="goal-habit"><strong>${progress.todayMinutes.toFixed(1)} <span>/ ${assumptions.dailyMinutes} min</span></strong><span>Today's Chinese reading · all shelves</span></div></div>
    <progress value="${progress.completed}" max="${Math.max(1, progress.total)}" aria-label="Goal first-read progress"></progress>
    <p class="goal-note">${complete ? "Every text in the current goal scope has a completed first read." : `${formatGoalCount(Math.abs(difference))} characters ${difference >= 0 ? "ahead of" : "behind"} the required pace through yesterday. Goal started ${formatGoalDate(goal.startDate)}.`}</p>
    <div class="goal-forecast-grid"><div><p class="goal-eyebrow">At current speed · ${progress.cpm?.toFixed(1) ?? "unknown"} CPM</p><strong id="goal-forecast-constant">${forecastDescription(constant, goal.deadline)}</strong></div><div><p class="goal-eyebrow">With your speed changes</p><strong id="goal-forecast-growth">${forecastDescription(growth, goal.deadline)}</strong></div></div>
    <p class="goal-note">${formatGoalCount(data.lifetime_characters)} lifetime characters of experience. These forecasts assume ${assumptions.dailyMinutes} minutes/day on unread goal material, with ${Math.max(0, assumptions.dailyMinutes - progress.todayMinutes).toFixed(1)} minutes left in today's budget. Speed improvement is an assumption, not a measured trend.</p>
    </div><section id="goal-chart" class="goal-panel"><h3>Your path to ${formatGoalDate(goal.deadline)}</h3>${renderGoalChart(fullChart, "goal-full", "Full timeline")}</section>
    ${nearChart ? `<section id="goal-chart-near" class="goal-panel"><h3>The next three months</h3><p class="goal-note">${formatGoalDate(nearChart.start)} – ${formatGoalDate(nearChart.end)} · vertical scale zoomed to this period</p>${renderGoalChart(nearChart, "goal-near", "Next three months")}</section>` : ""}`;
  const dates = inspectedDates.get(goal.id) ?? {};
  inspectedDates.set(goal.id, dates);
  attachGoalChartInspector(document.getElementById("goal-chart")!, fullChart, { selectedDate: dates.full, onDateChange: date => { dates.full = date; } });
  if (nearChart) attachGoalChartInspector(document.getElementById("goal-chart-near")!, nearChart, { selectedDate: dates.near, onDateChange: date => { dates.near = date; } });
}
