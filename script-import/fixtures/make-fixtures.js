#!/usr/bin/env node
// Writes the synthetic scenes in fixtures/scenes.js as small PDFs in fixtures/synthetic/.
// Usage: node script-import/fixtures/make-fixtures.js
import fs from 'fs';
import { layout, makePdf } from '../test-support/synthetic.js';
import { NORMAL_SCENE, PAGE_BREAK, DUAL_DIALOGUE, BEAT, TRANSITIONS } from './scenes.js';

const out = new URL('./synthetic/', import.meta.url);
fs.mkdirSync(out, { recursive: true });

const titlePage = (title) => [
  ['blank'], ['blank'], ['blank'], ['blank'], ['blank'], ['blank'], ['blank'], ['blank'], ['blank'], ['blank'],
  ['centered', title], ['blank'], ['centered', 'written by'], ['blank'], ['centered', 'Rehearsal Fixtures'],
  ['pagebreak'],
];

const fixtures = {
  'normal-scene.pdf': { rows: NORMAL_SCENE, options: {} },
  'page-break.pdf': { rows: PAGE_BREAK, options: { pageNumbers: true } },
  'dual-dialogue.pdf': { rows: DUAL_DIALOGUE, options: {} },
  'beat.pdf': { rows: BEAT, options: {} },
  'transitions.pdf': { rows: TRANSITIONS, options: {} },
  // Title page, running header, page numbers and margins shifted by 0.25".
  'title-page-shifted.pdf': {
    rows: [...titlePage('NIGHT DRIVE'), ...NORMAL_SCENE, ['pagebreak'], ...PAGE_BREAK],
    options: { pageNumbers: true, header: 'NIGHT DRIVE - Blue Rev.', shift: 0.25 },
  },
};

for (const [name, { rows, options }] of Object.entries(fixtures)) {
  const bytes = makePdf(layout(rows, options), { title: name.replace(/\.pdf$/, '') });
  fs.writeFileSync(new URL(name, out), bytes);
  console.log(`wrote fixtures/synthetic/${name} (${bytes.length} bytes)`);
}
