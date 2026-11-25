// Positioned text -> rows of segments. Input is format-neutral, so tests can build it directly:
//
//   Page { width, height, items: Item[], hasImages?: boolean }      (points, 72 per inch)
//   Item { str, x, y, w?, size? }   x = left edge, y = baseline measured from the TOP of the page
//
// Output rows (one per visual line), each split into segments where there's a wide horizontal
// gap, so side-by-side text (dual dialogue, margin scene numbers, revision asterisks) stays apart.
//
//   Row { page, y, segments: Segment[] }
//   Segment { text, x, right, y, page, size }

export const PT_PER_INCH = 72;

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export { median };

/** Average character width of an item (Courier 12pt is 7.2pt). */
function charWidth(item) {
  const n = item.str.length;
  if (item.w && n) return item.w / n;
  return (item.size || 12) * 0.6;
}

export function buildRows(pages) {
  const rows = [];
  const widths = [];
  pages.forEach((page, pi) => {
    const items = [];
    for (const it of page.items) {
      if (!it.str || !it.str.trim()) continue;
      const cw = charWidth(it);
      widths.push(cw);
      // Some PDFs indent with spaces inside one text run: move x to the first visible character.
      const lead = it.str.length - it.str.trimStart().length;
      const str = it.str.trim();
      const x = it.x + lead * cw;
      items.push({ str, x, right: x + str.length * cw, y: it.y, size: it.size || 12, cw });
    }
    items.sort((a, b) => a.y - b.y || a.x - b.x);
    // Group into rows: items whose baselines are within 40% of the font size.
    const pageRows = [];
    for (const it of items) {
      const row = pageRows[pageRows.length - 1];
      if (row && Math.abs(it.y - row.y) <= it.size * 0.4) row.items.push(it);
      else pageRows.push({ y: it.y, items: [it] });
    }
    for (const row of pageRows) {
      row.items.sort((a, b) => a.x - b.x);
      const segments = [];
      for (const it of row.items) {
        const seg = segments[segments.length - 1];
        // Same segment when the gap is under ~2.5 characters (a normal word space is 1).
        if (seg && it.x - seg.right <= it.cw * 2.5) {
          const gap = it.x - seg.right > it.cw * 0.3 ? ' ' : '';
          seg.text += gap + it.str;
          seg.right = Math.max(seg.right, it.right);
        } else {
          segments.push({ text: it.str, x: it.x, right: it.right, y: row.y, page: pi + 1, size: it.size });
        }
      }
      rows.push({ page: pi + 1, y: row.y, segments });
    }
  });
  const size = median(rows.flatMap((r) => r.segments.map((s) => s.size))) || 12;
  return { rows, charWidth: median(widths) || 7.2, lineHeight: lineHeight(rows, size) };
}

/**
 * The document's single-spaced line height: the smallest gap between consecutive rows that's at
 * least 3/4 of the font size (blank lines double the gap, so the most common gap can be wrong).
 */
function lineHeight(rows, size) {
  let best = null;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].page !== rows[i - 1].page) continue;
    const g = rows[i].y - rows[i - 1].y;
    if (g >= size * 0.75 && (best === null || g < best)) best = g;
  }
  return best && best < size * 2.5 ? best : size;
}

/** Joins a row's segments into one string (used when a row isn't treated as columns). */
export function rowText(row) {
  return row.segments.map((s) => s.text).join(' ');
}
