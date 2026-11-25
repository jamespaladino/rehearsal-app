// Browser debug view for the script importer. UI only: parsing lives in src/.
import { importScript, toRehearsalScript, FLAGS } from './src/index.js';

const $ = (id) => document.getElementById(id);
const PDFJS = new URL('../vendor/pdfjs-4.10.38/pdf.min.mjs', import.meta.url).href;
const PDF_WORKER = new URL('../vendor/pdfjs-4.10.38/pdf.worker.min.mjs', import.meta.url).href;
const TYPE_LABEL = { scene_heading: 'Scene heading', action: 'Action', character: 'Character', parenthetical: 'Parenthetical', dialogue: 'Dialogue', transition: 'Transition' };

let pdfjs = null;
let current = null; // { result, fileName }
let me = null;

async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import(PDFJS);
    pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER;
  }
  return pdfjs;
}

async function handleFile(file) {
  if (!file) return;
  $('status').textContent = `Reading ${file.name}…`;
  $('result').classList.add('hidden');
  $('saved').textContent = '';
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const isPdf = data.length > 4 && String.fromCharCode(...data.subarray(0, 4)) === '%PDF';
    const t0 = performance.now();
    const result = await importScript({ name: file.name, data }, { pdfjs: isPdf ? await loadPdfjs() : null });
    current = { result, fileName: file.name };
    me = result.characters[0]?.name || null;
    $('status').textContent = `Imported ${file.name} in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
    render();
  } catch (e) {
    console.error(e);
    $('status').textContent = `Couldn't import ${file.name}: ${e.message}`;
  }
}

function render() {
  const { result, fileName } = current;
  $('result').classList.remove('hidden');
  const s = result.stats;
  $('summary').innerHTML = '';
  $('summary').append(
    el('strong', result.title || fileName),
    el('span', ` · ${result.source.toUpperCase()}${s.pages ? ` · ${s.pages} pages` : ''} · ${s.blocks} blocks · `),
    el('span', `${s.review} to review`, s.review ? 'review-count' : ''),
  );
  $('warnings').replaceChildren(...result.warnings.map((w) => {
    const a = el('div', '', 'alert import-warning');
    a.setAttribute('role', 'alert');
    a.append(el('div', w, 'alert-description'));
    return a;
  }));
  $('title').value = result.title || fileName.replace(/\.[^.]+$/, '');
  renderCharacters();
  renderBlocks();
}

function renderCharacters() {
  const { result } = current;
  const box = $('characters');
  if (!result.characters.length) {
    box.replaceChildren(el('p', 'No characters found.', 'muted'));
    return;
  }
  box.replaceChildren(...result.characters.map((c) => {
    const label = el('label', '', 'import-character');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'me';
    input.value = c.name;
    input.checked = c.name === me;
    input.onchange = () => { me = c.name; };
    const meta = `${c.speeches} speech${c.speeches === 1 ? '' : 'es'}${c.extensions.length ? ` · ${c.extensions.join(', ')}` : ''}`;
    label.append(input, el('span', c.name), el('span', meta, 'muted'));
    return label;
  }));
}

function renderBlocks() {
  const { result } = current;
  const only = $('onlyReview').checked;
  const rows = [];
  for (const b of result.blocks) {
    if (only && !b.review) continue;
    const tr = document.createElement('tr');
    if (b.review) tr.className = 'needs-review';
    const conf = el('td', b.confidence.toFixed(2), 'conf ' + (b.confidence < 0.6 ? 'conf-low' : b.confidence < 0.85 ? 'conf-mid' : 'conf-high'));
    const textCell = el('td', '', `block-text type-${b.type}`);
    textCell.append(el('div', b.text));
    const notes = [];
    if (b.meta.character && b.type !== 'character') notes.push(b.meta.character);
    if (b.type === 'character' && b.meta.extensions?.length) notes.push(b.meta.extensions.join(' '));
    if (b.meta.sceneNumber) notes.push(`scene ${b.meta.sceneNumber}`);
    if (b.meta.dual) notes.push(`dual: ${b.meta.dual}`);
    if (b.meta.revised) notes.push('revised');
    if (notes.length || b.flags.length) {
      const n = el('div', '', 'block-notes');
      notes.forEach((t) => n.append(el('span', t, 'muted')));
      b.flags.forEach((f) => {
        const chip = el('span', f.replace(/_/g, ' '), 'flag' + (b.review ? ' flag-review' : ''));
        chip.title = FLAGS[f] || f;
        n.append(chip);
      });
      textCell.append(n);
    }
    const idCell = el('td', String(b.id), 'num');
    if (b.review) idCell.prepend(el('span', '', 'review-dot'));
    tr.append(idCell, el('td', b.page ?? '–', 'num'), el('td', TYPE_LABEL[b.type], 'type'), conf, textCell);
    rows.push(tr);
  }
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = el('td', only ? 'Nothing needs review.' : 'No blocks.', 'muted');
    td.colSpan = 5;
    tr.append(td);
    rows.push(tr);
  }
  $('blocks').replaceChildren(...rows);
}

// Save as a new script in Rehearsal's own IndexedDB store (same origin as the app).
async function save() {
  if (!current) return;
  const script = toRehearsalScript(current.result, { title: $('title').value.trim() || undefined, meCharacter: me || undefined });
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
    const turns = script.turns.length;
    $('saved').replaceChildren(`Saved "${script.title}" (${turns} blocks, you are ${script.meCharacter}). `, link('../', 'Open it in Rehearsal'));
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
function link(href, text) {
  const a = el('a', text);
  a.href = href;
  return a;
}

window.renderIcons?.(); // swap the <i data-lucide> placeholders for icons (js/icons.js)

$('file').onchange = (e) => handleFile(e.target.files[0]);
$('onlyReview').onchange = () => current && renderBlocks();
$('save').onclick = save;
const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragging'); });
drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('dragging'); handleFile(e.dataTransfer.files[0]); });

// Test hook for automated checks.
window.__import = { handleFile, get current() { return current; } };
