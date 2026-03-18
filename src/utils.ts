import * as library from "./lib/library";

// =============================================================================
// Shared Utilities
// =============================================================================

export function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

export function findShelfById(nodes: library.ShelfTree[], id: number): library.ShelfTree | null {
  for (const node of nodes) {
    if (node.shelf.id === id) return node;
    const found = findShelfById(node.children, id);
    if (found) return found;
  }
  return null;
}

export function renderShelfOptions(nodes: library.ShelfTree[], depth: number): string {
  return nodes
    .map((node) => {
      const indent = "—".repeat(depth);
      return `
        <option value="${node.shelf.id}">${indent}${escapeHtml(node.shelf.name)}</option>
        ${renderShelfOptions(node.children, depth + 1)}
      `;
    })
    .join("");
}

export function renderShelfOptionsExcluding(
  nodes: library.ShelfTree[],
  depth: number,
  excludeIds: Set<number>,
  currentParentId: number | null
): string {
  return nodes
    .filter(node => !excludeIds.has(node.shelf.id))
    .map((node) => {
      const indent = "—".repeat(depth);
      const selected = node.shelf.id === currentParentId ? "selected" : "";
      return `
        <option value="${node.shelf.id}" ${selected}>${indent}${escapeHtml(node.shelf.name)}</option>
        ${renderShelfOptionsExcluding(node.children, depth + 1, excludeIds, currentParentId)}
      `;
    })
    .join("");
}

export function getShelfAndDescendantIds(tree: library.ShelfTree[], shelfId: number): Set<number> {
  const ids = new Set<number>();

  function collectIds(nodes: library.ShelfTree[]) {
    for (const node of nodes) {
      ids.add(node.shelf.id);
      collectIds(node.children);
    }
  }

  function findAndCollect(nodes: library.ShelfTree[]): boolean {
    for (const node of nodes) {
      if (node.shelf.id === shelfId) {
        ids.add(node.shelf.id);
        collectIds(node.children);
        return true;
      }
      if (findAndCollect(node.children)) return true;
    }
    return false;
  }

  findAndCollect(tree);
  return ids;
}

export function isCjkCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF);
}

export function createModal(title: string, content: string): HTMLElement {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${title}</h3>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        ${content}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector(".modal-close")?.addEventListener("click", closeModal);
  overlay.querySelector(".modal-cancel")?.addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  return overlay;
}

export function closeModal() {
  document.querySelector(".modal-overlay")?.remove();
}

// =============================================================================
// Two-Level Shelf Selector Helpers
// =============================================================================

/** Flatten first two levels of shelf tree for the primary dropdown */
export function getTopTwoLevels(shelves: library.ShelfTree[]): { shelf: library.Shelf; depth: number }[] {
  const result: { shelf: library.Shelf; depth: number }[] = [];
  for (const node of shelves) {
    result.push({ shelf: node.shelf, depth: 0 });
    for (const child of node.children) {
      result.push({ shelf: child.shelf, depth: 1 });
    }
  }
  return result;
}

/** Find a shelf node in the tree by ID */
export function findShelfInTree(shelves: library.ShelfTree[], id: number): library.ShelfTree | null {
  for (const node of shelves) {
    if (node.shelf.id === id) return node;
    const found = findShelfInTree(node.children, id);
    if (found) return found;
  }
  return null;
}

/** Get all descendants of a shelf (for the secondary dropdown) */
export function getShelfDescendants(node: library.ShelfTree, depth: number = 0): { shelf: library.Shelf; depth: number }[] {
  const result: { shelf: library.Shelf; depth: number }[] = [];
  for (const child of node.children) {
    result.push({ shelf: child.shelf, depth });
    result.push(...getShelfDescendants(child, depth + 1));
  }
  return result;
}

/** Render a two-level shelf selector with primary and secondary dropdowns */
export function renderTwoLevelShelfSelector(
  shelves: library.ShelfTree[],
  prefix: string,
  primaryShelfId: number | null,
  finalShelfId: number | null
): string {
  const topLevels = getTopTwoLevels(shelves);

  const primaryOptions = topLevels.map(({ shelf, depth }) => {
    const indent = depth > 0 ? "— " : "";
    const selected = shelf.id === primaryShelfId ? "selected" : "";
    return `<option value="${shelf.id}" ${selected}>${indent}${escapeHtml(shelf.name)}</option>`;
  }).join("");

  let secondaryOptions = "";
  let hasSecondaryOptions = false;

  if (primaryShelfId !== null) {
    const primaryNode = findShelfInTree(shelves, primaryShelfId);
    if (primaryNode && primaryNode.children.length > 0) {
      hasSecondaryOptions = true;
      const descendants = getShelfDescendants(primaryNode);
      secondaryOptions = descendants.map(({ shelf, depth }) => {
        const indent = "— ".repeat(depth);
        const selected = shelf.id === finalShelfId ? "selected" : "";
        return `<option value="${shelf.id}" ${selected}>${indent}${escapeHtml(shelf.name)}</option>`;
      }).join("");
    }
  }

  const isAllSelected = finalShelfId === null || finalShelfId === primaryShelfId;

  return `
    <select id="${prefix}-shelf-primary" class="shelf-select-primary">
      <option value="">All Shelves</option>
      ${primaryOptions}
    </select>
    ${hasSecondaryOptions ? `
      <select id="${prefix}-shelf-secondary" class="shelf-select-secondary">
        <option value="" ${isAllSelected ? "selected" : ""}>All in shelf</option>
        ${secondaryOptions}
      </select>
    ` : primaryShelfId !== null ? `
      <span class="shelf-no-children">(no sub-shelves)</span>
    ` : ""}
  `;
}
