// End to end: the synthetic fixture PDFs through pdf.js and the parser. Needs Node 20+ (pdf.js 4);
// skipped on older Node. The same logic is covered without pdf.js by the other test files.
import fs from 'fs';
import { test, assert } from './harness.js';
import { nodeSupportsPdf, loadPdfjs, MIN_NODE } from '../node-pdfjs.js';
import { importScript } from '../src/index.js';

const skip = nodeSupportsPdf() ? false : `needs Node ${MIN_NODE}+ for pdf.js (this is ${process.versions.node})`;
let pdfjs;
const load = async (name) => {
  pdfjs ||= await loadPdfjs();
  const data = new Uint8Array(fs.readFileSync(new URL(`../fixtures/synthetic/${name}`, import.meta.url)));
  return importScript({ name, data }, { pdfjs });
};
const types = (r) => r.blocks.map((b) => b.type);

test('normal-scene.pdf: all block types, nothing flagged', async () => {
  const r = await load('normal-scene.pdf');
  assert.deepStrictEqual(types(r), ['transition', 'scene_heading', 'action', 'character', 'dialogue', 'character', 'parenthetical', 'dialogue', 'action', 'character', 'dialogue', 'transition', 'scene_heading', 'action']);
  assert.strictEqual(r.stats.review, 0);
  assert.deepStrictEqual(r.blocks.filter((b) => b.type === 'scene_heading').map((b) => b.meta.sceneNumber), ['1', '2']);
}, { skip });

test('page-break.pdf: (MORE)/(CONT\'D) stitched, page numbers gone', async () => {
  const r = await load('page-break.pdf');
  const ben = r.blocks[3];
  assert.ok(ben.text.endsWith('all of it. And I think you\'re right. We should go.'), ben.text);
  assert.ok(ben.flags.includes('stitched'));
  assert.ok(!r.blocks.some((b) => /MORE|^\d+\.$/.test(b.text)));
}, { skip });

test('dual-dialogue.pdf: two flagged speeches, left then right', async () => {
  const r = await load('dual-dialogue.pdf');
  assert.deepStrictEqual(r.blocks.filter((b) => b.type === 'character').map((b) => [b.text, b.meta.dual]), [['ANNA', 'left'], ['BEN', 'right']]);
}, { skip });

test('beat.pdf and transitions.pdf', async () => {
  const beat = await load('beat.pdf');
  assert.strictEqual(beat.blocks.filter((b) => b.meta.beat).length, 2);
  const tr = await load('transitions.pdf');
  assert.deepStrictEqual(tr.blocks.filter((b) => b.type === 'transition').map((b) => b.text), ['FADE IN:', 'SMASH CUT TO:', 'DISSOLVE TO:', 'FADE OUT.']);
}, { skip });

test('title-page-shifted.pdf: title page skipped, header removed, shifted margins handled', async () => {
  const r = await load('title-page-shifted.pdf');
  assert.strictEqual(r.title, 'NIGHT DRIVE');
  assert.ok(!r.blocks.some((b) => /Blue Rev|written by/i.test(b.text)));
  assert.strictEqual(r.blocks[0].text, 'FADE IN:');
  assert.strictEqual(r.stats.review, 0, JSON.stringify(r.blocks.filter((b) => b.review)));
  assert.deepStrictEqual(r.characters.map((c) => c.name), ['ANNA', 'BEN']);
}, { skip });
