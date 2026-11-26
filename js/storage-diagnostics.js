// Run in the main page so the probe uses the same browser context as the script editor.
(() => {
  const save = $('saveStorageProbe');
  const check = $('checkStorageProbe');
  const status = $('storageProbeStatus');
  const report = $('storageProbeReport');
  const player = $('storageProbeAudio');
  const markerKey = 'rehearsal-storage-probe';
  let audioUrl;

  function describeError(error) {
    return [error?.name, error?.message].filter(Boolean).join(': ') || 'Unknown error';
  }

  async function readResult(read) {
    try { return await read(); }
    catch (error) { return { error: describeError(error) }; }
  }

  async function probeStorage(mode, operation) {
    const probe = await new Promise((resolve, reject) => {
      const request = indexedDB.open('rehearsal-storage-diagnostics', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('samples');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = probe.transaction('samples', mode);
        const request = operation(transaction.objectStore('samples'));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error || request.error);
      });
    } finally {
      probe.close();
    }
  }

  async function recordingInventory() {
    const scripts = await getAll();
    const recordings = scripts.flatMap(script => script.turns || []).filter(turn => turn.audio);
    return {
      scripts: scripts.length,
      recordings: recordings.length,
      bytes: recordings.reduce((sum, turn) => sum + (turn.audio.size || 0), 0),
      empty: recordings.filter(turn => !turn.audio.size).length,
    };
  }

  // Each script recording, saved and in memory: which line it's on, and whether its bytes can
  // actually be read and decoded (a stored size alone doesn't prove the audio is still there).
  async function checkRecording(audio) {
    let data;
    try { data = await audio.arrayBuffer(); }
    catch (error) { return `read failed (${describeError(error)})`; }
    if (!data.byteLength) return 'read returned 0 bytes';
    const Context = window.AudioContext || window.webkitAudioContext;
    const context = new Context();
    try { return `decodes, ${(await context.decodeAudioData(data)).duration.toFixed(1)} s`; }
    catch (error) { return `read ${data.byteLength} bytes, decode failed (${describeError(error)})`; }
    finally { context.close(); }
  }

  async function recordingDetails() {
    const lines = [];
    const describe = async (label, scripts) => {
      for (const saved of scripts) {
        for (const [index, turn] of (saved.turns || []).entries()) {
          if (!turn.audio) continue;
          const who = turn.who === 'them' ? `reader ${turn.character || ''}`.trim() : `who=${turn.who}`;
          const size = turn.audio.size ?? 'no size';
          const type = turn.audio.type || 'no type';
          lines.push(`  ${label} "${saved.title || 'Untitled'}" block ${index + 1} (${who}): ${size} bytes · ${type} · ${await checkRecording(turn.audio)}`);
        }
        const unrecorded = (saved.turns || []).filter(turn => turn.who === 'them' && !turn.audio).length;
        lines.push(`  ${label} "${saved.title || 'Untitled'}": ${unrecorded} reader lines without audio`);
      }
    };
    await describe('Saved', await getAll());
    if (typeof script !== 'undefined' && script) await describe('Open', [script]);
    return lines.length ? lines.join('\n') : '  None';
  }

  async function recordSample() {
    const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      return await new Promise((resolve, reject) => {
        const capture = new MediaRecorder(microphone);
        const pieces = [];
        let stopTimer, timeout;
        const clearTimers = () => { clearTimeout(stopTimer); clearTimeout(timeout); };
        capture.ondataavailable = event => { if (event.data.size) pieces.push(event.data); };
        capture.onstop = () => {
          clearTimers();
          resolve(new Blob(pieces, { type: capture.mimeType || pieces[0]?.type }));
        };
        capture.onerror = event => { clearTimers(); reject(event.error); };
        capture.start();
        stopTimer = setTimeout(() => { if (capture.state !== 'inactive') capture.stop(); }, 2000);
        timeout = setTimeout(() => reject(new Error('The recorder did not finish.')), 7000);
      });
    } finally {
      microphone.getTracks().forEach(track => track.stop());
    }
  }

  function showSample(audio) {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = audio?.size ? URL.createObjectURL(audio) : undefined;
    if (audioUrl) player.src = audioUrl;
    else player.removeAttribute('src');
    player.classList.toggle('hidden', !audioUrl);
  }

  async function inspectStorage() {
    const [sample, marker, inventory, persisted, estimate] = await Promise.all([
      readResult(() => probeStorage('readonly', store => store.get('latest'))),
      readResult(() => JSON.parse(localStorage.getItem(markerKey))),
      readResult(recordingInventory),
      readResult(() => navigator.storage?.persisted?.()),
      readResult(() => navigator.storage?.estimate?.()),
    ]);
    const details = await readResult(recordingDetails);
    showSample(sample?.audio);
    const savedAt = sample?.savedAt || marker?.savedAt;
    const baseline = sample?.inventory || marker?.inventory;
    const sampleResult = sample?.error ? `Read failed (${sample.error})`
      : sample?.audio?.size ? `${sample.audio.size} bytes · ${sample.audio.type || 'unknown format'}`
      : sample ? 'Sample has no audio bytes' : 'No sample found';
    report.textContent = [
      `Context: ${installed() ? 'Home Screen app' : 'Browser tab'} · ${location.origin}${location.pathname}`,
      `Browser: ${navigator.userAgent}`,
      `Test recording in IndexedDB: ${sampleResult}`,
      `Test marker in local storage: ${marker?.error || (marker ? 'Found' : 'Missing')}`,
      savedAt && `Test saved: ${new Date(savedAt).toLocaleString()}`,
      inventory.error ? `Script database: Read failed (${inventory.error})`
        : `Script database: ${inventory.scripts} scripts · ${inventory.recordings} recordings · ${inventory.bytes} bytes · ${inventory.empty} empty recordings`,
      `Script recordings:\n${details?.error ? `  Check failed (${details.error})` : details}`,
      baseline && !baseline.error && `When test was saved: ${baseline.scripts} scripts · ${baseline.recordings} recordings · ${baseline.bytes} bytes`,
      `Persistent storage: ${persisted?.error || (persisted === undefined ? 'Unavailable' : persisted ? 'Granted' : 'Not granted')}`,
      estimate?.quota != null && `Estimated storage: ${estimate.usage} of ${estimate.quota} bytes used`,
    ].filter(Boolean).join('\n');
    if (marker && !marker.error && !sample) return 'The local storage marker survived, but the IndexedDB test recording is missing.';
    if (sample?.audio?.size) return 'Test audio is present. Play it below to check playback.';
    return 'No playable test sample found in this context.';
  }

  async function run(record) {
    if (check.disabled) return;
    save.disabled = check.disabled = true;
    let result;
    try {
      if (record) {
        status.textContent = 'Recording a two-second sample…';
        let stage = 'Capture';
        try {
          const audio = await recordSample();
          if (!audio.size) throw new Error('The recorder returned zero bytes.');
          stage = 'IndexedDB write';
          status.textContent = 'Saving the sample…';
          const witness = { savedAt: Date.now(), inventory: await readResult(recordingInventory) };
          await probeStorage('readwrite', store => store.put({ ...witness, audio }, 'latest'));
          stage = 'Local storage marker write';
          localStorage.setItem(markerKey, JSON.stringify(witness));
        } catch (error) {
          result = `${stage} failed. ${describeError(error)}`;
        }
      } else status.textContent = 'Checking recording storage…';
      const summary = await inspectStorage();
      status.textContent = result || summary;
    } catch (error) {
      status.textContent = `Storage check failed. ${describeError(error)}`;
    } finally {
      save.disabled = check.disabled = false;
    }
  }

  save.onclick = () => run(true);
  check.onclick = () => run(false);
  player.onerror = () => {
    if (audioUrl) status.textContent = `Test audio is stored, but playback failed. ${player.error?.message || ''}`.trim();
  };
  document.addEventListener('storage-diagnostics-open', () => run(false));
  window.addEventListener('pageshow', () => { if (!$('storageTestPanel').closest('.hidden')) run(false); });
})();
