// Fountain (https://fountain.io/syntax) -> ImportResult, same block model as the PDF importer.
// Covers: title page, scene headings (incl. forced "." and #scene numbers#), characters (incl.
// forced "@", extensions, dual "^"), parentheticals, dialogue, transitions (incl. forced ">"),
// centred text, forced action "!", boneyard /* */, notes [[ ]], sections, synopses, page breaks,
// emphasis markers and lyrics.

import { makeBlock, finalize } from './model.js';
import { isSceneHeading, parseCue, isCueCaps, isTransitionText } from './text.js';

export function parseFountain(source) {
  let text = source.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  text = text.replace(/\/\*[\s\S]*?\*\//g, ''); // boneyard
  text = text.replace(/\[\[[\s\S]*?\]\]/g, ''); // notes
  let lines = text.split('\n');

  // Title page: "Key: value" lines (values may continue on indented lines) up to the first blank line.
  let title = null;
  if (/^\s*[A-Za-z][A-Za-z ]*:/.test(lines[0] || '')) {
    let i = 0;
    let key = null;
    while (i < lines.length && lines[i].trim() !== '') {
      const m = lines[i].match(/^([A-Za-z][A-Za-z ]*):\s*(.*)$/);
      if (m) {
        key = m[1].toLowerCase();
        if (key === 'title' && m[2].trim()) title = strip(m[2].trim());
      } else if (key === 'title' && !title) {
        title = strip(lines[i].trim());
      }
      i++;
    }
    lines = lines.slice(i);
  }

  const blocks = [];
  const blankAt = (i) => i < 0 || i >= lines.length || lines[i].trim() === '';
  let speech = null; // { name } while inside dialogue
  let last = null;
  const push = (b) => { blocks.push(b); last = b; };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      // A line of two or more spaces inside dialogue is a deliberate blank line in the speech.
      if (speech && raw.length >= 2 && last && last.type === 'dialogue') last.text += '\n';
      else { speech = null; last = null; }
      continue;
    }
    if (/^={3,}$/.test(line) || /^#/.test(line) || /^=(?!=)/.test(line)) { last = null; continue; } // page break, section, synopsis

    if (speech) {
      if (line.startsWith('(') && line.endsWith(')')) { push(makeBlock('parenthetical', strip(line), 0.98)); continue; }
      const t = strip(line.replace(/^~\s*/, ''));
      if (last && last.type === 'dialogue') last.text += '\n' + t;
      else push(makeBlock('dialogue', t, 0.98));
      continue;
    }

    // Forced elements.
    if (/^\.[A-Za-z0-9]/.test(line) && !line.startsWith('..')) { pushHeading(line.slice(1)); continue; }
    if (line.startsWith('!')) { pushAction(line.slice(1), 1); continue; }
    if (line.startsWith('>') && line.endsWith('<')) { push(makeBlock('action', strip(line.slice(1, -1).trim()), 1, { meta: { centered: true } })); continue; }
    if (line.startsWith('>')) { push(makeBlock('transition', strip(line.slice(1).trim()), 1)); continue; }
    if (line.startsWith('@')) { startSpeech(line.slice(1), 1); continue; }

    if (blankAt(i - 1) && isSceneHeading(line) && /^(?:INT|EXT|EST|I\/E|INT\.\/EXT|INT\/EXT)[.\s]/i.test(line)) { pushHeading(line); continue; }
    // Transitions: Fountain only auto-detects "...TO:"; FADE IN:/FADE OUT. are accepted too, like the PDF importer.
    if (blankAt(i - 1) && blankAt(i + 1) && isTransitionText(line)) { push(makeBlock('transition', strip(line), 0.95)); continue; }
    // Character: all caps (extensions may be lowercase), blank line before, text right after.
    if (blankAt(i - 1) && !blankAt(i + 1) && isCueCaps(line.replace(/\^$/, '')) && parseCue(line) && /\p{L}/u.test(line)) {
      startSpeech(line, 0.95);
      continue;
    }
    pushAction(line, 0.95, !blankAt(i - 1));
  }

  function pushHeading(t) {
    let heading = t.trim();
    let sceneNumber;
    const m = heading.match(/\s*#([^#]+)#\s*$/);
    if (m) { sceneNumber = m[1].trim(); heading = heading.slice(0, m.index); }
    push(makeBlock('scene_heading', strip(heading).toUpperCase(), 0.98, { meta: sceneNumber ? { sceneNumber } : {} }));
  }
  function pushAction(t, confidence, joinPrevious = false) {
    const s = strip(t);
    if (joinPrevious && last && last.type === 'action') last.text += '\n' + s;
    else push(makeBlock('action', s, confidence));
  }
  function startSpeech(t, confidence) {
    const cue = parseCue(t) || { name: t.replace(/\^$/, '').trim().toUpperCase(), extensions: [], dual: /\^$/.test(t) };
    const meta = { extensions: cue.extensions };
    if (cue.dual) {
      // "^" marks the second speaker of a dual pair; the previous speech is the left side.
      meta.dual = 'right';
      for (let j = blocks.length - 1; j >= 0 && ['dialogue', 'parenthetical', 'character'].includes(blocks[j].type); j--) {
        blocks[j].meta.dual = 'left';
        if (!blocks[j].flags.includes('dual_dialogue')) blocks[j].flags.push('dual_dialogue');
        if (blocks[j].type === 'character') break;
      }
    }
    push(makeBlock('character', cue.name, confidence, { meta, flags: cue.dual ? ['dual_dialogue'] : [] }));
    speech = { name: cue.name, dual: cue.dual };
  }

  // Dialogue in a dual speech carries the flag too.
  let side = null;
  for (const b of blocks) {
    if (b.type === 'character') side = b.meta.dual || null;
    else if (b.type !== 'dialogue' && b.type !== 'parenthetical') side = null;
    if (side && !b.meta.dual) { b.meta.dual = side; b.flags.push('dual_dialogue'); }
  }
  return finalize({ source: 'fountain', title, blocks });
}

/** Removes Fountain emphasis markers (*italic*, **bold**, _underline_) and escapes. */
function strip(t) {
  return t
    .replace(/(\*{1,3}|_)(?=\S)([^*_\n]+?)(?<=\S)\1/g, '$2')
    .replace(/\\([*_\\])/g, '$1')
    .trim();
}
