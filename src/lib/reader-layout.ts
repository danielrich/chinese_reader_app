/** Preserve reading position across panel reflow, keeping a tapped word visible. */
export function setReaderDictionaryOpen(open: boolean): void {
  const reader = document.getElementById("text-content-interactive");
  const panel = document.getElementById("dict-sidebar");
  if (!reader || !panel) return;
  const area = reader.getBoundingClientRect();
  const selected = reader.querySelector<HTMLElement>(".text-segment.selected");
  const selection = window.getSelection();
  const range = selection?.rangeCount && !selection.isCollapsed
    && reader.contains(selection.anchorNode) ? selection.getRangeAt(0) : null;
  const atTop = document.elementFromPoint(area.x + area.width / 2, Math.max(0, area.y) + 20);
  const anchor = open && (selected || range) ? selected ?? range
    : atTop && reader.contains(atTop) && atTop !== reader ? atTop : selected;
  const previousY = anchor?.getBoundingClientRect().top;
  panel.classList.toggle("open", open);
  if (anchor && previousY !== undefined) {
    const bounds = reader.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    const targetY = open
      ? Math.max(bounds.top + 12, Math.min(previousY, bounds.bottom - rect.height - 12))
      : previousY;
    reader.scrollTop += rect.top - targetY;
  }
}
