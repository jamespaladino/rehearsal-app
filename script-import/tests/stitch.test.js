// Stitching dialogue (and action) across page breaks.
import { test, assert } from './harness.js';
import { layout } from '../test-support/synthetic.js';
import { parseLayout } from '../src/parse-layout.js';
import { PAGE_BREAK } from '../fixtures/scenes.js';

const types = (r) => r.blocks.map((b) => [b.type, b.text]);

test('(MORE) + "NAME (CONT\'D)" across a page break becomes one speech', () => {
  const r = parseLayout(layout(PAGE_BREAK, { pageNumbers: true }));
  assert.deepStrictEqual(types(r).slice(0, 4), [
    ['scene_heading', 'INT. CAR - NIGHT'],
    ['action', 'Rain on the windscreen. Ben drives; Anna watches the road.'],
    ['character', 'BEN'],
    ['dialogue', "I've been thinking about what you said, about the house, and the move, and all of it. And I think you're right. We should go."],
  ]);
  const merged = r.blocks[3];
  assert.ok(merged.flags.includes('stitched'));
  assert.strictEqual(merged.meta.character, 'BEN');
  // (MORE) and the repeated cue are gone.
  assert.ok(!r.blocks.some((b) => /MORE/.test(b.text)));
  assert.strictEqual(r.blocks.filter((b) => b.type === 'character' && b.text === 'BEN').length, 2); // first speech + the later "BEN (CONT'D)"
});

test('CONT\'D that is not a page break keeps its own speech, with the extension as metadata', () => {
  const r = parseLayout(layout(PAGE_BREAK));
  const last = r.blocks.slice(-2);
  assert.deepStrictEqual(last.map((b) => [b.type, b.text]), [['character', 'BEN'], ['dialogue', 'Okay?']]);
  assert.deepStrictEqual(last[0].meta.extensions, ["CONT'D"]);
  assert.ok(!last[1].flags.includes('stitched'));
});

test('an action sentence cut by a page break is joined', () => {
  const r = parseLayout(layout(PAGE_BREAK));
  const action = r.blocks.find((b) => b.text.startsWith('He nods.'));
  assert.strictEqual(action.text, 'He nods. She looks away, smiling, and the wipers keep time.');
});

test('a finished action paragraph is not joined with the next page', () => {
  const r = parseLayout(layout([
    ['heading', 'INT. ROOM - DAY'], ['blank'], ['action', 'She sits down.'],
    ['pagebreak'], ['action', 'Later, the light changes.'],
  ]));
  assert.deepStrictEqual(r.blocks.slice(1).map((b) => b.text), ['She sits down.', 'Later, the light changes.']);
});

test('a page break mid-speech without (MORE) still continues the speech', () => {
  const r = parseLayout(layout([
    ['heading', 'INT. ROOM - DAY'], ['blank'],
    ['character', 'ANNA'], ['dialogue', 'I was going to say something'], ['dialogue', 'important.'],
    ['pagebreak'], ["character", "ANNA (CONT'D)"], ['dialogue', 'But I forgot.'],
  ]));
  assert.deepStrictEqual(types(r).slice(1), [['character', 'ANNA'], ['dialogue', 'I was going to say something important. But I forgot.']]);
});

test('(MORE) and (CONT\'D) work with a parenthetical opening the continuation', () => {
  const r = parseLayout(layout([
    ['heading', 'INT. ROOM - DAY'], ['blank'],
    ['character', 'ANNA'], ['dialogue', 'First half.'], ['parenthetical', '(MORE)'],
    ['pagebreak'], ["character", "ANNA (CONT'D)"], ['parenthetical', '(sighs)'], ['dialogue', 'Second half.'],
  ]));
  assert.deepStrictEqual(types(r).slice(1), [['character', 'ANNA'], ['dialogue', 'First half.'], ['parenthetical', '(sighs)'], ['dialogue', 'Second half.']]);
  assert.ok(r.blocks[3].flags.includes('stitched'));
});
