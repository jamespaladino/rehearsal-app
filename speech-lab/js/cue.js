// Cue matching. Pure functions over text; knows nothing about recognition engines.
// Every engine's transcripts go through the same normalize() -> tokenize() -> findCue() path.

const NUMBER_WORDS = {
  0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven',
  8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve',
};

// Lowercase, fold curly quotes, drop apostrophes ("don't" -> "dont"), turn other
// punctuation into spaces, spell out 0-12 (engines emit words, scripts often use digits).
export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’ʼ`']/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(\d{1,2})\b/g, (m, n) => NUMBER_WORDS[n] || m)
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text) {
  const n = normalize(text);
  return n ? n.split(' ') : [];
}

// The default cue: the last `n` words of the expected dialogue.
export function autoCue(dialogue, n = 5) {
  return tokenize(dialogue).slice(-n).join(' ');
}

export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Character-level similarity in [0, 1].
export function similarity(a, b) {
  const max = Math.max(a.length, b.length);
  return max ? 1 - levenshtein(a, b) / max : 1;
}

// Looks for the cue in the heard tokens.
//   exact: the cue's tokens appear contiguously.
//   fuzzy: some window of (n-1 .. n+1) heard tokens has character similarity >= threshold
//          to the cue (spaces included, so word splits/merges are cheap but not free).
// Returns { matched, start, end, score } with [start, end) indexing heardTokens; when not
// matched, start/end/score describe the best candidate window (useful for display).
export function findCue(heardTokens, cueTokens, { mode = 'exact', threshold = 0.8 } = {}) {
  const n = cueTokens.length;
  const none = { matched: false, start: -1, end: -1, score: 0 };
  if (!n || !heardTokens.length) return none;

  if (mode === 'exact') {
    // Search from the end so the most recent occurrence wins.
    for (let s = heardTokens.length - n; s >= 0; s--) {
      let ok = true;
      for (let k = 0; k < n && ok; k++) ok = heardTokens[s + k] === cueTokens[k];
      if (ok) return { matched: true, start: s, end: s + n, score: 1 };
    }
    return none;
  }

  const cueStr = cueTokens.join(' ');
  let best = none;
  for (let len = Math.max(1, n - 1); len <= n + 1; len++) {
    for (let s = heardTokens.length - len; s >= 0; s--) {
      const score = similarity(heardTokens.slice(s, s + len).join(' '), cueStr);
      if (score > best.score) best = { matched: score >= threshold, start: s, end: s + len, score };
    }
  }
  return best;
}

// Turns an engine's ordered result events into the running transcript the cue matcher sees.
// Finals accumulate; the latest partial is appended after them and replaced on each update.
export class TranscriptState {
  constructor() {
    this.finals = [];
    this.partial = '';
  }
  apply(event) {
    if (event.type === 'final') {
      if (event.text.trim()) this.finals.push(event.text.trim());
      this.partial = '';
    } else {
      this.partial = event.text.trim();
    }
  }
  get text() {
    return [...this.finals, this.partial].filter(Boolean).join(' ');
  }
  get finalText() {
    return this.finals.join(' ');
  }
}

// Replays result events (each with a time `t` in seconds on the audio timeline) and returns
// the first time each matching mode fired. This is the same logic the live view runs, applied
// after the fact so thresholds can change without re-running recognition.
export function detectCue(events, cue, { threshold }) {
  const cueTokens = tokenize(cue);
  const state = new TranscriptState();
  const out = { exact: null, fuzzy: null };
  for (const ev of events) {
    state.apply(ev);
    const heard = tokenize(state.text);
    if (!out.exact) {
      const r = findCue(heard, cueTokens, { mode: 'exact' });
      if (r.matched) out.exact = { t: ev.t, score: 1, text: heard.slice(r.start, r.end).join(' ') };
    }
    if (!out.fuzzy) {
      const r = findCue(heard, cueTokens, { mode: 'fuzzy', threshold });
      if (r.matched) out.fuzzy = { t: ev.t, score: r.score, text: heard.slice(r.start, r.end).join(' ') };
    }
    if (out.exact && out.fuzzy) break;
  }
  return out;
}

// Classifies a detection against the annotated cue end.
//   premature: fired more than `prematureTolerance` s before the cue ended.
//   missed:    never fired, or fired more than `maxLatency` s after the cue ended.
//   hit:       otherwise; latency = detection time - cue end.
export function classify(detection, cueEnd, { prematureTolerance, maxLatency }) {
  if (!detection) return { status: 'missed', latency: null, reason: 'never detected' };
  if (cueEnd == null) return { status: 'unannotated', latency: null, t: detection.t };
  const latency = detection.t - cueEnd;
  if (latency < -prematureTolerance) return { status: 'premature', latency, t: detection.t };
  if (latency > maxLatency) return { status: 'missed', latency, t: detection.t, reason: 'too late' };
  return { status: 'hit', latency, t: detection.t };
}

// Word error rate of a hypothesis against the expected dialogue (same normalisation).
export function wordErrorRate(reference, hypothesis) {
  const ref = tokenize(reference);
  const hyp = tokenize(hypothesis);
  if (!ref.length) return hyp.length ? 1 : 0;
  return levenshtein(ref, hyp) / ref.length;
}
