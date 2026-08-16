import { EventEmitter } from 'node:events';
import { serialize } from 'node:v8';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const pdfRuntimeMocks = vi.hoisted(() => ({
  execFileAsync: vi.fn(),
  processResults: [] as unknown[],
  spawnCalls: [] as unknown[],
}));
const expectedFallbackNodeExecutable =
  process.platform === 'win32'
    ? String.raw`C:\Program Files\nodejs\node.exe`
    : '/usr/local/bin/node';

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn((command: string, args: string[], options: unknown) => {
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      stderr: EventEmitter;
      stdin: { end: ReturnType<typeof vi.fn> };
      stdout: EventEmitter;
    };
    child.kill = vi.fn();
    child.stderr = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = {
      end: vi.fn(() =>
        queueMicrotask(() => {
          child.stdout.emit('data', serialize(pdfRuntimeMocks.processResults.shift()));
          child.emit('close', 0);
        })
      ),
    };
    pdfRuntimeMocks.spawnCalls.push({ args, command, options });
    return child;
  }),
}));

vi.mock('node:util', async importOriginal => ({
  ...(await importOriginal<typeof import('node:util')>()),
  promisify: () => pdfRuntimeMocks.execFileAsync,
}));

import {
  buildDeterministicPdfOutline,
  extractPdfText,
  PdfTextExtractionOutputLimitError,
  PdfTextExtractionTimeoutError,
} from '../../src/services/pdfTextExtractor.js';
import {
  buildBoundedPdfTextWorkerPayload,
  PdfTextWorkerOutputLimitError,
} from '../../src/services/pdfTextWorkerOutput.js';

beforeEach(() => {
  pdfRuntimeMocks.execFileAsync.mockReset();
  pdfRuntimeMocks.processResults.length = 0;
  pdfRuntimeMocks.spawnCalls.length = 0;
});

describe('buildDeterministicPdfOutline', () => {
  test('builds a stable hierarchy from numbered headings and keeps page provenance', () => {
    const outline = buildDeterministicPdfOutline([
      {
        pageNumber: 2,
        text: '1 Fondamenti\n1.1 Concetti essenziali\nTesto normale che non e un titolo',
      },
      {
        pageNumber: 5,
        text: '1.1 Concetti essenziali\n2 Applicazioni\nCapitolo III Approfondimenti',
      },
    ]);

    expect(outline.map(node => node.title)).toEqual([
      '1 Fondamenti',
      '2 Applicazioni',
      'Capitolo III Approfondimenti',
    ]);
    expect(outline[0]?.children).toEqual([
      expect.objectContaining({ title: '1.1 Concetti essenziali', level: 2, page: 2 }),
    ]);
    expect(outline.flatMap(node => [node, ...node.children]).map(node => node.id)).toEqual([
      'outline-1',
      'outline-2',
      'outline-3',
      'outline-4',
    ]);
  });
});

describe('buildBoundedPdfTextWorkerPayload', () => {
  test('sends page text once and keeps it below the structured-clone budget', () => {
    const payload = buildBoundedPdfTextWorkerPayload({
      fallbackText: 'duplicato non necessario',
      maxOutputBytes: 32,
      outline: [],
      pages: [{ num: 3, text: 'Testo pagina' }],
    });

    expect(payload).toEqual({
      outline: [],
      pages: [{ pageNumber: 3, text: 'Testo pagina' }],
    });
  });

  test('rejects UTF-8 text and outlines that exceed the worker output budget', () => {
    expect(() =>
      buildBoundedPdfTextWorkerPayload({
        fallbackText: '',
        maxOutputBytes: 3,
        outline: [],
        pages: [{ num: 1, text: 'éé' }],
      })
    ).toThrow(PdfTextWorkerOutputLimitError);
    expect(() =>
      buildBoundedPdfTextWorkerPayload({
        fallbackText: '',
        maxOutputBytes: 4,
        outline: [{ title: 'capitolo' }],
        pages: [],
      })
    ).toThrow(PdfTextWorkerOutputLimitError);
  });
});

describe('extractPdfText resource limits', () => {
  test('bounds pdftotext output and the outline subprocess from caller options', async () => {
    const extractedText = 'Contenuto didattico estratto. '.repeat(8);
    pdfRuntimeMocks.execFileAsync.mockResolvedValue({ stdout: extractedText });
    pdfRuntimeMocks.processResults.push({ outline: [] });

    const result = await extractPdfText('data:application/pdf;base64,JVBERi0xLjQ=', {
      fallbackTimeoutMs: 15_000,
      maxOutputBytes: 1_000,
      pdftotextTimeoutMs: 15_000,
      fallbackProcessMaxOldGenerationSizeMb: 272,
    });

    expect(result).toMatchObject({ parser: 'pdftotext', text: extractedText.trim() });
    expect(pdfRuntimeMocks.execFileAsync).toHaveBeenCalledWith(
      'pdftotext',
      expect.any(Array),
      expect.objectContaining({ maxBuffer: 1_000, timeout: 15_000 })
    );
    expect(pdfRuntimeMocks.spawnCalls).toEqual([
      expect.objectContaining({
        args: expect.arrayContaining(['--max-old-space-size=272', 'outline', '1000']),
        command: expectedFallbackNodeExecutable,
      }),
    ]);
  });

  test('maps a bounded fallback subprocess response to the stable output-limit error', async () => {
    pdfRuntimeMocks.execFileAsync.mockRejectedValue(new Error('pdftotext failed'));
    pdfRuntimeMocks.processResults.push({
      error: 'PDF fallback output exceeds the configured limit.',
      errorCode: 'output-limit',
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      extractPdfText('data:application/pdf;base64,JVBERi0xLjQ=', {
        fallbackTimeoutMs: 15_000,
        maxOutputBytes: 32,
        pdftotextTimeoutMs: 15_000,
        fallbackProcessMaxOldGenerationSizeMb: 272,
      })
    ).rejects.toBeInstanceOf(PdfTextExtractionOutputLimitError);

    expect(pdfRuntimeMocks.spawnCalls).toEqual([
      expect.objectContaining({
        args: expect.arrayContaining(['--max-old-space-size=272', 'fallback', '32']),
        command: expectedFallbackNodeExecutable,
      }),
    ]);
  });

  test('uses fallback text and a native outline when the subprocess returns no pages', async () => {
    pdfRuntimeMocks.execFileAsync.mockRejectedValue(new Error('pdftotext failed'));
    pdfRuntimeMocks.processResults.push({
      outline: [{ dest: [0], title: 'Indice' }],
      pageCount: 1,
      text: 'Contenuto didattico dal parser di fallback.',
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await extractPdfText('data:application/pdf;base64,JVBERi0xLjQ=', {
      fallbackTimeoutMs: 15_000,
      maxOutputBytes: 1_000,
      pdftotextTimeoutMs: 15_000,
    });

    expect(result).toMatchObject({
      outline: [expect.objectContaining({ page: 1, title: 'Indice' })],
      outlineOrigin: 'native',
      pageCount: 1,
      pages: [{ pageNumber: 1, text: 'Contenuto didattico dal parser di fallback.' }],
    });
  });

  test('keeps only valid subprocess pages and derives their deterministic outline', async () => {
    pdfRuntimeMocks.execFileAsync.mockRejectedValue(new Error('pdftotext failed'));
    pdfRuntimeMocks.processResults.push({
      outline: [],
      pages: [
        null,
        {},
        { pageNumber: '1', text: 'scarto' },
        { pageNumber: 2, text: '1 Fondamenti' },
      ],
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await extractPdfText('data:application/pdf;base64,JVBERi0xLjQ=', {
      fallbackTimeoutMs: 15_000,
      maxOutputBytes: 1_000,
      pdftotextTimeoutMs: 15_000,
    });

    expect(result).toMatchObject({
      outline: [expect.objectContaining({ page: 2, title: '1 Fondamenti' })],
      outlineOrigin: 'deterministic',
      pageCount: 1,
      pages: [{ pageNumber: 2, text: '1 Fondamenti' }],
    });
  });

  test('rejects a non-positive fallback timeout before starting the subprocess', async () => {
    pdfRuntimeMocks.execFileAsync.mockRejectedValue(new Error('pdftotext failed'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      extractPdfText('data:application/pdf;base64,JVBERi0xLjQ=', {
        fallbackTimeoutMs: 0,
        pdftotextTimeoutMs: 15_000,
      })
    ).rejects.toBeInstanceOf(PdfTextExtractionTimeoutError);
    expect(pdfRuntimeMocks.spawnCalls).toEqual([]);
  });
});
