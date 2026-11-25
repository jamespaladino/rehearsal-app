// Fountain and Final Draft importers produce the same block model as the PDF importer.
import fs from 'fs';
import { test, assert } from './harness.js';
import { parseFountain } from '../src/fountain.js';
import { parseFdx } from '../src/fdx.js';
import { detectFormat, importScript } from '../src/index.js';

const fixture = (name) => fs.readFileSync(new URL(`../fixtures/synthetic/${name}`, import.meta.url), 'utf8');
const types = (r) => r.blocks.map((b) => [b.type, b.text]);

test('Fountain: title page, every block type, notes and boneyard removed', () => {
  const r = parseFountain(fixture('night-drive.fountain'));
  assert.strictEqual(r.title, 'Night Drive');
  assert.deepStrictEqual(types(r), [
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
    ['parenthetical', '(beat)'],
    ['dialogue', 'Never mind.'],
    ['character', 'BEN'],
    ['dialogue', 'I really meant it.'],
    ['action', 'They both start talking at once.'],
    ['character', 'ANNA'],
    ['dialogue', 'I told you we should have left earlier.'],
    ['character', 'BEN'],
    ['parenthetical', '(shouting)'],
    ['dialogue', 'You never said anything about leaving!'],
    ['transition', 'SMASH CUT TO:'],
    ['scene_heading', 'FLASHBACK - THE BEACH'],
    ['action', 'SILENCE. Waves.'],
    ['action', 'THE END'],
    ['transition', 'FADE OUT.'],
  ]);
  assert.strictEqual(r.blocks[1].meta.sceneNumber, '1');
  assert.deepStrictEqual(r.blocks[5].meta.extensions, ['O.S.']);
  assert.ok(r.blocks[11].meta.beat);
  const dual = r.blocks.filter((b) => b.meta.dual).map((b) => [b.meta.dual, b.type]);
  assert.deepStrictEqual(dual, [['left', 'character'], ['left', 'dialogue'], ['right', 'character'], ['right', 'parenthetical'], ['right', 'dialogue']]);
  assert.deepStrictEqual(r.characters.map((c) => c.name), ['ANNA', 'BEN']);
});

test('Final Draft: paragraph types, dual dialogue, scene numbers, entities and title page', () => {
  const r = parseFdx(fixture('night-drive.fdx'));
  assert.strictEqual(r.title, 'NIGHT DRIVE');
  assert.deepStrictEqual(types(r).slice(0, 4), [
    ['transition', 'FADE IN:'],
    ['scene_heading', 'INT. KITCHEN - DAY'],
    ['action', 'Anna stands at the sink, washing a cup that is already clean.'],
    ['character', 'ANNA'],
  ]);
  assert.strictEqual(r.blocks[1].meta.sceneNumber, '1');
  assert.ok(r.blocks.find((b) => b.text === "Then why didn't you?"));
  assert.ok(r.blocks.find((b) => b.text === '(beat)').meta.beat);
  assert.ok(r.blocks.find((b) => b.text === 'It barks & runs off.'));
  const dual = r.blocks.filter((b) => b.meta.dual).map((b) => [b.meta.dual, b.type, b.text]);
  assert.deepStrictEqual(dual.map((d) => d.slice(0, 2)), [['left', 'character'], ['left', 'dialogue'], ['right', 'character'], ['right', 'parenthetical'], ['right', 'dialogue']]);
  assert.ok(r.blocks.every((b) => !b.review));
  assert.ok(!r.blocks.some((b) => b.text === 'NIGHT DRIVE'), 'title page text stays out of the script');
});

test('format detection and importScript dispatch', async () => {
  assert.strictEqual(detectFormat('a.pdf', new Uint8Array([37, 80, 68, 70, 45, 49])), 'pdf');
  assert.strictEqual(detectFormat('a.fdx', new TextEncoder().encode('<?xml?>')), 'fdx');
  assert.strictEqual(detectFormat('a.txt', new TextEncoder().encode('<?xml version="1.0"?><FinalDraft>')), 'fdx');
  assert.strictEqual(detectFormat('a.fountain', new TextEncoder().encode('INT. A - DAY')), 'fountain');
  const r = await importScript({ name: 'x.fountain', text: 'INT. ROOM - DAY\n\nANNA\nHi.\n' });
  assert.deepStrictEqual(types(r), [['scene_heading', 'INT. ROOM - DAY'], ['character', 'ANNA'], ['dialogue', 'Hi.']]);
  await assert.rejects(() => importScript({ name: 'x.pdf', data: new Uint8Array([37, 80, 68, 70, 45]) }), /pdf\.js/);
});
