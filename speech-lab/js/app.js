// Speech Recognition Lab UI. Wires adapters (engines/), shared preprocessing (audio.js),
// cue matching (cue.js) and the benchmark runner (bench.js) together.

import { SherpaAdapter } from './engines/sherpa.js';
import { VoskAdapter } from './engines/vosk.js';
import { Chunker, MODEL_RATE, openMicrophone, decodeAudioFile, resampleAll, encodeWav, playSamples, suggestSpeechEnd } from './audio.js';
import { autoCue, tokenize, findCue, TranscriptState } from './cue.js';
import { replay, computeRun, summarise } from './bench.js';
import { exportJson, exportCsv, download } from './export.js';
import { listScripts, lineLabel } from './scripts.js';
import { setupFullRun } from './fullrun.js';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c.nodeType ? c : String(c));
  return n;
};
const ic = (name) => (window.icon ? window.icon(name) : '');
const fmtS = (x, signed = false) => (x == null ? '—' : `${signed && x > 0 ? '+' : ''}${x.toFixed(2)} s`);
const fmtMB = (b) => (b == null ? '—' : `${(b / 1048576).toFixed(1)} MB`);
const fmtPct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);

// ---- State ---------------------------------------------------------------------

const state = {
  pins: null,
  adapters: {},
  liveEngine: 'sherpa',
  takes: [],
  runs: [],
  nextTake: 1,
  benchAbort: null,
  live: null,
  playing: null,
};

function settings() {
  return {
    expected: $('expected').value,
    cue: $('cue').value,
    cueAuto: $('cueAuto').checked,
    cueWords: Number($('cueWords').value) || 5,
    fuzzyThreshold: Number($('fuzzyThreshold').value),
    prematureTolerance: Number($('prematureTolerance').value),
    maxLatency: Number($('maxLatency').value),
    chunkMs: Number($('chunkMs').value) || 100,
    trailingSilenceMs: Number($('trailingMs').value) || 0,
  };
}

const SETTINGS_KEY = 'speech-lab-settings';
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings())); } catch (e) { /* private mode */ }
}
function restoreSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { /* ignore */ }
  if (!s) return;
  const set = (id, v) => { if (v != null) $(id).value = v; };
  set('expected', s.expected);
  set('cue', s.cue);
  set('cueWords', s.cueWords);
  set('fuzzyThreshold', s.fuzzyThreshold);
  set('prematureTolerance', s.prematureTolerance);
  set('maxLatency', s.maxLatency);
  set('chunkMs', s.chunkMs);
  set('trailingMs', s.trailingSilenceMs);
  if (s.cueAuto != null) $('cueAuto').checked = s.cueAuto;
}

// ---- Theme (shares the main app's saved preference) ------------------------------

// The saved choice is 'light', 'dark' or 'system' (follows the device), as set in the app's Settings.
const systemDark = matchMedia('(prefers-color-scheme: dark)');
let themeChoice = 'system';
try { themeChoice = localStorage.getItem('rehearsal-theme') || 'system'; } catch (e) {}
function applyTheme() {
  const dark = themeChoice === 'dark' || (themeChoice === 'system' && systemDark.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
applyTheme();
systemDark.addEventListener('change', () => { if (themeChoice === 'system') applyTheme(); });
// Follow theme changes made in the main app (e.g. when embedded in its Tests view).
window.addEventListener('storage', (e) => { if (e.key === 'rehearsal-theme') { themeChoice = e.newValue || 'system'; applyTheme(); } });

// ---- Engine cards --------------------------------------------------------------

const cards = {};

function renderEngineCards() {
  const host = $('engineCards');
  host.textContent = '';
  for (const a of Object.values(state.adapters)) {
    const status = el('div', { class: 'muted' }, 'Not loaded');
    const bar = el('div', { class: 'progress hidden' }, el('div'));
    const stats = el('dl');
    const btn = el('button', { class: 'btn btn-outline btn-lg', type: 'button', onclick: () => loadEngine(a.id).catch(() => {}) }, 'Load model');
    const card = el('div', { class: 'engine-card' },
      el('div', { class: 'take-head' }, el('h3', {}, a.label), el('span', { class: 'spacer' }), btn),
      el('dl', {},
        el('dt', {}, 'Runtime'), el('dd', {}, `${a.info.runtime} (${a.info.runtimeLicense})`),
        el('dt', {}, 'Model'), el('dd', {}, `${a.info.model} (${a.info.modelLicense})`)),
      status, bar, stats);
    cards[a.id] = { card, status, bar, stats, btn };
    host.append(card);
  }
  markLiveCard();
}

function markLiveCard() {
  for (const [id, c] of Object.entries(cards)) c.card.toggleAttribute('data-live', id === state.liveEngine);
}

function showStats(id) {
  const a = state.adapters[id];
  const c = cards[id];
  const s = a.loadStats;
  c.stats.textContent = '';
  if (!s) return;
  c.stats.append(
    el('dt', {}, 'Load time'), el('dd', {}, `${(s.loadMs / 1000).toFixed(2)} s`),
    el('dt', {}, 'Model size'), el('dd', {}, fmtMB(s.modelBytes)),
    el('dt', {}, 'Runtime size'), el('dd', {}, fmtMB(s.runtimeBytes)),
  );
}

const loading = {};
function loadEngine(id) {
  if (loading[id]) return loading[id];
  const a = state.adapters[id];
  if (a.loaded) return Promise.resolve(a.loadStats);
  const c = cards[id];
  c.btn.disabled = true;
  c.bar.classList.remove('hidden');
  loading[id] = a
    .load(({ stage, fraction }) => {
      c.status.textContent = fraction == null ? `${stage}…` : `${stage}… ${Math.round(fraction * 100)}%`;
      c.bar.toggleAttribute('data-indeterminate', fraction == null);
      c.bar.firstChild.style.width = fraction == null ? '' : `${fraction * 100}%`;
    })
    .then((stats) => {
      c.status.textContent = 'Ready';
      c.btn.textContent = 'Loaded';
      c.bar.classList.add('hidden');
      showStats(id);
      return stats;
    })
    .catch((err) => {
      console.error(err);
      c.status.textContent = `Failed: ${err.message}`;
      c.btn.disabled = false;
      c.bar.classList.add('hidden');
      loading[id] = null;
      throw err;
    });
  return loading[id];
}

$('engineToggle').addEventListener('click', (e) => {
  const b = e.target.closest('[data-engine]');
  if (!b || state.live) return;
  state.liveEngine = b.dataset.engine;
  for (const t of $('engineToggle').querySelectorAll('[data-engine]')) t.setAttribute('aria-pressed', String(t === b));
  markLiveCard();
});

// ---- Cue phrase ----------------------------------------------------------------

function updateAutoCue() {
  if ($('cueAuto').checked) $('cue').value = autoCue($('expected').value, Number($('cueWords').value) || 5);
}
$('expected').addEventListener('input', () => { updateAutoCue(); syncLineState(); onSettingsChanged(); });
$('cueWords').addEventListener('input', () => { updateAutoCue(); onSettingsChanged(); });
$('cueAuto').addEventListener('change', () => { updateAutoCue(); onSettingsChanged(); });
$('cue').addEventListener('input', () => { $('cueAuto').checked = false; onSettingsChanged(); });
for (const id of ['fuzzyThreshold', 'prematureTolerance', 'maxLatency', 'chunkMs', 'trailingMs']) {
  $(id).addEventListener('input', onSettingsChanged);
}

function onSettingsChanged() {
  $('fuzzyThresholdValue').textContent = Number($('fuzzyThreshold').value).toFixed(2);
  saveSettings();
  renderTakes();
  renderResults();
}

// ---- Script picker ---------------------------------------------------------------
// Fills the expected dialogue (and the auto cue) from one of your lines in a Rehearsal script.
// Scripts are read from the app's IndexedDB, read-only (js/scripts.js). state.line is the picked
// line; takes recorded or loaded while it's current remember it. Editing the dialogue by hand
// unlinks it.

const PICK_KEY = 'speech-lab-picked-line';
state.scripts = [];
state.line = null;

const currentScript = () => state.scripts.find((s) => s.id === $('scriptPicker').value) || null;

let loadSeq = 0;
async function loadScripts() {
  const seq = ++loadSeq;
  let scripts;
  try {
    scripts = await listScripts();
  } catch (err) {
    console.error('Could not read Rehearsal scripts', err);
    scripts = [];
  }
  if (seq !== loadSeq) return; // a newer refresh started meanwhile
  // Read the current selection only now: the user may have picked a line while we waited.
  const keep = { script: $('scriptPicker').value, line: $('linePicker').value };
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PICK_KEY) || 'null'); } catch (e) { /* ignore */ }
  const unchanged = JSON.stringify(scripts) === JSON.stringify(state.scripts);
  state.scripts = scripts;
  if (unchanged && keep.script) return; // nothing to redraw
  const sp = $('scriptPicker');
  sp.textContent = '';
  if (!state.scripts.length) {
    sp.append(el('option', { value: '' }, 'No scripts found in Rehearsal'));
    sp.disabled = true;
  } else {
    sp.disabled = false;
    sp.append(el('option', { value: '' }, 'None (type dialogue below)'));
    for (const s of state.scripts) {
      sp.append(el('option', { value: s.id }, `${s.title} (${s.lines.length} ${s.lines.length === 1 ? 'line' : 'lines'})`));
    }
  }
  const wantScript = keep.script || (saved && saved.scriptId) || '';
  sp.value = state.scripts.some((s) => s.id === wantScript) ? wantScript : '';
  const wantLine = keep.line || (saved && saved.scriptId === sp.value && saved.turnIndex != null ? String(saved.turnIndex) : '');
  renderLineOptions(wantLine);
  syncLineState();
}

function renderLineOptions(selected = '') {
  const lp = $('linePicker');
  const s = currentScript();
  lp.textContent = '';
  if (!s || !s.lines.length) {
    lp.append(el('option', { value: '' }, s ? 'No lines for your character in this script' : 'Choose a script first'));
    lp.disabled = true;
    return;
  }
  lp.disabled = false;
  lp.append(el('option', { value: '' }, 'Choose a line…'));
  let group = null;
  let scene = null;
  for (const line of s.lines) {
    if (line.scene !== scene) {
      scene = line.scene;
      group = el('optgroup', { label: scene });
      lp.append(group);
    }
    group.append(el('option', { value: String(line.turnIndex) }, lineLabel(line)));
  }
  lp.value = s.lines.some((l) => String(l.turnIndex) === selected) ? selected : '';
}

function pickLine(turnIndex) {
  const s = currentScript();
  const line = s && s.lines.find((l) => l.turnIndex === turnIndex);
  $('linePicker').value = line ? String(turnIndex) : '';
  if (line) {
    $('expected').value = line.text;
    $('cueAuto').checked = true;
    updateAutoCue();
  }
  syncLineState();
  onSettingsChanged();
}

// Works out which line (if any) the current dialogue belongs to, and updates the context note,
// the Next line button and the remembered pick.
function syncLineState() {
  const s = currentScript();
  const idx = $('linePicker').value;
  const line = s && idx !== '' ? s.lines.find((l) => String(l.turnIndex) === idx) : null;
  const matches = line && line.text === $('expected').value.trim();
  state.line = matches
    ? { scriptId: s.id, scriptTitle: s.title, turnIndex: line.turnIndex, scene: line.scene, lineInScene: line.lineInScene, character: line.character, text: line.text }
    : null;
  if (line && !matches) $('linePicker').value = ''; // dialogue was edited by hand: unlink
  const ctx = $('lineContext');
  if (state.line) {
    ctx.textContent = line.previous ? `After ${line.previous.character}: “${line.previous.text}”` : 'First spoken line of the scene.';
    ctx.classList.remove('hidden');
  } else {
    ctx.classList.add('hidden');
  }
  const pos = s && state.line ? s.lines.findIndex((l) => l.turnIndex === state.line.turnIndex) : -1;
  $('nextLine').disabled = !s || !s.lines.length || pos === s.lines.length - 1;
  $('fullRun').disabled = !s || !s.lines.length;
  try {
    localStorage.setItem(PICK_KEY, JSON.stringify({ scriptId: $('scriptPicker').value, turnIndex: state.line ? state.line.turnIndex : null }));
  } catch (e) { /* private mode */ }
}

$('scriptPicker').addEventListener('change', () => { renderLineOptions(''); syncLineState(); });
$('linePicker').addEventListener('change', () => {
  const v = $('linePicker').value;
  if (v === '') { syncLineState(); return; }
  pickLine(Number(v));
});
$('nextLine').addEventListener('click', () => {
  const s = currentScript();
  if (!s || !s.lines.length) return;
  const pos = state.line ? s.lines.findIndex((l) => l.turnIndex === state.line.turnIndex) : -1;
  const next = s.lines[pos + 1];
  if (next) pickLine(next.turnIndex);
});
$('refreshScripts').addEventListener('click', () => loadScripts());
// Pick up edits made in the app's script editor when you come back to the lab.
window.addEventListener('focus', () => { if (!state.live && !(typeof fullRun !== 'undefined' && fullRun.isRunning())) loadScripts(); });

// ---- Test full script ------------------------------------------------------------------

const fullRun = setupFullRun({
  el,
  settings,
  adapters: () => state.adapters,
  loadEngine,
  liveEngine: () => state.liveEngine,
  renderTranscript: (...a) => renderTranscript(...a),
  addTake: (...a) => addTake(...a),
  voiceProcessing: () => $('voiceProcessing').checked,
  beforeOpen: async () => { if (state.live) await stopLive(); },
});
$('fullRun').addEventListener('click', () => {
  if (state.benchAbort) { alert('Wait for the benchmark to finish, or stop it first.'); return; }
  const s = currentScript();
  if (s) fullRun.open(s.id, state.line ? state.line.turnIndex : null);
});

const lineText = (line) => `${line.scriptTitle} · ${line.scene} · line ${line.lineInScene} (${line.character})`;

// ---- Transcript rendering with cue highlight --------------------------------------

function renderTranscript(target, transcript, cue, threshold) {
  const finals = tokenize(transcript.finalText);
  const partial = tokenize(transcript.partial);
  const heard = [...finals, ...partial];
  const cueTokens = tokenize(cue);
  const exact = findCue(heard, cueTokens, { mode: 'exact' });
  const fuzzy = findCue(heard, cueTokens, { mode: 'fuzzy', threshold });
  const span = exact.matched ? { ...exact, cls: 'cue-hit' } : fuzzy.matched ? { ...fuzzy, cls: 'cue-fuzzy' } : null;

  target.textContent = '';
  if (!heard.length) {
    target.append(el('span', { class: 'muted' }, 'Listening…'));
    return { exact, fuzzy };
  }
  let mark = null;
  heard.forEach((w, i) => {
    const inSpan = span && i >= span.start && i < span.end;
    if (i > 0) (inSpan && i > span.start ? mark : target).append(' ');
    if (inSpan && i === span.start) {
      mark = el('mark', { class: span.cls, title: `score ${span.score.toFixed(2)}` });
      target.append(mark);
    }
    (inSpan ? mark : target).append(el('span', { class: i >= finals.length ? 'partial' : '' }, w));
  });
  return { exact, fuzzy };
}

function setBadge(node, label, info) {
  node.dataset.state = info ? 'hit' : '';
  node.textContent = info ? `${label}: detected at ${info.t.toFixed(2)} s${info.score < 1 ? ` (score ${info.score.toFixed(2)})` : ''}` : `${label}: waiting`;
}

// ---- Live microphone -------------------------------------------------------------

async function startLive() {
  const id = state.liveEngine;
  const a = state.adapters[id];
  $('micStart').disabled = true;
  $('liveStatus').textContent = a.loaded ? '' : `Loading ${a.label}…`;
  try {
    await loadEngine(id);
    await a.reset();
    const s = settings();
    const transcript = new TranscriptState();
    const live = { adapter: a, transcript, detected: { exact: null, fuzzy: null }, t0: 0, fed: 0 };
    a.onResult = (ev) => {
      transcript.apply(ev);
      const cur = settings();
      const r = renderTranscript($('liveTranscript'), transcript, cur.cue, cur.fuzzyThreshold);
      const t = (ev.at - live.t0) / 1000;
      if (!live.detected.exact && r.exact.matched) live.detected.exact = { t, score: 1 };
      if (!live.detected.fuzzy && r.fuzzy.matched) live.detected.fuzzy = { t, score: r.fuzzy.score };
      setBadge($('liveExact'), 'Exact', live.detected.exact);
      setBadge($('liveFuzzy'), 'Fuzzy', live.detected.fuzzy);
    };
    const chunker = new Chunker(Math.round((MODEL_RATE * s.chunkMs) / 1000), (c) => {
      a.feed(c);
      live.fed += c.length;
      $('liveClock').textContent = `${(live.fed / MODEL_RATE).toFixed(1)} s`;
    });
    live.chunker = chunker;
    renderTranscript($('liveTranscript'), transcript, s.cue, s.fuzzyThreshold);
    setBadge($('liveExact'), 'Exact', null);
    setBadge($('liveFuzzy'), 'Fuzzy', null);
    live.mic = await openMicrophone({ voiceProcessing: $('voiceProcessing').checked, onSamples: (x) => chunker.push(x) });
    live.t0 = performance.now();
    live.snapshot = { expected: s.expected, cue: s.cue, line: state.line };
    state.live = live;
    $('micStart').classList.add('hidden');
    $('micStop').classList.remove('hidden');
    $('liveStatus').textContent = `Listening with ${a.label} (mic ${live.mic.nativeRate} Hz → 16 kHz)`;
  } catch (err) {
    console.error(err);
    $('liveStatus').textContent = `Could not start: ${err.message}`;
  } finally {
    $('micStart').disabled = false;
  }
}

async function stopLive() {
  const live = state.live;
  if (!live) return;
  $('micStop').disabled = true;
  const { raw16k } = await live.mic.stop();
  live.chunker.flush();
  await live.adapter.flush();
  live.adapter.onResult = () => {};
  state.live = null;
  $('micStop').disabled = false;
  $('micStop').classList.add('hidden');
  $('micStart').classList.remove('hidden');
  $('liveStatus').textContent = 'Stopped';
  if ($('keepTake').checked && raw16k.length > MODEL_RATE * 0.3) {
    addTake({ samples: raw16k, source: `microphone (${live.mic.nativeRate} Hz)`, ...live.snapshot });
  }
}

$('micStart').onclick = startLive;
$('micStop').onclick = stopLive;

// ---- Takes -------------------------------------------------------------------------

function addTake({ samples, source, name, expected, cue, line }) {
  const s = settings();
  const take = {
    id: state.nextTake++,
    name: name || `Take ${state.nextTake - 1}`,
    samples,
    source,
    expected: expected ?? s.expected,
    cue: cue ?? s.cue,
    line: line === undefined ? state.line : line,
    cueEnd: Number(suggestSpeechEnd(samples).toFixed(2)),
    cueEndSource: 'suggested: end of speech',
  };
  state.takes.push(take);
  renderTakes();
}

$('loadWav').addEventListener('change', async (e) => {
  for (const file of e.target.files) {
    try {
      const { samples, rate } = await decodeAudioFile(file);
      addTake({ samples: resampleAll(samples, rate), source: `file ${file.name} (${rate} Hz)`, name: file.name.replace(/\.[^.]+$/, '') });
    } catch (err) {
      alert(`Could not load ${file.name}: ${err.message}`);
    }
  }
  e.target.value = '';
});

function drawWave(canvas, take, playhead = null) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 72;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const fg = css.getPropertyValue('--muted-foreground').trim() || '#888';
  const accent = css.getPropertyValue('--destructive').trim() || 'red';
  const prim = css.getPropertyValue('--primary').trim() || '#000';
  const x = take.samples;
  const per = Math.max(1, Math.floor(x.length / w));
  g.fillStyle = fg;
  for (let px = 0; px < w; px++) {
    let lo = 0;
    let hi = 0;
    for (let i = px * per; i < Math.min(x.length, (px + 1) * per); i++) {
      if (x[i] < lo) lo = x[i];
      if (x[i] > hi) hi = x[i];
    }
    g.fillRect(px, h / 2 - hi * (h / 2), 1, Math.max(1, (hi - lo) * (h / 2)));
  }
  const dur = x.length / MODEL_RATE;
  if (take.cueEnd != null) {
    const cx = (take.cueEnd / dur) * w;
    g.fillStyle = accent;
    g.fillRect(cx - 1, 0, 2, h);
    g.font = '11px ' + (css.getPropertyValue('--font-sans') || 'sans-serif');
    g.fillText(`cue end ${take.cueEnd.toFixed(2)} s`, Math.min(cx + 4, w - 90), 12);
  }
  if (playhead != null) {
    g.fillStyle = prim;
    g.fillRect((playhead / dur) * w, 0, 1, h);
  }
}

function play(take, canvas, from, to = null) {
  if (state.playing) state.playing.stop();
  const p = playSamples(take.samples, from, to, () => {
    if (state.playing === p) state.playing = null;
    drawWave(canvas, take);
  });
  state.playing = p;
  const tick = () => {
    if (state.playing !== p) return;
    drawWave(canvas, take, p.position());
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function renderTakes() {
  const host = $('takes');
  host.textContent = '';
  if (!state.takes.length) {
    host.append(el('p', { class: 'muted small' }, 'No takes yet. Record one with the live microphone (with “Save as take” on) or load an audio file.'));
    return;
  }
  const s = settings();
  for (const take of state.takes) {
    const dur = take.samples.length / MODEL_RATE;
    const canvas = el('canvas', { 'aria-label': `Waveform of ${take.name}. Click to set the cue end.` });
    const cueInput = el('input', { type: 'number', class: 'num', step: '0.01', min: '0', max: dur.toFixed(2), value: take.cueEnd ?? '', 'aria-label': 'Cue end (seconds)' });
    const setCueEnd = (t, source) => {
      take.cueEnd = t == null || Number.isNaN(t) ? null : Math.max(0, Math.min(dur, Number(t.toFixed(2))));
      take.cueEndSource = source;
      cueInput.value = take.cueEnd ?? '';
      sourceNote.textContent = take.cueEndSource ? `(${take.cueEndSource})` : '';
      drawWave(canvas, take);
      renderResults();
    };
    cueInput.addEventListener('change', () => setCueEnd(cueInput.value === '' ? null : Number(cueInput.value), 'manual'));
    canvas.addEventListener('click', (e) => {
      const r = canvas.getBoundingClientRect();
      setCueEnd(((e.clientX - r.left) / r.width) * dur, 'manual');
    });
    const sourceNote = el('span', { class: 'muted small' }, take.cueEndSource ? `(${take.cueEndSource})` : '');
    const stale = take.cue !== s.cue || take.expected !== s.expected;
    const node = el('div', { class: 'take' },
      el('div', { class: 'take-head' },
        el('span', { class: 'name' }, take.name),
        el('span', { class: 'muted' }, `${dur.toFixed(2)} s · ${take.source}`),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn btn-ghost btn-lg', type: 'button', onclick: () => play(take, canvas, 0) }, ic('play'), 'Play'),
        el('button', { class: 'btn btn-ghost btn-lg', type: 'button', title: 'Play the 2 s before the cue end, then 0.5 s after', onclick: () => take.cueEnd != null && play(take, canvas, Math.max(0, take.cueEnd - 2), Math.min(dur, take.cueEnd + 0.5)) }, ic('scan-search'), 'Audition cue end'),
        el('button', { class: 'btn btn-ghost btn-lg', type: 'button', onclick: () => state.playing && state.playing.stop() }, ic('square'), 'Stop'),
        el('button', { class: 'btn btn-ghost btn-lg', type: 'button', onclick: () => download(`${take.name}.wav`, encodeWav(take.samples)) }, ic('download'), 'WAV'),
        el('button', { class: 'btn btn-destructive btn-lg', type: 'button', onclick: () => {
          state.takes = state.takes.filter((t) => t !== take);
          state.runs = state.runs.filter((r) => r.takeId !== take.id);
          renderTakes();
          renderResults();
        } }, ic('trash'), 'Delete')),
      canvas,
      el('div', { class: 'row' },
        el('span', { class: 'small' }, 'Cue end (s)'), cueInput,
        el('button', { class: 'btn btn-outline btn-lg', type: 'button', onclick: () => setCueEnd(suggestSpeechEnd(take.samples), 'suggested: end of speech') }, 'Suggest end of speech'),
        sourceNote),
      el('div', { class: 'take-meta' },
        take.line ? el('div', {}, el('span', { class: 'muted' }, 'Line: '), lineText(take.line)) : null,
        el('div', {}, el('span', { class: 'muted' }, 'Cue: '), `“${take.cue}”`),
        el('div', {}, el('span', { class: 'muted' }, 'Expected: '), take.expected),
        stale ? el('button', { class: 'btn btn-link btn-lg', type: 'button', onclick: () => {
          const cur = settings();
          take.cue = cur.cue;
          take.expected = cur.expected;
          take.line = state.line;
          renderTakes();
          renderResults();
        } }, 'Use current dialogue and cue for this take') : null));
    host.append(node);
    requestAnimationFrame(() => drawWave(canvas, take));
  }
}
window.addEventListener('resize', () => renderTakes());

// ---- Benchmark ---------------------------------------------------------------------

async function runBenchmark() {
  const engines = [...document.querySelectorAll('.bench-engine:checked')].map((c) => c.value);
  if (!state.takes.length) { $('benchStatus').textContent = 'Add at least one take first.'; return; }
  if (!engines.length) { $('benchStatus').textContent = 'Choose at least one engine.'; return; }
  if (state.live) await stopLive();
  const s = settings();
  const abort = new AbortController();
  state.benchAbort = abort;
  $('benchRun').classList.add('hidden');
  $('benchStop').classList.remove('hidden');
  $('micStart').disabled = true;
  const bar = $('benchProgress');
  bar.classList.remove('hidden');
  const totalAudio = state.takes.reduce((n, t) => n + t.samples.length / MODEL_RATE + s.trailingSilenceMs / 1000, 0) * engines.length;
  let doneAudio = 0;
  try {
    for (const id of engines) {
      const a = state.adapters[id];
      $('benchStatus').textContent = `Loading ${a.label}…`;
      await loadEngine(id);
      for (const take of state.takes) {
        $('benchStatus').textContent = `${a.label}: replaying ${take.name} in real time…`;
        const len = take.samples.length / MODEL_RATE + s.trailingSilenceMs / 1000;
        const result = await replay(a, take.samples, {
          chunkMs: s.chunkMs,
          trailingSilenceMs: s.trailingSilenceMs,
          signal: abort.signal,
          onTick: (f) => { bar.firstChild.style.width = `${((doneAudio + f * len) / totalAudio) * 100}%`; },
        });
        doneAudio += len;
        state.runs = state.runs.filter((r) => !(r.engine === id && r.takeId === take.id));
        state.runs.push({ engine: id, takeId: take.id, ...result, at: new Date().toISOString() });
        renderResults();
      }
    }
    $('benchStatus').textContent = 'Benchmark complete.';
  } catch (err) {
    $('benchStatus').textContent = err.name === 'AbortError' ? 'Benchmark stopped.' : `Benchmark failed: ${err.message}`;
    if (err.name !== 'AbortError') console.error(err);
  } finally {
    state.benchAbort = null;
    bar.classList.add('hidden');
    $('benchRun').classList.remove('hidden');
    $('benchStop').classList.add('hidden');
    $('micStart').disabled = false;
  }
}
$('benchRun').onclick = runBenchmark;
$('benchStop').onclick = () => state.benchAbort && state.benchAbort.abort();

function buildReport() {
  const s = settings();
  const takeById = new Map(state.takes.map((t) => [t.id, t]));
  const runs = state.runs
    .filter((r) => takeById.has(r.takeId))
    .map((r) => {
      const take = takeById.get(r.takeId);
      return {
        engine: r.engine,
        take: take.name,
        line: take.line,
        cue: take.cue,
        expected: take.expected,
        cueEnd: take.cueEnd,
        cueEndSource: take.cueEndSource,
        duration: take.samples.length / MODEL_RATE,
        chunkMs: r.chunkMs,
        trailingSilenceMs: r.trailingSilenceMs,
        timerDriftMs: r.timerDriftMs,
        ranAt: r.at,
        metrics: computeRun(r, take, s),
        events: r.events,
      };
    });
  const engineIds = Object.keys(state.adapters).filter((id) => runs.some((r) => r.engine === id));
  const summary = engineIds.map((id) => summarise(id, runs.filter((r) => r.engine === id), state.adapters[id].loadStats));
  return {
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    pins: state.pins,
    settings: {
      fuzzyThreshold: s.fuzzyThreshold,
      prematureTolerance: s.prematureTolerance,
      maxLatency: s.maxLatency,
      sampleRate: MODEL_RATE,
    },
    engines: Object.fromEntries(engineIds.map((id) => [id, { label: state.adapters[id].label, ...state.adapters[id].info, loadStats: state.adapters[id].loadStats }])),
    takes: state.takes.map((t) => ({ name: t.name, source: t.source, duration: t.samples.length / MODEL_RATE, cueEnd: t.cueEnd, cueEndSource: t.cueEndSource, cue: t.cue, expected: t.expected, line: t.line })),
    summary,
    runs,
  };
}

function renderResults() {
  const report = buildReport();
  const has = report.runs.length > 0;
  $('exportJson').disabled = !has;
  $('exportCsv').disabled = !has;
  const sum = $('summaryTable');
  const runsT = $('runsTable');
  sum.textContent = '';
  runsT.textContent = '';
  if (!has) {
    sum.append(el('tbody', {}, el('tr', {}, el('td', { class: 'muted' }, 'No results yet.'))));
    return;
  }

  // Side-by-side summary: one column per engine. `better` marks the best value in a row.
  const S = report.summary;
  const label = (id) => state.adapters[id].label;
  const rows = [
    ['Runtime', (x) => state.adapters[x.engine].info.runtime],
    ['Model', (x) => state.adapters[x.engine].info.model],
    ['Model size', (x) => fmtMB(x.modelBytes), (x) => x.modelBytes, 'min'],
    ['Runtime size', (x) => fmtMB(x.runtimeBytes), (x) => x.runtimeBytes, 'min'],
    ['Model load time', (x) => (x.loadMs == null ? '—' : `${(x.loadMs / 1000).toFixed(2)} s`), (x) => x.loadMs, 'min'],
    ['Takes run', (x) => x.runs],
    ['Mean WER', (x) => fmtPct(x.werMean), (x) => x.werMean, 'min'],
  ];
  for (const m of ['exact', 'fuzzy']) {
    const M = m === 'exact' ? 'Exact' : 'Fuzzy';
    rows.push(
      [`${M}: detected`, (x) => `${x[m].hits} / ${x.runs}`, (x) => x[m].hits, 'max'],
      [`${M}: missed`, (x) => x[m].missed, (x) => x[m].missed, 'min'],
      [`${M}: premature`, (x) => x[m].premature, (x) => x[m].premature, 'min'],
      [`${M}: latency median`, (x) => fmtS(x[m].latencyMedian, true), (x) => x[m].latencyMedian, 'min'],
      [`${M}: latency mean`, (x) => fmtS(x[m].latencyMean, true), (x) => x[m].latencyMean, 'min'],
      [`${M}: latency p90`, (x) => fmtS(x[m].latencyP90, true), (x) => x[m].latencyP90, 'min'],
    );
  }
  sum.append(el('thead', {}, el('tr', {}, el('th', {}, 'Metric'), S.map((x) => el('th', {}, label(x.engine))))));
  const body = el('tbody');
  for (const [name, show, val, better] of rows) {
    let best = null;
    if (better && S.length > 1) {
      const vals = S.map(val).filter((v) => v != null);
      if (vals.length > 1 && new Set(vals).size > 1) best = better === 'min' ? Math.min(...vals) : Math.max(...vals);
    }
    body.append(el('tr', {}, el('td', { class: 'metric' }, name), S.map((x) => el('td', { class: best != null && val(x) === best ? 'best' : '' }, show(x)))));
  }
  sum.append(body);

  // Per-run detail.
  const status = (r) => {
    const b = el('span', { class: 'badge', 'data-state': r.status }, r.status);
    return [b, ' ', r.t != null ? `at ${r.t.toFixed(2)} s` : '', r.latency != null ? ` (${fmtS(r.latency, true)})` : ''];
  };
  runsT.append(el('thead', {}, el('tr', {}, ['Engine', 'Take', 'Cue end', 'Exact', 'Fuzzy', 'Fuzzy score', 'WER', 'Transcript'].map((h) => el('th', {}, h)))));
  const tb = el('tbody');
  for (const r of report.runs) {
    tb.append(el('tr', {},
      el('td', {}, label(r.engine)),
      el('td', {}, r.take, r.line ? el('div', { class: 'muted' }, `${r.line.scene} · line ${r.line.lineInScene}`) : null),
      el('td', {}, fmtS(r.cueEnd)),
      el('td', {}, status(r.metrics.exact)),
      el('td', {}, status(r.metrics.fuzzy)),
      el('td', {}, r.metrics.fuzzy.match ? r.metrics.fuzzy.match.score.toFixed(2) : '—'),
      el('td', {}, fmtPct(r.metrics.wer)),
      el('td', {}, r.metrics.transcript)));
  }
  runsT.append(tb);
}

$('exportJson').onclick = () => exportJson(buildReport());
$('exportCsv').onclick = () => exportCsv(buildReport());

// ---- Startup -----------------------------------------------------------------------

async function checkSetup(pins) {
  const files = [
    `vendor/${pins.sherpa.runtime.dir}/sherpa-onnx-wasm-main-asr.wasm`,
    `models/${pins.sherpa.model.dir}/${pins.sherpa.model.use.encoder}`,
    `vendor/${pins.vosk.runtime.dir}/vosk.js`,
    `models/${pins.vosk.model.archive}`,
  ];
  const missing = [];
  for (const f of files) {
    try {
      const r = await fetch(new URL(`../${f}`, import.meta.url), { method: 'HEAD', cache: 'no-store' });
      if (!r.ok) missing.push(f);
    } catch (e) {
      missing.push(f);
    }
  }
  if (missing.length) {
    $('setupAlert').classList.remove('hidden');
    $('setupAlertText').textContent = `Missing: ${missing.join(', ')}. Run "python3 speech-lab/setup.py" from the repository root, then reload.`;
  }
}

async function init() {
  if (location.protocol === 'file:') {
    $('setupAlert').classList.remove('hidden');
    $('setupAlertText').textContent = 'The lab needs a local web server (workers and WASM do not load from file://). See speech-lab/README.md.';
  }
  restoreSettings();
  if (!$('cue').value) $('cueAuto').checked = true;
  updateAutoCue();
  state.pins = await (await fetch(new URL('../pins.json', import.meta.url))).json();
  state.adapters = { sherpa: new SherpaAdapter(state.pins), vosk: new VoskAdapter(state.pins) };
  renderEngineCards();
  await loadScripts();
  onSettingsChanged();
  if (window.renderIcons) window.renderIcons();
  checkSetup(state.pins);
}

// Lucide loads with `defer`; module scripts run after deferred scripts, so icons are ready.
init().catch((err) => {
  console.error(err);
  $('setupAlert').classList.remove('hidden');
  $('setupAlertText').textContent = `Startup failed: ${err.message}`;
});

// Test hook for automated checks (not used by the UI).
window.__lab = { state, addTake, runBenchmark, buildReport, loadEngine, settings, loadScripts, pickLine, fullRun };
