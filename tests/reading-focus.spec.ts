import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });

async function openReader(page: Page, title = "Reading Test", content?: string) {
  // This suite blocks workers; model a browser without Background Sync too.
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).SyncManager;
  });
  const text = {
    id: 1, shelf_id: 1, title, author: "Test Author",
    content: content ?? "中文测试。\n".repeat(300), character_count: 1200, has_analysis: false,
    source_type: "paste", created_at: "2026-01-01", updated_at: "2026-01-01",
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const values: Record<string, unknown> = {
      get_stats: { total_entries: 0 },
      get_shelf_tree: [{
        shelf: { id: 1, name: "Test Shelf", parent_id: null },
        children: [], text_count: 1, unread_count: 1,
      }],
      list_texts_in_shelf: [text],
      get_shelf_analysis: null,
      segment_text: content ? Array.from(content, (text) => ({
        text, is_cjk: /\p{Script=Han}/u.test(text), segment_type: "character", is_known: false,
      })) : Array.from({ length: 300 }, () => [
        { text: "中文", is_cjk: true, segment_type: "word", is_known: false },
        { text: "测试。\n", is_cjk: false },
      ]).flat(),
      dictionary_lookup: { query: "中文", entries: [], user_entries: [], character_info: null },
      is_auto_mark_enabled: false,
      sync_reading_sessions: [],
    };
    const value = path === "/api/texts/1" ? text
      : path.endsWith("/vocab-cache") ? { text_id: 1, entries: [] }
      : values[path.split("/").pop() ?? ""] ?? null;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  if (await page.locator("#shelf-drawer-toggle").isVisible()) {
    await page.locator("#shelf-drawer-toggle").click();
  }
  await page.locator('.shelf-item[data-shelf-id="1"]').click();
  await expect(page.getByText("Shelf analysis is currently unavailable.")).toBeAttached();
  await page.locator('.text-item[data-text-id="1"]').click();
  await expect(page.locator(".text-segment").first()).toBeVisible();
}

test("desktop reading uses available width and opens dictionary on demand", async ({ page }) => {
  await openReader(page);
  await expect(page.locator("#dict-sidebar")).toBeHidden();
  expect((await page.locator("#text-content-interactive").boundingBox())!.width).toBeGreaterThan(1000);
  await page.locator(".text-segment").first().click();
  await expect(page.locator("#dict-sidebar")).toBeVisible();
  await page.locator("#dict-sidebar-close").click();
  await expect(page.locator("#dict-sidebar")).toBeHidden();
});

test("Start Reading fills the viewport and Escape restores layout without stopping the session", async ({ page }) => {
  await openReader(page);
  await page.locator('[data-tab="history"]').click();
  await page.locator("#start-reading-btn").click();
  await expect(page.locator(".nav-tabs")).toBeHidden();
  await expect(page.locator("#shelf-sidebar")).toBeHidden();
  await expect(page.locator(".text-tabs")).toBeHidden();
  await expect(page.locator("#text-content-interactive")).toBeVisible();
  const area = (await page.locator("#text-content-interactive").boundingBox())!;
  expect(area.width).toBeGreaterThan(1350);
  expect(area.height).toBeGreaterThan(800);
  expect(area.y + area.height).toBeLessThanOrEqual(1000);
  await page.screenshot({ path: test.info().outputPath("desktop-focus.png") });
  await page.locator(".text-segment").first().click();
  await expect(page.locator("#dict-sidebar")).toBeVisible();
  await page.locator("#dict-sidebar-close").click();
  await page.locator("#pause-reading-btn").click();
  await expect(page.locator("#pause-reading-btn")).toHaveText("Resume");
  await page.locator("#pause-reading-btn").click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".nav-tabs")).toBeVisible();
  await expect(page.locator("#shelf-sidebar")).toBeVisible();
  await expect(page.locator("#pause-reading-btn")).toHaveText("Pause");
  await page.getByRole("button", { name: "Focus mode", exact: true }).click();
  await page.getByRole("button", { name: "Exit Focus", exact: true }).click();
  await expect(page.locator(".nav-tabs")).toBeVisible();
});

test("finishing and discarding restore layout and allow another focused session", async ({ page }) => {
  await openReader(page);
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator("#start-reading-btn").click();
  await page.locator("#finish-reading-btn").click();
  await expect(page.locator(".nav-tabs")).toBeVisible();
  await page.locator("#start-reading-btn").click();
  await expect(page.locator(".nav-tabs")).toBeHidden();
  await page.getByRole("button", { name: "Exit Focus", exact: true }).click();
  await page.locator("#discard-reading-btn").click();
  await expect(page.locator("#start-reading-btn")).toBeVisible();
  await page.getByRole("button", { name: "Focus mode", exact: true }).click();
  await page.locator("#back-to-shelf-btn").click();
  await expect(page.locator(".nav-tabs")).toBeVisible();
  await expect(page.locator("#shelf-sidebar")).toBeVisible();
});

test("mobile keeps its navigation and dictionary drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openReader(page);
  await page.locator("#start-reading-btn").click();
  await expect(page.locator(".nav-tabs")).toBeVisible();
  await expect(page.locator("#shelf-drawer-toggle")).toBeVisible();
  await page.locator(".text-segment").first().click();
  await expect(page.locator("#dict-sidebar")).toHaveClass(/open/);
  await page.screenshot({ path: test.info().outputPath("mobile-reader.png"), animations: "disabled" });
  const content = (await page.locator("#text-content-interactive").boundingBox())!;
  expect(content.x + content.width).toBeLessThanOrEqual(390);
});

test("manual Focus mode keeps long titles and controls within a narrow desktop window", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await openReader(page, "一个很长的中文章节标题".repeat(20));
  await page.getByRole("button", { name: "Focus mode", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(800);
  await expect(page.getByRole("button", { name: "Exit Focus", exact: true })).toBeInViewport();
  await page.locator("#start-reading-btn").click();
  await expect(page.locator("#finish-reading-btn")).toBeInViewport();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".nav-tabs")).toBeVisible();
});

test("fixed-width imported lines reflow across the desktop reader while paragraphs remain", async ({ page }) => {
  const line = "中".repeat(30);
  const content = "章節標題\n" + Array(8).fill(line).join("\r\n") + "\r\n結束。\n\n下一段。";
  await openReader(page, "Imported fixed-width book", content);
  await page.getByRole("button", { name: "Focus mode", exact: true }).click();
  const positions = () => page.locator('.text-segment[data-text="中"]').evaluateAll((els) =>
    [els[0], els[30], els[55]].map(el => ({ x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y })),
  );
  const reflowed = await positions();
  expect(reflowed[1].y).toBe(reflowed[0].y);
  expect(reflowed[2].x - reflowed[0].x).toBeGreaterThan(900);
  const last = await page.locator('.text-segment[data-text="下"]').boundingBox();
  const ending = await page.locator('.text-segment[data-text="束"]').boundingBox();
  expect(last!.y - ending!.y).toBeGreaterThan(60);
  await page.getByRole("checkbox", { name: "Original line breaks" }).check();
  const original = await positions();
  expect(original[1].y).toBeGreaterThan(original[0].y);
  await page.getByRole("checkbox", { name: "Original line breaks" }).uncheck();
  expect((await positions())[1].y).toBe((await positions())[0].y);
});

test("ordinary paragraphs and verse retain their intentional line breaks", async ({ page }) => {
  await openReader(page, "Verse", "床前明月光\n疑是地上霜\n\n舉頭望明月\n低頭思故鄉");
  await expect(page.getByRole("checkbox", { name: "Original line breaks" })).toBeHidden();
  const first = await page.locator('.text-segment[data-text="床"]').boundingBox();
  const second = await page.locator('.text-segment[data-text="疑"]').boundingBox();
  expect(second!.y).toBeGreaterThan(first!.y);
});
