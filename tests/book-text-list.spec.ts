import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

const texts = [
  { id: 101, shelf_id: 2, title: "Chapter 1 section 1", has_completed_read: true },
  { id: 102, shelf_id: 2, title: "Chapter 1 section 2", has_completed_read: false },
  { id: 201, shelf_id: 3, title: "Chapter 2 section 1", has_completed_read: false },
].map(text => ({ ...text, author: null, character_count: 4, has_analysis: false, created_at: "2026-11-20" }));

async function openLibrary(page: Page) {
  await page.addInitScript(() => { delete (window as unknown as Record<string, unknown>).SyncManager; });
  const leaf = (id: number, name: string, parent: number) => ({ shelf: { id, name, parent_id: parent, sort_order: id }, children: [], text_count: id === 2 ? 2 : 1, unread_count: 1 });
  const book = { shelf: { id: 1, name: "王者之路-上", parent_id: 10, sort_order: 0 }, children: [leaf(2, "Chapter 1", 1), leaf(3, "Chapter 2", 1)], text_count: 0, unread_count: 2 };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const args = route.request().postDataJSON() ?? {};
    const values: Record<string, unknown> = {
      get_stats: {}, get_setting: null, get_shelf_analysis: null,
      get_shelf_tree: [{ shelf: { id: 10, name: "Series", parent_id: null, sort_order: 0 }, children: [book], text_count: 0, unread_count: 2 }],
      list_texts_in_shelf: args.include_descendants && [1, 10].includes(args.shelf_id) ? texts : texts.filter(t => t.shelf_id === args.shelf_id),
      segment_text: [{ text: "中文测试", is_cjk: true, segment_type: "word", is_known: false }],
    };
    const id = Number(path.split("/")[3]);
    const value = path.endsWith("/vocab-cache") ? { text_id: id, words: [], characters: [] }
      : /^\/api\/texts\/\d+$/.test(path) ? { ...texts.find(t => t.id === id), content: "中文测试", source_type: "paste" }
      : values[path.split("/").pop() ?? ""] ?? null;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.locator('.shelf-item[data-shelf-id="10"] .shelf-toggle').click();
  await page.locator('.shelf-item[data-shelf-id="1"]').click();
}

async function expectBookList(page: Page) {
  await expect(page.locator(".text-list .text-title")).toHaveText([
    "Chapter 1 section 1", "Chapter 1 section 2", "Chapter 2 section 1",
  ]);
}

test("book lists descendant texts and Next crosses chapters while Back returns to book", async ({ page }) => {
  await openLibrary(page);
  await expectBookList(page);
  await page.locator("#library-main").screenshot({ path: test.info().outputPath("book-sections-desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#library-main").screenshot({ path: test.info().outputPath("book-sections-mobile.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('.text-item[data-text-id="102"]').click();
  await page.locator("#next-section-btn").click();
  await expect(page.locator(".text-header h2")).toHaveText("Chapter 2 section 1");
  await expect(page.locator("#next-section-btn")).toBeDisabled();
  await page.locator("#back-to-shelf-btn").click();
  await expect(page.locator(".shelf-header h2")).toHaveText("王者之路-上");
  await expectBookList(page);
});

test("book list stays ordered offline after reopening", async ({ page, context }) => {
  await openLibrary(page);
  await expectBookList(page);
  await context.setOffline(true);
  await page.locator('.shelf-item[data-shelf-id="10"]').click();
  await page.locator('.shelf-item[data-shelf-id="1"]').click();
  await expectBookList(page);
});

test("finishing from book updates book and chapter read status after upload while offline", async ({ page, context }) => {
  await openLibrary(page);
  await expectBookList(page);
  await page.route("**/api/sync/sessions", route => route.abort());
  page.on("dialog", dialog => dialog.accept());
  await page.locator('.text-item[data-text-id="102"]').click();
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
  await expect(page.locator('[data-text-id="102"] .text-read-status')).toHaveText("Read");
  await page.locator('.shelf-item[data-shelf-id="1"] .shelf-toggle').click();
  await page.locator('.shelf-item[data-shelf-id="2"]').click();
  await expect(page.locator('[data-text-id="102"] .text-read-status')).toHaveText("Read");
  await expect(page.locator(".text-list .text-title")).toHaveText(["Chapter 1 section 1", "Chapter 1 section 2"]);
});

test("caching a series makes intermediate book lists available offline", async ({ page, context }) => {
  await openLibrary(page);
  await page.locator('.shelf-item[data-shelf-id="10"]').click();
  await page.locator("#cache-shelf-btn").click();
  await expect(page.locator("#library-main .cache-pill")).toContainText("3/3 texts offline ready", { timeout: 15000 });
  await context.setOffline(true);
  await page.locator('.shelf-item[data-shelf-id="1"]').click();
  await expectBookList(page);
});

test("an old direct-only parent cache is not presented as a complete offline book", async ({ page, context }) => {
  await openLibrary(page);
  await expectBookList(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("chinese-reader", 5);
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const tx = db.transaction("nav_cache", "readwrite");
    const store = tx.objectStore("nav_cache");
    store.clear();
    store.put({ key: "texts_in_shelf_1", data: [], cached_at: Date.now() });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  });
  await context.setOffline(true);
  await page.locator('.shelf-item[data-shelf-id="10"]').click();
  await page.locator('.shelf-item[data-shelf-id="1"]').click();
  await expect(page.locator("#library-main")).toContainText("no cached text list available");
});
