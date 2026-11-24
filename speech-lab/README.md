# Speech Recognition Lab

An isolated benchmark harness for choosing the offline speech engine behind Rehearsal's cue detection. It compares **Sherpa-ONNX** (streaming Zipformer, WebAssembly) and **Vosk** (Kaldi, WebAssembly via vosk-browser). Both run entirely in the browser: no server-side recognition, no paid APIs, and no audio leaves the machine.

The lab lives only in `speech-lab/`. It links the app's design system (`../css/tokens.css`, `base.css`, `shadcn.css`, `../vendor/lucide`, `../js/icons.js`) read-only and changes nothing else in the repository.

## Setup

Needs Python 3.8+ (no packages) and a recent Chromium, Firefox or Safari (see [Browser compatibility](#browser-compatibility)).

```sh
# from the repository root
python3 speech-lab/setup.py        # downloads ~280 MB once, installs ~100 MB, verifies SHA-256
python3 speech-lab/serve.py       # serves the repository root on :8000 with caching off
```

Then open <http://localhost:8000/> and choose **Tests** at the top of the sidebar. The lab opens in the main area, like a script, and keeps its state while you switch to scripts and back. You can also open it on its own at <http://localhost:8000/speech-lab/>. Inside the app it loads with `?embed`, which hides its own header and follows the app's light/dark setting.

- `setup.py` reads every URL and hash from `pins.json`. A download that doesn't match its pinned SHA-256 is rejected. Downloads are cached in `speech-lab/.cache/`, so re-running is cheap. `python3 speech-lab/setup.py --verify` checks an existing install without downloading.
- Installed files go to `speech-lab/vendor/`, `speech-lab/models/` and `speech-lab/samples/`. These folders and `.cache/` are git-ignored (`speech-lab/.gitignore`), so no model or runtime binaries are committed.
- The Sherpa runtime only ships inside a 175 MB release archive that also bundles a large model. `setup.py` keeps just the three runtime files (13 MB) and discards the rest.
- Opening the page from `file://` does not work, because Web Workers and WASM need HTTP. Any static server works. `localhost` counts as a secure context, so the microphone is allowed.
- **Port 8000 already in use?** Run `python3 speech-lab/serve.py 8010` and open `http://localhost:8010/`. No COOP/COEP headers are needed: neither runtime uses threads or `SharedArrayBuffer`.

## Using it

1. **Engines.** Choose the live engine and load the models. Load time and model and runtime sizes appear on each card.
2. **Expected dialogue and cue.** Pick one of your scripts and one of **your lines** (the lines for the character you play, grouped by scene). This fills in the expected dialogue, and the note underneath shows the line you'll hear just before it. **Next line** steps through the script in order. Takes recorded while a line is selected remember it, and the results, JSON and CSV show the script, scene and line number. Scripts are read from the app's local database without ever being changed. The list refreshes when you come back to the lab, or with the reload button. You can also skip the picker and edit the line the actor will say directly; changing the dialogue unlinks the picked line. The cue phrase is filled in automatically from the last *N* words (5 by default). Typing in the cue field switches to manual. You can also adjust the fuzzy threshold, the premature/missed windows and the chunk size.
   **Test full script** opens the picked script in a window and runs through it the way rehearsal would. Reader lines play their recordings (a reader line with no recording is skipped, as in the app), and beats wait their length. On your lines it listens with the chosen engine and moves on as soon as it hears the cue (the last *N* words of your line, with exact or fuzzy matching). Each of your lines then shows how long after you stopped speaking the script moved on. **Skip** (or the → key) moves on by hand. Click any line before starting to begin there; by default the run starts at the scene of the picked line. Your lines are saved as takes, already linked to their lines, so you can benchmark them afterwards. Use headphones: the microphone only feeds the engine while it's listening for your line, but reader audio from speakers can still bleed into your take.
3. **Live microphone.** Start, speak, Stop. Partials (in italics) and finals stream in, and recognised cue words are highlighted: green for an exact match, amber for a fuzzy-only match. With **Save as take** on, the recording becomes a take.
4. **Takes and cue annotation.** Click the waveform, or type a time, to mark where the cue actually ends. A suggestion based on the end of speech is pre-filled (marked "suggested"); check it with **Audition cue end**. You can also load WAV or other audio files. `samples/librispeech-0.wav` is a ready-made test clip; its transcript is in `pins.json`.
5. **Benchmark.** Replays every take into each selected engine at real-time speed, then shows a side-by-side summary and per-take results. Export as JSON (including every raw recognition event) or CSV.

Takes are held in memory only. Download a take's WAV to keep it; loading it again gives the same 16 kHz samples, because the saved WAV is already preprocessed.

## How the benchmark stays fair

- **Same audio.** Each take is stored once as preprocessed 16 kHz mono Float32 PCM. Live microphone audio and loaded files go through the same `Resampler` in `js/audio.js` (a windowed-sinc low-pass plus resampling, used even for 16 kHz input). Both engines get the exact same sample arrays, and vosk-browser's own int16 scaling is the only engine-specific step.
- **Real-time replay.** Audio is sent in fixed chunks (100 ms by default). Chunk *i* is delivered at `t0 + (i+1) × chunk`, the moment it would have finished arriving from a microphone. Event times on the wall clock therefore equal positions in the audio, and include the chunking delay a live app would have. The trailing silence after each take (1.5 s by default) gives endpointing a chance to fire. The timer drift at the end of each replay is recorded as `timerDriftMs`.
- **Same timing point.** Every result is time-stamped when it reaches the main thread (`performance.now()` in the adapter base class), after worker and messaging overhead, for both engines.
- **One engine at a time.** Engines run one after another, so they never compete for CPU.
- **Same cue logic.** Cue matching runs on the engines' text output only. Detection is computed afterwards from the recorded events, so changing the cue, the threshold or an annotation re-scores the existing runs without re-running recognition.

## Metrics

| Metric | Definition |
|---|---|
| Detection time | First event, partial or final, after which the running transcript (finals plus current partial) contains the cue |
| Latency | Detection time minus the annotated cue end. Positive means after the actor finished the cue. |
| Premature | Detection more than *premature tolerance* (0.25 s by default) before the annotated end |
| Missed | No detection, or detection more than *max latency* (3 s by default) after the end |
| Exact match | The cue's normalised words appear contiguously |
| Fuzzy match | A window of *n*−1 to *n*+1 heard words has character-level similarity (1 − Levenshtein / length) of at least the threshold |
| WER | Word error rate of the final transcript against the take's expected dialogue |
| Model load time | From `load()` until the recogniser is ready, including download from the local server and initialisation (see caching note) |
| Model / runtime size | Bytes transferred for model files and for the runtime JS/WASM |

Normalisation for both matching and WER: lowercase, apostrophes removed (*don't* becomes *dont*), other punctuation replaced by spaces, and numbers 0–12 spelled out.

**Caching caveat:** after the first load, Vosk keeps the unpacked model in IndexedDB (IDBFS, database `/vosk`), so its later loads skip most of the work. `serve.py` turns off HTTP caching, so Sherpa re-downloads its files from the local server on every load; with another server, the browser cache may serve them instead. Cold and warm load times can differ a lot. For a cold measurement, use a fresh private window, or clear site data for localhost.

## Architecture

```
speech-lab/
  index.html, lab.css     UI (Rehearsal design system + lab-only styles)
  pins.json               Pinned versions, URLs, SHA-256s, licences (single source of truth)
  setup.py                Downloads + verifies + installs pinned assets
  js/
    app.js                UI wiring only
    audio.js              Shared preprocessing: mic capture (AudioWorklet), Resampler, Chunker, WAV I/O
    cue.js                Cue matching, transcript state, classification, WER (no engine knowledge)
    scripts.js            Read-only access to the app's scripts (IndexedDB) for the line picker
    fullrun.js            "Test full script": walks a whole script with one engine, like rehearsal
    bench.js              Real-time replay runner + metric aggregation
    export.js             JSON / CSV export
    engines/
      adapter.js          The adapter contract all engines implement
      sherpa.js           Sherpa-ONNX adapter (main thread side)
      sherpa-worker.js    Sherpa-ONNX WASM runtime in a Web Worker
      vosk.js             Vosk adapter (vosk-browser runs its own worker)
```

Adapter contract (`js/engines/adapter.js`): `load(onProgress) → {loadMs, modelBytes, runtimeBytes}`, `reset()`, `feed(Float32Array @ 16 kHz)`, `flush()`, `onResult({type: 'partial'|'final', text, at})`, `dispose()`. To add an engine, implement this contract and register it in `app.js`. Nothing in `cue.js` or `bench.js` needs to change.

**How the Sherpa model is loaded.** The prebuilt sherpa-onnx WASM ASR bundle embeds a large fp32 model in an Emscripten `.data` package. The worker skips that package through Emscripten's `Module.getPreloadedPackage` hook, which returns an empty buffer. It then fetches the pinned 20M int8 model itself, with download progress, and writes it into the WASM filesystem with `FS_createDataFile`.

## Pinned versions

| Component | Version | Source | Licence |
|---|---|---|---|
| sherpa-onnx WASM runtime (SIMD, single-thread) | v1.13.7 (2026-09-01): the latest release that publishes an English ASR WASM build. v1.13.8 through v2.0.3 ship WASM builds for TTS/VAD only. | GitHub release asset | Apache-2.0 |
| Sherpa model: `sherpa-onnx-streaming-zipformer-en-20M-2023-02-17` (int8 encoder/joiner, fp32 decoder, ~43 MB) | HF revision `d42f2d9` | huggingface.co/csukuangfj | Apache-2.0 (model card). Trained on LibriSpeech (CC BY 4.0). |
| vosk-browser | 0.0.8 (2022-12-25, latest) | npm registry tarball | Apache-2.0 |
| Vosk model: `vosk-model-small-en-us-0.15` (~39 MB) | 0.15 | alphacephei.com, repacked deterministically to `.tar.gz` | Apache-2.0 (Vosk models page) |

All file hashes are in `pins.json`.

## Commercial licensing notes

Checked on 2026-11-24 against the upstream repositories, npm metadata, the Hugging Face model card and the Vosk models page. This is not legal advice; have the licences reviewed before shipping.

- **Sherpa-ONNX:** Apache-2.0, which allows commercial use, modification and redistribution. Keep the licence and any NOTICE text. The WASM build statically includes onnxruntime (MIT) and other permissive dependencies.
- **Zipformer 20M model:** Apache-2.0 according to its Hugging Face card. Its training data, LibriSpeech, is CC BY 4.0. That licence generally attaches to the data rather than the trained weights, but crediting it is good practice.
- **vosk-browser, Vosk and Kaldi:** all Apache-2.0. The vosk-browser bundle also includes permissive third-party code (libarchive, zlib, tslib).
- **vosk-model-small-en-us-0.15:** listed as Apache-2.0. Some other Vosk models are **not** (for example, `vosk-model-small-en-us-zamia-0.5` is LGPL-3.0, and some large models carry other terms). Check the licence of any model you swap in.
- **Maintenance risk:** vosk-browser has had no release since December 2022. sherpa-onnx is very active, but its English ASR WASM release asset stopped after v1.13.7. Future upgrades may mean building the WASM runtime from source with Emscripten, using the scripts in the sherpa-onnx repo.

## Browser compatibility

| Requirement | Used by | Support |
|---|---|---|
| WebAssembly SIMD | Sherpa runtime (SIMD build) | Chrome/Edge 91+, Firefox 89+, Safari 16.4+ |
| Web Workers, `fetch` streams | both | all current browsers |
| IndexedDB | Vosk (model cache) | all current browsers; may be unavailable in some private modes |
| AudioWorklet, `getUserMedia` | live microphone | Chrome 66+, Firefox 76+, Safari 14.1+; needs a secure context (`localhost` qualifies) |

Neither runtime needs cross-origin isolation (`SharedArrayBuffer`), so a plain static server is enough. The lab was tested end to end in headless Chrome. Firefox and Safari have not been tested; vosk-browser's issue tracker has past reports of Safari problems.

## Known limitations

- Takes aren't saved between reloads. Keep the WAV downloads and the JSON exports.
- Each take has one cue. If the cue words occur earlier in the dialogue, the earlier occurrence fires first, which counts as premature; that is intended, because the real app would fire there too.
- Vosk's `flush()` has no explicit acknowledgement, so it waits until results stop arriving for 400 ms. This affects only the final transcript, not cue timing.
- Model load time includes fetching from the local server, so it underestimates load time over a real network.
