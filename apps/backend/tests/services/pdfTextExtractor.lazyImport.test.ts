import { afterEach, expect, test, vi } from 'vitest';
import { buildPdfTextDataUrl } from '../fixtures/pdfText.js';

const pdfRuntimeMocks = vi.hoisted(() => ({ execFileAsync: vi.fn() }));
vi.mock('node:util', async importOriginal => ({
  ...(await importOriginal<typeof import('node:util')>()),
  promisify: () => pdfRuntimeMocks.execFileAsync,
}));

afterEach(() => {
  vi.doUnmock('pdf-parse');
  vi.resetModules();
});

test.each([
  'fallback',
  'outline',
] as const)('defers parser loading until %s extraction and preserves its import failure', async extractionPath => {
  vi.resetModules();
  const importFailure = new Error('PDF parser module is unavailable');
  const loadParser = vi.fn(() => {
    throw importFailure;
  });
  vi.doMock('pdf-parse', loadParser);
  pdfRuntimeMocks.execFileAsync.mockReset();
  if (extractionPath === 'fallback') {
    pdfRuntimeMocks.execFileAsync.mockRejectedValue(new Error('spawn pdftotext ENOENT'));
  } else {
    pdfRuntimeMocks.execFileAsync.mockResolvedValue({ stdout: 'Text from pdftotext' });
  }

  const { extractPdfText } = await import('../../src/services/pdfTextExtractor.js');
  expect(loadParser).not.toHaveBeenCalled();

  const extractionFailure = await extractPdfText(buildPdfTextDataUrl()).catch(error => error);
  expect(loadParser).toHaveBeenCalledOnce();
  expect(extractionFailure).toBeInstanceOf(Error);
  expect(extractionFailure.cause).toBe(importFailure);
});
