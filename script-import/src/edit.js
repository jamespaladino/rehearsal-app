// Manual corrections to an ImportResult: change a block's type, mark it correct, or delete it.
// Each returns a NEW result (the input is not changed), with everything that depends on the
// blocks recomputed: speakers on dialogue, beats, the character list, review flags and counts.
// Edited blocks get confidence 1, lose their review flags and gain the 'edited' flag.

import { BLOCK_TYPES, finalize, addFlag } from './model.js';
import { parseCue } from './text.js';

// Flags that describe the block rather than a doubt about it; they survive an edit.
const KEEP_ON_EDIT = new Set(['beat', 'dual_dialogue', 'stitched']);

export function retypeBlock(result, id, type) {
  if (!BLOCK_TYPES.includes(type)) throw new Error(`Unknown block type: ${type}`);
  return edit(result, id, (b) => {
    const was = b.type;
    // Leaving "character": put the extensions back into the text so nothing is lost.
    if (was === 'character' && type !== 'character' && b.meta.extensions?.length) {
      b.text = `${b.text} ${b.meta.extensions.map((e) => `(${e})`).join(' ')}`;
    }
    if (type === 'character') {
      const cue = parseCue(b.text);
      b.text = cue ? cue.name : b.text.toUpperCase().trim();
      b.meta.extensions = cue ? cue.extensions : [];
    } else {
      delete b.meta.extensions;
    }
    if (type === 'scene_heading') b.text = b.text.toUpperCase();
    if (type !== 'parenthetical') delete b.meta.beat;
    b.type = type;
    markEdited(b);
  });
}

/** Marks a block's current type as correct. */
export function acceptBlock(result, id) {
  return edit(result, id, markEdited);
}

export function deleteBlock(result, id) {
  const next = clone(result);
  next.blocks = next.blocks.filter((b) => b.id !== id);
  return refinalize(next);
}

function edit(result, id, fn) {
  const next = clone(result);
  const block = next.blocks.find((b) => b.id === id);
  if (!block) throw new Error(`No block with id ${id}`);
  fn(block);
  return refinalize(next);
}

function markEdited(b) {
  b.confidence = 1;
  b.flags = b.flags.filter((f) => KEEP_ON_EDIT.has(f));
  addFlag(b, 'edited');
  b.meta.edited = true;
}

/** Recomputes speakers, orphan / no-dialogue flags, beats, characters and review state. */
function refinalize(result) {
  const { blocks } = result;
  let speaker = null;
  blocks.forEach((b, i) => {
    if (b.type === 'dialogue' || b.type === 'parenthetical') {
      delete b.meta.character;
      if (b.type === 'dialogue') delete b.meta.extensions;
      if (b.type === 'parenthetical' && b.meta.beat) { delete b.meta.beat; b.flags = b.flags.filter((f) => f !== 'beat'); }
      if (speaker) {
        // Having no speaker was the only doubt about an orphan; now it has one.
        if (b.flags.includes('orphan_dialogue')) b.confidence = Math.max(b.confidence, 0.9);
        b.flags = b.flags.filter((f) => f !== 'orphan_dialogue');
      } else if (!b.meta.edited) addFlag(b, 'orphan_dialogue');
    } else if (b.type === 'character') {
      speaker = b.text;
      const next = blocks[i + 1];
      const followed = next && (next.type === 'dialogue' || next.type === 'parenthetical');
      if (followed) {
        if (b.flags.includes('no_dialogue')) b.confidence = Math.max(b.confidence, 0.9);
        b.flags = b.flags.filter((f) => f !== 'no_dialogue');
      } else if (!b.meta.edited) addFlag(b, 'no_dialogue');
      return;
    } else {
      speaker = null;
    }
    if (b.type !== 'dialogue' && b.type !== 'parenthetical') b.flags = b.flags.filter((f) => f !== 'orphan_dialogue');
    if (b.type !== 'character') b.flags = b.flags.filter((f) => f !== 'no_dialogue');
  });
  // finalize() re-adds 'low_confidence' where it still applies, so start from a clean slate.
  blocks.forEach((b) => { b.flags = b.flags.filter((f) => f !== 'low_confidence'); });
  const out = finalize({ source: result.source, title: result.title, blocks, warnings: result.warnings, pages: result.stats.pages });
  if (result.debug) out.debug = result.debug;
  out.edits = (result.edits || 0) + 1;
  return out;
}

// Results are plain JSON (works on Node 16, which has no structuredClone).
const clone = (x) => JSON.parse(JSON.stringify(x));
