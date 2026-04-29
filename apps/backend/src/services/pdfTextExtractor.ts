import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { PDFParse } from 'pdf-parse';

import { decodePdfDataUrl } from '../utils/pdfDataUrl.js';
import { normalizeLineEndings } from '../utils/text.js';

const execFileAsync = promisify(execFile);
const TMP_DIR_PREFIX = 'nous-pdf-text-';
const PDF_TEXT_FALLBACK_WARNING =
  'Estrazione testo eseguita con parser di fallback; qualita e impaginazione potrebbero essere meno fedeli.';

export interface ExtractedPdfTextPage {
  pageNumber: number;
  text: string;
}

export interface ExtractedPdfText {
  text: string;
  pages: ExtractedPdfTextPage[];
  sourceHash: string;
  parser: 'pdftotext' | 'pdf-parse';
  parserFallbackReason?: string;
  pageCount?: number;
  qualityWarning?: string;
  usedFallbackParser: boolean;
}

const buildSourceHash = (buffer: Buffer): string =>
  crypto.createHash('sha1').update(buffer).digest('hex');

const normalizeExtractedTextSegment = (text: string): string =>
  normalizeLineEndings(text)
    .replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gim, '')
    .replace(/\f/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const buildExtractedPages = (
  pages: Array<{ pageNumber: number; text: string }>
): ExtractedPdfTextPage[] =>
  pages.map(page => ({
    pageNumber: page.pageNumber,
    text: normalizeExtractedTextSegment(page.text),
  }));

const joinExtractedPages = (pages: ExtractedPdfTextPage[]): string =>
  pages
    .map(page => page.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();

const extractWithPdfParse = async (
  pdfBuffer: Buffer
): Promise<Omit<ExtractedPdfText, 'sourceHash'>> => {
  const parser = new PDFParse({ data: pdfBuffer });

  try {
    const [textResult, infoResult] = await Promise.all([
      parser.getText(),
      parser.getInfo().catch(() => null),
    ]);
    const pages = buildExtractedPages(
      Array.isArray(textResult.pages) && textResult.pages.length > 0
        ? textResult.pages.map(page => ({
            pageNumber: page.num,
            text: page.text,
          }))
        : [
            {
              pageNumber: 1,
              text: textResult.text,
            },
          ]
    );

    return {
      text: joinExtractedPages(pages),
      pages,
      parser: 'pdf-parse',
      pageCount: infoResult?.total ?? textResult.total ?? pages.length,
      qualityWarning: PDF_TEXT_FALLBACK_WARNING,
      usedFallbackParser: true,
    };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
};

const extractWithPdftotext = async (
  pdfBuffer: Buffer
): Promise<{ result: Omit<ExtractedPdfText, 'sourceHash'> | null; failureReason?: string }> => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), TMP_DIR_PREFIX));
  const pdfPath = path.join(tmpDir, 'document.pdf');

  try {
    await writeFile(pdfPath, pdfBuffer);

    const { stdout } = await execFileAsync(
      'pdftotext',
      ['-layout', '-enc', 'UTF-8', '-eol', 'unix', pdfPath, '-'],
      {
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      }
    );

    const rawPages = normalizeLineEndings(stdout).split('\f');
    while (rawPages.length > 1 && rawPages[rawPages.length - 1]?.trim() === '') {
      rawPages.pop();
    }

    const pages = buildExtractedPages(
      rawPages.map((pageText, index) => ({
        pageNumber: index + 1,
        text: pageText,
      }))
    );
    const normalizedText = joinExtractedPages(pages);
    if (!normalizedText) {
      return { result: null, failureReason: 'pdftotext_empty_output' };
    }

    const result: Omit<ExtractedPdfText, 'sourceHash'> = {
      text: normalizedText,
      pages,
      parser: 'pdftotext',
      pageCount: pages.length,
      usedFallbackParser: false,
    };

    return { result };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (!errorMessage.toLowerCase().includes('enoent')) {
      console.warn('[Backend] pdftotext failed, falling back to pdf-parse:', errorMessage);
    }

    return { result: null, failureReason: errorMessage };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

export const extractPdfText = async (pdfDataUrl: string): Promise<ExtractedPdfText> => {
  const pdfBuffer = decodePdfDataUrl(pdfDataUrl);
  const sourceHash = buildSourceHash(pdfBuffer);

  const pdftotextResult = await extractWithPdftotext(pdfBuffer);
  if (pdftotextResult.result) {
    return {
      ...pdftotextResult.result,
      sourceHash,
    };
  }

  const fallbackResult = await extractWithPdfParse(pdfBuffer);
  return {
    ...fallbackResult,
    parserFallbackReason: pdftotextResult.failureReason,
    sourceHash,
  };
};
