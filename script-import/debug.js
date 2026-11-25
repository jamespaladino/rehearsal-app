// Standalone debug view for the script importer (the app has its own import flow; both use
// review-ui.js). UI only: parsing lives in src/.
import { readScriptFile, createImportReview, describe } from './review-ui.js';

const $ = (id) => document.getElementById(id);
let fileName = '';

const review = createImportReview({
  characters: $('characters'),
  labelledBy: 'youTitle',
  blocks: $('blocks'),
  filter: $('filter'),
  onChange: renderSummary,
});

async function handleFile(file) {
  if (!file) return;
  $('status').textContent = `Reading ${file.name}…`;
  $('result').classList.add('hidden');
  $('saved').textContent = '';
  try {
    const t0 = performance.now();
    const result = await readScriptFile(file);
    fileName = file.name;
    $('title').value = result.title || file.name.replace(/\.[^.]+$/, '');
    $('result').classList.remove('hidden');
    review.load(result);
    $('status').textContent = `Imported ${file.name} in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
  } catch (e) {
    console.error(e);
    $('status').textContent = `Couldn't import ${file.name}: ${e.message}`;
  }
}

function renderSummary() {
  const r = review.result;
  $('summary').replaceChildren(
    el('strong', r.title || fileName),
    el('span', ` · ${describe(r)} · `),
    el('span', `${r.stats.review} to review`, r.stats.review ? 'review-count' : ''),
  );
  if (r.edits) $('summary').append(el('span', ` · ${r.edits} edit${r.edits === 1 ? '' : 's'}`));
  $('undo').classList.toggle('hidden', !review.canUndo);
  $('warnings').replaceChildren(...r.warnings.map((w) => {
    const a = el('div', '', 'alert import-warning');
    a.setAttribute('role', 'alert');
    a.append(el('div', w, 'alert-description'));
    return a;
  }));
}

// Save as a new script in Rehearsal's own IndexedDB store (same origin as the app).
async function save() {
  if (!review.result) return;
  const script = review.toScript({ title: $('title').value.trim() });
  script.lastUsed = Date.now();
  try {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('rehearsal-v1', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('scripts', { keyPath: 'id' });
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('scripts', 'readwrite');
        tx.objectStore('scripts').put(script);
        tx.oncomplete = () => { req.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
    try { localStorage.setItem('rehearsal-last-opened', script.id); } catch (e) { /* private mode */ }
    const link = el('a', 'Open it in Rehearsal');
    link.href = '../';
    $('saved').replaceChildren(`Saved "${script.title}" (${script.turns.length} blocks, you are ${script.meCharacter}). `, link);
  } catch (e) {
    $('saved').textContent = `Couldn't save: ${e.message}`;
  }
}

function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (className) e.className = className;
  return e;
}

window.renderIcons?.(); // swap the <i data-lucide> placeholders for icons (js/icons.js)

// Follow theme changes made in the app (light, dark or system).
function applyTheme() {
  let t = 'light';
  try { t = localStorage.getItem('rehearsal-theme') || 'light'; } catch (e) { /* private mode */ }
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
window.addEventListener('storage', (e) => { if (e.key === 'rehearsal-theme') applyTheme(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

$('file').onchange = (e) => handleFile(e.target.files[0]);
$('save').onclick = save;
$('undo').onclick = () => review.undo();
const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragging'); });
drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('dragging'); handleFile(e.dataTransfer.files[0]); });

// Test hook for automated checks.
window.__import = { handleFile, get current() { return review.result && { result: review.result }; } };
