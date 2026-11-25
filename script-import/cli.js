#!/usr/bin/env node
// Debug importer: prints every block with its type and confidence.
//
//   node script-import/cli.js <file.pdf|.fountain|.fdx> [--review] [--json] [--rehearsal] [--me NAME]
//
//   --review     only blocks flagged for review
//   --json       the full ImportResult as JSON
//   --rehearsal  the converted Rehearsal script as JSON (--me picks "my character")
//
// PDFs need Node 20+ (pdf.js); Fountain and Final Draft files work on any Node.
import fs from 'fs';
import path from 'path';
import { importScript, detectFormat, toRehearsalScript, FLAGS } from './src/index.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--me');

if (!file) {
  console.error('Usage: node script-import/cli.js <file.pdf|.fountain|.fdx> [--review] [--json] [--rehearsal] [--me NAME]');
  process.exit(2);
}

const data = new Uint8Array(fs.readFileSync(file));
const format = detectFormat(file, data);
let pdfjs;
if (format === 'pdf') {
  try {
    pdfjs = await (await import('./node-pdfjs.js')).loadPdfjs();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

const result = await importScript({ name: path.basename(file), data }, { pdfjs });

if (flag('--json')) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
if (flag('--rehearsal')) {
  console.log(JSON.stringify(toRehearsalScript(result, { meCharacter: option('--me') }), null, 2));
  process.exit(0);
}

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const INDENT = { scene_heading: 0, action: 0, character: 22, parenthetical: 16, dialogue: 10, transition: 40 };

console.log(c('1', `${path.basename(file)}`) + `  ${format}${result.title ? `  "${result.title}"` : ''}${result.stats.pages ? `  ${result.stats.pages} pages` : ''}  ${result.stats.blocks} blocks  ${result.stats.review} to review`);
for (const w of result.warnings) console.log(c('33', `warning: ${w}`));
console.log(`characters: ${result.characters.map((ch) => `${ch.name} (${ch.speeches}${ch.extensions.length ? `; ${ch.extensions.join(', ')}` : ''})`).join(', ') || 'none'}`);
console.log('');
console.log(c('2', '   #  pg  type           conf  text'));

for (const b of result.blocks) {
  if (flag('--review') && !b.review) continue;
  const conf = b.confidence.toFixed(2);
  const confColour = b.confidence < 0.6 ? '31' : b.confidence < 0.85 ? '33' : '32';
  const width = Math.max(30, (process.stdout.columns || 120) - 32 - INDENT[b.type]);
  const text = b.text.replace(/\s+/g, ' ');
  const meta = [];
  if (b.meta.character && b.type !== 'character') meta.push(b.meta.character);
  if (b.meta.extensions?.length && b.type === 'character') meta.push(b.meta.extensions.join(' '));
  if (b.meta.sceneNumber) meta.push(`#${b.meta.sceneNumber}`);
  if (b.meta.dual) meta.push(`dual ${b.meta.dual}`);
  const line = [
    (b.review ? c('31', '!') : ' ') + String(b.id).padStart(3),
    String(b.page ?? '').padStart(3),
    b.type.padEnd(14),
    c(confColour, conf),
    ' '.repeat(INDENT[b.type]) + (text.length > width ? text.slice(0, width - 1) + '…' : text),
  ].join('  ');
  console.log(line);
  const notes = [...meta.map((m) => c('2', m)), ...b.flags.map((f) => c(b.review ? '31' : '36', f))];
  if (notes.length) console.log(' '.repeat(30) + notes.join(c('2', ' · ')));
}

const used = [...new Set(result.blocks.flatMap((b) => b.flags))];
if (used.length) {
  console.log('\n' + c('2', 'flags:'));
  for (const f of used) console.log(c('2', `  ${f}: ${FLAGS[f] || ''}`));
}
