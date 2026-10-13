import { expect, test, type Page } from "@playwright/test";

const shelf = {
  id: 1, name: "Test Shelf", description: null, parent_id: null,
  sort_order: 0, created_at: "2026-01-01", updated_at: "2026-01-01",
};
const text = {
  id: 1, shelf_id: 1, title: "Offline Test", author: null, source_type: "paste",
  content: "中文测试", character_count: 4, created_at: "2026-01-01", updated_at: "2026-01-01",
};

async function mockApp(page: Page, captured: { input?: Record<string, unknown> }, history: unknown[] = []) {
  await page.route(/\/api\/texts\/1$/, (route) => route.fulfill({ json: text }));
  await page.route(/\/api\/texts\/1\/vocab-cache$/, (route) => route.fulfill({ json: {} }));
  await page.route("**/api/invoke/**", async (route) => {
    const command = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const body = route.request().postDataJSON();
    if (command === "log_offline_read") captured.input = body.input;
    const values: Record<string, unknown> = {
      get_shelf_tree: [{ shelf, children: [], text_count: 1, unread_count: 1 }],
      list_texts_in_shelf: [text],
      get_text: text,
      segment_text: [],
      get_text_reading_history: history,
      log_offline_read: [],
      get_in_progress_session_for_text: null,
      get_stats: {},
    };
    await route.fulfill({ json: values[command] ?? null });
  });
}

async function openText(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Library" }).click();
  await page.locator('.shelf-item[data-shelf-id="1"]').click();
  await expect(page.locator(".shelf-analysis")).toContainText("currently unavailable");
  await page.evaluate(async (cachedText) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("chinese-reader", 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(["text_cache", "text_meta"], "readwrite");
    tx.objectStore("text_cache").put(cachedText);
    tx.objectStore("text_meta").put({ text_id: cachedText.id, text_cached_at: Date.now() });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, text);
  await page.locator('.text-item[data-text-id="1"]').click();
  await expect(page.locator(".text-view h2", { hasText: "Offline Test" })).toBeVisible();
}

test("offline read defaults to an untimed log", async ({ page }) => {
  const captured: { input?: Record<string, unknown> } = {};
  await mockApp(page, captured);
  await openText(page);
  await page.getByRole("button", { name: "Log offline read" }).click();

  await expect(page.locator("#offline-duration-fields")).toBeHidden();
  await expect(page.locator("#duration-hours")).toHaveValue("");
  await expect(page.locator("#duration-minutes")).toHaveValue("");
  await page.locator("#offline-save-btn").click();
  expect(captured.input?.total_duration_seconds).toBeNull();
});

test("offline read includes an explicitly entered duration", async ({ page }) => {
  const captured: { input?: Record<string, unknown> } = {};
  await mockApp(page, captured);
  await openText(page);
  await page.getByRole("button", { name: "Log offline read" }).click();
  await page.getByRole("button", { name: "Add reading time" }).click();
  await page.locator("#duration-hours").fill("1");
  await page.locator("#duration-minutes").fill("5");
  await page.locator("#offline-save-btn").click();
  expect(captured.input?.total_duration_seconds).toBe(3900);
});

test("untimed history omits duration and speed metrics", async ({ page }) => {
  const captured: { input?: Record<string, unknown> } = {};
  await mockApp(page, captured, [{
    id: 7, text_id: 1, started_at: "2026-10-13T18:00:00Z",
    finished_at: "2026-10-13T18:00:00Z", duration_seconds: null,
    characters_per_minute: null, character_count: 4, is_first_read: true,
    is_complete: true, is_manual_log: true, source: "physical_book",
  }]);
  await openText(page);
  await page.getByRole("button", { name: "History" }).click();

  const history = page.locator("#history-container");
  await expect(history).toContainText("Logged");
  await expect(history).toContainText("Characters");
  await expect(history).not.toContainText("Duration");
  await expect(history).not.toContainText("chars/min");
  await expect(history).not.toContainText("0s");
  await expect(history).not.toContainText("0 chars/min");
});
