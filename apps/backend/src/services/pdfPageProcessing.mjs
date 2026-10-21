import { createRequire } from 'node:module';
import path from 'node:path';
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { normalizeExtractedTextSegment } from './pdfTextNormalizationCore.mjs';

const pdfJsRoot = path
  .dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  .replaceAll('\\', '/');
const PDF_PAGE_LOAD_OPTIONS = {
  cMapPacked: true,
  cMapUrl: `${pdfJsRoot}/cmaps/`,
  standardFontDataUrl: `${pdfJsRoot}/standard_fonts/`,
  stopAtErrors: true,
  wasmUrl: `${pdfJsRoot}/wasm/`,
};

const countTextGlyphs = text => {
  const counts = new Map();
  for (const symbol of text.normalize('NFKC').match(/[\p{L}\p{N}\p{Sm}]/gu) || [])
    counts.set(symbol, (counts.get(symbol) || 0) + 1);
  return counts;
};

const rasterPaintOperators = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject]);

/** A full-page raster remains source content even when its footer is selectable text. */
const hasFullPageImage = (view, operators) => {
  if (!view) return false;
  let transform = [1, 0, 0, 1, 0, 0];
  const saved = [];
  for (let index = 0; index < operators.fnArray.length; index += 1) {
    const op = operators.fnArray[index];
    if (op === OPS.save) saved.push(transform);
    else if (op === OPS.restore) transform = saved.pop() || [1, 0, 0, 1, 0, 0];
    else if (op === OPS.transform)
      transform = Util.transform(transform, operators.argsArray[index]);
    else if (rasterPaintOperators.has(op)) {
      const inverse = Util.inverseTransform(transform);
      const corners = [
        [view[0], view[1]],
        [view[2], view[1]],
        [view[2], view[3]],
        [view[0], view[3]],
      ];
      const coversPage = corners.every(corner => {
        Util.applyTransform(corner, inverse);
        return corner.every(coordinate => coordinate >= 0 && coordinate <= 1);
      });
      if (coversPage) return true;
    }
  }
  return false;
};

/** Reasons are structural evidence, never a language or word-count classifier. */
export const inspectPdfPageText = async (page, extractedText) => {
  const [content, operators] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
  const reasons = [];
  if (!extractedText.trim()) reasons.push('empty-text');
  if (hasFullPageImage(page.view, operators)) reasons.push('full-page-image');
  const sourceText = content.items.map(item => item.str || '').join('');
  if (/[\p{Cc}\ufffd]/u.test((sourceText + extractedText).replaceAll(/[\t\n\r]/g, '')))
    reasons.push('unmapped-glyph');
  const extractedSymbols = countTextGlyphs(extractedText);
  if (
    [...countTextGlyphs(sourceText)].some(
      ([symbol, count]) => (extractedSymbols.get(symbol) || 0) < count
    )
  )
    reasons.push('lost-text-glyph');
  let mode = 0;
  const modes = [];
  for (let index = 0; index < operators.fnArray.length; index += 1) {
    const op = operators.fnArray[index];
    if (op === OPS.save) modes.push(mode);
    else if (op === OPS.restore) mode = modes.pop() ?? 0;
    else if (op === OPS.setTextRenderingMode) mode = Number(operators.argsArray[index][0]);
    else if ((op === OPS.showText || op === OPS.showSpacedText) && (mode === 3 || mode === 7)) {
      reasons.push('invisible-text-layer');
      break;
    }
  }
  return reasons;
};

export const inspectPdfTextPages = async (parser, extracted) => {
  await parser.getInfo();
  // pdf-parse owns the already loaded PDF.js document and page renderer.
  const document = parser.doc;
  const previousPages = new Map(extracted.pages.map(page => [page.pageNumber, page.text]));
  const pages = Array.from({ length: document.numPages }, (_, index) => ({
    pageNumber: index + 1,
    text: previousPages.get(index + 1) || '',
  }));
  const planned = [];
  for (const page of pages) {
    const pdfPage = await document.getPage(page.pageNumber);
    try {
      let reasons = await inspectPdfPageText(pdfPage, page.text);
      if (
        reasons.length > 0 &&
        extracted.parser === 'pdftotext' &&
        !reasons.includes('invisible-text-layer')
      ) {
        const fallback = await parser.getText({ partial: [page.pageNumber], pageJoiner: '' });
        const fallbackText = normalizeExtractedTextSegment(fallback.pages[0]?.text || '');
        const fallbackReasons = await inspectPdfPageText(pdfPage, fallbackText);
        if (fallbackReasons.length === 0) {
          page.text = fallbackText;
          reasons = [];
        }
      }
      if (reasons.length > 0) planned.push({ pageNumber: page.pageNumber, reasons });
    } finally {
      pdfPage.cleanup();
    }
  }
  return { pages, planned, pageCount: document.numPages };
};

export { PDF_PAGE_LOAD_OPTIONS };
