// Extracts text from uploaded PDF files through the backend parser flow.
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deserialize } from 'node:v8';

import { PDFParse } from 'pdf-parse';

import { buildSha256HexDigest } from '../utils/hash.js';
import { decodePdfDataUrl } from '../utils/pdfDataUrl.js';
import { normalizeLineEndings } from '../utils/text.js';

const execFileAsync = promisify(execFile);
const TMP_DIR_PREFIX = 'nous-pdf-text-';
const PDF_PROCESS_SERIALIZATION_OVERHEAD_BYTES = 1_000_000;
const PDF_PROCESS_SERIALIZATION_BYTES_PER_OUTPUT_BYTE = 2;
const PDF_PROCESS_STDERR_MAX_CHARS = 8_192;
export const resolvePdfTextFallbackNodeExecutable = (
  configuredExecutable = process.env.PDF_TEXT_FALLBACK_NODE_EXECUTABLE
): string => {
  const executable = configuredExecutable?.trim();
  if (executable && !path.isAbsolute(executable)) {
    throw new TypeError('PDF_TEXT_FALLBACK_NODE_EXECUTABLE must be an absolute path.');
  }

  const resolvedExecutable = Bun.which(executable || 'node');
  if (!resolvedExecutable || !path.isAbsolute(resolvedExecutable)) {
    throw new TypeError(
      executable
        ? 'PDF_TEXT_FALLBACK_NODE_EXECUTABLE must point to an executable file.'
        : 'Node.js is required for PDF fallback extraction but was not found on PATH.'
    );
  }
  return resolvedExecutable;
};
const PDF_TEXT_FALLBACK_NODE_EXECUTABLE = resolvePdfTextFallbackNodeExecutable();
const PDF_TEXT_FALLBACK_WARNING =
  'Estrazione testo eseguita con parser di fallback; qualita e impaginazione potrebbero essere meno fedeli.';

export interface PdfTextExtractionOptions {
  fallbackTimeoutMs?: number;
  maxOutputBytes?: number;
  pdftotextTimeoutMs?: number;
  fallbackProcessMaxOldGenerationSizeMb?: number;
}

export class PdfTextExtractionTimeoutError extends Error {
  constructor(readonly stage: 'pdf-parse' | 'pdftotext') {
    super(`PDF text extraction timed out during ${stage}.`);
    this.name = 'PdfTextExtractionTimeoutError';
  }
}

export class PdfTextExtractionOutputLimitError extends Error {
  constructor() {
    super('PDF text extraction exceeded the configured output limit.');
    this.name = 'PdfTextExtractionOutputLimitError';
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

type ExtractedPdfTextWithoutSourceHash = Omit<ExtractedPdfText, 'sourceHash'>;
type ExtractedPdfTextWithoutSourceMetadata = Omit<
  ExtractedPdfText,
  'sourceHash' | 'outline' | 'outlineOrigin'
>;

interface PdfTextProcessResult {
  error?: string;
  errorCode?: string;
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

const runPdfTextFallbackProcess = (
  pdfBuffer: Buffer,
  mode: 'fallback' | 'outline',
  timeoutMs: number,
  limits: Pick<
    PdfTextExtractionOptions,
    'fallbackProcessMaxOldGenerationSizeMb' | 'maxOutputBytes'
  > = {}
): Promise<PdfTextProcessResult> =>
  new Promise((resolve, reject) => {
    const processPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'pdfTextFallbackProcess.mjs'
    );
    const processArguments = [
      ...(limits.fallbackProcessMaxOldGenerationSizeMb === undefined
        ? []
        : [`--max-old-space-size=${limits.fallbackProcessMaxOldGenerationSizeMb}`]),
      processPath,
      mode,
      limits.maxOutputBytes?.toString() ?? '',
    ];
    const fallbackProcess = spawn(PDF_TEXT_FALLBACK_NODE_EXECUTABLE, processArguments, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    const maxSerializedBytes =
      limits.maxOutputBytes === undefined
        ? undefined
        : limits.maxOutputBytes * PDF_PROCESS_SERIALIZATION_BYTES_PER_OUTPUT_BYTE +
          PDF_PROCESS_SERIALIZATION_OVERHEAD_BYTES;
    let stderr = '';
    const timeout = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      fallbackProcess.kill();
      reject(new PdfTextExtractionTimeoutError('pdf-parse'));
    }, timeoutMs);

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      fallbackProcess.removeAllListeners();
      callback();
    };

    fallbackProcess.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.byteLength;
      if (maxSerializedBytes !== undefined && stdoutBytes > maxSerializedBytes) {
        settle(() => {
          fallbackProcess.kill();
          reject(new PdfTextExtractionOutputLimitError());
        });
        return;
      }
      stdoutChunks.push(chunk);
    });
    fallbackProcess.stderr.on('data', (chunk: Buffer) => {
      if (settled) return;
      if (stderr.length < PDF_PROCESS_STDERR_MAX_CHARS) stderr += chunk.toString('utf8');
    });
    fallbackProcess.once('error', error => settle(() => reject(error)));
    fallbackProcess.stdin.on('error', error => {
      if (!settled) settle(() => reject(error));
    });
    fallbackProcess.once('close', code =>
      settle(() => {
        if (code !== 0) {
          reject(
            /heap out of memory/iu.test(stderr)
              ? new PdfTextExtractionOutputLimitError()
              : new Error(`PDF fallback process exited with code ${code}.`)
          );
          return;
        }
        let result: PdfTextProcessResult;
        try {
          result = deserialize(Buffer.concat(stdoutChunks)) as PdfTextProcessResult;
        } catch {
          reject(new Error('PDF fallback process returned an invalid response.'));
          return;
        }
        if (result.errorCode === 'output-limit') {
          reject(new PdfTextExtractionOutputLimitError());
          return;
        }
        if (result.error) {
          reject(new Error(result.error));
          return;
        }
        resolve(result);
      })
    );
    fallbackProcess.stdin.end(pdfBuffer);
  });

const extractNativePdfOutline = async (
  pdfBuffer: Buffer,
  options: PdfTextExtractionOptions = {}
): Promise<ExtractedPdfOutlineNode[]> => {
  const timeoutMs = options.fallbackTimeoutMs;
  if (timeoutMs !== undefined) {
    if (timeoutMs <= 0) return [];
    try {
      const result = await runPdfTextFallbackProcess(pdfBuffer, 'outline', timeoutMs, options);
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
  result: ExtractedPdfTextWithoutSourceMetadata,
  options: PdfTextExtractionOptions = {}
): Promise<ExtractedPdfTextWithoutSourceHash> => {
  const nativeOutline = await extractNativePdfOutline(pdfBuffer, options);
  return {
    ...result,
    ...buildPdfOutlineFields(result.pages, nativeOutline),
  };
};

const buildPdfOutlineFields = (
  pages: ExtractedPdfTextPage[],
  nativeOutline: ExtractedPdfOutlineNode[]
): Pick<ExtractedPdfText, 'outline' | 'outlineOrigin'> => {
  if (nativeOutline.length > 0) {
    return { outline: nativeOutline, outlineOrigin: 'native' };
  }
  const deterministicOutline = buildDeterministicPdfOutline(pages);
  return {
    outline: deterministicOutline,
    outlineOrigin: deterministicOutline.length > 0 ? 'deterministic' : 'none',
  };
};

const buildFallbackProcessPages = (result: PdfTextProcessResult): ExtractedPdfTextPage[] => {
  const rawPages = Array.isArray(result.pages) ? result.pages : [];
  const fallbackText = typeof result.text === 'string' ? result.text : '';
  if (rawPages.length === 0) {
    return buildExtractedPages([{ pageNumber: 1, text: fallbackText }]);
  }
  return buildExtractedPages(
    rawPages.flatMap(page => {
      if (!page || typeof page !== 'object') return [];
      const record = page as Record<string, unknown>;
      if (typeof record.pageNumber !== 'number' || typeof record.text !== 'string') return [];
      return [{ pageNumber: record.pageNumber, text: record.text }];
    })
  );
};

const extractWithFallbackProcess = async (
  pdfBuffer: Buffer,
  timeoutMs: number,
  options: PdfTextExtractionOptions
): Promise<ExtractedPdfTextWithoutSourceHash> => {
  if (timeoutMs <= 0) throw new PdfTextExtractionTimeoutError('pdf-parse');
  const result = await runPdfTextFallbackProcess(pdfBuffer, 'fallback', timeoutMs, options);
  const pages = buildFallbackProcessPages(result);
  const outlineFields = buildPdfOutlineFields(pages, normalizeNativePdfOutline(result.outline));
  return {
    ...outlineFields,
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
};

const extractWithPdfParse = async (
  pdfBuffer: Buffer,
  options: PdfTextExtractionOptions = {}
): Promise<ExtractedPdfTextWithoutSourceHash> => {
  const timeoutMs = options.fallbackTimeoutMs;
  if (timeoutMs !== undefined) {
    return extractWithFallbackProcess(pdfBuffer, timeoutMs, options);
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

    const outlineFields = buildPdfOutlineFields(
      pages,
      normalizeNativePdfOutline(infoResult?.outline)
    );
    return {
      ...outlineFields,
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
  pdfBuffer: Buffer,
  options: PdfTextExtractionOptions = {}
): Promise<{
  result: ExtractedPdfTextWithoutSourceMetadata | null;
  failureReason?: string;
}> => {
  const timeoutMs = options.pdftotextTimeoutMs;
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), TMP_DIR_PREFIX));
  const pdfPath = path.join(tmpDir, 'document.pdf');

  try {
    await writeFile(pdfPath, pdfBuffer);

    const { stdout } = await execFileAsync(
      'pdftotext',
      ['-layout', '-enc', 'UTF-8', '-eol', 'unix', pdfPath, '-'],
      {
        windowsHide: true,
        maxBuffer: Math.min(64 * 1024 * 1024, options.maxOutputBytes ?? Number.MAX_SAFE_INTEGER),
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

    const result: ExtractedPdfTextWithoutSourceMetadata = {
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
  options: PdfTextExtractionOptions = {}
): Promise<ExtractedPdfText> => {
  const pdfBuffer = decodePdfDataUrl(pdfDataUrl);
  const sourceHash = buildSourceHash(pdfBuffer);

  const pdftotextResult = await extractWithPdftotext(pdfBuffer, options);
  if (pdftotextResult.result) {
    return {
      ...(await attachPdfOutline(pdfBuffer, pdftotextResult.result, options)),
      sourceHash,
    };
  }

  const fallbackResult = await extractWithPdfParse(pdfBuffer, options);
  return {
    ...fallbackResult,
    parserFallbackReason: pdftotextResult.failureReason,
    sourceHash,
  };
};
