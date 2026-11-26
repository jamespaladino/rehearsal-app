// Web Worker hosting the sherpa-onnx WebAssembly runtime (classic worker: the runtime uses
// importScripts-style globals).
//
// The prebuilt sherpa-onnx WASM ASR bundle embeds a large model in a .data package. We skip that
// package (getPreloadedPackage returns an empty buffer) and instead write the pinned lightweight
// model's files into the Emscripten filesystem ourselves, so only the runtime .js/.wasm and the
// small model are downloaded.
//
// Messages in:  {type:'load', runtimeBase, modelBase, files:{encoder,decoder,joiner,tokens}}
//               {type:'reset'} {type:'audio', samples:Float32Array} {type:'flush', id}
// Messages out: {type:'progress', loaded, total, stage} {type:'ready', modelBytes}
//               {type:'partial'|'final', text} {type:'flushed', id} {type:'error', error}

/* global importScripts, createOnlineRecognizer */
'use strict';

let recognizer = null;
let stream = null;
let lastText = '';
const SAMPLE_RATE = 16000;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') await load(m);
    else if (m.type === 'reset') reset();
    else if (m.type === 'audio') accept(m.samples);
    else if (m.type === 'flush') flush(m.id);
  } catch (err) {
    self.postMessage({ type: 'error', error: String((err && err.message) || err) });
  }
};

async function fetchWithProgress(urls) {
  const sizes = await Promise.all(
    urls.map(async (u) => {
      const r = await fetch(u, { method: 'HEAD' });
      if (!r.ok) throw new Error(`${r.status} ${u} — did you run setup.py?`);
      return Number(r.headers.get('Content-Length') || 0);
    }),
  );
  const total = sizes.reduce((a, b) => a + b, 0);
  let loaded = 0;
  const out = [];
  for (const u of urls) {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`${r.status} ${u}`);
    const reader = r.body.getReader();
    const parts = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      n += value.length;
      loaded += value.length;
      self.postMessage({ type: 'progress', loaded, total, stage: 'Downloading model', downloading: true });
    }
    const buf = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.length;
    }
    out.push(buf);
  }
  return { buffers: out, total: loaded };
}

async function load({ runtimeBase, modelBase, files, debug }) {
  self.SHERPA_DEBUG = !!debug;
  const names = ['encoder', 'decoder', 'joiner', 'tokens'];
  const { buffers, total } = await fetchWithProgress(names.map((k) => modelBase + files[k]));

  self.postMessage({ type: 'progress', loaded: 1, total: 1, stage: 'Initialising WebAssembly runtime' });
  await new Promise((resolve, reject) => {
    self.Module = {
      locateFile: (path) => runtimeBase + path,
      // Skip the bundled .data model package (see header comment).
      getPreloadedPackage: () => new ArrayBuffer(0),
      setStatus: () => {},
      print: (t) => self.SHERPA_DEBUG && console.debug('[sherpa-onnx]', t),
      printErr: (t) => console.debug('[sherpa-onnx]', t),
      onRuntimeInitialized: resolve,
      onAbort: (what) => reject(new Error('WASM aborted: ' + what)),
    };
    importScripts(runtimeBase + 'sherpa-onnx-asr.js', runtimeBase + 'sherpa-onnx-wasm-main-asr.js');
  });

  const Module = self.Module;
  Module.FS_createPath('/', 'lab-model', true, true);
  names.forEach((k, i) => Module.FS_createDataFile('/lab-model', files[k], buffers[i], true, false, true));
  const path = (k) => '/lab-model/' + files[k];

  recognizer = createOnlineRecognizer(Module, {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: path('encoder'), decoder: path('decoder'), joiner: path('joiner') },
      tokens: path('tokens'),
      numThreads: 1,
      provider: 'cpu',
      debug: self.SHERPA_DEBUG ? 1 : 0,
      modelType: '',
      modelingUnit: 'cjkchar', // upstream demo default; only used for hotwords (none here)
      bpeVocab: '',
    },
    decodingMethod: 'greedy_search',
    maxActivePaths: 4,
    enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20,
    hotwordsFile: '',
    hotwordsScore: 1.5,
    ctcFstDecoderConfig: { graph: '', maxActive: 3000 },
    ruleFsts: '',
    ruleFars: '',
  });
  if (!recognizer.handle) throw new Error('sherpa-onnx could not create the recognizer (check the model files and the browser console)');
  stream = recognizer.createStream();
  self.postMessage({ type: 'ready', modelBytes: total });
}

function reset() {
  if (stream) stream.free();
  stream = recognizer.createStream();
  lastText = '';
}

function decodeAndEmit() {
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const text = (recognizer.getResult(stream).text || '').trim();
  if (text !== lastText) {
    lastText = text;
    self.postMessage({ type: 'partial', text });
  }
  if (recognizer.isEndpoint(stream)) {
    if (text) self.postMessage({ type: 'final', text });
    recognizer.reset(stream);
    lastText = '';
  }
}

function accept(samples) {
  stream.acceptWaveform(SAMPLE_RATE, samples);
  decodeAndEmit();
}

function flush(id) {
  // Tail padding lets the streaming encoder see right context for the last frames.
  stream.acceptWaveform(SAMPLE_RATE, new Float32Array(SAMPLE_RATE * 0.66));
  stream.inputFinished();
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const text = (recognizer.getResult(stream).text || '').trim();
  if (text) self.postMessage({ type: 'final', text });
  reset();
  self.postMessage({ type: 'flushed', id });
}
