// A tiny test harness (no dependencies; works on Node 16, which has no node:test).
//   import { test, assert } from './harness.js';
//   test('name', () => { assert.equal(1, 1); });
// tests/run.js imports every *.test.js file and runs the collected tests.

import assert from 'assert';

export { assert };
export const tests = [];

export function test(name, fn, { skip = false } = {}) {
  tests.push({ name, fn, skip, file: currentFile });
}

let currentFile = '';
export function setFile(f) { currentFile = f; }
