// Removes page furniture before classification: page numbers, running headers/footers,
// "(CONTINUED)" / "CONTINUED:" markers, scene numbers in the margins and revision asterisks.
// Scene numbers and revision marks are kept on the row (row.sceneNumber, row.revised).

import { PT_PER_INCH as IN } from './layout.js';
import { isPageNumber, isSceneNumber, isContinuedMarker, isRevisionMark, isSceneHeading } from './text.js';
import { median } from './layout.js';

const TOP_ZONE = 0.92 * IN; // baselines above this are in the header area
const BOTTOM_ZONE = 0.75 * IN; // baselines below (height - this) are in the footer area

/**
 * Estimates the left text margin (where action and scene headings start). Scene headings are the
 * best anchor; without them, the smallest x shared by a meaningful share of rows. Margin numbers
 * are ignored.
 */
export function estimateLeftMargin(rows) {
  const headingXs = [];
  for (const r of rows) {
    const s = r.segments.find((seg) => !isSceneNumber(seg.text) && !isRevisionMark(seg.text));
    if (s && isSceneHeading(s.text)) headingXs.push(s.x);
  }
  if (headingXs.length) return median(headingXs);
  const xs = [];
  for (const r of rows) {
    const s = r.segments.find((seg) => !isSceneNumber(seg.text) && !isRevisionMark(seg.text));
    if (s) xs.push(Math.round(s.x / 2) * 2);
  }
  if (!xs.length) return 1.5 * IN;
  const counts = new Map();
  xs.forEach((x) => counts.set(x, (counts.get(x) || 0) + 1));
  const need = Math.max(2, xs.length * 0.06);
  const sorted = [...counts.keys()].sort((a, b) => a - b);
  for (const x of sorted) {
    // Count rows within ±4pt so slightly jittery positions still form one group.
    const n = sorted.filter((y) => Math.abs(y - x) <= 4).reduce((sum, y) => sum + counts.get(y), 0);
    if (n >= need) return x;
  }
  return sorted[0];
}

export function cleanRows(rows, pages) {
  const removed = [];
  const drop = (row, seg, reason) => removed.push({ page: row.page, text: seg ? seg.text : row.segments.map((s) => s.text).join(' '), reason });
  const pageCount = pages.length;
  const inZone = (row) => {
    const h = pages[row.page - 1]?.height || 792;
    return row.y < TOP_ZONE ? 'top' : row.y > h - BOTTOM_ZONE ? 'bottom' : null;
  };

  // Running headers/footers: the same text (digits ignored) in the same zone on many pages.
  const seen = new Map();
  for (const r of rows) {
    const zone = inZone(r);
    if (!zone) continue;
    for (const s of r.segments) {
      const key = zone + ':' + s.text.replace(/\d+/g, '#').toLowerCase();
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key).add(r.page);
    }
  }
  const repeated = (zone, text) => {
    if (pageCount < 3) return false;
    const pagesWith = seen.get(zone + ':' + text.replace(/\d+/g, '#').toLowerCase());
    return pagesWith && pagesWith.size >= Math.max(2, Math.ceil(pageCount * 0.4));
  };

  const out = [];
  for (const r of rows) {
    const zone = inZone(r);
    let segments = r.segments;
    if (zone) {
      segments = segments.filter((s) => {
        if (isPageNumber(s.text)) { drop(r, s, 'page number'); return false; }
        if (repeated(zone, s.text)) { drop(r, s, zone === 'top' ? 'running header' : 'running footer'); return false; }
        if (isContinuedMarker(s.text)) { drop(r, s, 'continued marker'); return false; }
        return true;
      });
    }
    if (segments.length === 1 && isContinuedMarker(segments[0].text)) {
      drop(r, segments[0], 'continued marker');
      segments = [];
    }
    if (segments.length) out.push({ ...r, segments });
  }

  // Margin scene numbers and revision asterisks, relative to the document's own left margin.
  const left = estimateLeftMargin(out);
  const result = [];
  for (const r of out) {
    let segments = [...r.segments];
    let sceneNumber = null;
    let revised = false;
    segments = segments.filter((s) => {
      if (isRevisionMark(s.text) && (s.x >= left + 4.5 * IN || s.right <= left - 0.1 * IN)) {
        revised = true;
        drop(r, s, 'revision mark');
        return false;
      }
      return true;
    });
    // A number left of the margin, or far right, next to other text on the same row.
    if (segments.length > 1) {
      const first = segments[0];
      const last = segments[segments.length - 1];
      if (isSceneNumber(first.text) && first.right <= left - 0.1 * IN) {
        sceneNumber = first.text.replace(/\.$/, '');
        drop(r, first, 'scene number');
        segments.shift();
      }
      if (segments.length > 1 && isSceneNumber(last.text) && last.x >= left + 5.0 * IN) {
        sceneNumber = sceneNumber || last.text.replace(/\.$/, '');
        drop(r, last, 'scene number');
        segments.pop();
      }
    } else if (segments.length === 1 && isSceneNumber(segments[0].text) && (segments[0].right <= left - 0.1 * IN || segments[0].x >= left + 5.0 * IN)) {
      drop(r, segments[0], 'scene number');
      segments = [];
    }
    if (!segments.length) continue;
    result.push({ ...r, segments, ...(sceneNumber ? { sceneNumber } : {}), ...(revised ? { revised } : {}) });
  }
  return { rows: result, removed, leftMargin: left };
}
