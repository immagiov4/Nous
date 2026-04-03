import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { PDFParse } from 'pdf-parse';

const execFileAsync = promisify(execFile);
const PDF_DATA_URL_PREFIX = /^data:application\/pdf;base64,/i;
const TMP_DIR_PREFIX = 'lumina-pdf-text-';

export interface ExtractedPdfTextPage {
  pageNumber: number;
  text: string;
}

export interface ExtractedPdfText {
  text: string;
  pages: ExtractedPdfTextPage[];
  sourceHash: string;
  parser: 'pdftotext' | 'pdf-parse';
  pageCount?: number;
}

const decodePdfDataUrl = (pdfDataUrl: string): Buffer => {
  if (!PDF_DATA_URL_PREFIX.test(pdfDataUrl)) {
    throw new Error('A PDF data URL is required.');
  }

  const base64 = pdfDataUrl.replace(PDF_DATA_URL_PREFIX, '');
  return Buffer.from(base64, 'base64');
};

const buildSourceHash = (buffer: Buffer): string =>
  crypto.createHash('sha1').update(buffer).digest('hex');

const normalizeExtractedTextSegment = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
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
    };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
};

const extractWithPdftotext = async (
  pdfBuffer: Buffer
): Promise<Omit<ExtractedPdfText, 'sourceHash'> | null> => {
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

    const rawPages = stdout.replace(/\r\n?/g, '\n').split('\f');
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
      return null;
    }

    return {
      text: normalizedText,
      pages,
      parser: 'pdftotext',
      pageCount: pages.length,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (!errorMessage.toLowerCase().includes('enoent')) {
      console.warn('[Backend] pdftotext failed, falling back to pdf-parse:', errorMessage);
    }

    return null;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

export const extractPdfText = async (pdfDataUrl: string): Promise<ExtractedPdfText> => {
  const pdfBuffer = decodePdfDataUrl(pdfDataUrl);
  const sourceHash = buildSourceHash(pdfBuffer);

  const pdftotextResult = await extractWithPdftotext(pdfBuffer);
  if (pdftotextResult) {
    return {
      ...pdftotextResult,
      sourceHash,
    };
  }

  const fallbackResult = await extractWithPdfParse(pdfBuffer);
  return {
    ...fallbackResult,
    sourceHash,
  };
};
