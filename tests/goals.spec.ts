import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 }, timezoneId: "America/Chicago" });

async function mockGoals(page: Page, saved = false) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  let settings: string | null = saved ? JSON.stringify({ version: 1, goals: [{ id: "first", name: "Finish both series", shelfIds: [2, 3], startDate: today, deadline: "2035-07-23", timeZone: "America/Chicago", assumptions: { dailyMinutes: 30, startingCpm: null, milestones: [{ characters: 6000000, cpm: 200 }, { characters: 12000000, cpm: 250 }] } }] }) : null;
  let calls = 0;
  let failSave = false;
  await page.route("**/api/**", async route => {
    calls++;
    const command = new URL(route.request().url()).pathname.split("/").pop();
    const body = route.request().postDataJSON() ?? {};
    if (command === "set_setting") {
      if (failSave) { await route.fulfill({ status: 503, body: "Unable to save" }); return; }
      settings = body.value;
    }
    const values: Record<string, unknown> = {
      get_stats: { total_entries: 0 },
      get_setting: settings,
      get_shelf_tree: [{ shelf: { id: 1, name: "Fantasy", parent_id: null }, text_count: 3, children: [
        { shelf: { id: 2, name: "Wheel Of Time", parent_id: 1 }, text_count: 2, children: [{ shelf: { id: 4, name: "Book One", parent_id: 2 }, children: [], text_count: 1 }] },
        { shelf: { id: 3, name: "Stormlight", parent_id: 1 }, text_count: 1, children: [] },
      ] }],
      get_goal_reading_data: {
        texts: [{ id: 1, character_count: 1000, first_completed_at: "2026-01-22T18:00:00Z" }, { id: 2, character_count: 7_000_000, first_completed_at: null }, { id: 3, character_count: 3_000_000, first_completed_at: null }],
        activity: [], lifetime_characters: 173404, recent_speeds: [140, 150, 130], missing_shelf_ids: [],
      },
    };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(values[command ?? ""] ?? null) });
  });
  return { calls: () => calls, settings: () => settings, failSaves: () => { failSave = true; } };
}

async function openGoals(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Goals", exact: true }).click();
}

test("creates a goal with multiple shelves and persists it across reload", async ({ page }) => {
  const mock = await mockGoals(page);
  await openGoals(page);
  await page.getByLabel("Goal name", { exact: true }).fill('Finish "both" series');
  await expect(page.locator('input[data-goal-shelf="2"]')).toBeChecked();
  await expect(page.locator('input[data-goal-shelf="3"]')).toBeChecked();
  await page.getByLabel("Search shelves").fill("Book One");
  await page.locator('input[data-goal-shelf="4"]').check();
  await page.getByRole("button", { name: "Create goal", exact: true }).click();
  await expect(page.locator("#goal-chart svg")).toBeVisible();
  expect(JSON.parse(mock.settings()!).goals[0].shelfIds.sort((a: number, b: number) => a - b)).toEqual([2, 3, 4]);
  await page.reload();
  await page.getByRole("button", { name: "Goals", exact: true }).click();
  await expect(page.locator("#goal-picker")).toHaveValue(/.+/);
  await expect(page.locator("#goal-chart svg")).toBeVisible();
  await page.getByRole("button", { name: "Edit goal", exact: true }).click();
  await expect(page.getByLabel("Goal name", { exact: true })).toHaveValue('Finish "both" series');
});

test("what-if edits update locally; save/reset preserve the goal schedule", async ({ page }) => {
  const mock = await mockGoals(page, true);
  await openGoals(page);
  await expect(page.locator("#goal-chart svg")).toBeVisible();
  const calls = mock.calls();
  await page.locator(".goals-view").screenshot({ path: test.info().outputPath("goals-desktop.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator(".goals-view").screenshot({ path: test.info().outputPath("goals-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  const original = await page.locator("#goal-forecast-growth").textContent();
  await page.getByLabel("Daily minutes", { exact: true }).fill("60");
  await expect(page.locator("#goal-forecast-growth")).not.toHaveText(original!);
  expect(mock.calls()).toBe(calls);
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByLabel("Daily minutes", { exact: true })).toHaveValue("30");
  await page.getByLabel("Daily minutes", { exact: true }).fill("45");
  await page.getByRole("button", { name: "Save assumptions", exact: true }).click();
  await expect(page.locator("#goal-message")).toContainText("saved");
  const saved = JSON.parse(mock.settings()!).goals[0];
  expect(saved.assumptions.dailyMinutes).toBe(45);
  expect(saved.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await page.getByLabel("Daily minutes", { exact: true }).fill("0");
  await expect(page.locator("#goal-forecast-growth")).toContainText("No completion");
  expect(await page.locator("#goal-chart").innerHTML()).not.toMatch(/NaN|Infinity/);
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByLabel("Daily minutes", { exact: true })).toHaveValue("45");
});

test("failed saves retain drafts and invalid milestones do not overwrite saved settings", async ({ page }) => {
  const mock = await mockGoals(page, true);
  await openGoals(page);
  await expect(page.locator("#goal-chart svg")).toBeVisible();
  const original = mock.settings();
  await page.getByLabel("Milestone 2 characters").fill("1");
  await expect(page.locator("#goal-scenario-error")).toContainText("increasing");
  await expect(page.getByRole("button", { name: "Save assumptions", exact: true })).toBeDisabled();
  expect(mock.settings()).toBe(original);
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  mock.failSaves();
  await page.getByLabel("Daily minutes", { exact: true }).fill("60");
  await page.getByRole("button", { name: "Save assumptions", exact: true }).click();
  await expect(page.locator("#goal-message")).toContainText("Unable to save");
  await expect(page.getByLabel("Daily minutes", { exact: true })).toHaveValue("60");
  expect(mock.settings()).toBe(original);
});

test("mobile goal controls and chart fit the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockGoals(page, true);
  await openGoals(page);
  await expect(page.locator("#goal-chart svg")).toBeVisible();
  const box = (await page.locator("#goal-chart").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.locator(".goals-view").screenshot({ path: test.info().outputPath("goals-mobile.png") });
  await page.getByRole("button", { name: "Edit goal", exact: true }).click();
  await expect(page.locator('input[data-goal-shelf="2"]')).toBeChecked();
  await expect(page.locator('input[data-goal-shelf="3"]')).toBeChecked();
});

test("invalid saved goals show an error without enabling an overwrite", async ({ page }) => {
  const mock = await mockGoals(page, true);
  const malformed = JSON.parse(mock.settings()!);
  delete malformed.goals[0].timeZone;
  await page.route("**/api/invoke/get_setting", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(JSON.stringify(malformed)) }));
  await openGoals(page);
  await expect(page.getByText(/Saved goals have an unsupported or invalid format/)).toBeVisible();
  await expect(page.getByRole("button", { name: "New goal", exact: true })).toBeHidden();
});

test("switching goals ignores a late response for the previous goal", async ({ page }) => {
  const mock = await mockGoals(page, true);
  const saved = JSON.parse(mock.settings()!);
  saved.goals.push({ ...saved.goals[0], id: "second", name: "Another goal", shelfIds: [4] });
  await page.route("**/api/invoke/get_setting", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(JSON.stringify(saved)) }));
  let releaseFirst!: () => void;
  const blocked = new Promise<void>(resolve => { releaseFirst = resolve; });
  await page.route("**/api/invoke/get_goal_reading_data", async route => {
    const first = route.request().postDataJSON().shelf_ids.includes(2);
    if (first) await blocked;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ texts: [{ id: 1, character_count: first ? 123 : 9000, first_completed_at: null }], activity: [], lifetime_characters: 1000, recent_speeds: [140], missing_shelf_ids: [] }) });
  });
  await openGoals(page);
  await page.locator("#goal-picker").selectOption("second");
  await expect(page.locator(".goal-progress-number")).toContainText("9,000");
  const firstResponse = page.waitForResponse(response => response.url().endsWith("get_goal_reading_data") && response.request().postDataJSON().shelf_ids.includes(2));
  releaseFirst();
  await (await firstResponse).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator(".goal-progress-number")).toContainText("9,000");
  await expect(page.locator("#goal-picker")).toHaveValue("second");
});

test("very slow scenarios keep all chart points inside the displayed date interval", async ({ page }) => {
  await mockGoals(page, true);
  await openGoals(page);
  await expect(page.locator("#goal-chart svg")).toBeVisible();
  await page.getByLabel("Starting speed (CPM)").fill("1");
  await page.getByLabel("Daily minutes", { exact: true }).fill("1");
  await expect(page.locator("#goal-forecast-growth")).toContainText("100-year");
  const maxX = await page.locator("#goal-chart circle").evaluateAll(points => Math.max(...points.map(point => Number(point.getAttribute("cx")))));
  expect(maxX).toBeLessThanOrEqual(968.01);
});

test("deleting a goal blocks refresh until the saved deletion is reconciled", async ({ page }) => {
  await mockGoals(page, true);
  await openGoals(page);
  await expect(page.locator("#goal-chart svg")).toBeVisible();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/invoke/set_setting", async route => { await blocked; await route.fulfill({ contentType: "application/json", body: "null" }); });
  page.on("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete goal", exact: true }).click();
  try { await expect(page.getByRole("button", { name: "Refresh facts", exact: true })).toBeDisabled(); }
  finally { release(); }
  await expect(page.getByRole("button", { name: "Create goal", exact: true })).toBeVisible();
  await expect(page.locator("#goal-picker")).toBeHidden();
});

test("a changed saved scope cannot reuse the previous scope's cached totals", async ({ page }) => {
  const mock = await mockGoals(page, true);
  const saved = JSON.parse(mock.settings()!);
  let changedScope = false;
  await page.route("**/api/invoke/get_setting", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(JSON.stringify(saved)) }));
  await page.route("**/api/invoke/get_goal_reading_data", async route => {
    if (changedScope) await route.fulfill({ status: 503, body: "Offline" });
    else await route.fallback();
  });
  await openGoals(page);
  await expect(page.locator("#goal-chart svg")).toBeVisible();
  await page.getByRole("button", { name: "Dictionary", exact: true }).click();
  changedScope = true;
  saved.goals[0].shelfIds = [4];
  await page.getByRole("button", { name: "Goals", exact: true }).click();
  await expect(page.getByText(/Could not refresh reading facts/)).toBeVisible();
  await expect(page.locator("#goal-chart svg")).toBeHidden();
  await expect(page.getByLabel("Daily minutes", { exact: true })).toBeVisible();
});

test("long goals have a three-month chart below the full chart at the same size", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-16T18:00:00Z"));
  await mockGoals(page, true);
  await openGoals(page);
  await expect(page.locator("#goal-chart-near svg")).toBeVisible();
  const full = (await page.locator("#goal-chart").boundingBox())!;
  const near = (await page.locator("#goal-chart-near").boundingBox())!;
  expect(near.y).toBeGreaterThanOrEqual(full.y + full.height);
  expect(near.width).toBeCloseTo(full.width, 0);
  const fullPlot = (await page.locator("#goal-chart svg").boundingBox())!;
  const nearPlot = (await page.locator("#goal-chart-near svg").boundingBox())!;
  expect(nearPlot.width).toBeCloseTo(fullPlot.width, 0);
  expect(nearPlot.height).toBeCloseTo(fullPlot.height, 0);
  await expect(page.locator("#goal-chart-near [data-inspect-date]")).toHaveAttribute("min", "2026-11-16");
  await expect(page.locator("#goal-chart-near [data-inspect-date]")).toHaveAttribute("max", "2027-02-16");
});

test("date inspection shows exact values, supports keyboard and drag, and does not redraw curves or make requests", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-16T18:00:00Z"));
  const mock = await mockGoals(page, true);
  await openGoals(page);
  const chart = page.locator("#goal-chart");
  const date = chart.locator("[data-inspect-date]");
  await date.fill("2027-02-10");
  await expect(chart.locator('[data-cursor-value="constant"]')).toHaveText("366,400");
  await expect(chart.locator('[data-cursor-value="actual"]')).toHaveText("Not recorded");
  const current = Number((await chart.locator('[data-cursor-value="constant"]').textContent())!.replaceAll(",", ""));
  const growing = Number((await chart.locator('[data-cursor-value="growth"]').textContent())!.replaceAll(",", ""));
  expect(growing).toBeGreaterThan(current);
  const calls = mock.calls();
  const path = await chart.locator(".goal-line.constant").elementHandle();
  const hit = chart.locator(".goal-chart-hitarea");
  await hit.focus();
  await page.keyboard.press("ArrowRight");
  await expect(date).toHaveValue("2027-02-11");
  const box = (await hit.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await expect(chart.locator(".goal-chart-cursor")).toHaveAttribute("visibility", "visible");
  await expect(chart.locator(".goal-cursor-line")).toHaveCSS("visibility", "visible");
  await chart.screenshot({ path: test.info().outputPath("full-chart-cursor.png") });
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 30, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(date).toHaveValue("2035-07-23");
  expect(await path!.evaluate(element => element.isConnected)).toBe(true);
  expect(mock.calls()).toBe(calls);
});

test("near-term inspection survives scenario edits and supports touch dragging", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-16T18:00:00Z"));
  await page.setViewportSize({ width: 390, height: 844 });
  const mock = await mockGoals(page, true);
  await openGoals(page);
  const chart = page.locator("#goal-chart-near");
  await chart.locator("[data-inspect-date]").fill("2027-02-10");
  await expect(chart.locator('[data-cursor-value="constant"]')).toHaveText("366,400");
  const calls = mock.calls();
  await page.getByLabel("Daily minutes", { exact: true }).fill("60");
  await expect(chart.locator("[data-inspect-date]")).toHaveValue("2027-02-10");
  await expect(chart.locator('[data-cursor-value="constant"]')).toHaveText("731,800");
  await chart.screenshot({ path: test.info().outputPath("near-chart-cursor.png") });
  const hit = chart.locator(".goal-chart-hitarea");
  await hit.scrollIntoViewIfNeeded();
  const box = (await hit.boundingBox())!;
  await hit.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", clientX: box.x + 30, clientY: box.y + 50 });
  await hit.dispatchEvent("pointermove", { pointerId: 1, pointerType: "touch", clientX: box.x + 150, clientY: box.y + 50 });
  await hit.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch", clientX: box.x + 150, clientY: box.y + 50 });
  await expect(chart.locator("[data-inspect-date]")).not.toHaveValue("2027-02-10");
  expect(mock.calls()).toBe(calls);
});

test("explicit date selection takes priority over queued pointer movement", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-16T18:00:00Z"));
  await mockGoals(page, true);
  await openGoals(page);
  await expect(page.locator("#goal-chart [data-inspect-date]")).toBeVisible();
  await page.locator("#goal-chart").evaluate(root => {
    const hit = root.querySelector(".goal-chart-hitarea")!;
    const rect = hit.getBoundingClientRect();
    hit.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }));
    const input = root.querySelector<HTMLInputElement>("[data-inspect-date]")!;
    input.value = "2027-02-10";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator("#goal-chart [data-inspect-date]")).toHaveValue("2027-02-10");
});

test("full chart preserves the exact completion corners when curves are sampled", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-16T18:00:00Z"));
  await mockGoals(page, true);
  await openGoals(page);
  await expect(page.locator("#goal-chart svg")).toBeVisible();
  const date = page.locator("#goal-chart [data-inspect-date]");
  const start = Date.parse((await date.getAttribute("min"))! + "T00:00:00Z");
  const end = Date.parse((await date.getAttribute("max"))! + "T00:00:00Z");
  for (const key of ["constant", "growth"]) {
    const finish = await page.locator(`#goal-forecast-${key}`).evaluate(element => element.firstChild!.textContent!);
    const x = 78 + (Date.parse(finish + " UTC") - start) / (end - start) * 890;
    const d = (await page.locator(`#goal-chart .goal-line.${key}`).getAttribute("d"))!;
    const points = [...d.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map(match => [Number(match[1]), Number(match[2])]);
    expect(points.some(([px, py]) => Math.abs(px - x) < 0.02 && Math.abs(py - 35) < 0.02)).toBe(true);
  }
});
