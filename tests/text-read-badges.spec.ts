import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

async function openShelf(page: Page) {
  await page.addInitScript(() => { delete (window as unknown as Record<string, unknown>).SyncManager; });
  const texts = [
    { id: 1, title: "Already read", has_completed_read: true },
    { id: 2, title: "Not read", has_completed_read: false },
    { id: 3, title: "Legacy cache" },
  ].map(text => ({ shelf_id: 1, author: null, character_count: 4, has_analysis: false, ...text }));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const args = route.request().postDataJSON() ?? {};
    const values: Record<string, unknown> = {
      get_stats: { total_entries: 0 }, get_setting: null,
      get_shelf_tree: [{ shelf: { id: 1, name: "Test Shelf", parent_id: null }, children: [], text_count: 3, unread_count: 2 }, { shelf: { id: 2, name: "Other Shelf", parent_id: null }, children: [], text_count: 1, unread_count: 1 }],
      list_texts_in_shelf: args.shelf_id === 2 ? [{ id: 4, shelf_id: 2, title: "Other shelf text", character_count: 4, has_analysis: false, has_completed_read: false }] : texts, get_shelf_analysis: null,
      segment_text: [{ text: "中文测试", is_cjk: true, segment_type: "word", is_known: false }],
    };
    const value = path === "/api/texts/2" ? { ...texts[1], content: "中文测试", source_type: "paste" }
      : path.endsWith("/vocab-cache") ? { text_id: 2, entries: [] }
      : values[path.split("/").pop() ?? ""] ?? null;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  if (await page.locator("#shelf-drawer-toggle").isVisible()) await page.locator("#shelf-drawer-toggle").click();
  await page.locator('.shelf-item[data-shelf-id="1"]').click();
  await expect(page.getByText("Shelf analysis is currently unavailable.")).toBeAttached();
  return texts;
}

async function setLocalSession(page: Page, status: "completed_pending_upload" | "uploaded") {
  await page.evaluate(async status => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("chinese-reader", 5);
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const tx = db.transaction("sessions", "readwrite");
    tx.objectStore("sessions").put({ local_id: "badge-read", text_id: 2, started_at: Date.now() - 60000, finished_at: Date.now(), status });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  }, status);
}

test("each text has a readable completed, unread or legacy-unknown badge", async ({ page }) => {
  await openShelf(page);
  await expect(page.locator('[data-text-id="1"] .text-read-status')).toHaveText("Read");
  await expect(page.locator('[data-text-id="2"] .text-read-status')).toHaveText("Unread");
  await expect(page.locator('[data-text-id="3"] .text-read-status')).toHaveText("Status unknown");
  await page.locator(".text-list").screenshot({ path: test.info().outputPath("read-badges-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator(".text-list").screenshot({ path: test.info().outputPath("read-badges-dark.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".text-list").screenshot({ path: test.info().outputPath("read-badges-mobile.png"), animations: "disabled" });
});

test("finishing a local session marks its cached summary as read before upload", async ({ page }) => {
  await openShelf(page);
  await page.route("**/api/sync/sessions", route => route.abort());
  page.on("dialog", dialog => dialog.accept());
  await page.locator('.text-item[data-text-id="2"]').click();
  await page.locator("#start-reading-btn").click();
  await page.locator("#finish-reading-btn").click();
  await expect(page.locator("#start-reading-btn")).toBeVisible();
  const cached = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("chinese-reader", 5);
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const result = await new Promise<{ data: { id: number; has_completed_read?: boolean }[] }>((resolve, reject) => {
      const req = db.transaction("nav_cache", "readonly").objectStore("nav_cache").get("texts_in_shelf_1");
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    db.close();
    return result.data.find(text => text.id === 2)?.has_completed_read;
  });
  expect(cached).toBe(true);
  await page.locator("#back-to-shelf-btn").click();
  await expect(page.locator('[data-text-id="2"] .text-read-status')).toHaveText("Read");
});

test("a pending completion stays read when upload finishes during the list request", async ({ page }) => {
  const texts = await openShelf(page);
  await setLocalSession(page, "completed_pending_upload");
  await page.route("**/api/invoke/list_texts_in_shelf", async route => {
    await setLocalSession(page, "uploaded");
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(texts) });
  });
  await page.locator('.shelf-item[data-shelf-id="1"]').click();
  await expect(page.locator('[data-text-id="2"] .text-read-status')).toHaveText("Read");
});

test("offline navigation retains a locally finished read even after upload", async ({ page, context }) => {
  await openShelf(page);
  await page.route("**/api/sync/sessions", route => route.abort());
  page.on("dialog", dialog => dialog.accept());
  await page.locator('.text-item[data-text-id="2"]').click();
  await page.locator("#start-reading-btn").click();
  await page.locator("#finish-reading-btn").click();
  await expect(page.locator("#start-reading-btn")).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("chinese-reader", 5);
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const tx = db.transaction("sessions", "readwrite");
    const store = tx.objectStore("sessions");
    const req = store.getAll();
    req.onsuccess = () => { for (const session of req.result) store.put({ ...session, status: "uploaded" }); };
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  });
  await context.setOffline(true);
  await page.locator("#back-to-shelf-btn").click();
  await expect(page.locator('[data-text-id="2"] .text-read-status')).toHaveText("Read");
});

test("switching shelves while Finish is waiting updates the finished text's own cache", async ({ page }) => {
  await openShelf(page);
  await page.route("**/api/sync/sessions", route => route.abort());
  page.on("dialog", dialog => dialog.accept());
  await page.locator('.text-item[data-text-id="2"]').click();
  await page.locator("#start-reading-btn").click();
  await page.getByRole("button", { name: "Exit Focus", exact: true }).click();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("chinese-reader", 5);
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const tx = db.transaction("sessions", "readwrite");
    let locked = true;
    (window as unknown as { releaseBadgeLock: () => void }).releaseBadgeLock = () => { locked = false; };
    const keepAlive = () => { const req = tx.objectStore("sessions").get("lock"); req.onsuccess = () => { if (locked) keepAlive(); }; };
    keepAlive(); tx.oncomplete = () => db.close();
  });
  const finished = page.waitForEvent("dialog", dialog => dialog.message().startsWith("Reading complete!"));
  await page.locator("#finish-reading-btn").click();
  await page.locator('.shelf-item[data-shelf-id="2"]').click();
  await page.evaluate(() => (window as unknown as { releaseBadgeLock: () => void }).releaseBadgeLock());
  await finished;
  await expect(page.locator('.text-item[data-text-id="4"]')).toBeVisible();
  const cache = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("chinese-reader", 5);
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const read = (key: string) => new Promise<{ data: { id: number; has_completed_read?: boolean }[] }>(resolve => {
      const req = db.transaction("nav_cache", "readonly").objectStore("nav_cache").get(key);
      req.onsuccess = () => resolve(req.result);
    });
    const [own, other] = await Promise.all([read("texts_in_shelf_1"), read("texts_in_shelf_2")]);
    db.close(); return { ownRead: own.data.find(text => text.id === 2)?.has_completed_read, otherIds: other.data.map(text => text.id) };
  });
  expect(cache.ownRead).toBe(true);
  expect(cache.otherIds).toEqual([4]);
});
