// The importer's block model. Every importer (PDF, Fountain, Final Draft) produces this shape;
// convert.js turns it into Rehearsal's script/turn model.
//
// ImportResult {
//   source: 'pdf' | 'fountain' | 'fdx',
//   title: string | null,
//   blocks: Block[],
//   characters: { name, speeches, extensions: string[] }[],  // most lines first
//   warnings: string[],                                       // document-level problems
//   stats: { pages?, blocks, review }
// }
//
// Block {
//   id: number,                 // position in the document
//   type: 'scene_heading' | 'action' | 'character' | 'parenthetical' | 'dialogue' | 'transition',
//   text: string,               // cleaned text; character blocks hold the bare name
//   confidence: number,         // 0..1, how sure the importer is about the type
//   review: boolean,            // confidence below REVIEW_THRESHOLD, or a flag that needs a look
//   flags: string[],            // see FLAGS
//   page: number | null,        // 1-based source page (PDF), null otherwise
//   meta: {
//     character?: string,       // dialogue / parenthetical: the speaker
//     extensions?: string[],    // character: ["V.O.", "CONT'D"] (also copied to their dialogue)
//     beat?: true,              // parenthetical that is "(beat)"
//     dual?: 'left' | 'right',  // part of dual (side-by-side) dialogue
//     sceneNumber?: string,     // scene heading: number found in the margins
//     revised?: true,           // a revision asterisk was next to it
//     x?: number,               // PDF: left edge in inches, for debugging
//     edited?: true,            // type set or confirmed by hand (see edit.js)
//   }
// }

export const BLOCK_TYPES = ['scene_heading', 'action', 'character', 'parenthetical', 'dialogue', 'transition'];

/** Blocks below this confidence are flagged for review. */
export const REVIEW_THRESHOLD = 0.6;

export const FLAGS = {
  low_confidence: 'The importer was unsure about this block type.',
  beat: 'A "(beat)" parenthetical.',
  dual_dialogue: 'Part of dual (side-by-side) dialogue; check the order and speakers.',
  dual_dialogue_unparsed: 'Looked like dual dialogue but the columns could not be separated; kept as raw text.',
  orphan_dialogue: 'Dialogue-like text with no character before it.',
  no_dialogue: 'A character cue with no dialogue after it.',
  stitched: 'Dialogue continued across a page break; (MORE) and the repeated cue were merged.',
  scanned_page: 'This page has no text layer (probably scanned); OCR is not available yet.',
  unusual_indent: 'Text at an indent that matches no block type in this document.',
  edited: 'Type set or confirmed by hand.',
};

// Flags that always mean "a person should look at this", whatever the confidence.
const REVIEW_FLAGS = new Set(['dual_dialogue_unparsed', 'orphan_dialogue', 'unusual_indent']);

export function makeBlock(type, text, confidence, extra = {}) {
  return {
    id: 0,
    type,
    text,
    confidence: round(confidence),
    review: false,
    flags: extra.flags ? [...extra.flags] : [],
    page: extra.page ?? null,
    meta: extra.meta ? { ...extra.meta } : {},
  };
}

export function addFlag(block, flag) {
  if (!block.flags.includes(flag)) block.flags.push(flag);
}

const round = (n) => Math.round(Math.max(0, Math.min(1, n)) * 100) / 100;

/**
 * Shared last step for every importer: numbers the blocks, attaches speakers and extensions to
 * dialogue, flags beats and low-confidence blocks, and builds the character list.
 */
export function finalize({ source, title = null, blocks, warnings = [], pages }) {
  let speaker = null;
  let speakerExt = [];
  for (const b of blocks) {
    b.confidence = round(b.confidence);
    if (b.type === 'character') {
      speaker = b.text;
      speakerExt = b.meta.extensions || [];
    } else if (b.type === 'dialogue' || b.type === 'parenthetical') {
      if (speaker && !b.meta.character) b.meta.character = speaker;
      if (b.type === 'dialogue' && speakerExt.length && !b.meta.extensions) b.meta.extensions = [...speakerExt];
    } else {
      speaker = null;
      speakerExt = [];
    }
    if (b.type === 'parenthetical' && /^\(\s*(?:a\s+|long\s+|short\s+|another\s+)?beat\s*\)$/i.test(b.text)) {
      b.meta.beat = true;
      addFlag(b, 'beat');
    }
    if (b.confidence < REVIEW_THRESHOLD) addFlag(b, 'low_confidence');
    b.review = b.confidence < REVIEW_THRESHOLD || b.flags.some((f) => REVIEW_FLAGS.has(f));
  }
  blocks.forEach((b, i) => { b.id = i + 1; });
  return {
    source,
    title,
    blocks,
    characters: characterList(blocks),
    warnings,
    stats: { ...(pages != null ? { pages } : {}), blocks: blocks.length, review: blocks.filter((b) => b.review).length },
  };
}

/** Unique characters, most speeches first (then first appearance), with every extension seen. */
export function characterList(blocks) {
  const byName = new Map();
  blocks.forEach((b, i) => {
    if (b.type !== 'character') return;
    const c = byName.get(b.text) || { name: b.text, speeches: 0, extensions: new Set(), first: i };
    c.speeches++;
    (b.meta.extensions || []).forEach((e) => c.extensions.add(e));
    byName.set(b.text, c);
  });
  return [...byName.values()]
    .sort((a, b) => b.speeches - a.speeches || a.first - b.first)
    .map(({ name, speeches, extensions }) => ({ name, speeches, extensions: [...extensions] }));
}

/**
 * Best guess at which character the user plays: one literally named ME or YOU (scripts written
 * for self-taping often use these), otherwise whoever has the most dialogue by word count
 * (then most speeches, then first to appear). Null when there are no characters.
 */
export function guessMyCharacter(result) {
  const names = result.characters.map((c) => c.name);
  const named = names.find((n) => n === 'ME' || n === 'YOU');
  if (named) return named;
  const words = new Map(names.map((n) => [n, 0]));
  for (const b of result.blocks) {
    if (b.type === 'dialogue' && words.has(b.meta.character)) {
      words.set(b.meta.character, words.get(b.meta.character) + b.text.split(/\s+/).filter(Boolean).length);
    }
  }
  // characters is already ordered by speeches, then first appearance; a stable sort keeps that on ties.
  return [...result.characters].sort((a, b) => words.get(b.name) - words.get(a.name))[0]?.name || null;
}
