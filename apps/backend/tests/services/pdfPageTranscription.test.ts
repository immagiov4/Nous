import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { formatPdfTranscriptionMarker } from '@shared/pdfTranscription';
import { beforeEach, expect, test, vi } from 'vitest';
import { extractPdfTextLayer } from '../../src/services/pdfTextExtractor.js';
import recording from '../fixtures/pdf-transcription-response.json';
import { buildPdfPageFixture, buildPdfTextDataUrl } from '../fixtures/pdfText.js';

const provider = vi.hoisted(() => ({ generateText: vi.fn(), runCodexAppServerTurn: vi.fn() }));
vi.mock('ai', async original => ({
  ...(await original<typeof import('ai')>()),
  generateText: provider.generateText,
}));
vi.mock('../../src/services/codexAppServer.js', () => ({
  runCodexAppServerTurn: provider.runCodexAppServerTurn,
}));
vi.mock('../../src/services/aiSdkTextModel.js', () => ({
  createConfiguredTextModel: () => ({ model: {}, providerOptions: {} }),
}));

import { getResolvedGlobalModelConfig } from '../../src/config/modelConfig.js';

const { completePdfTextExtraction, inspectPdfPageText } = await import(
  '../../src/services/pdfPageTranscription.js'
);

const recordedPage = recording.response;
const textLayer = (text: string) => ({
  text,
  pages: [{ pageNumber: 1, text }],
  sourceHash: 'synthetic',
  parser: 'pdf-parse' as const,
  usedFallbackParser: true,
  outline: [],
  outlineOrigin: 'none' as const,
});
const bytes = Buffer.from(buildPdfTextDataUrl().split(',')[1], 'base64');
const scannedBytes = await readFile(new URL('../fixtures/synthetic-proof.pdf', import.meta.url));

beforeEach(() => {
  provider.runCodexAppServerTurn.mockReset();
  provider.generateText.mockReset().mockResolvedValue({
    output: recordedPage,
    usage: { inputTokens: 120, outputTokens: 40 },
    providerMetadata: { openrouter: { usage: { cost: 0.0001 } } },
  });
});

test('transcribes a scanned page without extracted text as Markdown and retains its physical page number', async () => {
  const result = await completePdfTextExtraction(scannedBytes, textLayer(''), {
    config: await getResolvedGlobalModelConfig(),
  });
  expect(result.pages).toMatchObject([
    { pageNumber: 1, text: `${formatPdfTranscriptionMarker(1)}\n\n${recordedPage.markdown}` },
  ]);
  expect(result.text).toContain(recordedPage.markdown);
  expect(result.transcription?.pages).toEqual([1]);
  expect(result.transcription?.inputTokens).toBe(120);
});

test('keeps a usable text page byte-for-byte without a provider call', async () => {
  const clean = 'A clean selectable text page with a small amount of prose.';
  const fixture = buildPdfPageFixture([`BT /F1 12 Tf 10 100 Td (${clean}) Tj ET`]);
  const result = await completePdfTextExtraction(fixture, textLayer(clean), {
    config: await getResolvedGlobalModelConfig(),
  });
  expect(result.pages[0].text).toBe(clean);
  expect(provider.generateText).not.toHaveBeenCalled();
});

test('reports the failed page and rejects incomplete source material', async () => {
  provider.generateText.mockResolvedValue({
    output: { markdown: '', status: 'unreadable' },
    usage: {},
  });
  await expect(
    completePdfTextExtraction(bytes, textLayer(''), {
      config: await getResolvedGlobalModelConfig(),
    })
  ).rejects.toMatchObject({ failedPages: [1] });
});

test('replaces garbage invisible OCR in a mixed document and keeps clean pages in order', async () => {
  const fixture = buildPdfPageFixture([
    'BT /F1 12 Tf 10 100 Td (Clean first page) Tj ET',
    'BT /F1 12 Tf 3 Tr 10 100 Td (Scanner gibberish) Tj ET',
    'BT /F1 12 Tf 10 100 Td (Clean final page) Tj ET',
  ]);
  const raw = {
    ...textLayer(''),
    pageCount: 3,
    pages: [
      { pageNumber: 1, text: 'Clean first page' },
      { pageNumber: 2, text: 'Scanner gibberish' },
      { pageNumber: 3, text: 'Clean final page' },
    ],
  };
  const progress: unknown[] = [];
  const result = await completePdfTextExtraction(fixture, raw, {
    config: await getResolvedGlobalModelConfig(),
    onProgress: event => progress.push(event),
  });
  expect(result.pages).toMatchObject([
    { pageNumber: 1, text: 'Clean first page' },
    { pageNumber: 2, text: `${formatPdfTranscriptionMarker(2)}\n\n${recordedPage.markdown}` },
    { pageNumber: 3, text: 'Clean final page' },
  ]);
  expect(result.transcription?.pages).toEqual([2]);
  expect(provider.generateText).toHaveBeenCalledOnce();
  expect(progress).toEqual([
    { completed: 0, total: 1, failedPages: [] },
    { completed: 1, total: 1, failedPages: [] },
  ]);
});

test('recovers an empty trailing page even when the text parser omitted it', async () => {
  const fixture = buildPdfPageFixture(['BT /F1 12 Tf 10 100 Td (Clean first page) Tj ET', '']);
  const result = await completePdfTextExtraction(fixture, textLayer('Clean first page'), {
    config: await getResolvedGlobalModelConfig(),
  });
  expect(result.pages).toMatchObject([
    { pageNumber: 1, text: 'Clean first page' },
    { pageNumber: 2, text: `${formatPdfTranscriptionMarker(2)}\n\n${recordedPage.markdown}` },
  ]);
  expect(result.pageCount).toBe(2);
});

test('detects math symbols lost by a parser even when prose remains readable', async () => {
  const page = {
    cleanup: () => {},
    getTextContent: async () => ({ items: [{ str: 'A ∪ B ∩ C ∈ D' }] }),
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
  };
  expect(await inspectPdfPageText(page, 'A B C D')).toEqual(['lost-text-glyph']);
  expect(await inspectPdfPageText(page, 'A ∪ B ∩ C ∈ D')).toEqual([]);
});

test.each([
  ['α = 2', '= 2'],
  ['x² = 4', 'x = 4'],
  ['x₃ = 4', 'x = 4'],
])('detects lost letters and digits without relying on operator loss: %s', async (original, extracted) => {
  const page = {
    cleanup: () => {},
    getTextContent: async () => ({ items: [{ str: original }] }),
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
  };
  expect(await inspectPdfPageText(page, extracted)).toEqual(['lost-text-glyph']);
  expect(await inspectPdfPageText(page, original)).toEqual([]);
});

test('detects unknown glyphs while keeping a private-font bullet as usable text', async () => {
  const page = {
    cleanup: () => {},
    getTextContent: async () => ({ items: [{ str: 'Text' }] }),
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
  };
  expect(await inspectPdfPageText(page, 'A\u0000B')).toEqual(['unmapped-glyph', 'lost-text-glyph']);
  expect(await inspectPdfPageText(page, '\uf0b7 Text')).toEqual([]);
});

test('uses the configured Codex provider and records its reported token usage', async () => {
  provider.runCodexAppServerTurn.mockImplementation(async request => {
    request.onUsage({ inputTokens: 90, outputTokens: 30 });
    return JSON.stringify(recordedPage);
  });
  const config = {
    ...(await getResolvedGlobalModelConfig()),
    aiProvider: 'codex' as const,
    aiProviderOverrides: {},
    codexResearchModel: 'research-vision-fixture',
    codexLessonModel: 'lesson-fixture',
    codexFastModelSlots: ['research' as const],
    researchReasoningEffort: 'low' as const,
    lessonReasoningEffort: 'high' as const,
  };
  const result = await completePdfTextExtraction(bytes, textLayer(''), { config });
  expect(result.text).toContain(recordedPage.markdown);
  expect(result.transcription).toMatchObject({ inputTokens: 90, outputTokens: 30 });
  expect(provider.generateText).not.toHaveBeenCalled();
  expect(provider.runCodexAppServerTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'research-vision-fixture',
      reasoningEffort: 'low',
      serviceTier: 'fast',
      slot: 'research',
    })
  );
});

test('repairs invalid LaTeX once before admitting a page to the text pipeline', async () => {
  provider.generateText
    .mockResolvedValueOnce({
      output: { markdown: '$\\unsupportedMath{x}$', status: 'ok' },
      usage: { inputTokens: 100, outputTokens: 20 },
    })
    .mockResolvedValueOnce({ output: recordedPage, usage: { inputTokens: 150, outputTokens: 40 } });
  const result = await completePdfTextExtraction(bytes, textLayer(''), {
    config: await getResolvedGlobalModelConfig(),
  });
  expect(provider.generateText).toHaveBeenCalledTimes(2);
  expect(result.text).toContain(recordedPage.markdown);
  expect(result.transcription).toMatchObject({ inputTokens: 250, outputTokens: 60 });
});

test('rejects a page whose corrective response still contains unrenderable math', async () => {
  provider.generateText.mockResolvedValue({
    output: { markdown: '$\\unsupportedMath{x}$', status: 'ok' },
    usage: {},
  });
  await expect(
    completePdfTextExtraction(bytes, textLayer(''), {
      config: await getResolvedGlobalModelConfig(),
    })
  ).rejects.toMatchObject({ failedPages: [1] });
  expect(provider.generateText).toHaveBeenCalledTimes(2);
});

test('uses pdf-parse to recover digital math dropped by pdftotext without a vision call', async () => {
  const fixture = buildPdfPageFixture(['BT /F1 12 Tf 10 100 Td (A \\310 B) Tj ET'], 'Symbol');
  const result = await completePdfTextExtraction(
    fixture,
    { ...textLayer('A B'), parser: 'pdftotext', usedFallbackParser: false },
    { config: await getResolvedGlobalModelConfig() }
  );
  expect(result.text).toContain('∪');
  expect(provider.generateText).not.toHaveBeenCalled();
  expect(result.transcription).toBeUndefined();
});

test('renders JPEG 2000 scans with the bundled PDF.js decoder instead of sending a white page', async () => {
  const fixture = await readFile(new URL('../fixtures/red-jpx-page.pdf', import.meta.url));
  await completePdfTextExtraction(fixture, textLayer(''), {
    config: await getResolvedGlobalModelConfig(),
  });
  const request = provider.generateText.mock.calls[0][0];
  const { createCanvas, loadImage } = createRequire(
    createRequire(import.meta.url).resolve('pdf-parse')
  )('@napi-rs/canvas');
  const image = await loadImage(request.messages[0].content[0].image);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  expect(Array.from(context.getImageData(image.width / 2, image.height / 2, 1, 1).data)).toEqual([
    255, 0, 0, 255,
  ]);
});

test('marks a recorded transcription slip durably in page text and metadata', async () => {
  provider.generateText.mockResolvedValue({
    output: {
      status: 'ok',
      markdown: 'If $n=2k$, then $n^2=4k^2$. Thus $n \\Leftrightarrow n^2$ is even.',
    },
    usage: { inputTokens: 120, outputTokens: 40 },
  });
  const result = await completePdfTextExtraction(bytes, textLayer(''), {
    config: await getResolvedGlobalModelConfig(),
  });
  expect(result.pages[0]).toMatchObject({
    provenance: { kind: 'vision-transcription', pageNumber: 1 },
  });
  expect(result.pages[0].text).toContain('transcribed from scanned handwriting/image');
});

test('counts a billed response even when its syntax correction fails', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  provider.generateText
    .mockResolvedValueOnce({
      output: { status: 'ok', markdown: String.raw`$\unknowncommand{x}$` },
      usage: { inputTokens: 120, outputTokens: 40 },
      providerMetadata: { openrouter: { usage: { cost: 0.001 } } },
    })
    .mockRejectedValueOnce(new Error('recorded provider interruption'));
  try {
    await expect(
      completePdfTextExtraction(bytes, textLayer(''), {
        config: await getResolvedGlobalModelConfig(),
      })
    ).rejects.toMatchObject({ failedPages: [1] });
    expect(log).toHaveBeenCalledWith(
      '[Nous][PDF] Document transcription',
      expect.objectContaining({
        inputTokens: 120,
        outputTokens: 40,
        costUsd: 0.001,
        failedPages: [1],
      })
    );
  } finally {
    log.mockRestore();
  }
});

test('records Codex usage before rejecting malformed JSON', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  provider.runCodexAppServerTurn.mockImplementation(async request => {
    request.onUsage({ inputTokens: 90, outputTokens: 30 });
    return 'malformed response';
  });
  try {
    await expect(
      completePdfTextExtraction(bytes, textLayer(''), {
        config: {
          ...(await getResolvedGlobalModelConfig()),
          aiProvider: 'codex',
          aiProviderOverrides: {},
        },
      })
    ).rejects.toMatchObject({ failedPages: [1] });
    expect(log).toHaveBeenCalledWith(
      '[Nous][PDF] Document transcription',
      expect.objectContaining({ inputTokens: 90, outputTokens: 30, failedPages: [1] })
    );
  } finally {
    log.mockRestore();
  }
});

test('interrupts a pending raster operation when its page deadline expires', async () => {
  const { PDFParse } = await import('pdf-parse');
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const started = Promise.withResolvers<void>();
  const render = vi.spyOn(PDFParse.prototype, 'getScreenshot').mockImplementation(() => {
    started.resolve();
    return new Promise(() => {});
  });
  const destroy = vi.spyOn(PDFParse.prototype, 'destroy');
  try {
    const pending = completePdfTextExtraction(bytes, textLayer(''), {
      config: await getResolvedGlobalModelConfig(),
    });
    const rejected = expect(pending).rejects.toMatchObject({ failedPages: [1] });
    await started.promise;
    deadline.abort(new Error('recorded page deadline'));
    await rejected;
    expect(destroy).toHaveBeenCalled();
    expect(provider.generateText).not.toHaveBeenCalled();
  } finally {
    render.mockRestore();
    destroy.mockRestore();
    timeout.mockRestore();
  }
});

test('corrects an unclosed math delimiter instead of inserting an unrendered formula', async () => {
  provider.generateText
    .mockResolvedValueOnce({
      output: { status: 'ok', markdown: 'A formula: $x+1' },
      usage: { inputTokens: 100, outputTokens: 20 },
    })
    .mockResolvedValueOnce({ output: recordedPage, usage: { inputTokens: 100, outputTokens: 30 } });
  const result = await completePdfTextExtraction(bytes, textLayer(''), {
    config: await getResolvedGlobalModelConfig(),
  });
  expect(provider.generateText).toHaveBeenCalledTimes(2);
  expect(result.text).toContain(recordedPage.markdown);
});

test('rejects a corrective response that erases a page previously classified as nonempty', async () => {
  provider.generateText
    .mockResolvedValueOnce({
      output: { ...recordedPage, markdown: '$\\unsupportedMath{x}$' },
      usage: { inputTokens: 100, outputTokens: 20 },
    })
    .mockResolvedValueOnce({
      output: { markdown: '', status: 'blank' },
      usage: { inputTokens: 100, outputTokens: 5 },
    });
  await expect(
    completePdfTextExtraction(bytes, textLayer(''), {
      config: await getResolvedGlobalModelConfig(),
    })
  ).rejects.toMatchObject({ failedPages: [1] });
  expect(provider.generateText).toHaveBeenCalledTimes(2);
});

test('logs completed paid responses when another page is cancelled', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  const controller = new AbortController();
  const secondStarted = Promise.withResolvers<void>();
  const firstCompleted = Promise.withResolvers<void>();
  provider.generateText
    .mockResolvedValueOnce({
      output: recordedPage,
      usage: { inputTokens: 120, outputTokens: 40 },
      providerMetadata: { openrouter: { usage: { cost: 0.001 } } },
    })
    .mockImplementationOnce(({ abortSignal }) => {
      secondStarted.resolve();
      return new Promise((_resolve, reject) =>
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true })
      );
    });
  try {
    const pending = completePdfTextExtraction(buildPdfPageFixture(['', '']), textLayer(''), {
      config: await getResolvedGlobalModelConfig(),
      signal: controller.signal,
      onProgress: progress => {
        if (progress.completed === 1) firstCompleted.resolve();
      },
    });
    const rejected = expect(pending).rejects.toThrow('cancelled upload');
    await Promise.all([secondStarted.promise, firstCompleted.promise]);
    controller.abort(new Error('cancelled upload'));
    await rejected;
    expect(log).toHaveBeenCalledWith(
      '[Nous][PDF] Document transcription',
      expect.objectContaining({
        inputTokens: 120,
        outputTokens: 40,
        costUsd: 0.001,
        transcribedPageCount: 1,
        usageIncomplete: true,
      })
    );
  } finally {
    controller.abort();
    log.mockRestore();
  }
});

test('reads Unicode math text from the isolated Node parser process', async () => {
  const bytes = buildPdfPageFixture(
    [
      'BT /F1 12 Tf 10 100 Td (ABC) Tj ET',
      'BT /F1 12 Tf 10 100 Td (123) Tj ET',
      'BT /F1 12 Tf 10 100 Td (123) Tj ET',
    ],
    'Symbol'
  );
  const result = await extractPdfTextLayer(
    `data:application/pdf;base64,${bytes.toString('base64')}`,
    { fallbackTimeoutMs: 15000, maxOutputBytes: 1000000 }
  );
  expect(result.pages[0].text).toBe('ΑΒΧ');
});
