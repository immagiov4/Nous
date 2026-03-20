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

export interface ExtractedPdfText {
  text: string;
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

const normalizeExtractedText = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gim, '')
    .replace(/\f/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const extractWithPdfParse = async (pdfBuffer: Buffer): Promise<Omit<ExtractedPdfText, 'sourceHash'>> => {
  const parser = new PDFParse({ data: pdfBuffer });

  try {
    const [textResult, infoResult] = await Promise.all([
      parser.getText(),
      parser.getInfo().catch(() => null),
    ]);

    return {
      text: normalizeExtractedText(textResult.text),
      parser: 'pdf-parse',
      pageCount: infoResult?.total ?? textResult.total,
    };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
};

const extractWithPdftotext = async (pdfBuffer: Buffer): Promise<Omit<ExtractedPdfText, 'sourceHash'> | null> => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), TMP_DIR_PREFIX));
  const pdfPath = path.join(tmpDir, 'document.pdf');

  try {
    await writeFile(pdfPath, pdfBuffer);

    const { stdout } = await execFileAsync(
      'pdftotext',
      ['-layout', '-enc', 'UTF-8', '-eol', 'unix', '-nopgbrk', pdfPath, '-'],
      {
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      }
    );

    const normalizedText = normalizeExtractedText(stdout);
    if (!normalizedText) {
      return null;
    }

    return {
      text: normalizedText,
      parser: 'pdftotext',
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
