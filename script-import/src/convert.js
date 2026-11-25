// ImportResult -> Rehearsal's script model (the shape js/app.js stores in IndexedDB):
//
//   { id, title, meCharacter, otherCharacters, turns: Turn[] }
//   Turn: { who: 'heading' | 'action', text }
//       | { who: 'me' | 'them', character, text, audio: null }
//       | { who: 'beat', duration }
//
// Mapping:
//   scene_heading -> heading;  action -> action;  transition -> action (Rehearsal has no transition type)
//   character + its dialogue/parentheticals -> one 'me' or 'them' turn (me = the chosen character)
//     - a (beat) between two parts of a speech -> the inline "(beat)" pause marker Rehearsal already uses
//     - a (beat) before the first or after the last part -> a separate 2-second beat turn
//     - other parentheticals -> turn.parentheticals (shown nowhere yet, never spoken)
//     - extensions (V.O., O.S., CONT'D) -> turn.extensions
//   dual dialogue -> the two speeches in order (left, then right)
//   dialogue with no character -> action, so nothing is lost

import { guessMyCharacter } from './model.js';

export function toRehearsalScript(result, { title, meCharacter, id } = {}) {
  const me = (meCharacter || guessMyCharacter(result) || 'ME').toUpperCase();
  const turns = [];
  let speech = null; // { turn, parts: [], pendingBeat: false, leadingBeat: false }

  const flush = () => {
    if (!speech) return;
    const { turn, parts } = speech;
    if (parts.length) {
      if (speech.leadingBeat) turns.push({ who: 'beat', duration: 2 });
      turn.text = parts.join(' ');
      turns.push(turn);
      if (speech.pendingBeat) turns.push({ who: 'beat', duration: 2 });
    }
    speech = null;
  };

  for (const b of result.blocks) {
    if (b.type === 'character') {
      flush();
      const who = b.text === me ? 'me' : 'them';
      const turn = { who, character: b.text, text: '', audio: null };
      if (b.meta.extensions?.length) turn.extensions = [...b.meta.extensions];
      speech = { turn, parts: [], pendingBeat: false, leadingBeat: false };
      continue;
    }
    if (speech && b.type === 'dialogue') {
      if (speech.pendingBeat) {
        speech.parts.push('(beat)');
        speech.pendingBeat = false;
      }
      speech.parts.push(b.text);
      continue;
    }
    if (speech && b.type === 'parenthetical') {
      if (b.meta.beat) {
        if (speech.parts.length) speech.pendingBeat = true; else speech.leadingBeat = true;
      } else {
        (speech.turn.parentheticals ||= []).push(b.text);
      }
      continue;
    }
    flush();
    if (b.type === 'scene_heading') turns.push({ who: 'heading', text: b.text });
    else if (b.type === 'action' || b.type === 'transition') turns.push({ who: 'action', text: b.text });
    else if (b.type === 'dialogue' || b.type === 'parenthetical') turns.push({ who: 'action', text: b.text });
  }
  flush();

  const others = [...new Set(turns.filter((t) => t.who === 'them').map((t) => t.character))];
  return {
    id: id || (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `import-${Date.now()}`),
    title: title || result.title || 'Imported script',
    meCharacter: me,
    otherCharacters: others,
    turns: turns.length ? turns : [{ who: 'heading', text: '' }],
    imported: { source: result.source, at: new Date().toISOString(), blocks: result.stats.blocks, review: result.stats.review },
  };
}
