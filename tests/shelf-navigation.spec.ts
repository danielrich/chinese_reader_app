import { expect, test } from "@playwright/test";
import type { ShelfTree } from "../src/lib/library";

test.use({ serviceWorkers: "block" });

for (const width of [1280, 390]) {
  test(`deep shelves remain readable and navigable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    let children: ShelfTree[] = [];
    for (let id = 13; id >= 1; id--) {
      children = [{
        shelf: { id, name: `Shelf ${id} 中文小說`, description: null, parent_id: id === 1 ? null : id - 1, sort_order: 0, created_at: "2026-11-17", updated_at: "2026-11-17" },
        children, text_count: 1, unread_count: 1,
      }];
    }
    await page.route("**/api/**", async route => {
      const command = new URL(route.request().url()).pathname.split("/").pop() ?? "";
      const values: Record<string, unknown> = {
        get_stats: { total_entries: 0 }, get_setting: null,
        get_shelf_tree: children, get_shelf_analysis: null,
        list_texts_in_shelf: [{ id: 1, shelf_id: 13, title: "Imported chapter", author: null, character_count: 4, has_analysis: false, has_completed_read: false }],
      };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(values[command] ?? null) });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Library", exact: true }).click();
    if (width < 701) await page.locator("#shelf-drawer-toggle").click();

    for (let id = 1; id <= 13; id++) {
      const item = page.locator(`.shelf-item[data-shelf-id="${id}"]`);
      await expect(item).toBeVisible();
      // Names and controls must fit without horizontal scrolling, even past depth 8.
      const layout = await item.evaluate(element => {
        const name = element.querySelector(".shelf-name")!.getBoundingClientRect();
        const toggle = element.querySelector(".shelf-toggle, .shelf-toggle-placeholder")!.getBoundingClientRect();
        const tree = document.getElementById("shelf-tree")!;
        return { nameWidth: name.width, toggleWidth: toggle.width, overflow: tree.scrollWidth - tree.clientWidth };
      });
      expect(layout.nameWidth, `shelf ${id} name width`).toBeGreaterThan(100);
      expect(layout.toggleWidth, `shelf ${id} toggle width`).toBeGreaterThanOrEqual(16);
      expect(layout.overflow, `shelf ${id} horizontal overflow`).toBeLessThanOrEqual(1);
      if (id < 13) await item.locator(".shelf-toggle").click();
    }
    await page.locator('.shelf-item[data-shelf-id="13"]').click();
    await expect(page.locator(".text-list")).toContainText("Imported chapter");
    if (width < 701) await page.locator("#shelf-drawer-toggle").click();
    await page.locator('.shelf-item[data-shelf-id="7"] .shelf-toggle').click();
    await expect(page.locator('.shelf-item[data-shelf-id="13"]')).toBeHidden();
    await page.locator('.shelf-item[data-shelf-id="7"] .shelf-toggle').click();
    await expect(page.locator('.shelf-item[data-shelf-id="13"]')).toBeVisible();
  });
}
