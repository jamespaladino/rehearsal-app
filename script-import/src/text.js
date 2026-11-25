// Text rules shared by every importer: character cues, scene headings, transitions,
// parentheticals and page furniture. Pure functions, no DOM.

const LETTER = /\p{L}/u;
const LOWER = /\p{Ll}/u;

/** True when the text has letters and none of them are lowercase ("ANNA", "BANG!"). */
export function isAllCaps(text) {
  return LETTER.test(text) && !LOWER.test(text);
}

/** Same as isAllCaps, but ignores parenthesised parts, which may be lowercase in some scripts ("ANNA (cont'd)"). */
export function isCueCaps(text) {
  const bare = text.replace(/\([^)]*\)/g, '');
  return isAllCaps(bare);
}

// INT. / EXT. / EST. / INT./EXT. / I/E, optionally preceded by a scene number.
const HEADING = /^(?:[A-Z]?\d+[A-Z]{0,2}\.?\s+)?(?:INT\.?\s*\/\s*EXT|EXT\.?\s*\/\s*INT|INT|EXT|EST|I\s*\/\s*E)(?:\.|\s|$)/i;

export function isSceneHeading(text) {
  return HEADING.test(text.trim());
}

/**
 * Splits margin scene numbers off a heading: "12A INT. KITCHEN - DAY 12A" ->
 * { text: "INT. KITCHEN - DAY", sceneNumber: "12A" }.
 */
export function splitSceneNumber(text) {
  let t = text.trim();
  let sceneNumber = null;
  const lead = t.match(/^([A-Z]?\d+[A-Z]{0,2})\.?\s+(?=\S)/);
  if (lead && isSceneHeading(t.slice(lead[0].length))) {
    sceneNumber = lead[1];
    t = t.slice(lead[0].length);
  }
  const trail = t.match(/\s+([A-Z]?\d+[A-Z]{0,2})\.?$/);
  if (trail && (sceneNumber === null || trail[1] === sceneNumber)) {
    sceneNumber = trail[1];
    t = t.slice(0, -trail[0].length);
  }
  return { text: t.trim(), sceneNumber };
}

const TRANSITION_WORDS = /^(?:FADE (?:IN|OUT|TO BLACK)|CUT TO BLACK|SMASH CUT|MATCH CUT|JUMP CUT|DISSOLVE|FADE OUT|BACK TO|INTERCUT|END CREDITS|THE END)\b/;

/** Transitions end in "TO:" or are one of the standard fades and cuts. */
export function isTransitionText(text) {
  const t = text.trim();
  if (!isAllCaps(t) || t.length > 40) return false;
  return /TO:$/.test(t) || /^FADE IN:?$/.test(t) || /^(?:FADE OUT|FADE TO BLACK|CUT TO BLACK)\.?$/.test(t) || (TRANSITION_WORDS.test(t) && /[:.]$/.test(t));
}

/** "(beat)", "( Beat )", "(a beat)", "(long beat)" are beats. */
export function isBeat(text) {
  return /^\(\s*(?:a\s+|long\s+|short\s+|another\s+)?beat\s*\)$/i.test(text.trim());
}

export function isMore(text) {
  return /^\(\s*MORE\s*\)$/i.test(text.trim());
}

// CONT'D, CONT’D, CONTD, CONT., CONT'D., CONTINUING
const CONTD = /^(?:CONT['’]?D\.?|CONT\.|CONTINUING|CONTINUED)$/i;

export function isContd(extension) {
  return CONTD.test(extension.trim());
}

/**
 * Parses a character cue: "ANNA (V.O.) (CONT'D)" -> { name: "ANNA", extensions: ["V.O.", "CONT'D"] }.
 * Extensions are normalised to upper case; a trailing Fountain "^" (dual dialogue) is reported separately.
 * Returns null when the text can't be a cue (empty name, lowercase name, too long).
 */
export function parseCue(text) {
  let t = text.trim();
  let dual = false;
  if (t.endsWith('^')) {
    dual = true;
    t = t.slice(0, -1).trim();
  }
  const extensions = [];
  t = t.replace(/\(([^)]*)\)/g, (_, ext) => {
    if (ext.trim()) extensions.push(ext.trim().toUpperCase().replace(/’/g, "'"));
    return ' ';
  });
  const name = t.replace(/\s+/g, ' ').trim();
  if (!name || !isAllCaps(name) || name.length > 38) return null;
  return { name, extensions, dual };
}

/** Page numbers as they appear in headers and footers: "12.", "12", "Page 12", "- 12 -", "12 of 110". */
export function isPageNumber(text) {
  return /^(?:page\s*)?-?\s*\d{1,4}\s*-?\.?(?:\s*(?:of|\/)\s*\d{1,4})?$/i.test(text.trim());
}

/** Scene numbers in the margins: "12", "12A", "A12", "12.". */
export function isSceneNumber(text) {
  return /^[A-Z]?\d{1,4}[A-Z]{0,2}\.?$/.test(text.trim());
}

/** "(CONTINUED)" footers and "CONTINUED:" headers in shooting scripts. */
export function isContinuedMarker(text) {
  return /^\(?\s*CONTINUED\s*\)?:?$/i.test(text.trim()) || /^CONTINUED:\s*\(\d+\)$/i.test(text.trim());
}

export function isRevisionMark(text) {
  return /^\*+$/.test(text.trim());
}

/** Collapses runs of whitespace and normalises curly apostrophes. */
export function clean(text) {
  return text.replace(/[ \s]+/g, ' ').replace(/’/g, "'").trim();
}
