// pdf.js adapter: PDF bytes -> positioned pages for parseLayout. The pdf.js module is passed in,
// so the same code runs in the browser (vendor/pdfjs-4.10.38/pdf.min.mjs) and in Node 20+.

const IMAGE_OPS = ['paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintJpegXObject'];

/**
 * @param {Uint8Array} data
 * @param {object} pdfjs  the pdf.js module (with GlobalWorkerOptions.workerSrc already set)
 * @returns {Promise<{ pages, title }>}  pages: [{ width, height, items, hasImages }]
 */
export async function readPdfPages(data, pdfjs) {
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  try {
    const imageOps = new Set(IMAGE_OPS.map((k) => pdfjs.OPS[k]).filter((v) => v !== undefined));
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = [];
      for (const it of content.items) {
        if (typeof it.str !== 'string' || !it.str) continue;
        const [, , c, d, e, f] = it.transform;
        const [x, y] = vp.convertToViewportPoint(e, f);
        items.push({ str: it.str, x, y, w: it.width, size: Math.hypot(c, d) || it.height || 12 });
      }
      // Only look for images on pages with little text (cheap check for scanned pages).
      let hasImages = false;
      const chars = items.reduce((sum, it) => sum + it.str.trim().length, 0);
      if (chars < 20) {
        const ops = await page.getOperatorList();
        hasImages = ops.fnArray.some((fn) => imageOps.has(fn));
      }
      pages.push({ width: vp.width, height: vp.height, items, hasImages });
      page.cleanup();
    }
    let title = null;
    try {
      const meta = await doc.getMetadata();
      title = meta?.info?.Title?.trim() || null;
    } catch (e) { /* no metadata */ }
    return { pages, title };
  } finally {
    doc.destroy();
  }
}
