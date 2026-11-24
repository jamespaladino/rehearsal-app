// "Test full script": walks a whole Rehearsal script with one engine, the way rehearsal would.
//
//   heading / action   shown, not waited on
//   beat               waits its duration (same 0-120 s clamp as the app)
//   reader ("them")    plays its recording; a missing recording is skipped after 250 ms (as the app does)
//   your line ("me")   listens with the chosen engine; moves on the moment the cue (last N words of the
//                      line) is detected. Skip (or →) moves on by hand.
//
// For each of your lines it records how long after you stopped speaking the script moved on
// ("gap"): detection time minus the estimated end of speech (same estimate as takes use).
// The microphone stays open for the whole run but audio only reaches the engine while one of your
// lines is being listened for, so reader playback can't trigger cues.
//
// Uses the same preprocessing (audio.js), adapters and cue matcher (cue.js) as the rest of the lab.

import { Chunker, MODEL_RATE, openMicrophone, concat, suggestSpeechEnd } from './audio.js';
import { autoCue, TranscriptState } from './cue.js';
import { getScript, linesOf } from './scripts.js';

const $ = (id) => document.getElementById(id);
const PLAYABLE = new Set(['me', 'them', 'beat']);
const beatSeconds = (t) => {
  const d = Number(t.duration ?? 2);
  return Math.max(0, Math.min(120, Number.isFinite(d) ? d : 2));
};
const readerSpacing = (script) => {
  const v = Number(script && script.readerSpacing);
  return Number.isFinite(v) ? Math.max(0, Math.min(10, v)) : 0; // negative (overlap) treated as 0 here
};

// deps: { el, ic, settings, adapters, loadEngine, liveEngine, renderTranscript, addTake,
//         voiceProcessing, beforeOpen }
export function setupFullRun(deps) {
  const { el } = deps;
  let script = null;
  let lineInfo = new Map(); // turnIndex -> line (scene, lineInScene, character)
  let start = 0;
  let run = null; // active run state

  // ---- Rendering -------------------------------------------------------------------

  function renderScript() {
    const list = $('runScript');
    list.textContent = '';
    script.turns.forEach((t, i) => {
      const text = (t.text || '').trim();
      if (!PLAYABLE.has(t.who) && !text) return;
      const li = el('li', { class: 'run-turn', 'data-who': t.who, 'data-index': String(i) });
      if (t.who === 'heading') li.append(el('div', { class: 'run-scene' }, text));
      else if (t.who === 'action') li.append(el('div', { class: 'run-action' }, text));
      else if (t.who === 'beat') li.append(el('div', { class: 'run-beat' }, `Beat · ${beatSeconds(t)} s`));
      else {
        const name = (t.character || (t.who === 'me' ? script.meCharacter || 'ME' : 'Reader')).trim();
        li.append(
          el('div', { class: 'run-char' }, name, t.who === 'them' && !t.audio ? el('span', { class: 'badge' }, 'no recording') : null),
          el('div', { class: 'run-text' }, text || '—'),
        );
        if (t.who === 'me') li.append(el('div', { class: 'run-result' }));
      }
      li.addEventListener('click', () => { if (!run) setStart(i); });
      list.append(li);
    });
    setStart(start);
  }

  function turnEl(i) {
    return $('runScript').querySelector(`[data-index="${i}"]`);
  }

  function setStart(i) {
    start = i;
    for (const li of $('runScript').children) li.toggleAttribute('data-start', Number(li.dataset.index) === i);
    const li = turnEl(i);
    if (li) li.scrollIntoView({ block: 'center' });
  }

  function setCurrent(i) {
    for (const li of $('runScript').children) {
      const k = Number(li.dataset.index);
      li.toggleAttribute('data-current', k === i);
      li.toggleAttribute('data-done', k < i && k >= run.from);
    }
    const li = turnEl(i);
    if (li) li.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function showResult(i, r) {
    const slot = turnEl(i) && turnEl(i).querySelector('.run-result');
    if (!slot) return;
    slot.textContent = '';
    if (r.status === 'advanced') {
      slot.append(el('span', { class: 'badge', 'data-state': 'hit' }, `moved on ${fmtGap(r.gap)}`));
      if (r.score < 1) slot.append(el('span', { class: 'muted small' }, ` fuzzy match ${r.score.toFixed(2)}`));
    } else {
      slot.append(el('span', { class: 'badge', 'data-state': 'missed' }, 'skipped'));
    }
    if (r.heard) slot.append(el('div', { class: 'muted small' }, `Heard: ${r.heard}`));
  }

  const fmtGap = (g) => `${g >= 0 ? `${g.toFixed(2)} s after you stopped` : `${(-g).toFixed(2)} s before you stopped`}`;
  const status = (msg) => { $('runStatus').textContent = msg; };

  // ---- Open / close ------------------------------------------------------------------

  async function open(scriptId, startAtLine) {
    await deps.beforeOpen();
    script = await getScript(scriptId);
    if (!script) { alert('Could not read that script.'); return; }
    script.turns = Array.isArray(script.turns) ? script.turns : [];
    lineInfo = new Map(linesOf(script).map((l) => [l.turnIndex, l]));
    // Start at the scene containing the picked line, otherwise at the top.
    start = 0;
    if (startAtLine != null) {
      for (let i = startAtLine; i >= 0; i--) {
        if (script.turns[i] && script.turns[i].who === 'heading') { start = i; break; }
      }
    }
    $('runTitle').textContent = `Test full script · ${script.title || 'Untitled script'}`;
    $('runEngine').value = deps.liveEngine();
    $('runSummary').classList.add('hidden');
    $('runHeard').replaceChildren(el('span', { class: 'muted' }, "Your words appear here while it's listening."));
    status(missingNote());
    renderScript();
    $('runOverlay').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    $('runStart').focus();
  }

  function missingNote() {
    const readers = script.turns.filter((t) => t.who === 'them' && (t.text || '').trim());
    const missing = readers.filter((t) => !t.audio).length;
    return missing ? `${missing} of ${readers.length} reader lines have no recording and will be skipped.` : 'Use headphones so reader audio does not reach the microphone.';
  }

  async function close() {
    await stop();
    $('runOverlay').classList.add('hidden');
    document.body.style.overflow = '';
  }

  // ---- Running -----------------------------------------------------------------------

  // Cancellable helpers: Skip ends the current step; Stop ends the run.
  function stepWait(ms) {
    return new Promise((resolve) => {
      const id = setTimeout(resolve, ms);
      run.step.signal.addEventListener('abort', () => { clearTimeout(id); resolve(); }, { once: true });
    });
  }

  function stepPlay(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      const done = () => { audio.pause(); URL.revokeObjectURL(url); resolve(); };
      audio.onended = done;
      audio.onerror = done;
      run.step.signal.addEventListener('abort', done, { once: true });
      audio.play().catch(done);
    });
  }

  async function start_() {
    if (run) return;
    const engineId = $('runEngine').value;
    const adapter = deps.adapters()[engineId];
    run = { from: start, results: [], adapter, engineId, step: new AbortController(), listening: null, pendingFlush: Promise.resolve(), stopped: false };
    $('runStart').classList.add('hidden');
    $('runStop').classList.remove('hidden');
    $('runEngine').disabled = true;
    $('runMatch').disabled = true;
    $('runSummary').classList.add('hidden');
    for (const r of $('runScript').querySelectorAll('.run-result')) r.textContent = '';
    try {
      if (!adapter.loaded) status(`Loading ${adapter.label}…`);
      await deps.loadEngine(engineId);
      if (run.stopped) return;
      status('Opening microphone…');
      run.mic = await openMicrophone({
        voiceProcessing: deps.voiceProcessing(),
        onSamples: (x) => { if (run && run.listening) run.listening.push(x); },
      });
      if (run.stopped) return;
      $('runSkip').disabled = false;

      for (let i = start; i < script.turns.length; i++) {
        if (run.stopped) break;
        const t = script.turns[i];
        if (!PLAYABLE.has(t.who)) continue;
        setCurrent(i);
        run.step = new AbortController();
        if (t.who === 'beat') {
          status(`Beat · ${beatSeconds(t)} s`);
          await stepWait(beatSeconds(t) * 1000);
        } else if (t.who === 'them') {
          if (t.audio) {
            status('Playing reader…');
            await stepPlay(t.audio);
          } else {
            status('Reader recording missing — skipping');
            await stepWait(250);
          }
        } else if (t.who === 'me' && (t.text || '').trim()) {
          const r = await listenFor(t, i);
          if (!r) break; // stopped
          run.results.push(r);
          showResult(i, r);
          const following = script.turns.slice(i + 1).find((x) => PLAYABLE.has(x.who));
          if (following && following.who === 'them' && following.audio && readerSpacing(script) > 0) {
            await stepWait(readerSpacing(script) * 1000);
          }
        }
      }
      if (!run.stopped) {
        setCurrent(-1);
        status('Script complete.');
      }
    } catch (err) {
      console.error(err);
      status(`Run failed: ${err.message}`);
    } finally {
      await finish();
    }
  }

  // Listens for one of your lines. Resolves with a result, or null if the run was stopped.
  async function listenFor(t, i) {
    const s = deps.settings();
    const mode = $('runMatch').value;
    const cue = autoCue(t.text, s.cueWords);
    const a = run.adapter;
    await run.pendingFlush; // let the previous line's recognition drain first
    if (run.stopped) return null;
    await a.reset();
    const transcript = new TranscriptState();
    const parts = [];
    let received = 0;
    const chunker = new Chunker(Math.round((MODEL_RATE * s.chunkMs) / 1000), (c) => a.feed(c));
    deps.renderTranscript($('runHeard'), transcript, cue, s.fuzzyThreshold);
    status(`Listening for your line… cue: “${cue}”`);

    return new Promise((resolve) => {
      let done = false;
      const samples = () => concat(parts);
      const finish = (r) => {
        if (done) return;
        done = true;
        run.listening = null;
        a.onResult = () => {};
        run.pendingFlush = a.flush().catch(() => {});
        resolve(r);
      };
      run.listening = {
        push(x) { parts.push(x); received += x.length; chunker.push(x); },
        skip() {
          const all = samples();
          finish({ turnIndex: i, status: 'skipped', cue, heard: transcript.text, samples: all, text: t.text });
        },
        abort() { finish(null); },
      };
      a.onResult = (ev) => {
        if (done) return;
        transcript.apply(ev);
        const m = deps.renderTranscript($('runHeard'), transcript, cue, s.fuzzyThreshold);
        const hit = mode === 'exact' ? m.exact : (m.exact.matched ? m.exact : m.fuzzy);
        if (!hit.matched) return;
        const all = samples();
        const at = received / MODEL_RATE; // audio position when the result arrived
        const speechEnd = suggestSpeechEnd(all);
        finish({ turnIndex: i, status: 'advanced', cue, heard: transcript.text, score: hit.score, detectAt: at, speechEnd, gap: at - speechEnd, samples: all, text: t.text });
      };
    });
  }

  async function stop() {
    if (!run) return;
    run.stopped = true;
    run.step.abort();
    if (run.listening) run.listening.abort();
  }

  async function finish() {
    const r = run;
    if (!r) return;
    if (r.listening) r.listening.abort();
    if (r.mic) await r.mic.stop().catch(() => {});
    await r.pendingFlush;
    r.adapter.onResult = () => {};
    run = null;
    $('runStart').classList.remove('hidden');
    $('runStop').classList.add('hidden');
    $('runSkip').disabled = true;
    $('runEngine').disabled = false;
    $('runMatch').disabled = false;
    if (r.stopped) status('Stopped.');
    summarise(r);
    if ($('runSaveTakes').checked) saveTakes(r);
  }

  function summarise(r) {
    const box = $('runSummary');
    box.textContent = '';
    if (!r.results.length) { box.classList.add('hidden'); return; }
    const moved = r.results.filter((x) => x.status === 'advanced');
    const gaps = moved.map((x) => x.gap).sort((a, b) => a - b);
    const med = gaps.length ? gaps[Math.floor((gaps.length - 1) / 2)] : null;
    const worst = gaps.length ? gaps[gaps.length - 1] : null;
    box.append(
      el('strong', {}, `${deps.adapters()[r.engineId].label}, ${$('runMatch').value} match: `),
      `${moved.length} of ${r.results.length} lines moved on by voice`,
      r.results.length - moved.length ? `, ${r.results.length - moved.length} skipped` : '',
      med != null ? ` · typical gap ${med.toFixed(2)} s, slowest ${worst.toFixed(2)} s after you stopped speaking` : '',
      $('runSaveTakes').checked ? ' · saved as takes for the benchmark' : '',
    );
    box.classList.remove('hidden');
  }

  function saveTakes(r) {
    for (const x of r.results) {
      if (!x.samples || x.samples.length < MODEL_RATE * 0.3) continue;
      const l = lineInfo.get(x.turnIndex);
      const line = l ? { scriptId: script.id, scriptTitle: script.title || 'Untitled script', turnIndex: l.turnIndex, scene: l.scene, lineInScene: l.lineInScene, character: l.character, text: l.text } : null;
      deps.addTake({
        samples: x.samples,
        source: `full-script run (${deps.adapters()[r.engineId].label}, ${x.status})`,
        name: l ? `${l.scene} · line ${l.lineInScene}` : undefined,
        expected: x.text,
        cue: x.cue,
        line,
      });
    }
  }

  function skip() {
    if (!run) return;
    if (run.listening) run.listening.skip();
    else run.step.abort();
  }

  // ---- Wiring ------------------------------------------------------------------------

  $('runStart').addEventListener('click', () => start_());
  $('runStop').addEventListener('click', () => stop());
  $('runSkip').addEventListener('click', () => skip());
  $('runClose').addEventListener('click', () => close());
  $('runOverlay').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'ArrowRight' && run) { e.preventDefault(); skip(); }
  });

  return { open, close, isRunning: () => !!run };
}
