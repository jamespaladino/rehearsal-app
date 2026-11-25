// Final Draft (.fdx, XML) -> ImportResult, same block model as the PDF importer.
// Reads <Content><Paragraph Type="..."><Text>...</Text></Paragraph> and <DualDialogue> groups.
// Uses a small tolerant scanner instead of DOMParser so it also runs in Node.

import { makeBlock, finalize } from './model.js';
import { parseCue, splitSceneNumber } from './text.js';

const TYPE_MAP = {
  'scene heading': 'scene_heading',
  action: 'action',
  character: 'character',
  parenthetical: 'parenthetical',
  dialogue: 'dialogue',
  transition: 'transition',
  shot: 'action',
  general: 'action',
  'cast list': 'action',
  'new act': 'action',
  'end of act': 'action',
};

export function parseFdx(xml) {
  const warnings = [];
  if (!/<FinalDraft\b/.test(xml)) warnings.push('This does not look like a Final Draft file (no <FinalDraft> element).');

  // Title page paragraphs are in <TitlePage>; take the first non-empty one as the title.
  let title = null;
  const titlePage = xml.match(/<TitlePage\b[\s\S]*?<\/TitlePage>/);
  if (titlePage) {
    for (const p of paragraphs(titlePage[0])) {
      if (p.text.trim()) { title = p.text.trim(); break; }
    }
  }
  const body = (titlePage ? xml.replace(titlePage[0], '') : xml).match(/<Content\b[^>]*>([\s\S]*?)<\/Content>/);
  if (!body) {
    warnings.push('No <Content> element found.');
    return finalize({ source: 'fdx', title, blocks: [], warnings });
  }

  const blocks = [];
  // Walk top-level paragraphs and DualDialogue groups in document order.
  const re = /<DualDialogue\b[^>]*>([\s\S]*?)<\/DualDialogue>|<Paragraph\b[^>]*?(?:\/>|>[\s\S]*?<\/Paragraph>)/g;
  let m;
  while ((m = re.exec(body[1]))) {
    if (m[1] !== undefined) {
      let side = 'left';
      let seenCharacter = false;
      for (const p of paragraphs(m[1])) {
        if (p.type === 'character') {
          if (seenCharacter) side = 'right';
          seenCharacter = true;
        }
        const b = toBlock(p);
        if (!b) continue;
        b.meta.dual = side;
        b.flags.push('dual_dialogue');
        blocks.push(b);
      }
    } else {
      const [p] = paragraphs(m[0]);
      const b = p && toBlock(p);
      if (b) blocks.push(b);
    }
  }
  return finalize({ source: 'fdx', title, blocks, warnings });
}

function toBlock(p) {
  const text = p.text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const type = TYPE_MAP[p.rawType.toLowerCase()];
  if (!type) return makeBlock('action', text, 0.6, { meta: { fdxType: p.rawType } });
  if (type === 'character') {
    const cue = parseCue(text);
    return makeBlock('character', cue ? cue.name : text.toUpperCase(), cue ? 1 : 0.8, { meta: { extensions: cue ? cue.extensions : [] } });
  }
  if (type === 'scene_heading') {
    const { text: heading, sceneNumber } = splitSceneNumber(text);
    const number = p.number || sceneNumber;
    return makeBlock('scene_heading', heading, 1, { meta: number ? { sceneNumber: number } : {} });
  }
  const b = makeBlock(type, text, 1);
  if (p.rawType.toLowerCase() === 'shot') b.meta.shot = true;
  return b;
}

/** Paragraphs in an XML fragment: [{ rawType, type, number, text }]. */
function paragraphs(fragment) {
  const out = [];
  const re = /<Paragraph\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Paragraph>)/g;
  let m;
  while ((m = re.exec(fragment))) {
    const attrs = m[1];
    const rawType = (attrs.match(/\bType="([^"]*)"/) || [])[1] || 'General';
    const number = (attrs.match(/\bNumber="([^"]*)"/) || [])[1] || null;
    const inner = m[2] || '';
    // Text runs; ignore SceneProperties and other nested elements.
    const runs = [];
    const tre = /<Text\b[^>]*?(?:\/>|>([\s\S]*?)<\/Text>)/g;
    let t;
    while ((t = tre.exec(inner))) runs.push(decode(t[1] || ''));
    out.push({ rawType, type: TYPE_MAP[rawType.toLowerCase()] || null, number, text: runs.join('') });
  }
  return out;
}

function decode(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
