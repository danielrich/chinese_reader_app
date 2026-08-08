import { expect, test, type Page } from "@playwright/test";

const textSummary = {
  id: 1, shelf_id: 1, title: "Offline Test", author: null,
  character_count: 4, has_analysis: false,
};

async function mockLibraryApi(page: Page): Promise<void> {
  await page.route("**/api/invoke/**", async (route) => {
    const command = new URL(route.request().url()).pathname.split("/").pop();
    const shelf = {
      id: 1, name: "Test Shelf", description: null, parent_id: null,
      sort_order: 0, created_at: "2026-01-01", updated_at: "2026-01-01",
    };
    const values: Record<string, unknown> = {
      get_shelf_tree: [{ shelf, children: [], text_count: 1, unread_count: 1 }],
      list_texts_in_shelf: [textSummary],
      get_shelf_analysis: {
        shelf_id: 1, text_count: 1, total_characters: 4, unique_characters: 4,
        known_characters_count: 0, total_words: 1, unique_words: 1, known_words_count: 0,
        unknown_characters: [], known_characters: [], unknown_words: [], known_words: [],
      },
      get_stats: {},
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(values[command ?? ""] ?? null),
    });
  });
}

async function bootstrapControlledApp(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

test("reports offline launch ready only after the controlling shell verifies", async ({ page }) => {
  await bootstrapControlledApp(page);

  const verification = await page.evaluate(async () => {
    const controller = navigator.serviceWorker.controller;
    if (!controller) return null;
    return await new Promise<unknown>((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = window.setTimeout(() => reject(new Error("verification timed out")), 3_000);
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timer);
        resolve(event.data);
      };
      controller.postMessage({ type: "VERIFY_SHELL" }, [channel.port2]);
    });
  });
  expect(verification).toMatchObject({ ok: true, value: { controlled: true, verified: true } });
  await expect(page.locator("#offline-status-state")).toHaveText("Offline launch ready");
});

test("cold offline query navigation renders the cached app shell", async ({ page, context }) => {
  await bootstrapControlledApp(page);
  await context.setOffline(true);

  const startedAt = Date.now();
  await page.goto("/?refresh=123", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "Chinese Reader" })).toBeVisible();
  expect(Date.now() - startedAt).toBeLessThan(2_500);
});

test("a missing optional icon does not prevent a verified shell install", async ({ page }) => {
  await page.route("**/icon-512.png", (route) => route.fulfill({ status: 404, body: "missing" }));

  await bootstrapControlledApp(page);

  await expect(page.locator("#offline-status-state")).toHaveText("Offline launch ready");
});

test("text API responses are never stored in service-worker caches", async ({ page }) => {
  await bootstrapControlledApp(page);

  const cached = await page.evaluate(async () => {
    await fetch("/api/texts/987654");
    for (const name of await caches.keys()) {
      const response = await (await caches.open(name)).match("/api/texts/987654");
      if (response) return { name, found: true };
    }
    return { found: false };
  });

  expect(cached).toEqual({ found: false });
});

test("copy diagnostics exposes local and worker recovery evidence", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await bootstrapControlledApp(page);

  await page.locator("#offline-copy-btn").click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());

  expect(JSON.parse(copied)).toMatchObject({
    local: { controlled: true, activeReleaseId: expect.any(String) },
    worker: { buildId: expect.any(String), events: expect.any(Array) },
  });
});

test("opening a locally stored text issues no text record request", async ({ page }) => {
  await mockLibraryApi(page);
  const textRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/texts/1") textRequests.push(request.url());
  });
  await bootstrapControlledApp(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("chinese-reader", 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(["text_cache", "text_segments", "text_meta"], "readwrite");
    tx.objectStore("text_cache").put({
      id: 1, shelf_id: 1, title: "Offline Test", author: null, source_type: "paste",
      content: "中文测试", character_count: 4, created_at: "2026-01-01", updated_at: "2026-01-01",
    });
    tx.objectStore("text_segments").put({ text_id: 1, segments: [], cached_at: Date.now() });
    tx.objectStore("text_meta").put({ text_id: 1, text_cached_at: Date.now() });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });

  await page.getByRole("button", { name: "Library" }).click();
  await page.locator('.shelf-item[data-shelf-id="1"]').click();
  await page.locator('.text-item[data-text-id="1"]').click();

  await expect(page.getByRole("heading", { name: "Offline Test" })).toBeVisible();
  expect(textRequests).toEqual([]);
});
