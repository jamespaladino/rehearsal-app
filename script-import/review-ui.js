// Import review UI, shared by the app's import flow (js/app.js) and the standalone debug page
// (script-import/index.html). DOM only: parsing lives in src/.
//
//   const result = await readScriptFile(file);
//   const review = createImportReview({ characters, blocks, onlyReview, onChange });
//   review.load(result);            // renders the character list and the block table
//   review.toScript({ title });     // Rehearsal script, using the chosen character and every edit

import { importScript, toRehearsalScript, retypeBlock, acceptBlock, deleteBlock, BLOCK_TYPES, FLAGS } from './src/index.js';

const PDFJS = new URL('../vendor/pdfjs-4.10.38/pdf.min.mjs', import.meta.url).href;
const PDF_WORKER = new URL('../vendor/pdfjs-4.10.38/pdf.worker.min.mjs', import.meta.url).href;
export const TYPE_LABEL = { scene_heading: 'Scene heading', action: 'Action', character: 'Character', parenthetical: 'Parenthetical', dialogue: 'Dialogue', transition: 'Transition' };
export const ACCEPT = '.pdf,.fountain,.spmd,.fdx,.txt,application/pdf';

let pdfjs = null;
async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import(PDFJS);
    pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER;
  }
  return pdfjs;
}

/** Reads a File (PDF, Fountain, FDX) into an ImportResult. pdf.js loads only for PDFs. */
export async function readScriptFile(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const isPdf = data.length > 4 && String.fromCharCode(...data.subarray(0, 4)) === '%PDF';
  return importScript({ name: file.name, data }, { pdfjs: isPdf ? await loadPdfjs() : null });
}

/** "PDF · 5 pages · 25 blocks" */
export function describe(result) {
  const s = result.stats;
  return `${result.source.toUpperCase()}${s.pages ? ` · ${s.pages} page${s.pages === 1 ? '' : 's'}` : ''} · ${s.blocks} blocks`;
}

/**
 * els: { characters: Element, blocks: <tbody>, onlyReview?: <input type=checkbox>, onChange?: (review) => void }
 * Every row can be retyped or deleted; rows that need review show their controls all the time
 * (plus Mark correct), other rows on hover or keyboard focus (see review.css).
 */
export function createImportReview(els) {
  let result = null;
  let history = [];
  let me = null;
  const radioName = `me-${Math.random().toString(36).slice(2, 8)}`;

  const review = {
    get result() { return result; },
    get me() { return me; },
    get canUndo() { return history.length > 0; },
    load(next) {
      result = next;
      history = [];
      me = next.characters[0]?.name || null;
      render();
    },
    undo() {
      if (!history.length) return;
      result = history.pop();
      render();
    },
    render,
    toScript({ title } = {}) {
      return toRehearsalScript(result, { title: title || undefined, meCharacter: me || undefined });
    },
  };

  function apply(next) {
    history.push(result);
    result = next;
    render();
  }

  function render() {
    if (!result) return;
    if (me && !result.characters.some((c) => c.name === me)) me = result.characters[0]?.name || null;
    renderCharacters();
    renderBlocks();
    els.onChange?.(review);
  }

  // shadcn RadioGroup (css/shadcn.css): radio buttons with a Label each, arrow keys to move,
  // and Tab landing on the chosen character (roving tabindex), as Base UI's RadioGroup does.
  function renderCharacters() {
    const box = els.characters;
    box.classList.add('radio-group');
    box.setAttribute('role', 'radiogroup');
    if (!result.characters.length) {
      box.replaceChildren(el('p', 'No characters found.', 'muted'));
      return;
    }
    box.replaceChildren(...result.characters.map((c, i) => {
      const row = el('div', '', 'import-character');
      const item = el('button', '', 'radio-group-item');
      item.type = 'button';
      item.id = `${radioName}-${i}`;
      item.setAttribute('role', 'radio');
      item.value = c.name;
      const checked = c.name === me;
      item.setAttribute('aria-checked', String(checked));
      item.toggleAttribute('data-checked', checked);
      item.tabIndex = checked ? 0 : -1;
      item.append(el('span', '', 'radio-group-indicator'));
      item.onclick = () => choose(c.name);
      const label = el('label', c.name, 'label');
      label.htmlFor = item.id;
      row.append(item, label, el('span', `${c.speeches} speech${c.speeches === 1 ? '' : 'es'}`, 'muted'));
      return row;
    }));
  }

  function choose(name, focus = false) {
    me = name;
    for (const item of els.characters.querySelectorAll('.radio-group-item')) {
      const on = item.value === name;
      item.setAttribute('aria-checked', String(on));
      item.toggleAttribute('data-checked', on);
      item.tabIndex = on ? 0 : -1;
      if (on && focus) item.focus();
    }
    els.onChange?.(review);
  }

  els.characters.addEventListener('keydown', (e) => {
    const items = [...els.characters.querySelectorAll('.radio-group-item')];
    const at = items.indexOf(document.activeElement);
    if (at < 0) return;
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (step) {
      e.preventDefault();
      choose(items[(at + step + items.length) % items.length].value, true);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      choose(items[e.key === 'Home' ? 0 : items.length - 1].value, true);
    }
  });

  function renderBlocks() {
    const only = !!els.onlyReview?.checked;
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
      const typeCell = el('td', '', 'type');
      const select = document.createElement('select');
      select.className = 'type-select';
      select.setAttribute('aria-label', `Type of block ${b.id}`);
      for (const t of BLOCK_TYPES) {
        const o = el('option', TYPE_LABEL[t]);
        o.value = t;
        o.selected = t === b.type;
        select.append(o);
      }
      select.onchange = () => apply(retypeBlock(result, b.id, select.value));
      typeCell.append(select);
      const actions = el('td', '', 'actions');
      if (b.review) actions.append(iconButton('check', `Mark block ${b.id} correct`, 'Mark correct', () => apply(acceptBlock(result, b.id))));
      actions.append(iconButton('trash', `Delete block ${b.id}`, 'Delete', () => apply(deleteBlock(result, b.id)), 'destructive'));
      tr.append(idCell, el('td', b.page ?? '–', 'num'), conf, textCell, typeCell, actions);
      rows.push(tr);
    }
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = el('td', only ? 'Nothing needs review.' : 'No blocks.', 'muted');
      td.colSpan = 6;
      tr.append(td);
      rows.push(tr);
    }
    els.blocks.replaceChildren(...rows);
  }

  if (els.onlyReview) els.onlyReview.addEventListener('change', () => result && renderBlocks());
  return review;
}

function iconButton(name, label, tip, onClick, variant) {
  const b = el('button', '', 'btn btn-ghost btn-icon btn-sm' + (variant === 'destructive' ? ' btn-icon-destructive' : ''));
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = tip;
  if (window.icon) b.append(window.icon(name)); else b.textContent = tip;
  b.onclick = onClick;
  return b;
}

function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (className) e.className = className;
  return e;
}
