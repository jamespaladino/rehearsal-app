// Entry point: import a screenplay file of any supported format into blocks.
//
//   import { importScript } from './script-import/src/index.js';
//   const result = await importScript({ name: 'draft.pdf', data: uint8Array }, { pdfjs });
//   const script = toRehearsalScript(result, { meCharacter: 'ANNA' });
//
// Formats: PDF (needs the pdf.js module), Fountain (.fountain / .spmd / .txt), Final Draft (.fdx).

import { readPdfPages } from './pdf.js';
import { parseLayout, RULESETS } from './parse-layout.js';
import { parseFountain } from './fountain.js';
import { parseFdx } from './fdx.js';

export { parseLayout, RULESETS, parseFountain, parseFdx };
export { toRehearsalScript } from './convert.js';
export { retypeBlock, acceptBlock, deleteBlock } from './edit.js';
export { BLOCK_TYPES, FLAGS, REVIEW_THRESHOLD, guessMyCharacter } from './model.js';

/** 'pdf' | 'fdx' | 'fountain', from the bytes first and the file name second. */
export function detectFormat(name = '', data) {
  if (data && data.length >= 5 && String.fromCharCode(...data.subarray(0, 5)) === '%PDF-') return 'pdf';
  const head = data ? new TextDecoder().decode(data.subarray(0, 600)) : '';
  if (/\.fdx$/i.test(name) || /<FinalDraft\b/.test(head)) return 'fdx';
  if (/\.pdf$/i.test(name)) return 'pdf';
  return 'fountain';
}

/**
 * @param {{ name?: string, data?: Uint8Array, text?: string }} file
 * @param {{ pdfjs?: object, ruleset?: object }} options
 */
export async function importScript(file, options = {}) {
  const format = file.text != null ? (/\.fdx$/i.test(file.name || '') || /<FinalDraft\b/.test(file.text) ? 'fdx' : 'fountain') : detectFormat(file.name, file.data);
  if (format === 'pdf') {
    if (!options.pdfjs) throw new Error('Importing a PDF needs the pdf.js module (options.pdfjs).');
    const { pages, title } = await readPdfPages(file.data, options.pdfjs);
    const result = parseLayout(pages, { ruleset: options.ruleset });
    if (!result.title && title) result.title = title;
    return result;
  }
  const text = file.text != null ? file.text : new TextDecoder().decode(file.data);
  return format === 'fdx' ? parseFdx(text) : parseFountain(text);
}
