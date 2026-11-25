// Synthetic scenes shared by the unit tests and make-fixtures.js (which writes them as PDFs).
// Row format: see test-support/synthetic.js.

export const NORMAL_SCENE = [
  ['transition', 'FADE IN:'], ['blank'],
  ['heading', 'INT. KITCHEN - DAY', { sceneNumber: '1' }], ['blank'],
  ['action', 'Anna stands at the sink, washing a cup that is already'], ['action', 'clean.'], ['blank'],
  ['character', 'ANNA'], ['dialogue', 'You said you would call.'], ['blank'],
  ['character', 'BEN (O.S.)'], ['parenthetical', '(from the hall)'], ['dialogue', 'I know. I know I did, and I'], ['dialogue', 'meant it.'], ['blank'],
  ['action', 'He appears in the doorway, keys in hand.'], ['blank'],
  ['character', 'ANNA'], ['dialogue', "Then why didn't you?", { revised: true }], ['blank'],
  ['transition', 'CUT TO:'], ['blank'],
  ['heading', 'EXT. GARDEN - NIGHT', { sceneNumber: '2' }], ['blank'],
  ['action', 'Quiet. A dog barks somewhere.'],
];

// A speech cut by a page break: (MORE) at the bottom, "BEN (CONT'D)" at the top of the next page.
export const PAGE_BREAK = [
  ['heading', 'INT. CAR - NIGHT', { sceneNumber: '7' }], ['blank'],
  ['action', 'Rain on the windscreen. Ben drives; Anna watches the road.'], ['blank'],
  ['character', 'BEN'], ['dialogue', "I've been thinking about what you said, about the"], ['dialogue', 'house, and the move, and all of it.'],
  ['parenthetical', '(MORE)'],
  ['pagebreak'],
  ['character', "BEN (CONT'D)"], ['dialogue', "And I think you're right. We should go."], ['blank'],
  ['character', 'ANNA'], ['dialogue', 'Really?'], ['blank'],
  ['action', 'He nods. She looks away, smiling, and the wipers keep'],
  ['pagebreak'],
  ['action', 'time.'], ['blank'],
  ['character', 'ANNA'], ['dialogue', 'Okay.'], ['blank'],
  ['character', "BEN (CONT'D)"], ['dialogue', 'Okay?'],
];

export const DUAL_DIALOGUE = [
  ['heading', 'INT. KITCHEN - DAY'], ['blank'],
  ['action', 'They both start talking at once.'], ['blank'],
  ['dual', ['ANNA', 'BEN']],
  ['dualline', ['I told you we', 'You never said']],
  ['dualline', ['should have left', 'anything about']],
  ['dualline', ['earlier.', '(shouting)']],
  ['dualline', [null, 'leaving!']],
  ['blank'],
  ['action', 'Silence.'],
];

export const BEAT = [
  ['heading', 'EXT. PARK - DAY'], ['blank'],
  ['action', 'They set up.'], ['blank'],
  ['character', 'ME'], ['dialogue', 'Testing, testing.'], ['parenthetical', '(beat)'], ['dialogue', 'One, two, three.'], ['blank'],
  ['character', 'JANE'], ['dialogue', 'This guy.'], ['blank'],
  ['character', 'ME'], ['parenthetical', '(beat)'], ['dialogue', 'Is this thing on?'],
];

export const TRANSITIONS = [
  ['transition', 'FADE IN:'], ['blank'],
  ['heading', 'INT. OFFICE - DAY'], ['blank'],
  ['action', 'A phone rings and rings.'], ['blank'],
  ['transition', 'SMASH CUT TO:'], ['blank'],
  ['heading', 'EXT. STREET - CONTINUOUS'], ['blank'],
  ['action', 'Traffic.'], ['blank'],
  ['transition', 'DISSOLVE TO:'], ['blank'],
  ['heading', 'INT. OFFICE - LATER'], ['blank'],
  ['action', 'The phone is quiet now.'], ['blank'],
  ['transition', 'FADE OUT.'],
];
