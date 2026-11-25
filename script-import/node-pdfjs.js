// Loads the vendored pdf.js in Node (CLI and tests). pdf.js 4 needs Node 20 or later.
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const VENDOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../vendor/pdfjs-4.10.38');
export const MIN_NODE = 20;

export function nodeSupportsPdf() {
  return Number(process.versions.node.split('.')[0]) >= MIN_NODE;
}

export async function loadPdfjs() {
  if (!nodeSupportsPdf()) {
    throw new Error(`Reading PDFs from the command line needs Node ${MIN_NODE} or later (this is Node ${process.versions.node}). Fountain and Final Draft files work on any version, and PDFs work in the browser debug page.`);
  }
  // pdf.js warns (via console.log) that it can't polyfill canvas APIs in Node; text extraction
  // doesn't need them, so those warnings are hidden while it loads.
  const quiet = /Cannot (?:load "@napi-rs\/canvas"|polyfill)|@napi-rs\/canvas|Require stack|pdf\.min\.mjs"\./;
  const { log, warn } = console;
  console.log = (...args) => { if (!quiet.test(String(args[0]))) log(...args); };
  console.warn = (...args) => { if (!quiet.test(String(args[0]))) warn(...args); };
  try {
    const pdfjs = await import(pathToFileURL(path.join(VENDOR, 'pdf.min.mjs')).href);
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(VENDOR, 'pdf.worker.min.mjs')).href;
    return pdfjs;
  } finally {
    console.log = log;
    console.warn = warn;
  }
}
