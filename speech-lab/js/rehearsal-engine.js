// Bridge between Rehearsal's play mode (a classic script) and the lab's speech engines.
// The app loads it on demand with import('./speech-lab/js/rehearsal-engine.js') when a speech
// engine is chosen in the play pane's settings, so the app itself stays build-free and doesn't
// load anything when Voice activity (the default) is used.
//
// Uses the same adapters, preprocessing and cue matching as the lab, so play mode behaves like
// "Test full script": the line ends as soon as its last N words (the cue) are heard.

import { SherpaAdapter } from './engines/sherpa.js';
import { VoskAdapter } from './engines/vosk.js';
import { Chunker, MODEL_RATE, openMicrophone } from './audio.js';
import { autoCue, tokenize, findCue, TranscriptState } from './cue.js';

const ADAPTERS = { sherpa: SherpaAdapter, vosk: VoskAdapter };
const loaded = new Map(); // A model loads once per page, even if rehearsal is restarted mid-download.

let pinsPromise = null;
const pins = () => (pinsPromise ||= fetch(new URL('../pins.json', import.meta.url)).then((r) => {
  if (!r.ok) throw new Error('speech-lab/pins.json not found');
  return r.json();
}));

// Loads (once) and returns the engine. onProgress({stage, fraction, downloading}).
export function loadEngine(id, onProgress) {
  if (!ADAPTERS[id]) return Promise.reject(new Error(`Unknown engine: ${id}`));
  let load = loaded.get(id);
  if (!load) {
    load = { progress: null, listeners: new Set() };
    load.promise = pins().then(async (pinned) => {
      const adapter = new ADAPTERS[id](pinned);
      await adapter.load(progress => {
        load.progress = progress;
        for (const listener of load.listeners) listener(progress);
      });
      return adapter;
    }).catch(error => {
      loaded.delete(id); // allow a retry after a failure
      throw error;
    }).finally(() => {
      load.progress = null;
      load.listeners.clear();
    });
    loaded.set(id, load);
  }
  if (!onProgress) return load.promise;
  load.listeners.add(onProgress);
  if (load.progress) onProgress(load.progress);
  return load.promise.finally(() => load.listeners.delete(onProgress));
}

// Number of words in a line, using the same normalisation as cue matching.
export const wordCount = (text) => tokenize(text).length;

// A cue listener bound to one engine and one microphone stream for a rehearsal session.
//   const s = await startSession('vosk', micStream);
//   const h = s.listenFor(lineText, { cueWords: 5, onHeard });  // h.done resolves on the cue
//   h.cancel();  await s.close();
export async function startSession(id, stream, { chunkMs = 100, threshold = 0.7 } = {}) {
  const adapter = await loadEngine(id);
  let active = null; // current listen state
  let chunker = null;
  let drain = Promise.resolve(); // previous line's recognition finishing
  const mic = await openMicrophone({
    stream,
    record: false,
    onSamples: (x) => { if (active && chunker) chunker.push(x); },
  });

  function listenFor(text, { cueWords = 5, onHeard = () => {} } = {}) {
    const cue = autoCue(text, cueWords);
    const cueTokens = tokenize(cue);
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const me = { cancelled: false };

    const end = (result) => {
      if (active !== me) return;
      active = null;
      adapter.onResult = () => {};
      drain = adapter.flush().catch(() => {});
      resolveDone(result);
    };

    (async () => {
      await drain;
      if (me.cancelled) return;
      await adapter.reset();
      const transcript = new TranscriptState();
      chunker = new Chunker(Math.round((MODEL_RATE * chunkMs) / 1000), (c) => adapter.feed(c));
      active = me;
      adapter.onResult = (ev) => {
        if (active !== me) return;
        transcript.apply(ev);
        const heard = tokenize(transcript.text);
        onHeard(transcript.text);
        const r = findCue(heard, cueTokens, { mode: 'fuzzy', threshold }); // exact matches score 1
        if (r.matched) end({ cue, heard: transcript.text, score: r.score });
      };
    })();

    return {
      cue,
      done,
      cancel() {
        me.cancelled = true;
        if (active === me) end(null);
      },
    };
  }

  return {
    label: adapter.label,
    listenFor,
    async close() {
      if (active) {
        adapter.onResult = () => {};
        active = null;
      }
      await mic.stop().catch(() => {});
      await drain;
    },
  };
}
