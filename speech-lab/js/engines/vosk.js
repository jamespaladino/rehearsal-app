import { Adapter, sizeOf } from './adapter.js';

// vosk-browser ships a UMD bundle (window.Vosk) with its WASM and Web Worker inlined.
function loadScript(src) {
  if (window.Vosk) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src} — did you run setup.py?`));
    document.head.append(s);
  });
}

export class VoskAdapter extends Adapter {
  constructor(pins) {
    super();
    this.id = 'vosk';
    this.label = 'Vosk';
    const p = pins.vosk;
    this.info = {
      runtime: `vosk-browser ${p.runtime.version}`,
      runtimeLicense: p.runtime.license,
      model: p.model.name,
      modelLicense: p.model.license,
    };
    this.scriptUrl = new URL(`../../vendor/${p.runtime.dir}/vosk.js`, import.meta.url).href;
    this.modelUrl = new URL(`../../models/${p.model.archive}`, import.meta.url).href;
    this.recognizer = null;
    this.lastPartial = '';
    this.flushWaiter = null;
  }

  async load(onProgress = () => {}) {
    if (this.loaded) return this.loadStats;
    const t0 = performance.now();
    onProgress({ stage: 'Loading vosk-browser runtime', fraction: null });
    await loadScript(this.scriptUrl);

    // Fetch the archive ourselves first so we can show progress; the Vosk worker's own fetch
    // then hits the HTTP cache. Vosk also persists the unpacked model in IndexedDB (IDBFS).
    const res = await fetch(this.modelUrl);
    if (!res.ok) throw new Error(`${res.status} ${this.modelUrl} — did you run setup.py?`);
    const total = Number(res.headers.get('Content-Length') || 0);
    const reader = res.body.getReader();
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.length;
      onProgress({ stage: 'Downloading model', fraction: total ? loaded / total : null });
    }

    onProgress({ stage: 'Unpacking model and initialising (Vosk worker)', fraction: null });
    this.model = await window.Vosk.createModel(this.modelUrl, -1);
    this.loaded = true;
    this.loadStats = {
      loadMs: performance.now() - t0,
      modelBytes: loaded,
      runtimeBytes: await sizeOf([this.scriptUrl]),
    };
    return this.loadStats;
  }

  async reset() {
    if (this.recognizer) this.recognizer.remove();
    const rec = new this.model.KaldiRecognizer(16000);
    rec.setWords(true);
    rec.on('partialresult', (m) => {
      if (rec !== this.recognizer) return;
      const text = (m.result.partial || '').trim();
      if (text === this.lastPartial) return;
      this.lastPartial = text;
      this.emit('partial', text);
    });
    rec.on('result', (m) => {
      if (rec !== this.recognizer) return;
      this.lastPartial = '';
      this.emit('final', (m.result.text || '').trim());
      if (this.flushWaiter) this.flushWaiter.bump();
    });
    rec.on('error', (m) => console.error('[vosk]', m.error));
    this.recognizer = rec;
    this.lastPartial = '';
  }

  feed(samples) {
    // acceptWaveformFloat scales [-1, 1] to the int16 range Kaldi expects.
    this.recognizer.acceptWaveformFloat(samples, 16000);
  }

  // vosk-browser has no explicit acknowledgement for the final result, and 'result' is also
  // emitted at endpoints. Resolve once results have stopped arriving for 400 ms.
  flush() {
    return new Promise((resolve) => {
      let timer = null;
      const finish = () => {
        clearTimeout(timer);
        clearTimeout(hard);
        this.flushWaiter = null;
        resolve();
      };
      const hard = setTimeout(finish, 10000);
      this.flushWaiter = {
        bump: () => {
          clearTimeout(timer);
          timer = setTimeout(finish, 400);
        },
      };
      this.recognizer.retrieveFinalResult();
    });
  }

  dispose() {
    if (this.model) this.model.terminate();
    this.model = null;
    this.recognizer = null;
    this.loaded = false;
  }
}
