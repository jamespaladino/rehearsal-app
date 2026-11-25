// Screenplay ruleset (US feature format). A ruleset turns cleaned rows into typed blocks.
// Rulesets are pluggable: parseLayout(pages, { ruleset }) accepts any object with the same shape
// ({ id, name, classify(rows, ctx) }), so a stage-play ruleset can be added beside this one.
//
// How it works:
//   1. Learn this document's indents: cluster the left edges of all single-segment rows.
//   2. Map each cluster to a role (action, dialogue, parenthetical, character, transition) from
//      its position relative to the document's left margin (standard indents are only priors)
//      and from what its lines look like (all caps, starts with "(", follows a cue, ends "TO:").
//   3. Walk the lines in order with a small state machine (are we inside a speech?), using the
//      line's role plus its text to pick a type and a confidence.
//   4. Stitch dialogue across page breaks ((MORE) + "NAME (CONT'D)"), merge wrapped lines into
//      blocks, and split dual dialogue into left/right columns.

import { PT_PER_INCH as IN, rowText } from '../layout.js';
import { clusterX } from '../cluster.js';
import { makeBlock, addFlag } from '../model.js';
import { isCueCaps, isAllCaps, isSceneHeading, splitSceneNumber, isTransitionText, isMore, isContd, parseCue, clean } from '../text.js';

// Standard indents, in inches from the left margin (action at 1.5" on the page). Priors only.
export const PRIORS = { action: 0, dialogue: 1.0, parenthetical: 1.6, character: 2.2, transition: 4.5 };
const ROLES = Object.keys(PRIORS);

export const screenplay = {
  id: 'screenplay',
  name: 'Screenplay (US format)',
  priors: PRIORS,
  classify,
};

function classify(rows, ctx) {
  const { leftMargin, lineHeight } = ctx;
  const warnings = [];

  // ---- 1. Lines (dual-dialogue regions are pulled out whole) -------------------------------
  const items = []; // { kind: 'line', line } | { kind: 'dual', rows }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.segments.length >= 2 && isDualStart(r, leftMargin)) {
      const region = [r];
      while (i + 1 < rows.length && rows[i + 1].page === r.page && rows[i + 1].y - region[region.length - 1].y <= lineHeight * 1.6) {
        region.push(rows[++i]);
      }
      items.push({ kind: 'dual', rows: region });
      continue;
    }
    const first = r.segments[0];
    const last = r.segments[r.segments.length - 1];
    items.push({
      kind: 'line',
      line: { text: clean(rowText(r)), x: first.x, right: last.right, y: r.y, page: r.page, sceneNumber: r.sceneNumber, revised: r.revised },
    });
  }
  const lines = items.filter((it) => it.kind === 'line').map((it) => it.line);

  // ---- 2. Learn indents and map them to roles -----------------------------------------------
  const rightEdge = Math.max(...lines.map((l) => l.right), leftMargin + 6 * IN);
  const { roleOf, centers, clusterConfidence } = mapRoles(lines, leftMargin, lineHeight, rightEdge);

  // ---- 3. Classify each line -----------------------------------------------------------------
  const out = []; // blocks in order
  let speech = null; // { name, extensions } while inside a speech
  let prev = null; // previous line
  let pendingMore = null; // speaker whose dialogue was cut by (MORE)
  let lastLineOfPage = null;
  let parenOpen = false;
  let stitchNext = false; // the next dialogue continues the speech from the previous page

  const startsNewParagraph = (l) => !prev || l.page !== prev.page || l.y - prev.y > lineHeight * 1.6;

  for (const it of items) {
    if (it.kind === 'dual') {
      speech = null;
      parenOpen = false;
      out.push(...dualBlocks(it.rows, leftMargin, ctx));
      prev = { page: it.rows[0].page, y: it.rows[it.rows.length - 1].y };
      continue;
    }
    const l = it.line;
    const role = roleOf(l);
    const newPage = prev && l.page !== prev.page;
    if (newPage) lastLineOfPage = prev;
    // A blank line ends a speech (screenplays never leave blank lines inside one).
    if (prev && l.page === prev.page && l.y - prev.y > lineHeight * 1.6) { speech = null; parenOpen = false; }

    // (MORE): remember the speaker; the continuation on the next page joins this speech.
    if (isMore(l.text)) {
      if (speech) pendingMore = speech.name;
      prev = l;
      continue;
    }

    const base = clusterConfidence(l);
    const text = l.text;
    const cue = parseCue(text);
    let block = null;

    // Continuation after a page break: "NAME (CONT'D)" repeating the speaker cut off by (MORE).
    if (newPage && cue && role.name === 'character') {
      const lastSpeaker = pendingMore || (lastBlockSpeaker(out));
      const contd = cue.extensions.some(isContd);
      if (lastSpeaker && cue.name === lastSpeaker && (pendingMore || contd)) {
        speech = { name: cue.name, extensions: cue.extensions };
        pendingMore = null;
        stitchNext = true;
        prev = l;
        continue;
      }
    }
    pendingMore = newPage ? null : pendingMore;

    if (isSceneHeading(text) && (isAllCaps(text) || role.name === 'action')) {
      const { text: heading, sceneNumber } = splitSceneNumber(text);
      const atAction = role.name === 'action' || Math.abs(l.x - centers.action) < 0.3 * IN;
      block = makeBlock('scene_heading', heading, atAction ? 0.97 : 0.7, { page: l.page, meta: { sceneNumber: l.sceneNumber || sceneNumber || undefined } });
      speech = null;
    } else if (isTransitionText(text) && (role.name === 'transition' || l.right >= rightEdge - 0.4 * IN || role.name === 'action')) {
      block = makeBlock('transition', text, role.name === 'action' && !/^FADE IN/.test(text) ? 0.75 : 0.95, { page: l.page });
      speech = null;
    } else if (speech && (text.startsWith('(') || parenOpen) && ['parenthetical', 'dialogue', 'character'].includes(role.name)) {
      block = makeBlock('parenthetical', text, (role.name === 'parenthetical' ? 0.95 : 0.85) * base, { page: l.page });
      parenOpen = !/\)\s*$/.test(text);
    } else if (cue && role.name === 'character' && isCueCaps(text)) {
      const next = nextLine(items, it);
      const followed = next && (next.page !== l.page || next.y - l.y <= lineHeight * 1.6) && ['dialogue', 'parenthetical'].includes(roleOf(next).name);
      block = makeBlock('character', cue.name, (followed ? 0.95 : 0.5) * base, { page: l.page, meta: { extensions: cue.extensions } });
      if (!followed) addFlag(block, 'no_dialogue');
      speech = { name: cue.name, extensions: cue.extensions };
      parenOpen = false;
    } else if (speech && (role.name === 'dialogue' || role.name === 'parenthetical')) {
      block = makeBlock('dialogue', text, 0.95 * base, { page: l.page });
    } else if (role.name === 'dialogue' && !speech && newPage && lastBlockIs(out, 'dialogue')) {
      // Dialogue continuing on a new page without (MORE)/(CONT'D): join the previous speech.
      speech = { name: lastBlockSpeaker(out), extensions: [] };
      block = makeBlock('dialogue', text, 0.7 * base, { page: l.page });
    } else if (role.name === 'action') {
      block = makeBlock('action', text, (isAllCaps(text) ? 0.85 : 0.92) * base, { page: l.page });
      speech = null;
    } else if (role.name === 'dialogue') {
      block = makeBlock('dialogue', text, 0.45, { page: l.page, flags: ['orphan_dialogue'] });
    } else if (role.name === 'parenthetical' && text.startsWith('(')) {
      block = makeBlock('parenthetical', text, 0.5, { page: l.page, flags: ['orphan_dialogue'] });
    } else {
      // Nothing fits well (e.g. centred text, an unusual indent): keep it as action, flagged.
      block = makeBlock('action', text, role.distance > 0.35 * IN ? 0.35 : 0.5, { page: l.page, flags: role.distance > 0.35 * IN ? ['unusual_indent'] : [] });
      speech = null;
    }

    block.meta.x = Math.round((l.x / IN) * 100) / 100;
    if (l.revised) block.meta.revised = true;
    if (block.meta.sceneNumber === undefined) delete block.meta.sceneNumber;

    // Merge wrapped lines into the previous block of the same kind.
    const last = out[out.length - 1];
    const sameParagraph = last && !startsNewParagraph(l) && !newPage;
    const continuesAcrossPage = last && stitchNext && last.type === 'dialogue' && block.type === 'dialogue';
    const actionAcrossPage = last && newPage && lastLineOfPage && last.type === 'action' && block.type === 'action'
      && !/[.!?:"')\]]$/.test(last.text) && /^[a-z]/.test(block.text);
    const mergeable = last && last.type === block.type && ['action', 'dialogue', 'parenthetical', 'scene_heading'].includes(block.type)
      && (block.type !== 'parenthetical' || !/\)\s*$/.test(last.text));
    if (mergeable && (sameParagraph || continuesAcrossPage || actionAcrossPage)) {
      last.text += ' ' + block.text;
      last.confidence = Math.min(last.confidence, block.confidence);
      block.flags.forEach((f) => addFlag(last, f));
      if (continuesAcrossPage) addFlag(last, 'stitched');
      if (block.meta.revised) last.meta.revised = true;
    } else {
      if (stitchNext) addFlag(block, 'stitched');
      out.push(block);
    }
    stitchNext = false;
    if (block.type !== 'dialogue' && block.type !== 'parenthetical' && block.type !== 'character') speech = null;
    prev = l;
  }

  if (pendingMore) warnings.push(`"(MORE)" for ${pendingMore} at the end of the document had no continuation.`);
  return { blocks: out, warnings };
}

// ---- Role mapping ---------------------------------------------------------------------------

function mapRoles(lines, leftMargin, lineHeight, rightEdge) {
  // Keep clusters with a few lines, and single lines that sit near a standard indent (short
  // documents may have just one parenthetical). Anything else is "unclustered".
  const nearPrior = (c) => ROLES.some((r) => Math.abs((c.center - leftMargin) / IN - PRIORS[r]) <= 0.3);
  const clusters = clusterX(lines.map((l) => ({ x: l.x, ref: l })), 6).filter((c) => c.count >= Math.max(2, lines.length * 0.01) || nearPrior(c));
  const cueLike = (l) => !!parseCue(l.text) && isCueCaps(l.text) && !isSceneHeading(l.text) && !isTransitionText(l.text);
  const index = new Map(lines.map((l, i) => [l, i]));

  const scored = clusters.map((c) => {
    const n = c.count;
    const frac = (pred) => c.members.filter(pred).length / n;
    const before = (l) => lines[index.get(l) - 1];
    const after = (l) => lines[index.get(l) + 1];
    const f = {
      caps: frac(cueLike),
      paren: frac((l) => l.text.startsWith('(')),
      heading: frac((l) => isSceneHeading(l.text)),
      trans: frac((l) => isTransitionText(l.text) || l.right >= rightEdge - 0.4 * IN),
      lower: frac((l) => /\p{Ll}/u.test(l.text)),
      // follows a cue-like line or another line of this cluster closely (inside a speech)
      followsCue: frac((l) => { const p = before(l); return p && p.page === l.page && l.y - p.y <= lineHeight * 1.6 && p.x > l.x && cueLike(p); }),
      precedesIndented: frac((l) => { const a = after(l); return a && (a.page !== l.page || a.y - l.y <= lineHeight * 1.6) && a.x < l.x && a.x > leftMargin + 0.4 * IN; }),
    };
    const dx = (c.center - leftMargin) / IN;
    const pos = (role) => -(((dx - PRIORS[role]) / 0.3) ** 2);
    const score = {
      action: pos('action') + 2 * f.heading + 1 * f.lower - 1.5 * f.followsCue,
      dialogue: pos('dialogue') + 2 * f.followsCue + 1 * f.lower - 2 * f.paren - 1 * f.caps,
      parenthetical: pos('parenthetical') + 4 * f.paren - 1 * f.caps,
      character: pos('character') + 3 * f.caps + 1.5 * f.precedesIndented - 3 * f.paren - 2 * f.lower,
      transition: pos('transition') + 4 * f.trans - 1 * f.lower,
    };
    const ranked = ROLES.map((r) => [r, score[r]]).sort((a, b) => b[1] - a[1]);
    const margin = ranked[0][1] - ranked[1][1];
    return { cluster: c, role: ranked[0][0], confidence: 1 - Math.exp(-Math.max(0, margin)), features: f };
  });

  // Each role's center: its biggest cluster, else the prior.
  const centers = {};
  for (const role of ROLES) {
    const best = scored.filter((s) => s.role === role).sort((a, b) => b.cluster.count - a.cluster.count)[0];
    centers[role] = best ? best.cluster.center : leftMargin + PRIORS[role] * IN;
  }
  const clusterOfLine = new Map();
  scored.forEach((s) => s.cluster.members.forEach((l) => clusterOfLine.set(l, s)));

  function roleOf(l) {
    const s = clusterOfLine.get(l);
    if (s) return { name: s.role, distance: Math.abs(l.x - s.cluster.center) };
    // Lines outside every cluster: nearest role center (right-aligned text counts as transition).
    if (l.right >= rightEdge - 0.4 * IN && l.x > centers.character + 0.5 * IN && isTransitionText(l.text)) return { name: 'transition', distance: 0 };
    let best = null;
    for (const role of ROLES) {
      const d = Math.abs(l.x - centers[role]);
      if (!best || d < best.distance) best = { name: role, distance: d };
    }
    return best;
  }
  const clusterConfidence = (l) => {
    const s = clusterOfLine.get(l);
    // 0.75..1 depending on how clearly the cluster maps to its role; unclustered lines get less,
    // the further they are from the nearest role's indent.
    if (s) return 0.75 + 0.25 * s.confidence;
    return roleOf(l).distance < 0.15 * IN ? 0.85 : 0.6;
  };
  return { roleOf, centers, clusterConfidence, scored };
}

// ---- Dual dialogue --------------------------------------------------------------------------

function isDualStart(row, leftMargin) {
  const cues = row.segments.filter((s) => parseCue(s.text) && isCueCaps(s.text) && !isSceneHeading(s.text) && !isTransitionText(s.text));
  return row.segments.length === 2 && cues.length === 2 && row.segments[0].x > leftMargin + 0.5 * IN;
}

function dualBlocks(rows, leftMargin, ctx) {
  const [cueL, cueR] = rows[0].segments;
  const split = (cueL.x + cueR.x) / 2;
  const cols = { left: [], right: [] };
  let corrupt = false;
  for (const r of rows.slice(1)) {
    for (const s of r.segments) {
      if (s.x < split && s.right > cueR.x + ctx.charWidth) corrupt = true;
      (s.x < split ? cols.left : cols.right).push(s);
    }
  }
  const page = rows[0].page;
  if (corrupt) {
    const raw = rows.map((r) => r.segments.map((s) => s.text).join('    ')).join(' / ');
    return [makeBlock('action', raw, 0.3, { page, flags: ['dual_dialogue_unparsed'] })];
  }
  const blocks = [];
  for (const [side, cueSeg] of [['left', cueL], ['right', cueR]]) {
    const cue = parseCue(cueSeg.text);
    blocks.push(makeBlock('character', cue.name, 0.8, { page, flags: ['dual_dialogue'], meta: { extensions: cue.extensions, dual: side } }));
    let open = false;
    for (const s of cols[side]) {
      const text = clean(s.text);
      const isParen = text.startsWith('(') || open;
      const type = isParen ? 'parenthetical' : 'dialogue';
      open = isParen && !/\)\s*$/.test(text);
      const last = blocks[blocks.length - 1];
      if (last.type === type && (type === 'dialogue' || !/\)\s*$/.test(last.text))) last.text += ' ' + text;
      else blocks.push(makeBlock(type, text, 0.8, { page, flags: ['dual_dialogue'], meta: { dual: side } }));
    }
    if (!cols[side].length) addFlag(blocks[blocks.length - 1], 'no_dialogue');
  }
  return blocks;
}

// ---- helpers --------------------------------------------------------------------------------

function nextLine(items, it) {
  const i = items.indexOf(it);
  for (let j = i + 1; j < items.length; j++) {
    if (items[j].kind === 'line' && !isMore(items[j].line.text)) return items[j].line;
    if (items[j].kind === 'dual') return null;
  }
  return null;
}

function lastBlockIs(blocks, type) {
  return blocks.length > 0 && blocks[blocks.length - 1].type === type;
}

function lastBlockSpeaker(blocks) {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === 'character') return b.text;
    if (b.type !== 'dialogue' && b.type !== 'parenthetical') return null;
  }
  return null;
}
