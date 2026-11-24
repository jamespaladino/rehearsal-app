import { Adapter, sizeOf } from './adapter.js';

const WASM_FILES = ['sherpa-onnx-asr.js', 'sherpa-onnx-wasm-main-asr.js', 'sherpa-onnx-wasm-main-asr.wasm'];

export class SherpaAdapter extends Adapter {
  constructor(pins) {
    super();
    this.id = 'sherpa';
    this.label = 'Sherpa-ONNX';
    const p = pins.sherpa;
    this.info = {
      runtime: `sherpa-onnx WASM ${p.runtime.version}`,
      runtimeLicense: p.runtime.license,
      model: p.model.name,
      modelLicense: p.model.license,
    };
    this.runtimeBase = new URL(`../../vendor/${p.runtime.dir}/`, import.meta.url).href;
    this.modelBase = new URL(`../../models/${p.model.dir}/`, import.meta.url).href;
    this.files = p.model.use;
    this.flushes = new Map();
    this.nextFlush = 1;
  }

  async load(onProgress = () => {}) {
    if (this.loaded) return this.loadStats;
    const t0 = performance.now();
    this.worker = new Worker(new URL('./sherpa-worker.js', import.meta.url));
    const ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') onProgress({ stage: m.stage, fraction: m.total ? m.loaded / m.total : null });
        else if (m.type === 'ready') resolve(m);
        else if (m.type === 'error') {
          console.error('[sherpa-onnx worker]', m.error);
          reject(new Error(m.error));
          // Errors after load (e.g. during decoding) must not leave a flush() waiting forever.
          for (const done of this.flushes.values()) done();
          this.flushes.clear();
        }
        else if (m.type === 'partial' || m.type === 'final') this.emit(m.type, m.text);
        else if (m.type === 'flushed') {
          const done = this.flushes.get(m.id);
          this.flushes.delete(m.id);
          done && done();
        }
      };
      this.worker.onerror = (e) => reject(new Error(e.message || 'Worker failed to start'));
    });
    // Open the lab with ?debug to see sherpa-onnx's own logging in the console.
    const debug = new URLSearchParams(location.search).has('debug');
    this.worker.postMessage({ type: 'load', runtimeBase: this.runtimeBase, modelBase: this.modelBase, files: this.files, debug });
    const m = await ready;
    this.loaded = true;
    this.loadStats = {
      loadMs: performance.now() - t0,
      modelBytes: m.modelBytes,
      runtimeBytes: await sizeOf(WASM_FILES.map((f) => this.runtimeBase + f)),
    };
    return this.loadStats;
  }

  async reset() {
    this.worker.postMessage({ type: 'reset' });
  }

  feed(samples) {
    const copy = new Float32Array(samples);
    this.worker.postMessage({ type: 'audio', samples: copy }, [copy.buffer]);
  }

  flush() {
    const id = this.nextFlush++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        console.warn('[sherpa-onnx] flush timed out');
        this.flushes.delete(id);
        resolve();
      }, 15000);
      this.flushes.set(id, () => { clearTimeout(timer); resolve(); });
      this.worker.postMessage({ type: 'flush', id });
    });
  }

  dispose() {
    this.worker && this.worker.terminate();
    this.worker = null;
    this.loaded = false;
  }
}
