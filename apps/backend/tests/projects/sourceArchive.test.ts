import { createHash } from 'node:crypto';
import { SOURCE_ARCHIVE_PREVIEW_MAX_CHARS } from '@shared/sourceArchivePreview';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const pdfTextExtractorMocks = vi.hoisted(() => ({
  extractPdfText: vi.fn(),
}));

vi.mock('../../src/services/pdfTextExtractor.js', () => ({
  extractPdfText: pdfTextExtractorMocks.extractPdfText,
}));

import { indexSourceArchive, type SourceArchiveLimits } from '../../src/projects/sourceArchive.js';

const textEncoder = new TextEncoder();
const GENEROUS_LIMITS: SourceArchiveLimits = {
  maxEntries: 100,
  maxEntryBytes: 1_000_000,
  maxExpandedBytes: 10_000_000,
};

const createArchive = async (
  entries: Array<
    | { content: string | Uint8Array; path: string; type: 'file' }
    | { path: string; type: 'directory' }
  >
) => {
  const zip = new JSZip();

  for (const entry of entries) {
    if (entry.type === 'directory') {
      zip.file(`${entry.path}/`, null, { createFolders: false, dir: true });
      continue;
    }

    zip.file(entry.path, entry.content, { createFolders: false });
  }

  return zip.generateAsync({
    compression: 'DEFLATE',
    type: 'uint8array',
  });
};

const replaceAscii = (bytes: Uint8Array, from: string, to: string) => {
  const source = textEncoder.encode(from);
  const replacement = textEncoder.encode(to);
  expect(replacement.byteLength).toBe(source.byteLength);

  const result = bytes.slice();
  let replacementCount = 0;

  for (let offset = 0; offset <= result.byteLength - source.byteLength; offset += 1) {
    if (source.every((byte, index) => result[offset + index] === byte)) {
      result.set(replacement, offset);
      replacementCount += 1;
      offset += source.byteLength - 1;
    }
  }

  expect(replacementCount).toBeGreaterThan(0);
  return result;
};

beforeEach(() => {
  pdfTextExtractorMocks.extractPdfText.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('indexSourceArchive', () => {
  test('indexes usable PDF text by ZIP path and keeps unreadable PDFs isolated', async () => {
    const validPdfBytes = textEncoder.encode('%PDF-valid');
    const scannedPdfBytes = textEncoder.encode('%PDF-scanned');
    const unreadablePdfBytes = textEncoder.encode('%PDF-unreadable');
    const usablePdfText = 'Contenuto didattico estratto dal PDF. '.repeat(8).trim();
    const notes = 'Materiale testuale valido';
    const archive = await createArchive([
      { content: validPdfBytes, path: 'docs/a-valid.PDF', type: 'file' },
      { content: scannedPdfBytes, path: 'docs/b-scanned.pdf', type: 'file' },
      { content: unreadablePdfBytes, path: 'docs/c-unreadable.pdf', type: 'file' },
      { content: notes, path: 'docs/notes.txt', type: 'file' },
    ]);
    pdfTextExtractorMocks.extractPdfText
      .mockResolvedValueOnce({ pages: [{ text: usablePdfText }], text: usablePdfText })
      .mockResolvedValueOnce({ pages: [], text: '   ' })
      .mockRejectedValueOnce(new Error('scanned document'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await indexSourceArchive(archive, GENEROUS_LIMITS);

    expect(pdfTextExtractorMocks.extractPdfText.mock.calls).toEqual([
      [`data:application/pdf;base64,${Buffer.from(validPdfBytes).toString('base64')}`],
      [`data:application/pdf;base64,${Buffer.from(scannedPdfBytes).toString('base64')}`],
      [`data:application/pdf;base64,${Buffer.from(unreadablePdfBytes).toString('base64')}`],
    ]);
    expect(result.entries.find(entry => entry.path === 'docs/a-valid.PDF')).toMatchObject({
      byteSize: textEncoder.encode(usablePdfText).byteLength,
      content: textEncoder.encode(usablePdfText),
      hash: createHash('sha256').update(usablePdfText).digest('hex'),
      kind: 'file',
      path: 'docs/a-valid.PDF',
      preview: usablePdfText,
      text: usablePdfText,
    });
    const scannedEntry = result.entries.find(entry => entry.path === 'docs/b-scanned.pdf');
    expect(scannedEntry).toMatchObject({
      byteSize: scannedPdfBytes.byteLength,
      content: scannedPdfBytes,
      hash: createHash('sha256').update(scannedPdfBytes).digest('hex'),
      kind: 'file',
      path: 'docs/b-scanned.pdf',
    });
    expect(scannedEntry).not.toHaveProperty('preview');
    expect(scannedEntry).not.toHaveProperty('text');
    expect(result.entries.find(entry => entry.path === 'docs/c-unreadable.pdf')).toMatchObject({
      byteSize: unreadablePdfBytes.byteLength,
      content: unreadablePdfBytes,
      hash: createHash('sha256').update(unreadablePdfBytes).digest('hex'),
      kind: 'file',
      path: 'docs/c-unreadable.pdf',
    });
    expect(result.entries.find(entry => entry.path === 'docs/notes.txt')).toMatchObject({
      kind: 'file',
      path: 'docs/notes.txt',
      text: notes,
    });
    expect(result.totalExpandedBytes).toBe(
      textEncoder.encode(usablePdfText).byteLength +
        scannedPdfBytes.byteLength +
        textEncoder.encode(notes).byteLength +
        unreadablePdfBytes.byteLength
    );
  });

  test('keeps extracted PDF text within entry and expanded archive limits', async () => {
    const pdfBytes = textEncoder.encode('%PDF-data');
    const archive = await createArchive([
      { content: pdfBytes, path: 'docs/source.pdf', type: 'file' },
    ]);
    const extractedText = 'Testo estratto oltre il budget. '.repeat(10).trim();
    pdfTextExtractorMocks.extractPdfText.mockResolvedValue({
      pages: [{ text: extractedText }],
      text: extractedText,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const entryLimited = await indexSourceArchive(archive, {
      ...GENEROUS_LIMITS,
      maxEntryBytes: extractedText.length - 1,
    });
    const totalLimited = await indexSourceArchive(archive, {
      ...GENEROUS_LIMITS,
      maxExpandedBytes: extractedText.length - 1,
    });

    for (const result of [entryLimited, totalLimited]) {
      expect(result.entries.find(entry => entry.path === 'docs/source.pdf')).toMatchObject({
        byteSize: pdfBytes.byteLength,
        content: pdfBytes,
        hash: createHash('sha256').update(pdfBytes).digest('hex'),
        kind: 'file',
        path: 'docs/source.pdf',
      });
      expect(result.totalExpandedBytes).toBe(pdfBytes.byteLength);
    }
  });

  test('keeps PDFs with only incidental extracted text as unusable binary entries', async () => {
    const pdfBytes = textEncoder.encode('%PDF-watermark');
    const archive = await createArchive([
      { content: pdfBytes, path: 'scans/watermarked.pdf', type: 'file' },
    ]);
    pdfTextExtractorMocks.extractPdfText.mockResolvedValue({
      pages: [{ text: '1' }, { text: 'CONFIDENTIAL' }],
      text: '1\n\nCONFIDENTIAL',
    });

    const result = await indexSourceArchive(archive, GENEROUS_LIMITS);

    const entry = result.entries.find(candidate => candidate.path === 'scans/watermarked.pdf');
    expect(entry).toMatchObject({
      byteSize: pdfBytes.byteLength,
      content: pdfBytes,
      kind: 'file',
      path: 'scans/watermarked.pdf',
    });
    expect(entry).not.toHaveProperty('text');
  });

  test('builds a complete lexicographic tree and preserves every file byte', async () => {
    const sourceLines = Array.from({ length: 26 }, (_, index) => `line ${index + 1}`);
    const sourceText = sourceLines.join('\r\n');
    const binaryBytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    const archive = await createArchive([
      { content: sourceText, path: 'packages/core/index.ts', type: 'file' },
      { content: 'name: CI', path: '.github/workflows/ci.yml', type: 'file' },
      { content: 'nested', path: 'nested/deep/file.txt', type: 'file' },
      { path: 'explicit', type: 'directory' },
      { content: '', path: 'explicit/empty.txt', type: 'file' },
      { content: binaryBytes, path: 'bin/blob.bin', type: 'file' },
    ]);

    const result = await indexSourceArchive(archive, GENEROUS_LIMITS);

    expect(result.entries.map(({ path }) => path)).toEqual([
      '.github',
      '.github/workflows',
      '.github/workflows/ci.yml',
      'bin',
      'bin/blob.bin',
      'explicit',
      'explicit/empty.txt',
      'nested',
      'nested/deep',
      'nested/deep/file.txt',
      'packages',
      'packages/core',
      'packages/core/index.ts',
    ]);
    expect(result.entries.filter(({ kind }) => kind === 'directory')).toEqual([
      { explicit: false, kind: 'directory', path: '.github' },
      { explicit: false, kind: 'directory', path: '.github/workflows' },
      { explicit: false, kind: 'directory', path: 'bin' },
      { explicit: true, kind: 'directory', path: 'explicit' },
      { explicit: false, kind: 'directory', path: 'nested' },
      { explicit: false, kind: 'directory', path: 'nested/deep' },
      { explicit: false, kind: 'directory', path: 'packages' },
      { explicit: false, kind: 'directory', path: 'packages/core' },
    ]);

    const sourceEntry = result.entries.find(({ path }) => path === 'packages/core/index.ts');
    expect(sourceEntry).toMatchObject({
      byteSize: textEncoder.encode(sourceText).byteLength,
      hash: createHash('sha256').update(textEncoder.encode(sourceText)).digest('hex'),
      kind: 'file',
      path: 'packages/core/index.ts',
      preview: sourceLines.slice(0, 24).join('\n'),
      text: sourceText,
    });
    expect(sourceEntry?.kind === 'file' ? sourceEntry.content : undefined).toEqual(
      textEncoder.encode(sourceText)
    );

    const emptyEntry = result.entries.find(({ path }) => path === 'explicit/empty.txt');
    expect(emptyEntry).toMatchObject({
      byteSize: 0,
      content: new Uint8Array(),
      hash: createHash('sha256').update(new Uint8Array()).digest('hex'),
      kind: 'file',
      preview: '',
      text: '',
    });

    const binaryEntry = result.entries.find(({ path }) => path === 'bin/blob.bin');
    expect(binaryEntry).toMatchObject({
      byteSize: binaryBytes.byteLength,
      content: binaryBytes,
      hash: createHash('sha256').update(binaryBytes).digest('hex'),
      kind: 'file',
    });
    expect(binaryEntry).not.toHaveProperty('preview');
    expect(binaryEntry).not.toHaveProperty('text');
    expect(result.fileCount).toBe(5);
    expect(result.totalExpandedBytes).toBe(
      textEncoder.encode(sourceText).byteLength +
        textEncoder.encode('name: CI').byteLength +
        textEncoder.encode('nested').byteLength +
        binaryBytes.byteLength
    );
  });

  test('keeps content beyond the preview instead of aggregating or truncating it', async () => {
    const content = `${'complete line\n'.repeat(2_000)}final sentinel`;
    const archive = await createArchive([{ content, path: 'large.txt', type: 'file' }]);

    const result = await indexSourceArchive(archive, GENEROUS_LIMITS);
    const file = result.entries[0];

    expect(file?.kind).toBe('file');
    expect(file?.kind === 'file' ? file.text : undefined).toBe(content);
    expect(file?.kind === 'file' ? file.content : undefined).toEqual(textEncoder.encode(content));
    expect(file).not.toHaveProperty('aggregatedText');
  });

  test('caps a minified single-line preview without truncating the indexed source', async () => {
    const content = 'x'.repeat(SOURCE_ARCHIVE_PREVIEW_MAX_CHARS + 10_000);
    const archive = await createArchive([{ content, path: 'minified.js', type: 'file' }]);

    const result = await indexSourceArchive(archive, GENEROUS_LIMITS);
    const file = result.entries[0];

    expect(file?.kind === 'file' ? file.preview : undefined).toBe(
      content.slice(0, SOURCE_ARCHIVE_PREVIEW_MAX_CHARS)
    );
    expect(file?.kind === 'file' ? file.text : undefined).toBe(content);
    expect(file?.kind === 'file' ? file.content.byteLength : undefined).toBe(content.length);
  });

  test('rejects traversal, absolute, backslash, empty-segment, and dot-segment paths', async () => {
    for (const path of [
      '../secret.txt',
      '/absolute.txt',
      'C:/drive.txt',
      String.raw`folder\file.txt`,
      'folder//file.txt',
      'folder/./file.txt',
    ]) {
      const archive = await createArchive([{ content: 'unsafe', path, type: 'file' }]);

      await expect(indexSourceArchive(archive, GENEROUS_LIMITS)).rejects.toThrow(/unsafe path/i);
    }

    const unsafeDirectory = await createArchive([{ path: '../outside', type: 'directory' }]);
    await expect(indexSourceArchive(unsafeDirectory, GENEROUS_LIMITS)).rejects.toThrow(
      /unsafe path/i
    );
  });

  test('rejects duplicate archive paths even when JSZip would collapse them', async () => {
    const archive = await createArchive([
      { content: 'first', path: 'a.txt', type: 'file' },
      { content: 'second', path: 'b.txt', type: 'file' },
    ]);
    const duplicateArchive = replaceAscii(archive, 'b.txt', 'a.txt');

    await expect(indexSourceArchive(duplicateArchive, GENEROUS_LIMITS)).rejects.toThrow(
      /duplicate path/i
    );
  });

  test('rejects a file and directory that occupy the same tree path', async () => {
    const archive = await createArchive([
      { content: 'file', path: 'same', type: 'file' },
      { path: 'same', type: 'directory' },
    ]);

    await expect(indexSourceArchive(archive, GENEROUS_LIMITS)).rejects.toThrow(/duplicate path/i);
  });

  test('rejects a file that would also need to be an implicit parent directory', async () => {
    const archive = await createArchive([
      { content: 'file', path: 'same', type: 'file' },
      { content: 'child', path: 'same/child.txt', type: 'file' },
    ]);

    await expect(indexSourceArchive(archive, GENEROUS_LIMITS)).rejects.toThrow(/duplicate path/i);
  });

  test('enforces entry, per-file, and total expanded-size limits at their exact boundaries', async () => {
    const archive = await createArchive([
      { content: '1234', path: 'one.txt', type: 'file' },
      { content: '56789', path: 'two.txt', type: 'file' },
    ]);

    await expect(
      indexSourceArchive(archive, {
        maxEntries: 2,
        maxEntryBytes: 5,
        maxExpandedBytes: 9,
      })
    ).resolves.toMatchObject({
      fileCount: 2,
      totalExpandedBytes: 9,
    });
    await expect(
      indexSourceArchive(archive, {
        maxEntries: 1,
        maxEntryBytes: 5,
        maxExpandedBytes: 9,
      })
    ).rejects.toThrow(/entry limit/i);
    await expect(
      indexSourceArchive(archive, {
        maxEntries: 2,
        maxEntryBytes: 4,
        maxExpandedBytes: 9,
      })
    ).rejects.toThrow(/file size limit/i);
    await expect(
      indexSourceArchive(archive, {
        maxEntries: 2,
        maxEntryBytes: 5,
        maxExpandedBytes: 8,
      })
    ).rejects.toThrow(/expanded size limit/i);
  });

  test('uses JSZip size metadata to reject oversized archives before decompressing entries', async () => {
    const archive = await createArchive([
      { content: '1234', path: 'one.txt', type: 'file' },
      { content: '56789', path: 'two.txt', type: 'file' },
    ]);
    const loaded = await JSZip.loadAsync(archive, { createFolders: false });
    const asyncSpies = Object.values(loaded.files).map(entry => vi.spyOn(entry, 'async'));
    vi.spyOn(JSZip, 'loadAsync').mockResolvedValueOnce(loaded);

    await expect(
      indexSourceArchive(archive, {
        maxEntries: 2,
        maxEntryBytes: 5,
        maxExpandedBytes: 8,
      })
    ).rejects.toThrow(/expanded size limit/i);
    for (const asyncSpy of asyncSpies) {
      expect(asyncSpy).not.toHaveBeenCalled();
    }
  });

  test('fails closed before decompression when JSZip omits uncompressed-size metadata', async () => {
    const archive = await createArchive([{ content: 'source', path: 'source.txt', type: 'file' }]);
    const loaded = await JSZip.loadAsync(archive, { createFolders: false });
    const entry = loaded.file('source.txt');
    expect(entry).not.toBeNull();
    if (!entry) {
      throw new Error('Expected source.txt in the test archive.');
    }

    const internalEntry = entry as typeof entry & {
      _data?: { uncompressedSize?: number };
    };
    const asyncSpy = vi.spyOn(entry, 'async');
    internalEntry._data = undefined;
    vi.spyOn(JSZip, 'loadAsync').mockResolvedValueOnce(loaded);

    await expect(indexSourceArchive(archive, GENEROUS_LIMITS)).rejects.toThrow(
      /missing uncompressed size/i
    );
    expect(asyncSpy).not.toHaveBeenCalled();
  });
});
