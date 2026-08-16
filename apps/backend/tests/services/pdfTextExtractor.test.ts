import { EventEmitter } from 'node:events';
import path from 'node:path';
import { serialize } from 'node:v8';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const pdfRuntimeMocks = vi.hoisted(() => ({
  execFileAsync: vi.fn(),
  processResults: [] as unknown[],
  spawnCalls: [] as unknown[],
  stdinErrors: [] as Error[],
}));

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn((command: string, args: string[], options: unknown) => {
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      stderr: EventEmitter;
      stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
      stdout: EventEmitter;
    };
    child.kill = vi.fn();
    child.stderr = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      end: vi.fn(() =>
        queueMicrotask(() => {
          const stdinError = pdfRuntimeMocks.stdinErrors.shift();
          if (stdinError) {
            child.stdin.emit('error', stdinError);
            return;
          }
          child.stdout.emit('data', serialize(pdfRuntimeMocks.processResults.shift()));
          child.emit('close', 0);
        })
      ),
    });
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
  resolvePdfTextFallbackNodeExecutable,
} from '../../src/services/pdfTextExtractor.js';
import {
  buildBoundedPdfTextWorkerPayload,
  PdfTextWorkerOutputLimitError,
} from '../../src/services/pdfTextWorkerOutput.js';

beforeEach(() => {
  pdfRuntimeMocks.execFileAsync.mockReset();
  pdfRuntimeMocks.processResults.length = 0;
  pdfRuntimeMocks.spawnCalls.length = 0;
  pdfRuntimeMocks.stdinErrors.length = 0;
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
        command: resolvePdfTextFallbackNodeExecutable(),
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
        command: resolvePdfTextFallbackNodeExecutable(),
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

  test('rejects fallback stdin failures without leaving an unhandled stream error', async () => {
    pdfRuntimeMocks.execFileAsync.mockRejectedValue(new Error('pdftotext failed'));
    pdfRuntimeMocks.stdinErrors.push(new Error('EPIPE'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      extractPdfText('data:application/pdf;base64,JVBERi0xLjQ=', {
        fallbackTimeoutMs: 15_000,
        pdftotextTimeoutMs: 15_000,
      })
    ).rejects.toThrow('EPIPE');
  });
});

describe('resolvePdfTextFallbackNodeExecutable', () => {
  test('accepts only an absolute operator override', () => {
    const absoluteExecutable = Bun.which('node');
    if (!absoluteExecutable) throw new Error('Expected Node.js on PATH for the test runtime.');

    expect(resolvePdfTextFallbackNodeExecutable(` ${absoluteExecutable} `)).toBe(
      absoluteExecutable
    );
    expect(() => resolvePdfTextFallbackNodeExecutable('node')).toThrow(TypeError);
  });

  test('resolves Node from PATH to an absolute executable before spawning', () => {
    const nodeExecutable = path.join(path.parse(process.execPath).root, 'tools', 'node');
    const which = vi.spyOn(Bun, 'which').mockReturnValueOnce(nodeExecutable);

    try {
      expect(resolvePdfTextFallbackNodeExecutable('')).toBe(nodeExecutable);
      expect(which).toHaveBeenCalledWith('node');
    } finally {
      which.mockRestore();
    }
  });

  test('fails at startup when Node cannot be resolved', () => {
    const which = vi.spyOn(Bun, 'which').mockReturnValueOnce(null);

    try {
      expect(() => resolvePdfTextFallbackNodeExecutable('')).toThrow(/not found on PATH/u);
    } finally {
      which.mockRestore();
    }
  });
});
