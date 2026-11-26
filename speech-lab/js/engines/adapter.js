// The speech recognition adapter contract. The UI, benchmark runner and cue matcher only talk
// to engines through this interface, so engines are interchangeable.
//
//   id, label                       identifiers
//   info                            static facts: runtime/model names, versions, licences
//   async load(onProgress)          download + initialise. onProgress({stage, fraction, downloading?}).
//                                   Resolves to LoadStats { loadMs, modelBytes, runtimeBytes }.
//   async reset()                   start a fresh utterance stream
//   feed(samples)                   push 16 kHz mono Float32 [-1, 1]; must not block
//   async flush()                   finish input; resolves after any final result is emitted
//   onResult = (ev) => {}           ev = { type: 'partial' | 'final', text, at }
//                                   `at` is performance.now() when the main thread received it,
//                                   stamped here so every engine is timed the same way.
//   dispose()                       free workers and memory
//
// Engines receive identical audio: preprocessing happens before feed() (see audio.js).

export class Adapter {
  constructor() {
    this.onResult = () => {};
    this.loaded = false;
    this.loadStats = null;
  }
  emit(type, text) {
    this.onResult({ type, text, at: performance.now() });
  }
}

// Total bytes of the given URLs via HEAD requests (Content-Length).
export async function sizeOf(urls) {
  const sizes = await Promise.all(
    urls.map(async (u) => {
      try {
        const r = await fetch(u, { method: 'HEAD', cache: 'no-store' });
        return r.ok ? Number(r.headers.get('Content-Length') || 0) : 0;
      } catch (e) {
        return 0;
      }
    }),
  );
  return sizes.reduce((a, b) => a + b, 0);
}
