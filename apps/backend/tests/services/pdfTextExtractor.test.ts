import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const pdfRuntimeMocks = vi.hoisted(() => ({
  execFileAsync: vi.fn(),
  workerMessages: [] as unknown[],
  workerOptions: [] as unknown[],
}));

vi.mock('node:util', async importOriginal => ({
  ...(await importOriginal<typeof import('node:util')>()),
  promisify: () => pdfRuntimeMocks.execFileAsync,
}));

vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    constructor(_url: URL, options: unknown) {
      super();
      pdfRuntimeMocks.workerOptions.push(options);
      queueMicrotask(() => this.emit('message', pdfRuntimeMocks.workerMessages.shift()));
    }

    removeAllListeners() {
      super.removeAllListeners();
      return this;
    }

    terminate = vi.fn(async () => 0);
  },
}));

import {
  buildDeterministicPdfOutline,
  extractPdfText,
  PdfTextExtractionOutputLimitError,
} from '../../src/services/pdfTextExtractor.js';
import {
  buildBoundedPdfTextWorkerPayload,
  PdfTextWorkerOutputLimitError,
} from '../../src/services/pdfTextWorkerOutput.js';

beforeEach(() => {
  pdfRuntimeMocks.execFileAsync.mockReset();
  pdfRuntimeMocks.workerMessages.length = 0;
  pdfRuntimeMocks.workerOptions.length = 0;
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
  test('bounds pdftotext output and the outline worker from caller options', async () => {
    const extractedText = 'Contenuto didattico estratto. '.repeat(8);
    pdfRuntimeMocks.execFileAsync.mockResolvedValue({ stdout: extractedText });
    pdfRuntimeMocks.workerMessages.push({ outline: [] });

    const result = await extractPdfText('data:application/pdf;base64,JVBERi0xLjQ=', {
      fallbackTimeoutMs: 15_000,
      maxOutputBytes: 1_000,
      pdftotextTimeoutMs: 15_000,
      workerMaxOldGenerationSizeMb: 272,
    });

    expect(result).toMatchObject({ parser: 'pdftotext', text: extractedText.trim() });
    expect(pdfRuntimeMocks.execFileAsync).toHaveBeenCalledWith(
      'pdftotext',
      expect.any(Array),
      expect.objectContaining({ maxBuffer: 1_000, timeout: 15_000 })
    );
    expect(pdfRuntimeMocks.workerOptions).toEqual([
      expect.objectContaining({
        resourceLimits: { maxOldGenerationSizeMb: 272 },
        workerData: expect.objectContaining({ maxOutputBytes: 1_000, mode: 'outline' }),
      }),
    ]);
  });

  test('maps a bounded fallback worker response to the stable output-limit error', async () => {
    pdfRuntimeMocks.execFileAsync.mockRejectedValue(new Error('pdftotext failed'));
    pdfRuntimeMocks.workerMessages.push({
      error: 'PDF fallback output exceeds the configured limit.',
      errorCode: 'output-limit',
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      extractPdfText('data:application/pdf;base64,JVBERi0xLjQ=', {
        fallbackTimeoutMs: 15_000,
        maxOutputBytes: 32,
        pdftotextTimeoutMs: 15_000,
        workerMaxOldGenerationSizeMb: 272,
      })
    ).rejects.toBeInstanceOf(PdfTextExtractionOutputLimitError);

    expect(pdfRuntimeMocks.workerOptions).toEqual([
      expect.objectContaining({
        resourceLimits: { maxOldGenerationSizeMb: 272 },
        workerData: expect.objectContaining({ maxOutputBytes: 32, mode: 'fallback' }),
      }),
    ]);
  });
});
