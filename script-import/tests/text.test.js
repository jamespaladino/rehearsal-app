import { test, assert } from './harness.js';
import { parseCue, isSceneHeading, splitSceneNumber, isTransitionText, isBeat, isMore, isContd, isPageNumber, isSceneNumber, isAllCaps } from '../src/text.js';

test('parseCue strips extensions into metadata', () => {
  assert.deepStrictEqual(parseCue("ANNA (V.O.) (CONT'D)"), { name: 'ANNA', extensions: ['V.O.', "CONT'D"], dual: false });
  assert.deepStrictEqual(parseCue('DR. SMITH (O.S.)'), { name: 'DR. SMITH', extensions: ['O.S.'], dual: false });
  assert.deepStrictEqual(parseCue('ANNA (cont’d)'), { name: 'ANNA', extensions: ["CONT'D"], dual: false });
  assert.deepStrictEqual(parseCue('BEN ^'), { name: 'BEN', extensions: [], dual: true });
});

test('parseCue rejects non-cues', () => {
  assert.strictEqual(parseCue('Anna'), null);
  assert.strictEqual(parseCue('(beat)'), null);
  assert.strictEqual(parseCue('THIS IS A VERY LONG LINE OF SHOUTED CAPITAL ACTION TEXT'), null);
});

test('scene headings, with and without scene numbers', () => {
  for (const h of ['INT. KITCHEN - DAY', 'EXT. GARDEN - NIGHT', 'INT./EXT. CAR - MOVING', 'I/E VAN - DAY', 'EST. CITY - DAWN', '12 INT. HALL - DAY', 'int. kitchen - day']) {
    assert.ok(isSceneHeading(h), h);
  }
  for (const n of ['INTERIOR DESIGN IS HARD.', 'EXTRA! EXTRA!', 'Inside, it is dark.']) assert.ok(!isSceneHeading(n), n);
  assert.deepStrictEqual(splitSceneNumber('12A INT. KITCHEN - DAY 12A'), { text: 'INT. KITCHEN - DAY', sceneNumber: '12A' });
  assert.deepStrictEqual(splitSceneNumber('INT. KITCHEN - DAY'), { text: 'INT. KITCHEN - DAY', sceneNumber: null });
});

test('transitions', () => {
  for (const t of ['CUT TO:', 'SMASH CUT TO:', 'DISSOLVE TO:', 'FADE IN:', 'FADE OUT.', 'FADE TO BLACK.', 'MATCH CUT TO:']) assert.ok(isTransitionText(t), t);
  for (const t of ['Cut to the chase:', 'ANNA', 'HE WALKS TO THE DOOR']) assert.ok(!isTransitionText(t), t);
});

test('beats, (MORE) and CONT\'D variants', () => {
  for (const b of ['(beat)', '( Beat )', '(a beat)', '(long beat)']) assert.ok(isBeat(b), b);
  assert.ok(!isBeat('(beats him to it)'));
  assert.ok(isMore('(MORE)') && isMore('(more)'));
  for (const c of ["CONT'D", 'CONT’D', 'CONTD', 'CONT.', 'CONTINUING', "cont'd"]) assert.ok(isContd(c), c);
});

test('page and scene numbers', () => {
  for (const p of ['12.', '12', 'Page 12', '- 12 -', '3 of 110']) assert.ok(isPageNumber(p), p);
  for (const s of ['12', '12A', 'A12', '12.']) assert.ok(isSceneNumber(s), s);
  assert.ok(!isSceneNumber('INT.'));
  assert.ok(isAllCaps('BANG!') && !isAllCaps('Bang!') && !isAllCaps('123'));
});
