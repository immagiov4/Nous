import { APICallError } from 'ai';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PdfTranscriptionPool } from '../../src/services/pdfTranscriptionPool.js';

const timing = vi.hoisted(() => ({ now: 1_000, delays: [] as number[] }));
vi.mock('node:timers/promises', () => ({
  setTimeout: async (milliseconds: number, _value: unknown, options: { signal?: AbortSignal }) => {
    options.signal?.throwIfAborted();
    timing.delays.push(milliseconds);
    timing.now += milliseconds;
  },
}));
const image = { dataUrl: 'data:image/png;base64,c3ludGhldGlj', width: 10, height: 10 };
const TIMEOUT_MS = 120_000;

beforeEach(() => {
  timing.now = 1_000;
  timing.delays = [];
});
afterEach(() => vi.restoreAllMocks());

test('bounds requests and rendered images across documents and admits the next page as a slot frees', async () => {
  const pool = new PdfTranscriptionPool(2);
  const responses = Array.from({ length: 3 }, () => Promise.withResolvers<string>());
  const render = vi.fn(async () => image);
  const pages: Array<Promise<string>> = [];
  let third: Promise<{ completion: Promise<string> }> | undefined;
  try {
    for (const response of responses.slice(0, 2)) {
      const queued = await pool.schedule({
        render,
        transcribe: () => response.promise,
        timeoutMs: TIMEOUT_MS,
      });
      pages.push(queued.completion);
    }
    third = pool.schedule({
      render,
      transcribe: () => responses[2].promise,
      timeoutMs: TIMEOUT_MS,
    });
    await vi.waitFor(() => expect(pool.measurements.maxInFlight).toBe(2));
    expect(render).toHaveBeenCalledTimes(2);
    responses[0].resolve('first');
    pages.push((await third).completion);
    expect(render).toHaveBeenCalledTimes(3);
    expect(pool.measurements.maxRenderedImages).toBe(2);
    responses[1].resolve('second');
    responses[2].resolve('third');
    expect(await Promise.all(pages)).toEqual(['first', 'second', 'third']);
  } finally {
    responses.forEach(response => {
      response.resolve('cleanup');
    });
    if (third) await third.then(queued => queued.completion).catch(() => undefined);
    await pool.close();
  }
});

test.each([
  429, 503,
])('honours Retry-After and retains shared concurrency after HTTP %s', async statusCode => {
  vi.spyOn(Date, 'now').mockImplementation(() => timing.now);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const pool = new PdfTranscriptionPool(4);
  const render = vi.fn(async () => image);
  const transcribe = vi
    .fn()
    .mockRejectedValueOnce(
      new APICallError({
        message: 'Synthetic provider response',
        requestBodyValues: {},
        statusCode,
        responseHeaders: { 'retry-after': '3' },
        url: 'https://provider.invalid',
      })
    )
    .mockResolvedValue('accepted');
  try {
    const queued = await pool.schedule({ render, transcribe, timeoutMs: TIMEOUT_MS });
    expect(await queued.completion).toBe('accepted');
    expect(render).toHaveBeenCalledOnce();
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(timing.delays).toEqual([3_000]);
    expect(pool.measurements).toMatchObject({
      concurrency: 4,
      transientRetries: 1,
      maxRenderedImages: 1,
    });
  } finally {
    await pool.close();
  }
});

test('reports a permanent provider rejection without retrying or rerendering', async () => {
  const pool = new PdfTranscriptionPool(2);
  const failure = new APICallError({
    message: 'Synthetic bad request',
    requestBodyValues: {},
    statusCode: 400,
    url: 'https://provider.invalid',
  });
  const transcribe = vi.fn().mockRejectedValue(failure);
  try {
    const queued = await pool.schedule({
      render: async () => image,
      transcribe,
      timeoutMs: TIMEOUT_MS,
    });
    await expect(queued.completion).rejects.toBe(failure);
    expect(transcribe).toHaveBeenCalledOnce();
    expect(timing.delays).toEqual([]);
  } finally {
    await pool.close();
  }
});

test('stops transient retries when the page has spent its request budget', async () => {
  vi.spyOn(Date, 'now').mockImplementation(() => timing.now);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const pool = new PdfTranscriptionPool(2);
  const failure = new APICallError({
    message: 'Unavailable',
    requestBodyValues: {},
    statusCode: 503,
    url: 'https://provider.invalid',
  });
  const transcribe = vi
    .fn()
    .mockRejectedValueOnce(failure)
    .mockRejectedValueOnce(failure)
    .mockResolvedValue('forbidden third request');
  try {
    const queued = await pool.schedule({
      render: async () => image,
      transcribe,
      timeoutMs: TIMEOUT_MS,
      canRetry: () => transcribe.mock.calls.length < 2,
    });
    await expect(queued.completion).rejects.toBe(failure);
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(pool.measurements.transientRetries).toBe(1);
    expect(timing.delays).toHaveLength(1);
  } finally {
    await pool.close();
  }
});

test('assigns course-wide xhigh then medium across file boundaries, counting scanned pages only', async () => {
  const pool = new PdfTranscriptionPool(2);
  try {
    const firstDocument = pool.allocateScannedPages(149);
    expect(firstDocument).toHaveLength(149);
    expect(firstDocument[0]).toMatchObject({
      ordinal: 1,
      tier: 'full',
      model: 'openai/gpt-6-luna',
      reasoningEffort: 'xhigh',
    });
    expect(pool.allocateScannedPages(0)).toEqual([]);
    expect(pool.allocateScannedPages(2)).toEqual([
      { ordinal: 150, tier: 'full', model: 'openai/gpt-6-luna', reasoningEffort: 'xhigh' },
      { ordinal: 151, tier: 'reduced', model: 'openai/gpt-6-luna', reasoningEffort: 'medium' },
    ]);
    expect(pool.measurements.reducedQuality).toEqual({ from: 151, to: 151 });
  } finally {
    await pool.close();
  }
});

test('rejects page 301 across source files before scheduling it and preserves the course count', async () => {
  const pool = new PdfTranscriptionPool(2, 299);
  try {
    expect(pool.allocateScannedPages(1)[0]).toMatchObject({ ordinal: 300, tier: 'reduced' });
    expect(() => pool.allocateScannedPages(1)).toThrow(
      expect.objectContaining({ code: 'PDF_SCANNED_PAGE_LIMIT', limit: 300 })
    );
    expect(pool.measurements.scannedPages).toBe(300);
    expect(pool.measurements.maxRenderedImages).toBe(0);
  } finally {
    await pool.close();
  }
});

test('honours both model/effort/threshold environment overrides for the course budget', async () => {
  vi.stubEnv('PDF_TRANSCRIPTION_FULL_QUALITY_PAGES', '1');
  vi.stubEnv('PDF_TRANSCRIPTION_MAX_SCANNED_PAGES', '2');
  vi.stubEnv('MODEL_PDF_TRANSCRIPTION', 'synthetic/full-vision');
  vi.stubEnv('MODEL_PDF_TRANSCRIPTION_REDUCED', 'synthetic/reduced-vision');
  vi.stubEnv('PDF_TRANSCRIPTION_REASONING_EFFORT', 'high');
  vi.stubEnv('PDF_TRANSCRIPTION_REDUCED_REASONING_EFFORT', 'low');
  const pool = new PdfTranscriptionPool(2);
  try {
    expect(pool.allocateScannedPages(2)).toEqual([
      { ordinal: 1, tier: 'full', model: 'synthetic/full-vision', reasoningEffort: 'high' },
      { ordinal: 2, tier: 'reduced', model: 'synthetic/reduced-vision', reasoningEffort: 'low' },
    ]);
    expect(() => pool.allocateScannedPages(1)).toThrow(expect.objectContaining({ limit: 2 }));
  } finally {
    vi.unstubAllEnvs();
    await pool.close();
  }
});

test('applies the same transient retry budget to an OpenRouter error body returned with HTTP 200', async () => {
  vi.spyOn(Date, 'now').mockImplementation(() => timing.now);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const pool = new PdfTranscriptionPool(4);
  const transcribe = vi
    .fn()
    .mockRejectedValueOnce(
      new APICallError({
        message: 'Unavailable',
        requestBodyValues: {},
        statusCode: 200,
        data: { code: 502, message: 'Unavailable' },
        responseHeaders: { 'retry-after': '3' },
        url: 'https://provider.invalid',
      })
    )
    .mockResolvedValue('accepted');
  try {
    const queued = await pool.schedule({
      render: async () => image,
      transcribe,
      timeoutMs: TIMEOUT_MS,
      canRetry: () => transcribe.mock.calls.length < 2,
    });
    await expect(queued.completion).resolves.toBe('accepted');
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(pool.measurements).toMatchObject({ concurrency: 4, transientRetries: 1 });
  } finally {
    await pool.close();
  }
});
