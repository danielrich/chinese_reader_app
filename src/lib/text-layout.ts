/** Find artificial line wraps in fixed-width Chinese ebook text.
 * Original text and segmentation stay intact; only display breaks are omitted.
 */
export function getSoftLineBreakOffsets(content: string): Set<number> {
  const lines: { text: string; width: number; breakAt: number; breakLength: number }[] = [];
  let start = 0;
  for (const match of content.matchAll(/\r\n|\r|\n/g)) {
    const text = content.slice(start, match.index).trim();
    lines.push({ text, width: [...text].length, breakAt: match.index, breakLength: match[0].length });
    start = match.index + match[0].length;
  }
  const tail = content.slice(start).trim();
  lines.push({ text: tail, width: [...tail].length, breakAt: content.length, breakLength: 0 });

  const nonempty = lines.filter(line => line.width > 0);
  if (nonempty.length < 6) return new Set();
  const widths = new Map<number, number>();
  for (const line of nonempty) {
    if (line.width < 20 || line.width > 100) continue;
    if ((line.text.match(/\p{Script=Han}/gu)?.length ?? 0) < line.width / 2) continue;
    widths.set(line.width, (widths.get(line.width) ?? 0) + 1);
  }
  const dominantWidth = [...widths].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
  if (!dominantWidth) return new Set();
  const isFullLine = (width: number) => width >= dominantWidth - 2 && width <= dominantWidth + 1;
  // Variable-length prose and short verse must retain their original formatting.
  if (nonempty.filter(line => isFullLine(line.width)).length < nonempty.length * 0.6) return new Set();
  if (nonempty.some(line => line.width > dominantWidth + 2)) return new Set();

  const softBreaks = new Set<number>();
  lines.forEach((line, index) => {
    const next = lines[index + 1];
    if (!next?.width || !isFullLine(line.width) || !line.breakLength) return;
    // Preserve sentence endings, dialogue boundaries, short lines and blank lines.
    if (/[。！？!?；;：:…」』”’）)】]$/u.test(line.text)) return;
    if (!/\p{Script=Han}$/u.test(line.text) && !/[，、]$/u.test(line.text)) return;
    for (let offset = 0; offset < line.breakLength; offset++) softBreaks.add(line.breakAt + offset);
  });
  return softBreaks;
}
