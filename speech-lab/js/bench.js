// Benchmark runner: replays the same preprocessed 16 kHz PCM into an adapter at real-time
// speed and records every result event against the audio timeline. Metrics are computed
// afterwards (computeRun) from those raw events, so changing the cue, the fuzzy threshold or
// the annotation never requires re-running recognition.

import { MODEL_RATE } from './audio.js';
import { detectCue, classify, wordErrorRate, TranscriptState } from './cue.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// Chunk i covers audio [i*chunk, (i+1)*chunk). It is delivered when that audio would have
// finished arriving from a live microphone, at t0 + (i+1)*chunk, so event time on the wall
// clock equals position on the audio timeline.
export async function replay(adapter, samples, { chunkMs = 100, trailingSilenceMs = 1500, onTick, signal } = {}) {
  const chunk = Math.round((MODEL_RATE * chunkMs) / 1000);
  const padded = new Float32Array(samples.length + Math.round((MODEL_RATE * trailingSilenceMs) / 1000));
  padded.set(samples);
  const duration = padded.length / MODEL_RATE;

  await adapter.reset();
  const events = [];
  let t0 = 0;
  adapter.onResult = (ev) => events.push({ type: ev.type, text: ev.text, t: (ev.at - t0) / 1000 });

  t0 = performance.now();
  for (let i = 0, k = 0; i < padded.length; i += chunk, k++) {
    if (signal && signal.aborted) throw new DOMException('Benchmark stopped', 'AbortError');
    const due = t0 + ((Math.min(i + chunk, padded.length)) / MODEL_RATE) * 1000;
    await sleep(due - performance.now());
    adapter.feed(padded.subarray(i, i + chunk));
    onTick && onTick((i + chunk) / padded.length);
  }
  const lateness = performance.now() - (t0 + duration * 1000); // timer drift at the end
  await adapter.flush();
  adapter.onResult = () => {};
  return { events, duration, chunkMs, trailingSilenceMs, timerDriftMs: lateness };
}

// Metrics for one (engine, take) run under the current settings.
export function computeRun(run, take, settings) {
  const detections = detectCue(run.events, take.cue ?? settings.cue, { threshold: settings.fuzzyThreshold });
  const state = new TranscriptState();
  run.events.forEach((e) => state.apply(e));
  const finalText = state.text; // finals plus any trailing partial
  return {
    exact: { ...classify(detections.exact, take.cueEnd, settings), match: detections.exact },
    fuzzy: { ...classify(detections.fuzzy, take.cueEnd, settings), match: detections.fuzzy },
    transcript: finalText,
    wer: wordErrorRate(take.expected ?? settings.expected, finalText),
  };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

// Aggregates per-run metrics into one summary row per engine.
export function summarise(engineId, rows, loadStats) {
  const mode = (m) => {
    const hits = rows.filter((r) => r.metrics[m].status === 'hit');
    const lat = hits.map((r) => r.metrics[m].latency);
    return {
      hits: hits.length,
      missed: rows.filter((r) => r.metrics[m].status === 'missed').length,
      premature: rows.filter((r) => r.metrics[m].status === 'premature').length,
      unannotated: rows.filter((r) => r.metrics[m].status === 'unannotated').length,
      latencyMedian: median(lat),
      latencyMean: mean(lat),
      latencyP90: pct(lat, 90),
    };
  };
  return {
    engine: engineId,
    runs: rows.length,
    loadMs: loadStats ? loadStats.loadMs : null,
    modelBytes: loadStats ? loadStats.modelBytes : null,
    runtimeBytes: loadStats ? loadStats.runtimeBytes : null,
    werMean: mean(rows.map((r) => r.metrics.wer)),
    exact: mode('exact'),
    fuzzy: mode('fuzzy'),
  };
}
