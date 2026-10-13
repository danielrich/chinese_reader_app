import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

async function mockShelf(page: Page) {
  const shelf = { id: 1, name: "Test Shelf", description: null, parent_id: null, sort_order: 0, created_at: "2026-01-01", updated_at: "2026-01-01" };
  await page.route("**/api/invoke/**", async (route) => {
    const command = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const values: Record<string, unknown> = {
      get_shelf_tree: [{ shelf, children: [], text_count: 0, unread_count: 0 }],
      list_texts_in_shelf: [], get_shelf_analysis: null, get_stats: {},
    };
    await route.fulfill({ json: values[command] ?? null });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Library" }).click();
  await page.locator('.shelf-item[data-shelf-id="1"]').click();
  await expect(page.getByRole("heading", { name: "Test Shelf" })).toBeVisible();
}

test("downloads a shelf EPUB with the server filename", async ({ page }) => {
  await page.addInitScript(() => {
    URL.createObjectURL = () => "blob:test";
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function () { (window as any).__downloadName = this.download; };
  });
  let requests = 0;
  await page.route("**/api/shelves/1/export.epub", async (route) => {
    requests += 1;
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.fulfill({ status: 200, headers: { "Content-Type": "application/epub+zip", "Content-Disposition": "attachment; filename*=UTF-8''Test%20Shelf.epub" }, body: "epub" });
  });
  await mockShelf(page);
  const button = page.locator("#export-epub-btn");
  await button.click();
  await expect(button).toHaveText("Preparing EPUB…");
  await expect.poll(() => page.evaluate(() => (window as any).__downloadName)).toBe("Test Shelf.epub");
  expect(requests).toBe(1);
  await expect(button).toHaveText("Export as EPUB");
});

test("restores the export button after a server failure", async ({ page }) => {
  await page.route("**/api/shelves/1/export.epub", (route) => route.fulfill({ status: 500, body: "broken" }));
  await mockShelf(page);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("EPUB export failed");
    await dialog.dismiss();
  });
  const button = page.locator("#export-epub-btn");
  await button.click();
  await expect(button).toHaveText("Export as EPUB");
  await expect(page.getByRole("heading", { name: "Test Shelf" })).toBeVisible();
});
