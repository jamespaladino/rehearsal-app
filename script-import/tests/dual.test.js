// Dual (side-by-side) dialogue.
import { test, assert } from './harness.js';
import { layout } from '../test-support/synthetic.js';
import { parseLayout } from '../src/parse-layout.js';
import { DUAL_DIALOGUE } from '../fixtures/scenes.js';

test('dual dialogue is split into left then right speeches, flagged', () => {
  const r = parseLayout(layout(DUAL_DIALOGUE));
  const dual = r.blocks.filter((b) => b.meta.dual);
  assert.deepStrictEqual(dual.map((b) => [b.meta.dual, b.type, b.text]), [
    ['left', 'character', 'ANNA'],
    ['left', 'dialogue', 'I told you we should have left earlier.'],
    ['right', 'character', 'BEN'],
    ['right', 'dialogue', 'You never said anything about'],
    ['right', 'parenthetical', '(shouting)'],
    ['right', 'dialogue', 'leaving!'],
  ]);
  assert.ok(dual.every((b) => b.flags.includes('dual_dialogue')));
  // Text around it is untouched.
  assert.strictEqual(r.blocks[r.blocks.length - 1].text, 'Silence.');
  assert.strictEqual(r.blocks.find((b) => b.text === 'BEN').meta.character, undefined);
  assert.strictEqual(r.blocks.find((b) => b.text === 'leaving!').meta.character, 'BEN');
});

test('columns that run together are not corrupted: kept as raw text and flagged for review', () => {
  // The left column runs into the right one, so the columns can't be told apart.
  const pages = layout([
    ['heading', 'INT. KITCHEN - DAY'], ['blank'],
    ['dual', ['ANNA', 'BEN']],
    ['raw', 'I told you we should have left much earlier than this you never said', { x: 1.5 }],
    ['blank'], ['action', 'Silence.'],
  ]);
  const r = parseLayout(pages);
  const raw = r.blocks.find((b) => b.flags.includes('dual_dialogue_unparsed'));
  assert.ok(raw, JSON.stringify(r.blocks.map((b) => [b.type, b.text])));
  assert.ok(raw.review);
  assert.ok(raw.text.includes('ANNA') && raw.text.includes('BEN') && raw.text.includes('much earlier'));
  assert.strictEqual(r.blocks[r.blocks.length - 1].text, 'Silence.');
});
