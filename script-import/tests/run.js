#!/usr/bin/env node
// Runs every tests/*.test.js file.  Usage: node script-import/tests/run.js [filter]
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { tests, setFile } from './harness.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || '';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

for (const f of files) {
  setFile(f);
  await import(pathToFileURL(path.join(dir, f)).href);
}

let passed = 0;
let failed = 0;
let skipped = 0;
let lastFile = '';
for (const t of tests) {
  if (filter && !`${t.file} ${t.name}`.includes(filter)) continue;
  if (t.file !== lastFile) { console.log(`\n${t.file}`); lastFile = t.file; }
  const skip = typeof t.skip === 'function' ? await t.skip() : t.skip;
  if (skip) { skipped++; console.log(`  - ${t.name} (skipped: ${typeof skip === 'string' ? skip : 'skip'})`); continue; }
  try {
    await t.fn();
    passed++;
    console.log(`  ✓ ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${t.name}\n    ${String(e && e.stack || e).split('\n').slice(0, 6).join('\n    ')}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed ? 1 : 0);
