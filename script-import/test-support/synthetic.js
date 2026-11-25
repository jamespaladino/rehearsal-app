// Builds synthetic screenplay pages for tests and fixture PDFs, without any PDF library.
//
//   const pages = layout([
//     ['heading', 'INT. KITCHEN - DAY'], ['blank'],
//     ['action', 'Anna enters.'], ['blank'],
//     ['character', 'ANNA'], ['dialogue', 'Hello.'],
//     ['pagebreak'], ...
//   ], { shift: 0.3, pageNumbers: true, sceneNumbers: true })
//
// Returns parseLayout-ready pages ({ width, height, items }) in Courier 12 (7.2pt per character,
// 12pt lines). makePdf(pages) turns the same pages into a minimal, valid PDF file.

const IN = 72;
const CW = 7.2;
const LINE = 12;

// Standard US screenplay indents (inches from the page's left edge).
export const STANDARD = { heading: 1.5, action: 1.5, dialogue: 2.5, parenthetical: 3.1, character: 3.7, transitionRight: 7.5 };

/**
 * rows: [kind, text?, opts?]
 *   kind: heading | action | character | parenthetical | dialogue | transition | centered | blank | pagebreak
 *         | dual  (text = [leftCue, rightCue], then 'dualline' rows: [leftText|null, rightText|null])
 *         | raw   (opts.x in inches: arbitrary placement)
 *   opts: { sceneNumber: '12', revised: true, x: inches }
 * options:
 *   shift: inches added to every indent (simulates other margins)
 *   indents: overrides for STANDARD
 *   pageNumbers: put "N." top right from page 2
 *   header: running header text on every page (top left)
 *   leadingSpaces: encode indents as leading spaces from the left margin instead of x positions
 */
export function layout(rows, options = {}) {
  const ind = { ...STANDARD, ...(options.indents || {}) };
  const shift = options.shift || 0;
  const X = (inches) => (inches + shift) * IN;
  const pages = [];
  let page = null;
  let y = 0;
  let dual = null;
  const newPage = () => {
    page = { width: 8.5 * IN, height: 11 * IN, items: [] };
    pages.push(page);
    y = 1 * IN + LINE;
    const n = pages.length;
    if (options.pageNumbers && n > 1) put(`${n}.`, 7.5 * IN - `${n}.`.length * CW, 0.5 * IN);
    if (options.header) put(options.header.replace('#', n), X(ind.action), 0.5 * IN);
  };
  const put = (str, x, yy) => page.items.push({ str, x, y: yy, w: str.length * CW, size: 12 });
  const putAt = (str, inches, opts = {}) => {
    if (options.leadingSpaces) {
      const spaces = Math.round(((inches - ind.action) * IN) / CW);
      put(' '.repeat(Math.max(0, spaces)) + str, X(ind.action), y);
    } else {
      put(str, X(inches), y);
    }
    if (opts.sceneNumber) {
      put(opts.sceneNumber, X(ind.action) - 0.75 * IN, y);
      put(opts.sceneNumber, 7.5 * IN + 0.1 * IN, y);
    }
    if (opts.revised) put('*', 7.5 * IN + 0.4 * IN, y);
  };
  newPage();
  for (const [kind, text, opts = {}] of rows) {
    switch (kind) {
      case 'pagebreak': newPage(); continue;
      case 'blank': y += LINE; continue;
      case 'heading': putAt(text, ind.heading, opts); break;
      case 'action': putAt(text, ind.action, opts); break;
      case 'character': putAt(text, ind.character, opts); break;
      case 'parenthetical': putAt(text, ind.parenthetical, opts); break;
      case 'dialogue': putAt(text, ind.dialogue, opts); break;
      case 'transition': putAt(text, ind.transitionRight - (text.length * CW) / IN - shift, opts); break;
      case 'centered': put(text, (8.5 * IN - text.length * CW) / 2, y); break;
      case 'raw': put(text, opts.x * IN, y); break;
      case 'dual': {
        // Final Draft-style columns: left cue 2.3", dialogue 1.5"; right cue 5.1", dialogue 4.4".
        dual = { left: { cue: 2.3, text: 1.5 }, right: { cue: 5.1, text: 4.4 } };
        put(text[0], X(dual.left.cue), y);
        put(text[1], X(dual.right.cue), y);
        break;
      }
      case 'dualline': {
        const [l, r] = text;
        if (l) put(l, X(l.startsWith('(') ? dual.left.text + 0.4 : dual.left.text), y);
        if (r) put(r, X(r.startsWith('(') ? dual.right.text + 0.4 : dual.right.text), y);
        break;
      }
      default: throw new Error('unknown row kind ' + kind);
    }
    y += LINE;
  }
  return pages;
}

/** Minimal PDF (one Courier font, text only) for the given pages. Returns a Uint8Array. */
export function makePdf(pages, { title } = {}) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const p of pages) {
    const content = p.items.map((it) => `BT /F1 ${it.size || 12} Tf ${fix(it.x)} ${fix(p.height - it.y)} Td (${esc(it.str)}) Tj ET`).join('\n');
    const stream = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${fix(p.width)} ${fix(p.height)}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = title ? add(`<< /Title (${esc(title)}) /Producer (rehearsal script-import fixtures) >>`) : null;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R${info ? ` /Info ${info} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

const fix = (n) => Math.round(n * 100) / 100;
