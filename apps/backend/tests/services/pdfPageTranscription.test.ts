import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { formatPdfTranscriptionMarker } from '@shared/pdfTranscription';
import { APICallError } from 'ai';
import { beforeEach, expect, test, vi } from 'vitest';
import type { SourcePreparationContext } from '../../src/projects/sourcePreparationContext.js';
import * as pdfTasks from '../../src/services/pdfPageTask.js';
import { extractPdfTextLayer } from '../../src/services/pdfTextExtractor.js';
import { normalizePdfTranscriptionMarkdown } from '../../src/services/pdfTranscriptionMath.js';
import { PdfTranscriptionPool } from '../../src/services/pdfTranscriptionPool.js';
import recording from '../fixtures/pdf-transcription-response.json';
import { buildPdfPageFixture, buildPdfTextDataUrl } from '../fixtures/pdfText.js';

const provider = vi.hoisted(() => ({
  generateText: vi.fn(),
  runCodexAppServerTurn: vi.fn(),
  createConfiguredTextModel: vi.fn(),
}));
vi.mock('ai', async original => ({
  ...(await original<typeof import('ai')>()),
  generateText: provider.generateText,
}));
vi.mock('../../src/services/codexAppServer.js', () => ({
  runCodexAppServerTurn: provider.runCodexAppServerTurn,
}));
vi.mock('../../src/services/aiSdkTextModel.js', () => ({
  createConfiguredTextModel: provider.createConfiguredTextModel,
}));

import { getResolvedGlobalModelConfig } from '../../src/config/modelConfig.js';

const { inspectPdfPageText } = await import('../../src/services/pdfPageProcessing.mjs');
const { preparePdfTextExtraction } = await import('../../src/services/pdfPageTranscription.js');

const completePdfTextExtraction = async (...args: Parameters<typeof preparePdfTextExtraction>) =>
  (await preparePdfTextExtraction(...args)).completion;

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
  provider.createConfiguredTextModel
    .mockReset()
    .mockReturnValue({ model: {}, providerOptions: {} });
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

test('returns failed-page metadata without exposing unreadable source content', async () => {
  provider.generateText.mockResolvedValue({
    output: { markdown: '', status: 'unreadable' },
    usage: {},
  });
  await expect(
    completePdfTextExtraction(bytes, textLayer(''), {
      config: await getResolvedGlobalModelConfig(),
    })
  ).resolves.toMatchObject({ transcription: { failedPages: [1] } });
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

test('pins transcription to OpenRouter/OpenAI even when account research uses Codex', async () => {
  const config = {
    ...(await getResolvedGlobalModelConfig()),
    aiProvider: 'codex' as const,
    aiProviderOverrides: { research: 'codex' as const },
  };
  const result = await completePdfTextExtraction(scannedBytes, textLayer(''), { config });
  expect(result.transcription?.pages).toEqual([1]);
  expect(provider.runCodexAppServerTurn).not.toHaveBeenCalled();
  expect(provider.createConfiguredTextModel).toHaveBeenCalledWith(
    expect.objectContaining({
      aiProvider: 'openrouter',
      aiProviderOverrides: { research: 'openrouter' },
    }),
    'research',
    expect.objectContaining({ model: 'openai/gpt-6-luna', reasoningEffort: 'xhigh' })
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
  ).resolves.toMatchObject({ transcription: { failedPages: [1] } });
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
    ).resolves.toMatchObject({ transcription: { failedPages: [1] } });
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

test('interrupts a pending raster operation when its page deadline expires', async () => {
  const deadline = new AbortController();
  const original = pdfTasks.runPdfPageTask;
  const started = Promise.withResolvers<void>();
  const operation = vi
    .spyOn(pdfTasks, 'runPdfPageTask')
    .mockImplementation((bytes, task, signal) => {
      if (task.kind === 'inspect') return original(bytes, task, signal);
      started.resolve();
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      );
    });
  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockImplementation(ms => (ms === 75000 ? deadline.signal : AbortSignal.any([])));
  try {
    const pending = completePdfTextExtraction(bytes, textLayer(''), {
      config: await getResolvedGlobalModelConfig(),
    });
    await started.promise;
    deadline.abort(new Error('recorded page deadline'));
    await expect(pending).resolves.toMatchObject({ transcription: { failedPages: [1] } });
    expect(provider.generateText).not.toHaveBeenCalled();
  } finally {
    operation.mockRestore();
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
  ).resolves.toMatchObject({ transcription: { failedPages: [1] } });
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

test('retranscribes provider text with invalid control characters instead of admitting corrupted prose', async () => {
  provider.generateText
    .mockResolvedValueOnce({
      output: { markdown: 'Synthetic corrupted prosa\u0000e8 with $x=1$.', status: 'ok' },
      usage: { inputTokens: 100, outputTokens: 20 },
    })
    .mockResolvedValueOnce({ output: recordedPage, usage: { inputTokens: 150, outputTokens: 40 } });
  const result = await completePdfTextExtraction(bytes, textLayer(''), {
    config: await getResolvedGlobalModelConfig(),
  });
  expect(result.pages[0].text).toBe(
    `${formatPdfTranscriptionMarker(1)}\n\n${recordedPage.markdown}`
  );
  expect(result.transcription).toMatchObject({ inputTokens: 250, outputTokens: 60 });
  expect(provider.generateText).toHaveBeenCalledTimes(2);
});

test.each([
  '$',
  '$$',
])('normalizes a valid multiline matrix (%s) without a paid corrective request', async delimiter => {
  const markdown = `${delimiter}A=\\begin{pmatrix}\na & b\\\\\nc & d\n\\end{pmatrix}${delimiter}`;
  provider.generateText.mockResolvedValue({
    output: { markdown, status: 'ok' },
    usage: { inputTokens: 100, outputTokens: 20 },
  });
  const result = await completePdfTextExtraction(bytes, textLayer(''), {
    config: await getResolvedGlobalModelConfig(),
  });
  expect(result.pages[0].text).toContain('a & b\\\\\nc & d');
  expect(result.pages[0].text).toContain('$$');
  expect(provider.generateText).toHaveBeenCalledOnce();
});

test('keeps normalized multiline math stable when the prepared source is normalized again', () => {
  const source = '$A=\\begin{pmatrix}\na & b\\\\\nc & d\n\\end{pmatrix}$';
  const normalized = normalizePdfTranscriptionMarkdown(source);
  expect(normalizePdfTranscriptionMarkdown(normalized)).toBe(normalized);
});

test('rejects a blank response that contains substantive Markdown instead of silently deleting it', async () => {
  provider.generateText.mockResolvedValue({
    output: { markdown: 'A real source statement $x=2$.', status: 'blank' },
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  await expect(
    completePdfTextExtraction(bytes, textLayer(''), {
      config: await getResolvedGlobalModelConfig(),
    })
  ).resolves.toMatchObject({ transcription: { failedPages: [1] } });
});

test('does not count an empty scanned page as recovered text or attach transcription provenance', async () => {
  provider.generateText.mockResolvedValue({
    output: { markdown: '', status: 'blank' },
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  const result = await completePdfTextExtraction(bytes, textLayer(''), {
    config: await getResolvedGlobalModelConfig(),
  });
  expect(result.transcription?.pages).toEqual([]);
  expect(result.transcription).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  expect(result.pages).toEqual([{ pageNumber: 1, text: '' }]);
});

test('transcribes a full-page raster despite visible footer text and retains a digital page with a small image', async () => {
  const raster = 'BI /W 1 /H 1 /CS /RGB /BPC 8 /F /AHx ID FF0000> EI';
  const fixture = buildPdfPageFixture([
    `q 200 0 0 200 0 0 cm ${raster} Q BT /F1 12 Tf 10 10 Td (Footer) Tj ET`,
    `q 20 0 0 20 0 0 cm ${raster} Q BT /F1 12 Tf 10 100 Td (Digital statement) Tj ET`,
  ]);
  const result = await completePdfTextExtraction(
    fixture,
    {
      ...textLayer(''),
      pageCount: 2,
      pages: [
        { pageNumber: 1, text: 'Footer' },
        { pageNumber: 2, text: 'Digital statement' },
      ],
    },
    { config: await getResolvedGlobalModelConfig() }
  );
  expect(result.pages[0].provenance?.kind).toBe('vision-transcription');
  expect(result.pages[0].text).toContain(recordedPage.markdown);
  expect(result.pages[1]).toEqual({ pageNumber: 2, text: 'Digital statement' });
  expect(result.transcription?.measurements[0].reasons).toContain('full-page-image');
  expect(provider.generateText).toHaveBeenCalledOnce();
});

test('retries an unreadable response once with the original image and a fresh request', async () => {
  provider.generateText.mockResolvedValueOnce({
    output: { status: 'unreadable', markdown: '' },
    usage: { inputTokens: 100, outputTokens: 20 },
  });
  const result = await completePdfTextExtraction(scannedBytes, textLayer(''), {
    config: await getResolvedGlobalModelConfig(),
  });
  expect(result.pages[0].text).toContain(recordedPage.markdown);
  expect(result.transcription).toMatchObject({ inputTokens: 220, outputTokens: 60 });
  expect(result.transcription?.measurements[0].attempts).toBe(2);
  expect(provider.generateText).toHaveBeenCalledTimes(2);
  const requests = provider.generateText.mock.calls.map(call => call[0]);
  expect(requests[1].messages).toEqual(requests[0].messages);
});

test('preserves a non-Latin source language with mathematical formulas', async () => {
  const original = 'Ελληνική μαθηματική πρόταση';
  const fixture = buildPdfPageFixture(['BT /F1 12 Tf 3 Tr 10 100 Td (OCR) Tj ET']);
  provider.generateText.mockResolvedValue({
    output: {
      status: 'ok',
      markdown: `${original}. $a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r+s+t+u+v+w+x+y+z$`,
    },
    usage: {},
  });
  const result = await completePdfTextExtraction(fixture, textLayer(original), {
    config: await getResolvedGlobalModelConfig(),
  });
  expect(result.text).toContain(original);
  expect(provider.generateText).toHaveBeenCalledOnce();
});

test('logs only safe provider request identity metadata', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  provider.generateText.mockResolvedValue({
    output: recordedPage,
    usage: {},
    response: {
      id: 'gen-recorded',
      body: {
        provider: 'Recorded upstream',
        model: 'recorded-model',
        endpoint_id: 'recorded-endpoint',
        choices: [{ private: 'excluded-content' }],
      },
    },
  });
  try {
    await completePdfTextExtraction(scannedBytes, textLayer(''), {
      config: await getResolvedGlobalModelConfig(),
    });
    expect(log).toHaveBeenCalledWith('[Nous][PDF] Provider request', {
      sourceHash: 'synthetic',
      pageNumber: 1,
      requestId: 'gen-recorded',
      upstreamProvider: 'Recorded upstream',
      upstreamModel: 'recorded-model',
      endpointId: 'recorded-endpoint',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('excluded-content');
  } finally {
    log.mockRestore();
  }
});

test('shares collection progress while requests from consecutive documents overlap', async () => {
  const first = Promise.withResolvers<unknown>();
  const second = Promise.withResolvers<unknown>();
  provider.generateText
    .mockReset()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const pool = new PdfTranscriptionPool(2);
  const progress: Array<{ completed: number; total: number }> = [];
  const options = {
    pool,
    config: await getResolvedGlobalModelConfig(),
    onProgress: (event: { completed: number; total: number }) => {
      progress.push(event);
    },
  };
  try {
    const a = await preparePdfTextExtraction(scannedBytes, textLayer(''), options);
    const b = await preparePdfTextExtraction(scannedBytes, textLayer(''), options);
    expect(provider.generateText).toHaveBeenCalledTimes(2);
    expect(progress.at(-1)).toMatchObject({ completed: 0, total: 2 });
    second.resolve({ output: recordedPage, usage: {} });
    await b.completion;
    expect(progress.at(-1)).toMatchObject({ completed: 1, total: 2 });
    first.resolve({ output: recordedPage, usage: {} });
    await a.completion;
    expect(progress.at(-1)).toMatchObject({ completed: 2, total: 2 });
  } finally {
    first.resolve({ output: recordedPage, usage: {} });
    second.resolve({ output: recordedPage, usage: {} });
    await pool.close();
  }
});

test('shares the two-request budget between syntax correction and an unreadable response', async () => {
  provider.generateText
    .mockResolvedValueOnce({
      output: { status: 'ok', markdown: '$\\unsupportedMath{x}$' },
      usage: {},
    })
    .mockResolvedValue({ output: { status: 'unreadable', markdown: '' }, usage: {} });
  await expect(
    completePdfTextExtraction(scannedBytes, textLayer(''), {
      config: await getResolvedGlobalModelConfig(),
    })
  ).resolves.toMatchObject({ transcription: { failedPages: [1] } });
  expect(provider.generateText).toHaveBeenCalledTimes(2);
});

test('pins the default transcription model to OpenAI without upstream fallback', async () => {
  await completePdfTextExtraction(scannedBytes, textLayer(''), {
    config: await getResolvedGlobalModelConfig(),
  });
  expect(provider.generateText.mock.calls[0][0].providerOptions.openrouter.provider).toEqual({
    only: ['openai'],
    allow_fallbacks: false,
  });
});

test('keeps the OpenAI allowlist despite an obsolete upstream environment override', async () => {
  vi.stubEnv('PDF_TRANSCRIPTION_OPENROUTER_PROVIDER', 'recorded/region');
  try {
    await completePdfTextExtraction(scannedBytes, textLayer(''), {
      config: await getResolvedGlobalModelConfig(),
    });
    expect(provider.generateText.mock.calls[0][0].providerOptions.openrouter.provider).toEqual({
      only: ['openai'],
      allow_fallbacks: false,
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

test('reports a missing pinned endpoint as a page failure with no cross-provider fallback', async () => {
  provider.generateText.mockRejectedValue(
    new APICallError({
      message: 'No endpoints available',
      url: 'https://provider.invalid',
      requestBodyValues: {},
      statusCode: 404,
    })
  );
  await expect(
    completePdfTextExtraction(scannedBytes, textLayer(''), {
      config: await getResolvedGlobalModelConfig(),
    })
  ).resolves.toMatchObject({ transcription: { failedPages: [1] } });
  expect(provider.generateText).toHaveBeenCalledOnce();
  expect(provider.generateText.mock.calls[0][0].providerOptions.openrouter.provider).toEqual({
    only: ['openai'],
    allow_fallbacks: false,
  });
});

test('keeps dollar signs inside Markdown code unchanged during multiline formula normalization', () => {
  const markdown = ['```sh', 'echo "$HOME"', 'echo "$PATH"', '```', '', '$x=1$'].join('\n');
  expect(normalizePdfTranscriptionMarkdown(markdown)).toBe(markdown);
});

test('gives a timed-out first request one fresh deadline without exceeding two calls', async () => {
  provider.generateText
    .mockRejectedValueOnce(new DOMException('Recorded attempt deadline', 'TimeoutError'))
    .mockImplementationOnce(async request => {
      expect(request.abortSignal.aborted).toBe(false);
      return { output: recordedPage, usage: {} };
    });
  const result = await completePdfTextExtraction(bytes, textLayer(''), {
    config: await getResolvedGlobalModelConfig(),
  });
  expect(result.text).toContain(recordedPage.markdown);
  expect(provider.generateText).toHaveBeenCalledTimes(2);
  const signals = provider.generateText.mock.calls.map(([request]) => request.abortSignal);
  expect(signals[0]).not.toBe(signals[1]);
});

test('retains good pages while removing a failed garbage OCR page from downstream text', async () => {
  const fixture = buildPdfPageFixture([
    'BT /F1 12 Tf 10 100 Td (Clean first page) Tj ET',
    'BT /F1 12 Tf 3 Tr 10 100 Td (Garbage scanner OCR) Tj ET',
  ]);
  provider.generateText.mockResolvedValue({
    output: { status: 'unreadable', markdown: '' },
    usage: {},
  });
  const result = await completePdfTextExtraction(
    fixture,
    {
      ...textLayer(''),
      pages: [
        { pageNumber: 1, text: 'Clean first page' },
        { pageNumber: 2, text: 'Garbage scanner OCR' },
      ],
    },
    { config: await getResolvedGlobalModelConfig() }
  );
  expect(result.text).toBe('Clean first page');
  expect(result.pages).toEqual([
    { pageNumber: 1, text: 'Clean first page' },
    { pageNumber: 2, text: '' },
  ]);
  expect(result.transcription).toMatchObject({ failedPages: [2], pages: [] });
  expect(provider.generateText).toHaveBeenCalledTimes(2);
});

test('uses the correct model effort at the course tier boundary and never counts a clean page', async () => {
  const pool = new PdfTranscriptionPool(2, 149);
  const config = await getResolvedGlobalModelConfig();
  const fixture = buildPdfPageFixture([
    'BT /F1 12 Tf 3 Tr 10 100 Td (Scan first) Tj ET',
    'BT /F1 12 Tf 10 100 Td (Clean middle) Tj ET',
    'BT /F1 12 Tf 3 Tr 10 100 Td (Scan last) Tj ET',
  ]);
  try {
    const result = await completePdfTextExtraction(
      fixture,
      {
        ...textLayer(''),
        pages: [
          { pageNumber: 1, text: 'Scan first' },
          { pageNumber: 2, text: 'Clean middle' },
          { pageNumber: 3, text: 'Scan last' },
        ],
      },
      { config, pool }
    );
    expect(result.pages[1].text).toBe('Clean middle');
    expect(provider.createConfiguredTextModel.mock.calls.map(call => call[2])).toEqual([
      { model: 'openai/gpt-6-luna', role: 'pdfPageTranscription', reasoningEffort: 'xhigh' },
      { model: 'openai/gpt-6-luna', role: 'pdfPageTranscription', reasoningEffort: 'medium' },
    ]);
    expect(pool.measurements.scannedPages).toBe(151);
    expect(
      provider.generateText.mock.calls.map(call => call[0].providerOptions.openrouter.provider)
    ).toEqual([
      { only: ['openai'], allow_fallbacks: false },
      { only: ['openai'], allow_fallbacks: false },
    ]);
  } finally {
    await pool.close();
  }
});

test('stops over-limit scanned material before rendering or calling a provider', async () => {
  const pool = new PdfTranscriptionPool(2, 300);
  try {
    await expect(
      completePdfTextExtraction(scannedBytes, textLayer(''), {
        pool,
        config: await getResolvedGlobalModelConfig(),
      })
    ).rejects.toMatchObject({ name: 'PdfScannedPageLimitError', limit: 300 });
    expect(provider.generateText).not.toHaveBeenCalled();
    expect(pool.measurements.maxRenderedImages).toBe(0);
  } finally {
    await pool.close();
  }
});

test('shares the collection context pool across files, reports job progress and overlaps inference', async () => {
  const firstResponse = Promise.withResolvers<{ output: typeof recordedPage; usage: object }>();
  provider.generateText.mockImplementationOnce(() => firstResponse.promise);
  const context: SourcePreparationContext = {
    userId: 'synthetic-user',
    uploadId: 'synthetic-upload',
    projectId: 'synthetic-course',
    signal: new AbortController().signal,
    previousScannedPages: 149,
    reportProgress: vi.fn(),
  };
  const config = await getResolvedGlobalModelConfig();
  const first = await preparePdfTextExtraction(scannedBytes, textLayer(''), {
    context,
    config,
    documentName: 'a.pdf',
  });
  let second: Awaited<ReturnType<typeof preparePdfTextExtraction>> | undefined;
  try {
    second = await preparePdfTextExtraction(scannedBytes, textLayer(''), {
      context,
      config,
      documentName: 'b.pdf',
    });
    await second.completion;
    expect(context.pdfTranscriptionPool?.measurements).toMatchObject({
      scannedPages: 151,
      maxInFlight: 2,
      maxRenderedImages: 2,
    });
    expect(
      provider.createConfiguredTextModel.mock.calls.map(call => call[2].reasoningEffort)
    ).toEqual(['xhigh', 'medium']);
    expect(context.reportProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        step: 'pdf-transcription',
        documentName: 'b.pdf',
        completed: 1,
        total: 2,
        reducedQuality: { from: 151, to: 151 },
      })
    );
  } finally {
    firstResponse.resolve({ output: recordedPage, usage: {} });
    await Promise.allSettled([first.completion, ...(second ? [second.completion] : [])]);
    await context.pdfTranscriptionPool?.close();
  }
});

test('honours job cancellation before inspecting or requesting a PDF page', async () => {
  const controller = new AbortController();
  const reason = new Error('Synthetic job cancelled');
  controller.abort(reason);
  await expect(
    preparePdfTextExtraction(scannedBytes, textLayer(''), {
      context: {
        userId: 'synthetic-user',
        uploadId: 'synthetic-upload',
        projectId: 'synthetic-course',
        signal: controller.signal,
        reportProgress: vi.fn(),
      },
      config: await getResolvedGlobalModelConfig(),
    })
  ).rejects.toBe(reason);
  expect(provider.generateText).not.toHaveBeenCalled();
});

test('logs only a safe category for a provider failure with private request and response content', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  provider.generateText.mockRejectedValue(
    new APICallError({
      message: 'private transcript',
      url: 'https://provider.invalid',
      statusCode: 400,
      requestBodyValues: { image: 'private page image' },
      responseBody: 'private answer',
    })
  );
  try {
    const result = await completePdfTextExtraction(scannedBytes, textLayer(''), {
      config: await getResolvedGlobalModelConfig(),
    });
    expect(result.transcription?.failedPages).toEqual([1]);
    expect(warn).toHaveBeenCalledWith('[Nous][PDF] Page transcription failed', {
      sourceHash: 'synthetic',
      pageNumber: 1,
      failure: 'provider-error',
      statusCode: 400,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  } finally {
    warn.mockRestore();
  }
});

test('accepts mathematical OCR whose Greek symbols become delimited math in transcription', async () => {
  const fixture = buildPdfPageFixture(['BT /F1 12 Tf 3 Tr 10 100 Td (OCR) Tj ET']);
  const original = 'Sia α+β=γ, α+β=γ, α+β=γ';
  const markdown = String.raw`Sia $\alpha+\beta=\gamma$, $\alpha+\beta=\gamma$, $\alpha+\beta=\gamma$.`;
  provider.generateText.mockResolvedValue({ output: { status: 'ok', markdown }, usage: {} });
  const result = await completePdfTextExtraction(fixture, textLayer(original), {
    config: await getResolvedGlobalModelConfig(),
  });
  expect(result.transcription?.pages).toEqual([1]);
  expect(result.pages[0].text).toContain(markdown);
  expect(provider.generateText).toHaveBeenCalledOnce();
});

test('terminates PDF inspection at its deadline before starting provider calls', async () => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  try {
    const pending = preparePdfTextExtraction(bytes, textLayer(''));
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'PdfTextExtractionTimeoutError',
    });
    expect(timeout).toHaveBeenCalledWith(15000);
    deadline.abort(new DOMException('Inspection deadline', 'TimeoutError'));
    await rejected;
    expect(provider.generateText).not.toHaveBeenCalled();
  } finally {
    timeout.mockRestore();
  }
});
