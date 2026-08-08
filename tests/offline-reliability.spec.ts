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

async function workerMessage<T>(page: Page, type: string): Promise<T> {
  return await page.evaluate(async (messageType) => {
    const controller = navigator.serviceWorker.controller;
    if (!controller) throw new Error("service worker is not controlling the page");
    return await new Promise<T>((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = window.setTimeout(() => reject(new Error(`${messageType} timed out`)), 3_000);
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timer);
        if (event.data?.ok) resolve(event.data.value as T);
        else reject(new Error(event.data?.error ?? `${messageType} failed`));
      };
      controller.postMessage({ type: messageType }, [channel.port2]);
    });
  }, type);
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

test("a corrupted selected release falls back to an older complete release", async ({ page }) => {
  await bootstrapControlledApp(page);
  const initial = await workerMessage<{ activeReleaseId: string }>(page, "VERIFY_SHELL");
  const fallbackId = "test-fallback-release";

  await page.evaluate(async ({ currentId, fallbackId }) => {
    const currentCache = await caches.open(`shell-content-release-${currentId}`);
    const fallbackCache = await caches.open(`shell-content-release-${fallbackId}`);
    for (const request of await currentCache.keys()) {
      const response = await currentCache.match(request);
      if (response) await fallbackCache.put(request, response);
    }
    const meta = await caches.open("shell-release-meta-v1");
    const currentResponse = await meta.match(`/release-${currentId}.json`);
    if (!currentResponse) throw new Error("current release metadata missing");
    const current = await currentResponse.json();
    await meta.put(`/release-${fallbackId}.json`, new Response(JSON.stringify({
      ...current,
      id: fallbackId,
      cachedAt: current.cachedAt - 1,
    }), { headers: { "Content-Type": "application/json" } }));
    await currentCache.delete("/index.html");
  }, { currentId: initial.activeReleaseId, fallbackId });

  const recovered = await workerMessage<{ verified: boolean; activeReleaseId: string }>(page, "VERIFY_SHELL");
  expect(recovered).toMatchObject({ verified: true, activeReleaseId: fallbackId });
});

test("online recovery after shell eviction records loss and does not claim readiness", async ({ page }) => {
  await bootstrapControlledApp(page);
  await page.evaluate(async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("shell-content-release-")) await caches.delete(name);
    }
  });

  await page.reload();

  await expect(page.getByRole("heading", { name: "Chinese Reader" })).toBeVisible();
  await expect(page.locator("#offline-status-state")).toHaveText("Offline launch unavailable");
  const diagnostics = await workerMessage<{ lastMissingCriticalUrl?: string }>(page, "GET_DIAGNOSTICS");
  expect(diagnostics.lastMissingCriticalUrl).toBeTruthy();
});

test("offline API failure never prevents the cached shell from rendering", async ({ page, context }) => {
  await bootstrapControlledApp(page);
  await context.route("**/api/**", (route) => route.abort("connectionrefused"));
  await context.setOffline(true);

  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "Chinese Reader" })).toBeVisible();
});

test("partial and complete bundle markers drive truthful shelf badges", async ({ page }) => {
  const secondSummary = { ...textSummary, id: 2, title: "Partial Text" };
  await page.route("**/api/invoke/**", async (route) => {
    const command = new URL(route.request().url()).pathname.split("/").pop();
    const shelf = {
      id: 1, name: "Test Shelf", description: null, parent_id: null,
      sort_order: 0, created_at: "2026-01-01", updated_at: "2026-01-01",
    };
    const values: Record<string, unknown> = {
      get_shelf_tree: [{ shelf, children: [], text_count: 2, unread_count: 2 }],
      list_texts_in_shelf: [textSummary, secondSummary],
      get_shelf_analysis: null,
      get_stats: {},
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(values[command ?? ""] ?? null) });
  });
  await bootstrapControlledApp(page);
  await page.evaluate(async ({ complete, partial }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("chinese-reader", 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const now = Date.now();
    const tx = db.transaction(["text_cache", "text_segments", "text_meta", "vocab_cache", "offline_text_bundles"], "readwrite");
    tx.objectStore("text_cache").put({ ...complete, content: "中文测试", source_type: "paste", created_at: "2026-01-01", updated_at: "2026-01-01" });
    tx.objectStore("text_segments").put({ text_id: 1, segments: [{ text: "中文", is_cjk: true, is_known: false, is_learning: false, segment_type: "word" }], cached_at: now });
    tx.objectStore("vocab_cache").put({ term: "中文", pinyin: "zhong wen", definitions: ["Chinese"], source: "test" });
    tx.objectStore("text_meta").put({ text_id: 1, text_cached_at: now, segments_cached_at: now, vocab_cached_at: now });
    tx.objectStore("offline_text_bundles").put({ text_id: 1, schema_version: 1, status: "complete", downloaded_at: now, segment_count: 1, vocab_entry_count: 1, vocab_terms: ["中文"], summary: complete });
    tx.objectStore("text_cache").put({ ...partial, content: "部分", source_type: "paste", created_at: "2026-01-01", updated_at: "2026-01-01" });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, { complete: textSummary, partial: secondSummary });

  await page.getByRole("button", { name: "Library" }).click();
  await page.locator('.shelf-item[data-shelf-id="1"]').click();

  await expect(page.locator('.text-item[data-text-id="1"] .text-cache-badge')).toHaveText("Available offline");
  await expect(page.locator('.text-item[data-text-id="2"] .text-cache-badge')).toHaveText("Partial");
  await expect(page.locator(".cache-pill")).toContainText("1/2 texts offline ready");
});

test("interrupted shelf download identifies the failed text", async ({ page }) => {
  const broken = { ...textSummary, id: 2, title: "Broken Text" };
  await page.route("**/api/invoke/**", async (route) => {
    const command = new URL(route.request().url()).pathname.split("/").pop();
    const shelf = { id: 1, name: "Test Shelf", description: null, parent_id: null, sort_order: 0, created_at: "2026-01-01", updated_at: "2026-01-01" };
    const values: Record<string, unknown> = {
      get_shelf_tree: [{ shelf, children: [], text_count: 2, unread_count: 2 }],
      list_texts_in_shelf: [textSummary, broken],
      get_shelf_analysis: null,
      segment_text: [{ text: "中文", is_cjk: true, is_known: false, is_learning: false, segment_type: "word" }],
      get_stats: {},
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(values[command ?? ""] ?? null) });
  });
  await page.context().route("**/api/texts/**", async (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    const id = Number(parts[3]);
    if (parts[4] === "vocab-cache") {
      if (id === 2) return route.fulfill({ status: 503, body: "interrupted" });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text_id: id, words: [], characters: [] }) });
    }
    const summary = id === 2 ? broken : textSummary;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...summary, content: "中文测试", source_type: "paste", created_at: "2026-01-01", updated_at: "2026-01-01" }) });
  });
  await bootstrapControlledApp(page);
  await page.getByRole("button", { name: "Library" }).click();
  await page.locator('.shelf-item[data-shelf-id="1"]').click();

  await page.locator("#cache-shelf-btn").click();

  await expect(page.locator("#cache-shelf-btn")).toContainText("Broken Text");
});

test("connection refusal falls back to the shell", async ({ page, context }) => {
  await bootstrapControlledApp(page);
  await context.route("**/refused-launch", (route) => route.abort("connectionrefused"));

  await page.goto("/refused-launch", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "Chinese Reader" })).toBeVisible();
});

test("hung navigation falls back within two seconds", async ({ page, context }) => {
  await bootstrapControlledApp(page);
  await context.route("**/hung-launch", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    await route.fulfill({ status: 200, contentType: "text/html", body: "late" });
  });

  const startedAt = Date.now();
  await page.goto("/hung-launch", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "Chinese Reader" })).toBeVisible();
  expect(Date.now() - startedAt).toBeLessThan(2_500);
});

test("a broken newer release never replaces the selected complete release", async ({ page }) => {
  await bootstrapControlledApp(page);
  const initial = await workerMessage<{ activeReleaseId: string }>(page, "VERIFY_SHELL");
  await page.evaluate(async (currentId) => {
    const meta = await caches.open("shell-release-meta-v1");
    await meta.put("/release-broken-newer.json", new Response(JSON.stringify({
      id: "broken-newer",
      entryUrl: "/index.html",
      criticalUrls: ["/index.html", "/assets/missing-critical.js"],
      ready: true,
      cachedAt: Date.now() + 10_000,
    }), { headers: { "Content-Type": "application/json" } }));
    const broken = await caches.open("shell-content-release-broken-newer");
    const current = await caches.open(`shell-content-release-${currentId}`);
    const index = await current.match("/index.html");
    if (index) await broken.put("/index.html", index);
    await meta.delete("/selected-release.json");
  }, initial.activeReleaseId);

  const verified = await workerMessage<{ verified: boolean; activeReleaseId: string }>(page, "VERIFY_SHELL");
  expect(verified).toMatchObject({ verified: true, activeReleaseId: initial.activeReleaseId });
});

test("an interrupted release without ready metadata is ignored", async ({ page }) => {
  await bootstrapControlledApp(page);
  const initial = await workerMessage<{ activeReleaseId: string }>(page, "VERIFY_SHELL");
  await page.evaluate(async () => {
    const partial = await caches.open("shell-content-release-interrupted");
    await partial.put("/index.html", new Response("partial"));
  });

  const verified = await workerMessage<{ verified: boolean; activeReleaseId: string }>(page, "VERIFY_SHELL");
  expect(verified).toMatchObject({ verified: true, activeReleaseId: initial.activeReleaseId });
});

test("retry setup preserves IndexedDB text data", async ({ page }) => {
  await bootstrapControlledApp(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("chinese-reader", 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction("text_cache", "readwrite");
    tx.objectStore("text_cache").put({ id: 77, title: "Preserved", content: "保留" });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });

  await page.locator("#offline-retry-btn").click();
  await expect(page.locator("#offline-status-state")).toHaveText("Offline launch ready");
  const preserved = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("chinese-reader", 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise<boolean>((resolve, reject) => {
      const request = db.transaction("text_cache", "readonly").objectStore("text_cache").get(77);
      request.onsuccess = () => resolve(Boolean(request.result));
      request.onerror = () => reject(request.error);
    });
  });
  expect(preserved).toBe(true);
});

test("cleanup retains at least one verified selected release", async ({ page }) => {
  await bootstrapControlledApp(page);
  const initial = await workerMessage<{ activeReleaseId: string }>(page, "VERIFY_SHELL");
  await page.evaluate(async (currentId) => {
    const currentCache = await caches.open(`shell-content-release-${currentId}`);
    const meta = await caches.open("shell-release-meta-v1");
    const response = await meta.match(`/release-${currentId}.json`);
    if (!response) throw new Error("release metadata missing");
    const release = await response.json();
    for (let index = 0; index < 5; index += 1) {
      const id = `cleanup-${index}`;
      const cache = await caches.open(`shell-content-release-${id}`);
      for (const request of await currentCache.keys()) {
        const cached = await currentCache.match(request);
        if (cached) await cache.put(request, cached);
      }
      await meta.put(`/release-${id}.json`, new Response(JSON.stringify({
        ...release, id, cachedAt: Date.now() - index - 1,
      }), { headers: { "Content-Type": "application/json" } }));
    }
    navigator.serviceWorker.controller?.postMessage({ type: "REFRESH_APP_SHELL" });
  }, initial.activeReleaseId);

  await expect.poll(() => page.evaluate(async () => (
    await caches.keys()).filter((name) => name.startsWith("shell-content-release-")).length
  )).toBeLessThanOrEqual(3);
  const verified = await workerMessage<{ verified: boolean; activeReleaseId?: string }>(page, "VERIFY_SHELL");
  expect(verified.verified).toBe(true);
  expect(verified.activeReleaseId).toBeTruthy();
});

test("missing shell returns diagnostic HTML instead of a browser error", async ({ page, context }) => {
  await bootstrapControlledApp(page);
  await page.evaluate(async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("shell-content-release-")) await caches.delete(name);
    }
  });
  await context.setOffline(true);

  await page.goto("/missing-shell", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "Chinese Reader offline shell unavailable" })).toBeVisible();
});

test("offline status reports a storage persistence decision", async ({ page }) => {
  await bootstrapControlledApp(page);

  await expect(page.locator("#offline-storage-state")).toContainText(/Persistent storage granted|Persistence not granted|unsupported/i);
});
