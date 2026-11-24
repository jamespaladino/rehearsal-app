// Shared audio preprocessing. Every engine receives audio produced by this module,
// whether it comes from the live microphone or a replayed take:
//
//   source (any rate, mono) -> Resampler (windowed-sinc low-pass + resample) -> 16 kHz Float32 [-1, 1]
//   -> Chunker (fixed-size chunks, default 100 ms) -> adapter.feed(chunk)
//
// The live path and the take path use the same Resampler class with the same settings, so a
// recorded take is bit-identical to what a live engine would have received.

export const MODEL_RATE = 16000;

// Streaming windowed-sinc resampler. Works for any input rate, including 16 kHz (which still
// passes through the same low-pass so all inputs are treated alike).
export class Resampler {
  constructor(inRate, outRate = MODEL_RATE, zeroCrossings = 16) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.step = inRate / outRate; // input samples per output sample
    this.fc = Math.min(1, outRate / inRate) * 0.9; // cutoff, as a fraction of the input Nyquist
    this.half = Math.ceil(zeroCrossings / this.fc); // kernel half-width in input samples
    this.buf = new Float32Array(this.half); // leading zeros so output 0 aligns with input 0
    this.pos = this.half; // input position (within buf) of the next output sample
  }

  process(input) {
    const merged = new Float32Array(this.buf.length + input.length);
    merged.set(this.buf);
    merged.set(input, this.buf.length);
    const out = [];
    const { half, fc } = this;
    while (this.pos + half < merged.length) {
      const p = this.pos;
      const k0 = Math.ceil(p - half);
      const k1 = Math.floor(p + half);
      let acc = 0;
      let norm = 0;
      for (let k = k0; k <= k1; k++) {
        const t = k - p;
        const x = fc * t;
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const w = 0.5 * (1 + Math.cos((Math.PI * t) / half)); // Hann window
        const h = sinc * w;
        acc += merged[k] * h;
        norm += h;
      }
      out.push(acc / norm);
      this.pos += this.step;
    }
    // Keep only the history the next call still needs.
    const keepFrom = Math.max(0, Math.floor(this.pos - half));
    this.buf = merged.slice(keepFrom);
    this.pos -= keepFrom;
    return Float32Array.from(out);
  }

  flush() {
    return this.process(new Float32Array(this.half + 1));
  }
}

// Resample a whole buffer with the same streaming code path.
export function resampleAll(samples, inRate) {
  const r = new Resampler(inRate);
  const a = r.process(samples);
  const b = r.flush();
  // Trim the flush padding so the output length matches the input duration.
  const expected = Math.round((samples.length * MODEL_RATE) / inRate);
  const out = new Float32Array(expected);
  out.set(a.subarray(0, Math.min(a.length, expected)));
  if (a.length < expected) out.set(b.subarray(0, expected - a.length), a.length);
  return out;
}

// Splits a stream of samples into fixed-size chunks.
export class Chunker {
  constructor(size, onChunk) {
    this.size = size;
    this.onChunk = onChunk;
    this.pending = new Float32Array(0);
  }
  push(samples) {
    const merged = new Float32Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);
    let i = 0;
    for (; i + this.size <= merged.length; i += this.size) this.onChunk(merged.slice(i, i + this.size));
    this.pending = merged.slice(i);
  }
  flush() {
    if (this.pending.length) this.onChunk(this.pending);
    this.pending = new Float32Array(0);
  }
}

// ---- Microphone capture ----------------------------------------------------

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const n = input[0].length;
      const mono = new Float32Array(n);
      for (const ch of input) for (let i = 0; i < n; i++) mono[i] += ch[i] / input.length;
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor('lab-tap', Tap);
`;

// Opens the microphone. onSamples(Float32Array at 16 kHz) is called as audio arrives.
// Returns { stop(): Promise<{ raw16k: Float32Array }>, nativeRate }.
export async function openMicrophone({ voiceProcessing = true, onSamples }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: voiceProcessing,
      noiseSuppression: voiceProcessing,
      autoGainControl: voiceProcessing,
    },
    video: false,
  });
  const ctx = new AudioContext();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const source = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, 'lab-tap', { numberOfInputs: 1, numberOfOutputs: 0 });
  const resampler = new Resampler(ctx.sampleRate);
  const recorded = [];
  tap.port.onmessage = (e) => {
    const out = resampler.process(e.data);
    if (!out.length) return;
    recorded.push(out);
    onSamples(out);
  };
  source.connect(tap);

  return {
    nativeRate: ctx.sampleRate,
    async stop() {
      tap.port.onmessage = null;
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
      const tail = resampler.flush();
      if (tail.length) onSamples(tail);
      recorded.push(tail);
      return { raw16k: concat(recorded) };
    },
  };
}

export function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---- WAV in/out --------------------------------------------------------------

// Parses a PCM (8/16/24/32-bit int) or IEEE float WAV into mono Float32 at its native rate.
export function parseWav(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let o = 12;
  let fmt = null;
  while (o + 8 <= v.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      fmt = {
        format: v.getUint16(body, true),
        channels: v.getUint16(body + 2, true),
        rate: v.getUint32(body + 4, true),
        bits: v.getUint16(body + 14, true),
      };
      if (fmt.format === 0xfffe) fmt.format = v.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
    } else if (id === 'data' && fmt) {
      const bytes = fmt.bits / 8;
      const frames = Math.floor(Math.min(size, v.byteLength - body) / (bytes * fmt.channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const p = body + (i * fmt.channels + c) * bytes;
          let s;
          if (fmt.format === 3 && fmt.bits === 32) s = v.getFloat32(p, true);
          else if (fmt.bits === 16) s = v.getInt16(p, true) / 32768;
          else if (fmt.bits === 8) s = (v.getUint8(p) - 128) / 128;
          else if (fmt.bits === 24) s = ((v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16)) / 8388608);
          else if (fmt.bits === 32) s = v.getInt32(p, true) / 2147483648;
          else throw new Error(`Unsupported WAV bit depth: ${fmt.bits}`);
          sum += s;
        }
        out[i] = sum / fmt.channels;
      }
      return { samples: out, rate: fmt.rate };
    }
    o = body + size + (size % 2);
  }
  throw new Error('WAV file has no audio data');
}

// Decodes any audio file to mono Float32 at its native rate (WAV parsed directly; other
// formats via the browser decoder at 48 kHz).
export async function decodeAudioFile(file) {
  const buf = await file.arrayBuffer();
  try {
    return parseWav(buf);
  } catch (e) {
    const ctx = new OfflineAudioContext(1, 1, 48000);
    const audio = await ctx.decodeAudioData(buf);
    const mono = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const d = audio.getChannelData(c);
      for (let i = 0; i < d.length; i++) mono[i] += d[i] / audio.numberOfChannels;
    }
    return { samples: mono, rate: audio.sampleRate };
  }
}

// Encodes 16 kHz mono Float32 as a 16-bit PCM WAV Blob.
export function encodeWav(samples, rate = MODEL_RATE) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// Plays 16 kHz samples from `from` seconds. Returns a stop() function.
export function playSamples(samples, from = 0, to = null, onEnded) {
  const ctx = new AudioContext();
  const buffer = ctx.createBuffer(1, samples.length, MODEL_RATE);
  buffer.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  const startedAt = ctx.currentTime;
  const duration = to == null ? undefined : Math.max(0, to - from);
  src.start(0, from, duration);
  src.onended = () => {
    ctx.close();
    onEnded && onEnded();
  };
  return {
    position: () => from + (ctx.currentTime - startedAt),
    stop: () => {
      try { src.stop(); } catch (e) { /* already stopped */ }
    },
  };
}

// Suggests where speech ends: the end of the last 20 ms frame whose RMS is within 30 dB of
// the loudest frame. A starting point for annotation, not a ground truth.
export function suggestSpeechEnd(samples, rate = MODEL_RATE) {
  const frame = Math.round(rate * 0.02);
  const rms = [];
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let s = 0;
    for (let j = i; j < i + frame; j++) s += samples[j] * samples[j];
    rms.push(Math.sqrt(s / frame));
  }
  const peak = Math.max(...rms, 1e-9);
  const threshold = peak * Math.pow(10, -30 / 20);
  for (let i = rms.length - 1; i >= 0; i--) if (rms[i] >= threshold) return ((i + 1) * frame) / rate;
  return samples.length / rate;
}
