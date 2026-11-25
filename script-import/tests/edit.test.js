// Manual corrections: retype, accept and delete blocks.
import { test, assert } from './harness.js';
import { layout } from '../test-support/synthetic.js';
import { parseLayout } from '../src/parse-layout.js';
import { retypeBlock, acceptBlock, deleteBlock } from '../src/edit.js';
import { toRehearsalScript } from '../src/convert.js';
import { parseFdx } from '../src/fdx.js';

// A cue typed at the action margin: the importer can't tell it's a character, so it becomes
// action and the dialogue under it is an orphan, flagged for review.
const MISPLACED_CUE = layout([
  ['heading', 'INT. ROOM - DAY'], ['blank'],
  ['action', 'Anna waits.'], ['blank'],
  ['character', 'ANNA'], ['dialogue', 'Well?'], ['blank'],
  ['raw', 'BEN (O.S.)', { x: 1.5 }], ['dialogue', 'Coming!'], ['blank'],
  ['raw', 'a stray note', { x: 5.6 }], ['blank'],
  ['action', 'He enters.'],
]);

const find = (r, text) => r.blocks.find((b) => b.text === text);

test('setup: the misplaced cue produces blocks that need review', () => {
  const r = parseLayout(MISPLACED_CUE);
  const coming = find(r, 'Coming!');
  assert.ok(coming.review && coming.flags.includes('orphan_dialogue'), JSON.stringify(coming));
  assert.ok(find(r, 'a stray note').review);
  assert.deepStrictEqual(r.characters.map((c) => c.name), ['ANNA']);
});

test('retyping a block to character attaches the dialogue after it and updates the cast', () => {
  const r = parseLayout(MISPLACED_CUE);
  const cue = r.blocks.find((b) => b.text.startsWith('BEN'));
  const next = retypeBlock(r, cue.id, 'character');
  const ben = next.blocks.find((b) => b.id === cue.id);
  assert.deepStrictEqual([ben.type, ben.text, ben.meta.extensions, ben.confidence, ben.review], ['character', 'BEN', ['O.S.'], 1, false]);
  assert.ok(ben.flags.includes('edited'));
  const coming = find(next, 'Coming!');
  assert.strictEqual(coming.meta.character, 'BEN');
  assert.ok(!coming.flags.includes('orphan_dialogue'));
  assert.ok(!coming.review, 'the orphan no longer needs review once it has a speaker');
  assert.deepStrictEqual(next.characters.map((c) => c.name).sort(), ['ANNA', 'BEN']);
  // The original result is untouched.
  assert.strictEqual(r.blocks.find((b) => b.id === cue.id).type, cue.type);
});

test('accepting a low-confidence block clears its review state; deleting removes it', () => {
  const r = parseLayout(MISPLACED_CUE);
  const stray = find(r, 'a stray note');
  const accepted = acceptBlock(r, stray.id);
  const a = find(accepted, 'a stray note');
  assert.deepStrictEqual([a.type, a.confidence, a.review, a.flags], [stray.type, 1, false, ['edited']]);
  assert.strictEqual(accepted.stats.review, r.stats.review - 1);

  const deleted = deleteBlock(r, stray.id);
  assert.ok(!find(deleted, 'a stray note'));
  assert.strictEqual(deleted.stats.blocks, r.stats.blocks - 1);
  assert.deepStrictEqual(deleted.blocks.map((b) => b.id), deleted.blocks.map((_, i) => i + 1), 'ids are renumbered');
});

test('leaving "character" keeps the extensions in the text; retyping away a speaker orphans its dialogue', () => {
  const r = parseLayout(layout([
    ['heading', 'INT. ROOM - DAY'], ['blank'], ['character', 'BEN (V.O.)'], ['dialogue', 'Hello.'],
  ]));
  const ben = find(r, 'BEN');
  const next = retypeBlock(r, ben.id, 'action');
  assert.strictEqual(next.blocks.find((b) => b.id === ben.id).text, 'BEN (V.O.)');
  const hello = find(next, 'Hello.');
  assert.ok(hello.flags.includes('orphan_dialogue') && hello.review);
  assert.strictEqual(hello.meta.character, undefined);
  assert.deepStrictEqual(next.characters, []);
});

test('deleting a character\'s only line flags the cue; edited results still convert', () => {
  const r = parseLayout(layout([
    ['heading', 'INT. ROOM - DAY'], ['blank'], ['character', 'ANNA'], ['dialogue', 'Hi.'], ['blank'], ['character', 'BEN'], ['dialogue', 'Bye.'],
  ]));
  const next = deleteBlock(r, find(r, 'Bye.').id);
  assert.ok(find(next, 'BEN').flags.includes('no_dialogue'));
  const s = toRehearsalScript(retypeBlock(next, find(next, 'BEN').id, 'action'), { meCharacter: 'ANNA' });
  assert.deepStrictEqual(s.turns.map((t) => [t.who, t.text]), [['heading', 'INT. ROOM - DAY'], ['me', 'Hi.'], ['action', 'BEN']]);
});

test('scene headings are upper-cased; unknown types are rejected', () => {
  const r = parseLayout(layout([['heading', 'INT. ROOM - DAY'], ['blank'], ['action', 'Later that night']]));
  const next = retypeBlock(r, find(r, 'Later that night').id, 'scene_heading');
  assert.ok(find(next, 'LATER THAT NIGHT'));
  assert.throws(() => retypeBlock(r, 1, 'shot'), /Unknown block type/);
});

test('a character with nothing after it needs review in any format, until marked correct', () => {
  const xml = '<FinalDraft><Content><Paragraph Type="Scene Heading"><Text>INT. ROOM - DAY</Text></Paragraph>'
    + '<Paragraph Type="Character"><Text>ANNA</Text></Paragraph><Paragraph Type="Action"><Text>She leaves.</Text></Paragraph>'
    + '<Paragraph Type="Character"><Text>BEN</Text></Paragraph><Paragraph Type="Dialogue"><Text>Bye.</Text></Paragraph></Content></FinalDraft>';
  const r = parseFdx(xml);
  const anna = find(r, 'ANNA');
  assert.ok(anna.flags.includes('no_dialogue') && anna.review, JSON.stringify(anna));
  assert.ok(!find(r, 'BEN').review);
  const accepted = acceptBlock(r, anna.id);
  assert.ok(!find(accepted, 'ANNA').review);
  // Still fine after another, unrelated edit recomputes everything.
  assert.ok(!find(deleteBlock(accepted, find(accepted, 'Bye.').id), 'ANNA').review);
});
