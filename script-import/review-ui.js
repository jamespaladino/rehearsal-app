// Import review UI, shared by the app's import flow (js/app.js) and the standalone debug page
// (script-import/index.html). DOM only: parsing lives in src/.
//
//   const result = await readScriptFile(file);
//   const review = createImportReview({ characters, blocks, filter, onChange });
//   review.load(result);            // renders the character list and the block table
//   review.toScript({ title });     // Rehearsal script, using the chosen character and every edit

import { importScript, toRehearsalScript, retypeBlock, acceptBlock, deleteBlock, guessMyCharacter, BLOCK_TYPES } from './src/index.js';

const PDFJS = new URL('../vendor/pdfjs-4.10.38/pdf.min.mjs', import.meta.url).href;
const PDF_WORKER = new URL('../vendor/pdfjs-4.10.38/pdf.worker.min.mjs', import.meta.url).href;
export const TYPE_LABEL = { scene_heading: 'Scene heading', action: 'Action', character: 'Character', parenthetical: 'Parenthetical', dialogue: 'Dialogue', transition: 'Transition' };
export const ACCEPT ='.pdf,.fountain,.spmd,.fdx,.txt,application/pdf';

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
 * els: { characters: Element, selectId?: string, labelledBy?: string, blocks: <tbody>,
 *         filter?: shadcn ToggleGroup with <button data-filter="all"> and <button data-filter="review">,
 *         confidence?: false to leave out the confidence column (the table head must match),
 *         onChange?: (review) => void }
 * Every row can be retyped or deleted. Rows that need review show their controls all the time,
 * and their type picker starts on "Choose type" so the user has to pick one (even the guessed
 * type) to clear the review. Other rows show controls on hover or keyboard focus (see review.css).
 */
export function createImportReview(els) {
  let result = null;
  let history = [];
  let me = null;
  let onlyReview = false; // the All / Review toggle

  const review = {
    get result() { return result; },
    get me() { return me; },
    get canUndo() { return history.length > 0; },
    load(next) {
      result = next;
      history = [];
      me = guessMyCharacter(next);
      setFilter('all');
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
    if (!me || !result.characters.some((c) => c.name === me)) me = guessMyCharacter(result);
    renderCharacters();
    renderBlocks();
    renderReviewCount();
    els.onChange?.(review);
  }

  // The Review toggle shows how many blocks still need review: "Review 3". With nothing to
  // review it's plain "Review".
  function renderReviewCount() {
    const btn = els.filter?.querySelector('[data-filter="review"]');
    if (!btn) return;
    const n = result.blocks.filter((b) => b.review).length;
    btn.replaceChildren('Review');
    if (!n) { btn.removeAttribute('aria-label'); return; }
    btn.append(el('span', String(n), 'toggle-count'));
    btn.setAttribute('aria-label', `Review, ${n} ${n === 1 ? 'block needs' : 'blocks need'} review`);
  }

  // "You": a shadcn NativeSelect (css/shadcn.css) listing every character, best guess first chosen.
  function renderCharacters() {
    const box = els.characters;
    if (!result.characters.length) {
      box.replaceChildren(el('p', 'No characters found.', 'muted'));
      return;
    }
    const select = document.createElement('select');
    if (els.selectId) select.id = els.selectId;
    if (els.labelledBy) select.setAttribute('aria-labelledby', els.labelledBy);
    for (const c of result.characters) {
      const o = el('option', c.name);
      o.value = c.name;
      o.selected = c.name === me;
      select.append(o);
    }
    select.onchange = () => { me = select.value; els.onChange?.(review); };
    box.replaceChildren(nativeSelect(select));
  }

  function renderBlocks() {
    const only = onlyReview;
    const rows = [];
    for (const b of result.blocks) {
      if (only && !b.review) continue;
      const tr = document.createElement('tr');
      if (b.review) tr.className = 'needs-review';
      const conf = el('td', b.confidence.toFixed(2), 'conf ' + (b.confidence < 0.6 ? 'conf-low' : b.confidence < 0.85 ? 'conf-mid' : 'conf-high'));
      const textCell = el('td', '', `block-text type-${b.type}`);
      // Character names keep their extensions, as in the script: BEN (O.S.) (CONT'D).
      const extensions = b.type === 'character' && b.meta.extensions?.length ? ' ' + b.meta.extensions.map((e) => `(${e})`).join(' ') : '';
      textCell.append(el('div', b.text + extensions));
      const notes = [];
      // The speaker isn't shown: the character row sits just above its dialogue.
      if (b.meta.sceneNumber) notes.push(`scene ${b.meta.sceneNumber}`);
      if (b.meta.dual) notes.push(`dual: ${b.meta.dual}`);
      if (b.meta.revised) notes.push('revised');
      // Flags aren't shown as badges: the highlighted row is the cue (they stay in the data).
      if (notes.length) {
        const n = el('div', '', 'block-notes');
        notes.forEach((t) => n.append(el('span', t, 'muted')));
        textCell.append(n);
      }
      const idCell = el('td', String(b.id), 'num');
      const typeCell = el('td', '', 'type');
      const select = document.createElement('select');
      select.setAttribute('aria-label', `Type of block ${b.id}`);
      // A block that needs review has no type chosen yet: the user must pick one.
      if (b.review) {
        const placeholder = el('option', 'Choose type');
        placeholder.value = '';
        placeholder.disabled = true;
        placeholder.selected = true;
        select.append(placeholder);
        select.required = true;
      }
      for (const t of BLOCK_TYPES) {
        const o = el('option', TYPE_LABEL[t]);
        o.value = t;
        o.selected = !b.review && t === b.type;
        select.append(o);
      }
      // Picking the guessed type confirms it as is (retyping a character to character would
      // drop its extensions); any other type retypes the block.
      select.onchange = () => apply(select.value === b.type ? acceptBlock(result, b.id) : retypeBlock(result, b.id, select.value));
      typeCell.append(nativeSelect(select, 'sm'));
      const actions = el('td', '', 'actions');
      actions.append(iconButton('trash', `Delete block ${b.id}`, 'Delete', () => apply(deleteBlock(result, b.id))));
      tr.append(idCell, el('td', b.page ?? '–', 'num'), ...(els.confidence === false ? [] : [conf]), textCell, typeCell, actions);
      rows.push(tr);
    }
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = el('td', only ? 'Nothing needs review.' : 'No blocks.', 'muted');
      td.colSpan = els.confidence === false ? 5 : 6;
      tr.append(td);
      rows.push(tr);
    }
    els.blocks.replaceChildren(...rows);
  }

  // All / Review: a shadcn ToggleGroup where exactly one item is pressed.
  function setFilter(value) {
    onlyReview = value === 'review';
    els.filter?.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === value)));
  }
  els.filter?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    setFilter(b.dataset.filter);
    if (result) renderBlocks();
  });
  return review;
}

/** shadcn NativeSelect (css/shadcn.css): the select in a wrapper with a chevron. size: 'sm' or default. */
function nativeSelect(select, size) {
  const wrap = el('div', '', 'native-select');
  if (size) wrap.dataset.size = size;
  wrap.append(select);
  if (window.icon) {
    const chevron = window.icon('chevron-down');
    chevron.classList.add('native-select-icon');
    wrap.append(chevron);
  }
  return wrap;
}

// shadcn Button, destructive variant, icon-sm size (28px, like the small type picker beside it).
function iconButton(name, label, tip, onClick) {
  const b = el('button', '', 'btn btn-destructive btn-icon-sm');
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
