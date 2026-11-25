// Positioned pages -> ImportResult. Pure: no pdf.js, no DOM, so it's unit-testable with
// hand-built pages (see test-support/synthetic.js). pdf.js extraction lives in pdf.js.

import { PT_PER_INCH as IN, buildRows, rowText } from './layout.js';
import { cleanRows } from './clean.js';
import { finalize, makeBlock, addFlag } from './model.js';
import { isSceneHeading } from './text.js';
import { screenplay } from './rulesets/screenplay.js';

export const RULESETS = { screenplay };

/**
 * pages: [{ width, height, items: [{ str, x, y, w?, size? }], hasImages? }]  (y from the top)
 * options.ruleset: a ruleset object (default: screenplay)
 */
export function parseLayout(pages, options = {}) {
  const ruleset = options.ruleset || screenplay;
  const warnings = [];
  const { rows: allRows, charWidth, lineHeight } = buildRows(pages);

  // Pages with no text: probably scanned. Flag them (no OCR yet).
  const scanned = [];
  pages.forEach((p, i) => {
    const chars = p.items.reduce((n, it) => n + (it.str || '').trim().length, 0);
    if (chars < 20 && (p.hasImages || chars === 0)) scanned.push(i + 1);
  });
  if (scanned.length) {
    warnings.push(`${scanned.length === pages.length ? 'No pages have' : `Page${scanned.length > 1 ? 's' : ''} ${scanned.join(', ')} ${scanned.length > 1 ? 'have' : 'has'}`} a text layer; ${scanned.length === pages.length ? 'this looks like a scanned PDF' : 'they look scanned'}. OCR isn't available yet, so ${scanned.length > 1 ? 'they were' : 'it was'} skipped.`);
  }

  // Title page: the first page when it has no scene heading and looks like a cover.
  const { title, rows: bodyRows } = stripTitlePage(allRows, pages);

  const { rows, removed, leftMargin } = cleanRows(bodyRows, pages);
  const ctx = { leftMargin, charWidth, lineHeight, pages };
  const { blocks, warnings: rulesetWarnings = [] } = ruleset.classify(rows, ctx);
  warnings.push(...rulesetWarnings);

  // A marker block per scanned page, so the gap is visible in the block list.
  for (const page of scanned) {
    const at = blocks.findIndex((b) => b.page != null && b.page > page);
    const marker = makeBlock('action', `[Page ${page}: no text layer]`, 0.1, { page, flags: ['scanned_page'] });
    if (at === -1) blocks.push(marker); else blocks.splice(at, 0, marker);
  }
  for (const b of blocks) if (b.flags.includes('scanned_page')) addFlag(b, 'low_confidence');

  const result = finalize({ source: 'pdf', title, blocks, warnings, pages: pages.length });
  result.debug = { removed, ruleset: ruleset.id, lineHeight: round(lineHeight), charWidth: round(charWidth), leftMarginInches: round(ctx.leftMargin / IN) };
  return result;
}

const round = (n) => Math.round(n * 100) / 100;

function stripTitlePage(rows, pages) {
  if (pages.length < 2) return { title: null, rows };
  const first = rows.filter((r) => r.page === 1);
  if (!first.length || first.some((r) => isSceneHeading(rowText(r)))) return { title: null, rows };
  const width = pages[0].width || 612;
  const texts = first.map(rowText);
  const centred = first.filter((r) => {
    const s = r.segments[0];
    const mid = (s.x + r.segments[r.segments.length - 1].right) / 2;
    return Math.abs(mid - width / 2) < 0.6 * IN;
  }).length;
  const coverWords = texts.some((t) => /\b(?:written by|screenplay by|story by|teleplay by|draft|copyright)\b|^by$|©/i.test(t));
  if (!coverWords && centred < first.length * 0.6) return { title: null, rows };
  // Title: the first centred line that isn't "by ..." / a date / contact detail.
  const titleRow = first.find((r) => {
    const t = rowText(r);
    return t.length > 1 && !/^(?:by|written by|screenplay by)\b/i.test(t) && !/@|\d{3}.*\d{4}/.test(t);
  });
  return { title: titleRow ? rowText(titleRow).replace(/^["“]|["”]$/g, '') : null, rows: rows.filter((r) => r.page !== 1) };
}
