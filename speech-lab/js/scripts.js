// Read-only access to the main Rehearsal app's scripts (IndexedDB "rehearsal-v1", store "scripts").
// The lab shares the app's origin, so it can read them directly. It never writes.
//
// Safety: opening a database that doesn't exist creates it. If the app hasn't created
// "rehearsal-v1" yet, an empty one made here would stop the app's own setup from running,
// so any version upgrade is aborted and we report "no scripts" instead.

const DB_NAME = 'rehearsal-v1';
const STORE = 'scripts';

// Same rule the app uses for scene headings (js/app.js: SCENE_HEADING).
const SCENE_HEADING = /^\s*(INT|EXT)[.\s/]/i;

function openReadOnly() {
  return new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME);
    } catch (e) {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => req.transaction.abort(); // never create or upgrade the app's DB
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.close();
        resolve(null);
        return;
      }
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

// Turns a stored script into the actor's lines ("me" turns with text), with scene and context.
export function linesOf(script) {
  const turns = Array.isArray(script.turns) ? script.turns : [];
  const meName = (script.meCharacter || 'ME').trim();
  const lines = [];
  let scene = null;
  let sceneNo = 0;
  let lineInScene = 0;
  let previous = null; // last spoken line before this one (usually the reader's cue-in)
  turns.forEach((t, index) => {
    const text = (t.text || '').trim();
    if (t.who === 'heading' && SCENE_HEADING.test(text)) {
      sceneNo += 1;
      scene = text;
      lineInScene = 0;
      previous = null;
      return;
    }
    if (t.who === 'me' && text) {
      lineInScene += 1;
      lines.push({
        turnIndex: index,
        scene: scene || (sceneNo ? `Scene ${sceneNo}` : 'Opening'),
        sceneNo,
        lineInScene,
        character: (t.character || meName).trim(),
        text,
        previous,
      });
    }
    if ((t.who === 'me' || t.who === 'them') && text) {
      previous = { character: (t.character || (t.who === 'me' ? meName : 'Reader')).trim(), text };
    }
  });
  return lines;
}

// Lists the app's scripts, most recently used first, each with its actor lines.
export async function listScripts() {
  const db = await openReadOnly();
  if (!db) return [];
  const all = await new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
  db.close();
  return all
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))
    .map((s) => ({ id: s.id, title: s.title || 'Untitled script', lines: linesOf(s) }));
}

// One stored script in full (turns, reader recordings as Blobs), or null.
export async function getScript(id) {
  const db = await openReadOnly();
  if (!db) return null;
  const script = await new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
  db.close();
  return script;
}

// Short label for a line, used in the picker and on takes.
export function lineLabel(line, max = 70) {
  const t = line.text.length > max ? line.text.slice(0, max - 1) + '…' : line.text;
  return `${line.lineInScene}. ${line.character}: ${t}`;
}
