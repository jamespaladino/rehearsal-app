// Converting import results into Rehearsal's script model.
import { test, assert } from './harness.js';
import { layout } from '../test-support/synthetic.js';
import { parseLayout } from '../src/parse-layout.js';
import { parseFountain } from '../src/fountain.js';
import { toRehearsalScript } from '../src/convert.js';
import { guessMyCharacter } from '../src/model.js';
import { BEAT, NORMAL_SCENE } from '../fixtures/scenes.js';

test('speeches become me/them turns; headings and action carry over', () => {
  const s = toRehearsalScript(parseLayout(layout(NORMAL_SCENE)), { meCharacter: 'anna', title: 'Kitchen' });
  assert.strictEqual(s.title, 'Kitchen');
  assert.strictEqual(s.meCharacter, 'ANNA');
  assert.deepStrictEqual(s.otherCharacters, ['BEN']);
  assert.deepStrictEqual(s.turns.map((t) => [t.who, t.character || '', t.text]), [
    ['action', '', 'FADE IN:'],
    ['heading', '', 'INT. KITCHEN - DAY'],
    ['action', '', 'Anna stands at the sink, washing a cup that is already clean.'],
    ['me', 'ANNA', 'You said you would call.'],
    ['them', 'BEN', 'I know. I know I did, and I meant it.'],
    ['action', '', 'He appears in the doorway, keys in hand.'],
    ['me', 'ANNA', "Then why didn't you?"],
    ['action', '', 'CUT TO:'],
    ['heading', '', 'EXT. GARDEN - NIGHT'],
    ['action', '', 'Quiet. A dog barks somewhere.'],
  ]);
  const ben = s.turns.find((t) => t.character === 'BEN');
  assert.deepStrictEqual(ben.parentheticals, ['(from the hall)']);
  assert.deepStrictEqual(ben.extensions, ['O.S.']);
  assert.strictEqual(ben.audio, null);
});

test('(beat) mid-speech becomes the inline pause; a leading (beat) becomes a beat turn', () => {
  const s = toRehearsalScript(parseLayout(layout(BEAT)), { meCharacter: 'ME' });
  assert.deepStrictEqual(s.turns.map((t) => [t.who, t.text ?? t.duration]), [
    ['heading', 'EXT. PARK - DAY'],
    ['action', 'They set up.'],
    ['me', 'Testing, testing. (beat) One, two, three.'],
    ['them', 'This guy.'],
    ['beat', 2],
    ['me', 'Is this thing on?'],
  ]);
});

test('defaults to the best-guess character, and never produces an empty script', () => {
  const s = toRehearsalScript(parseFountain('INT. A - DAY\n\nBEN\nOne.\n\nANNA\nTwo.\n\nBEN\nThree.\n'));
  assert.strictEqual(s.meCharacter, 'BEN');
  const empty = toRehearsalScript(parseFountain(''));
  assert.deepStrictEqual(empty.turns, [{ who: 'heading', text: '' }]);
});

test('best guess: a character named ME or YOU, else the most dialogue by words', () => {
  // ANNA has fewer speeches but far more words.
  const wordy = parseFountain('INT. A - DAY\n\nBEN\nYes.\n\nANNA\nI have been waiting here for hours and nobody told me anything at all.\n\nBEN\nNo.\n');
  assert.deepStrictEqual(wordy.characters.map((c) => c.name), ['BEN', 'ANNA']);
  assert.strictEqual(guessMyCharacter(wordy), 'ANNA');
  const me = parseFountain('INT. A - DAY\n\nJANE\nA long line with many words in it, more than the other one.\n\nME\nHi.\n');
  assert.strictEqual(guessMyCharacter(me), 'ME');
  assert.strictEqual(guessMyCharacter(parseFountain('')), null);
});
