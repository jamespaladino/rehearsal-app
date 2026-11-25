// Classifier tests on synthetic layouts (no PDF library needed).
import { test, assert } from './harness.js';
import { layout } from '../test-support/synthetic.js';
import { parseLayout } from '../src/parse-layout.js';
import { NORMAL_SCENE } from '../fixtures/scenes.js';

const types = (r) => r.blocks.map((b) => [b.type, b.text]);

const EXPECTED_NORMAL = [
  ['transition', 'FADE IN:'],
  ['scene_heading', 'INT. KITCHEN - DAY'],
  ['action', 'Anna stands at the sink, washing a cup that is already clean.'],
  ['character', 'ANNA'],
  ['dialogue', 'You said you would call.'],
  ['character', 'BEN'],
  ['parenthetical', '(from the hall)'],
  ['dialogue', 'I know. I know I did, and I meant it.'],
  ['action', 'He appears in the doorway, keys in hand.'],
  ['character', 'ANNA'],
  ['dialogue', "Then why didn't you?"],
  ['transition', 'CUT TO:'],
  ['scene_heading', 'EXT. GARDEN - NIGHT'],
  ['action', 'Quiet. A dog barks somewhere.'],
];

test('normal scene: every block type, high confidence, nothing to review', () => {
  const r = parseLayout(layout(NORMAL_SCENE));
  assert.deepStrictEqual(types(r), EXPECTED_NORMAL);
  assert.strictEqual(r.stats.review, 0);
  assert.ok(r.blocks.every((b) => b.confidence >= 0.85), JSON.stringify(r.blocks.map((b) => b.confidence)));
});

test('dialogue is attached to its character, and extensions become metadata', () => {
  const r = parseLayout(layout(NORMAL_SCENE));
  const ben = r.blocks.find((b) => b.type === 'character' && b.text === 'BEN');
  assert.deepStrictEqual(ben.meta.extensions, ['O.S.']);
  const benLine = r.blocks.find((b) => b.type === 'dialogue' && b.meta.character === 'BEN');
  assert.strictEqual(benLine.text, 'I know. I know I did, and I meant it.');
  assert.deepStrictEqual(benLine.meta.extensions, ['O.S.']);
  assert.deepStrictEqual(r.characters.map((c) => [c.name, c.speeches]), [['ANNA', 2], ['BEN', 1]]);
});

test('indents are learned, not hard-coded: shifted margins still classify the same', () => {
  for (const shift of [-0.5, 0.4, 0.9]) {
    const r = parseLayout(layout(NORMAL_SCENE, { shift }));
    assert.deepStrictEqual(types(r), EXPECTED_NORMAL, `shift ${shift}`);
  }
});

test('non-standard indents (other software) still classify the same', () => {
  const indents = { action: 1.25, heading: 1.25, dialogue: 2.25, parenthetical: 2.75, character: 3.5 };
  const r = parseLayout(layout(NORMAL_SCENE, { indents }));
  assert.deepStrictEqual(types(r), EXPECTED_NORMAL);
});

test('indents written as leading spaces inside one text run', () => {
  const r = parseLayout(layout(NORMAL_SCENE, { leadingSpaces: true }));
  assert.deepStrictEqual(types(r), EXPECTED_NORMAL);
});

test('a (beat) parenthetical is flagged as a beat', () => {
  const r = parseLayout(layout([
    ['heading', 'INT. ROOM - DAY'], ['blank'],
    ['character', 'ANNA'], ['dialogue', 'Testing, testing.'], ['parenthetical', '(beat)'], ['dialogue', 'One, two, three.'], ['blank'],
    ['character', 'BEN'], ['parenthetical', '(quietly)'], ['dialogue', 'Stop.'],
  ]));
  const beat = r.blocks.find((b) => b.text === '(beat)');
  assert.strictEqual(beat.type, 'parenthetical');
  assert.strictEqual(beat.meta.beat, true);
  assert.ok(beat.flags.includes('beat'));
  assert.strictEqual(beat.meta.character, 'ANNA');
  const quietly = r.blocks.find((b) => b.text === '(quietly)');
  assert.ok(!quietly.meta.beat);
  assert.deepStrictEqual(types(r).slice(1, 5), [['character', 'ANNA'], ['dialogue', 'Testing, testing.'], ['parenthetical', '(beat)'], ['dialogue', 'One, two, three.']]);
});

test('multi-line parentheticals join into one block', () => {
  const r = parseLayout(layout([
    ['heading', 'INT. ROOM - DAY'], ['blank'],
    ['character', 'ANNA'], ['parenthetical', '(looking out of the'], ['parenthetical', 'window)'], ['dialogue', 'Rain again.'],
  ]));
  assert.deepStrictEqual(types(r).slice(1), [['character', 'ANNA'], ['parenthetical', '(looking out of the window)'], ['dialogue', 'Rain again.']]);
});

test('transitions: right-aligned "TO:" lines and FADE IN at the left margin', () => {
  const r = parseLayout(layout([
    ['transition', 'FADE IN:'], ['blank'], ['heading', 'INT. ROOM - DAY'], ['blank'], ['action', 'Nothing happens.'], ['blank'],
    ['transition', 'SMASH CUT TO:'], ['blank'], ['heading', 'EXT. ROAD - DAY'], ['blank'], ['action', 'Still nothing.'], ['blank'],
    ['action', 'FADE IN:'], ['blank'], ['action', 'More nothing.'], ['blank'], ['transition', 'FADE OUT.'],
  ]));
  const t = r.blocks.filter((b) => b.type === 'transition').map((b) => b.text);
  assert.deepStrictEqual(t, ['FADE IN:', 'SMASH CUT TO:', 'FADE IN:', 'FADE OUT.']);
});

test('all-caps action is still action, and a cue without dialogue is flagged', () => {
  const r = parseLayout(layout([
    ['heading', 'INT. ROOM - DAY'], ['blank'],
    ['action', 'BANG! The door flies open.'], ['blank'],
    ['character', 'ANNA'], ['dialogue', 'Who is it?'], ['blank'],
    ['character', 'BEN'], ['blank'],
    ['action', 'Silence.'],
  ]));
  assert.strictEqual(r.blocks[1].type, 'action');
  const ben = r.blocks.find((b) => b.text === 'BEN');
  assert.strictEqual(ben.type, 'character');
  assert.ok(ben.flags.includes('no_dialogue') && ben.review);
});

test('text at an indent matching no block type is kept as action and flagged for review', () => {
  const r = parseLayout(layout([
    ['heading', 'INT. ROOM - DAY'], ['blank'], ['action', 'Anna waits.'], ['blank'],
    ['character', 'ANNA'], ['dialogue', 'Well?'], ['blank'],
    ['raw', 'a stray note', { x: 5.6 }], ['blank'],
    ['action', 'Nothing.'],
  ]));
  const stray = r.blocks.find((b) => b.text === 'a stray note');
  assert.strictEqual(stray.type, 'action');
  assert.ok(stray.review, JSON.stringify(stray));
});

test('every block has a confidence between 0 and 1', () => {
  const r = parseLayout(layout(NORMAL_SCENE));
  for (const b of r.blocks) assert.ok(b.confidence >= 0 && b.confidence <= 1);
});
