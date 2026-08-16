// Extracts text from uploaded PDF files through the backend worker flow.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';

import { PDFParse } from 'pdf-parse';

import { buildSha256HexDigest } from '../utils/hash.js';
import { decodePdfDataUrl } from '../utils/pdfDataUrl.js';
import { normalizeLineEndings } from '../utils/text.js';

const execFileAsync = promisify(execFile);
const TMP_DIR_PREFIX = 'nous-pdf-text-';
const PDF_TEXT_FALLBACK_WARNING =
  'Estrazione testo eseguita con parser di fallback; qualita e impaginazione potrebbero essere meno fedeli.';

export interface PdfTextExtractionTimeouts {
  fallbackTimeoutMs?: number;
  pdftotextTimeoutMs?: number;
}

export class PdfTextExtractionTimeoutError extends Error {
  constructor(readonly stage: 'pdf-parse' | 'pdftotext') {
    super(`PDF text extraction timed out during ${stage}.`);
    this.name = 'PdfTextExtractionTimeoutError';
  }
}

export interface ExtractedPdfTextPage {
  pageNumber: number;
  text: string;
}

export interface ExtractedPdfOutlineNode {
  children: ExtractedPdfOutlineNode[];
  id: string;
  level: number;
  page?: number;
  title: string;
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
  outline: ExtractedPdfOutlineNode[];
  outlineOrigin: 'deterministic' | 'native' | 'none';
}

interface PdfTextWorkerResult {
  error?: string;
  outline?: unknown;
  pageCount?: unknown;
  pages?: unknown;
  text?: unknown;
}

const buildSourceHash = (buffer: Buffer): string => buildSha256HexDigest(buffer);

const isPageMarkerLine = (line: string): boolean => {
  const trimmedLine = line.trim();
  if (!trimmedLine.startsWith('--') || !trimmedLine.endsWith('--')) {
    return false;
  }

  const content = trimmedLine.slice(2, -2).trim();
  const parts = content.split(/\s+/);
  return (
    parts.length === 3 &&
    /^\d+$/u.test(parts[0] || '') &&
    (parts[1] || '').toLowerCase() === 'of' &&
    /^\d+$/u.test(parts[2] || '')
  );
};

const normalizeExtractedTextSegment = (text: string): string =>
  normalizeLineEndings(text)
    .split('\n')
    .filter(line => !isPageMarkerLine(line))
    .join('\n')
    .replaceAll('\f', '\n')
    .replaceAll(/\n{3,}/g, '\n\n')
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

const buildOutlineTree = (
  flatNodes: Array<Omit<ExtractedPdfOutlineNode, 'children'>>
): ExtractedPdfOutlineNode[] => {
  const roots: ExtractedPdfOutlineNode[] = [];
  const stack: ExtractedPdfOutlineNode[] = [];
  for (const flatNode of flatNodes) {
    const node = { ...flatNode, children: [] };
    let parent = stack.at(-1);
    while (parent && parent.level >= node.level) {
      stack.pop();
      parent = stack.at(-1);
    }
    (parent?.children || roots).push(node);
    stack.push(node);
  }
  return roots;
};

const normalizeNativePdfOutline = (outline: unknown): ExtractedPdfOutlineNode[] => {
  if (!Array.isArray(outline)) {
    return [];
  }
  let sequence = 0;
  const normalize = (items: unknown[], level: number): ExtractedPdfOutlineNode[] =>
    items.flatMap(item => {
      if (!item || typeof item !== 'object') {
        return [];
      }
      const record = item as Record<string, unknown>;
      const title = typeof record.title === 'string' ? record.title.trim() : '';
      if (!title) {
        return [];
      }
      sequence += 1;
      const destinationPage =
        Array.isArray(record.dest) && typeof record.dest[0] === 'number'
          ? Math.trunc(record.dest[0]) + 1
          : undefined;
      return [
        {
          children: normalize(Array.isArray(record.items) ? record.items : [], level + 1),
          id: `outline-${sequence}`,
          level,
          page: destinationPage,
          title,
        },
      ];
    });
  return normalize(outline, 1);
};

const runPdfTextWorker = (
  pdfBuffer: Buffer,
  mode: 'fallback' | 'outline',
  timeoutMs: number
): Promise<PdfTextWorkerResult> =>
  new Promise((resolve, reject) => {
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const workerPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      `pdfTextFallbackWorker.${extension}`
    );
    const worker = new Worker(pathToFileURL(workerPath), {
      workerData: { bytes: new Uint8Array(pdfBuffer), mode },
    });
    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new PdfTextExtractionTimeoutError('pdf-parse'));
    }, timeoutMs);

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      worker.removeAllListeners();
      callback();
    };
    worker.once('message', (result: PdfTextWorkerResult) =>
      settle(() => {
        if (result.error) {
          reject(new Error(result.error));
          return;
        }
        resolve(result);
      })
    );
    worker.once('error', error => settle(() => reject(error)));
    worker.once('exit', code =>
      settle(() => reject(new Error(`PDF fallback worker exited with code ${code}.`)))
    );
  });

const extractNativePdfOutline = async (
  pdfBuffer: Buffer,
  timeoutMs?: number
): Promise<ExtractedPdfOutlineNode[]> => {
  if (timeoutMs !== undefined) {
    if (timeoutMs <= 0) return [];
    try {
      const result = await runPdfTextWorker(pdfBuffer, 'outline', timeoutMs);
      return normalizeNativePdfOutline(result.outline);
    } catch {
      return [];
    }
  }
  const parser = new PDFParse({ data: pdfBuffer });
  try {
    return normalizeNativePdfOutline((await parser.getInfo()).outline);
  } catch {
    return [];
  } finally {
    await parser.destroy().catch(() => undefined);
  }
};

export const buildDeterministicPdfOutline = (
  pages: ExtractedPdfTextPage[]
): ExtractedPdfOutlineNode[] => {
  const seen = new Set<string>();
  const flatNodes: Array<Omit<ExtractedPdfOutlineNode, 'children'>> = [];
  for (const page of pages) {
    for (const rawLine of page.text.split('\n')) {
      const title = rawLine.replaceAll(/\s+/g, ' ').trim();
      if (title.length < 3 || title.length > 120) {
        continue;
      }
      const numbered = title.match(/^(\d+(?:\.\d+){0,3})[.)]?\s+\S/u);
      const named = /^(?:chapter|capitolo|parte|section|sezione)\s+[\dIVXLC]+\b/iu.test(title);
      if (!numbered && !named) {
        continue;
      }
      const key = title.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      flatNodes.push({
        id: `outline-${flatNodes.length + 1}`,
        level: numbered ? Math.min(6, numbered[1].split('.').length) : 1,
        page: page.pageNumber,
        title,
      });
    }
  }
  return buildOutlineTree(flatNodes);
};

const attachPdfOutline = async (
  pdfBuffer: Buffer,
  result: Omit<ExtractedPdfText, 'sourceHash' | 'outline' | 'outlineOrigin'>,
  timeoutMs?: number
): Promise<Omit<ExtractedPdfText, 'sourceHash'>> => {
  const nativeOutline = await extractNativePdfOutline(pdfBuffer, timeoutMs);
  if (nativeOutline.length > 0) {
    return { ...result, outline: nativeOutline, outlineOrigin: 'native' };
  }
  const deterministicOutline = buildDeterministicPdfOutline(result.pages);
  return {
    ...result,
    outline: deterministicOutline,
    outlineOrigin: deterministicOutline.length > 0 ? 'deterministic' : 'none',
  };
};

const extractWithPdfParse = async (
  pdfBuffer: Buffer,
  timeoutMs?: number
): Promise<Omit<ExtractedPdfText, 'sourceHash'>> => {
  if (timeoutMs !== undefined) {
    if (timeoutMs <= 0) throw new PdfTextExtractionTimeoutError('pdf-parse');
    const result = await runPdfTextWorker(pdfBuffer, 'fallback', timeoutMs);
    const rawPages = Array.isArray(result.pages) ? result.pages : [];
    const fallbackText = typeof result.text === 'string' ? result.text : '';
    const pages = buildExtractedPages(
      rawPages.length > 0
        ? rawPages.flatMap(page => {
            if (!page || typeof page !== 'object') return [];
            const record = page as Record<string, unknown>;
            return typeof record.pageNumber === 'number' && typeof record.text === 'string'
              ? [{ pageNumber: record.pageNumber, text: record.text }]
              : [];
          })
        : [{ pageNumber: 1, text: fallbackText }]
    );
    const nativeOutline = normalizeNativePdfOutline(result.outline);
    const deterministicOutline =
      nativeOutline.length > 0 ? [] : buildDeterministicPdfOutline(pages);
    return {
      outline: nativeOutline.length > 0 ? nativeOutline : deterministicOutline,
      outlineOrigin:
        nativeOutline.length > 0
          ? 'native'
          : deterministicOutline.length > 0
            ? 'deterministic'
            : 'none',
      pageCount:
        typeof result.pageCount === 'number' && Number.isFinite(result.pageCount)
          ? result.pageCount
          : pages.length,
      pages,
      parser: 'pdf-parse',
      qualityWarning: PDF_TEXT_FALLBACK_WARNING,
      text: joinExtractedPages(pages),
      usedFallbackParser: true,
    };
  }
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

    const nativeOutline = normalizeNativePdfOutline(infoResult?.outline);
    const deterministicOutline =
      nativeOutline.length > 0 ? [] : buildDeterministicPdfOutline(pages);
    return {
      text: joinExtractedPages(pages),
      pages,
      parser: 'pdf-parse',
      pageCount: infoResult?.total ?? textResult.total ?? pages.length,
      qualityWarning: PDF_TEXT_FALLBACK_WARNING,
      usedFallbackParser: true,
      outline: nativeOutline.length > 0 ? nativeOutline : deterministicOutline,
      outlineOrigin:
        nativeOutline.length > 0
          ? 'native'
          : deterministicOutline.length > 0
            ? 'deterministic'
            : 'none',
    };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
};

const extractWithPdftotext = async (
  pdfBuffer: Buffer,
  timeoutMs?: number
): Promise<{
  result: Omit<ExtractedPdfText, 'sourceHash' | 'outline' | 'outlineOrigin'> | null;
  failureReason?: string;
}> => {
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
        ...(timeoutMs === undefined ? {} : { killSignal: 'SIGKILL', timeout: timeoutMs }),
      }
    );

    const rawPages = normalizeLineEndings(stdout).split('\f');
    while (rawPages.length > 1 && rawPages.at(-1)?.trim() === '') {
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

    const result: Omit<ExtractedPdfText, 'sourceHash' | 'outline' | 'outlineOrigin'> = {
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

export const extractPdfText = async (
  pdfDataUrl: string,
  timeouts: PdfTextExtractionTimeouts = {}
): Promise<ExtractedPdfText> => {
  const pdfBuffer = decodePdfDataUrl(pdfDataUrl);
  const sourceHash = buildSourceHash(pdfBuffer);

  const pdftotextResult = await extractWithPdftotext(pdfBuffer, timeouts.pdftotextTimeoutMs);
  if (pdftotextResult.result) {
    return {
      ...(await attachPdfOutline(pdfBuffer, pdftotextResult.result, timeouts.fallbackTimeoutMs)),
      sourceHash,
    };
  }

  const fallbackResult = await extractWithPdfParse(pdfBuffer, timeouts.fallbackTimeoutMs);
  return {
    ...fallbackResult,
    parserFallbackReason: pdftotextResult.failureReason,
    sourceHash,
  };
};
