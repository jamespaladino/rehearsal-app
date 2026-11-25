// Page furniture removal: page numbers, running headers, scene numbers, revision asterisks.
import { test, assert } from './harness.js';
import { layout } from '../test-support/synthetic.js';
import { parseLayout } from '../src/parse-layout.js';
import { NORMAL_SCENE, PAGE_BREAK } from '../fixtures/scenes.js';

const allText = (r) => r.blocks.map((b) => b.text).join(' | ');

test('scene numbers in both margins are removed and kept on the heading', () => {
  const r = parseLayout(layout(NORMAL_SCENE));
  const headings = r.blocks.filter((b) => b.type === 'scene_heading');
  assert.deepStrictEqual(headings.map((h) => [h.text, h.meta.sceneNumber]), [['INT. KITCHEN - DAY', '1'], ['EXT. GARDEN - NIGHT', '2']]);
  assert.ok(!/\b[12]\b/.test(headings.map((h) => h.text).join(' ')));
});

test('revision asterisks are removed and the block is marked revised', () => {
  const r = parseLayout(layout(NORMAL_SCENE));
  const line = r.blocks.find((b) => b.text === "Then why didn't you?");
  assert.strictEqual(line.meta.revised, true);
  assert.ok(!allText(r).includes('*'));
});

test('page numbers are removed', () => {
  const r = parseLayout(layout(PAGE_BREAK, { pageNumbers: true }));
  assert.ok(!/(^|\| )\d+\.( \||$)/.test(allText(r)), allText(r));
  assert.ok(r.debug.removed.some((x) => x.reason === 'page number' && x.text === '2.'));
});

test('a running header repeated on every page is removed', () => {
  const pages = layout([
    ...PAGE_BREAK, ['pagebreak'], ['action', 'The end of the drive.'],
  ], { header: 'NIGHT DRIVE - Blue Rev. 10/12/24', pageNumbers: true });
  const r = parseLayout(pages);
  assert.ok(!allText(r).includes('Blue Rev'), allText(r));
  assert.ok(r.debug.removed.some((x) => x.reason === 'running header'));
});

test('(CONTINUED) and CONTINUED: markers are removed', () => {
  const r = parseLayout(layout([
    ['heading', 'INT. HALL - DAY'], ['blank'], ['action', 'Anna waits.'], ['blank'], ['transition', '(CONTINUED)'],
    ['pagebreak'], ['action', 'CONTINUED:'], ['blank'], ['action', 'Still waiting.'],
  ]));
  assert.ok(!/CONTINUED/.test(allText(r)), allText(r));
});
