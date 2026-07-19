import { describe, expect, test, vi } from 'vitest';

import {
  SOURCE_ARCHIVE_READ_PAGE_MAX_BYTES,
  SourceArchiveAccess,
  type SourceArchiveAccessError,
  type SourceArchiveIndexedEntry,
} from '../../src/projects/sourceArchiveAccess.js';

const encoder = new TextEncoder();
const TEXT_FILES = {
  'readme.md': 'project notes',
  'src/a.ts': 'needle needle\nmiddle\nneedle',
  'src/z.ts': 'zero\r\nneedle later',
} as const;
const BINARY_FILE = new Uint8Array([0xff, 0xfe, 0x00]);

const INDEX_ENTRIES: SourceArchiveIndexedEntry[] = [
  {
    byteSize: encoder.encode(TEXT_FILES['src/z.ts']).byteLength,
    contentKind: 'text',
    kind: 'file',
    path: 'src/z.ts',
  },
  { kind: 'directory', path: 'empty' },
  {
    byteSize: encoder.encode(TEXT_FILES['readme.md']).byteLength,
    contentKind: 'text',
    kind: 'file',
    path: 'readme.md',
  },
  { kind: 'directory', path: 'src' },
  {
    byteSize: BINARY_FILE.byteLength,
    contentKind: 'binary',
    kind: 'file',
    path: 'assets/logo.bin',
  },
  {
    byteSize: encoder.encode(TEXT_FILES['src/a.ts']).byteLength,
    contentKind: 'text',
    kind: 'file',
    path: 'src/a.ts',
  },
  { kind: 'directory', path: 'assets' },
];

const createByteReader = () =>
  vi.fn(async (path: string) => {
    if (path === 'assets/logo.bin') return BINARY_FILE.slice();
    const text = TEXT_FILES[path as keyof typeof TEXT_FILES];
    if (text === undefined) throw new Error(`Missing fixture ${path}`);
    return encoder.encode(text);
  });

const createByteRangeReader = () =>
  vi.fn(async (path: string, start: number, endExclusive: number) => {
    if (path === 'assets/logo.bin') return BINARY_FILE.slice(start, endExclusive);
    const text = TEXT_FILES[path as keyof typeof TEXT_FILES];
    if (text === undefined) throw new Error(`Missing fixture ${path}`);
    return encoder.encode(text).slice(start, endExclusive);
  });

const createAccess = (maxContextBytes = 1_000) => {
  const readBytes = createByteReader();
  const readByteRange = createByteRangeReader();
  return {
    access: new SourceArchiveAccess({
      index: { entries: INDEX_ENTRIES },
      maxContextBytes,
      readByteRange,
      readBytes,
    }),
    readByteRange,
    readBytes,
  };
};

describe('SourceArchiveAccess', () => {
  test('returns the complete ordered tree and immediate directory listings', () => {
    const { access } = createAccess();

    expect(access.getTree()).toEqual([
      {
        children: [
          {
            byteSize: 3,
            contentKind: 'binary',
            kind: 'file',
            path: 'assets/logo.bin',
          },
        ],
        kind: 'directory',
        path: 'assets',
      },
      { children: [], kind: 'directory', path: 'empty' },
      {
        byteSize: 13,
        contentKind: 'text',
        kind: 'file',
        path: 'readme.md',
      },
      {
        children: [
          {
            byteSize: 27,
            contentKind: 'text',
            kind: 'file',
            path: 'src/a.ts',
          },
          {
            byteSize: 18,
            contentKind: 'text',
            kind: 'file',
            path: 'src/z.ts',
          },
        ],
        kind: 'directory',
        path: 'src',
      },
    ]);
    expect(access.listDirectory()).toEqual([
      { kind: 'directory', path: 'assets' },
      { kind: 'directory', path: 'empty' },
      { byteSize: 13, contentKind: 'text', kind: 'file', path: 'readme.md' },
      { kind: 'directory', path: 'src' },
    ]);
    expect(access.listDirectory('src').map(entry => entry.path)).toEqual(['src/a.ts', 'src/z.ts']);
  });

  test('reads exact UTF-8 pages through the injected range reader', async () => {
    const { access, readByteRange, readBytes } = createAccess();

    await expect(access.readTextPage('src/z.ts')).resolves.toEqual({
      cursorBytes: 0,
      endByteExclusive: 18,
      nextCursorBytes: null,
      path: 'src/z.ts',
      text: TEXT_FILES['src/z.ts'],
      totalBytes: 18,
    });
    expect(readByteRange).toHaveBeenCalledExactlyOnceWith('src/z.ts', 0, 18);
    expect(readBytes).not.toHaveBeenCalled();
  });

  test('paginates a complete textual file above the lesson selector limit', async () => {
    const completeDocumentation = 'documentation'.repeat(40_000);
    const bytes = encoder.encode(completeDocumentation);
    const readBytes = vi.fn(async () => bytes);
    const readByteRange = vi.fn(async (_path: string, start: number, endExclusive: number) =>
      bytes.slice(start, endExclusive)
    );
    const access = new SourceArchiveAccess({
      index: {
        entries: [
          {
            byteSize: bytes.byteLength,
            contentKind: 'text',
            kind: 'file',
            path: 'README.md',
          },
        ],
      },
      maxContextBytes: 400_000,
      readByteRange,
      readBytes,
    });

    const firstPage = await access.readTextPage('README.md');
    const secondPage = await access.readTextPage('README.md', firstPage.nextCursorBytes || 0);
    expect(firstPage.text + secondPage.text).toBe(completeDocumentation);
    expect(firstPage.endByteExclusive).toBe(SOURCE_ARCHIVE_READ_PAGE_MAX_BYTES);
    expect(firstPage.nextCursorBytes).toBe(SOURCE_ARCHIVE_READ_PAGE_MAX_BYTES);
    expect(secondPage.nextCursorBytes).toBeNull();
    await expect(access.resolveSelector({ kind: 'file', path: 'README.md' })).rejects.toMatchObject(
      {
        code: 'context-limit-exceeded',
      }
    );
    expect(readByteRange).toHaveBeenCalledTimes(2);
    expect(readBytes).not.toHaveBeenCalled();
  });

  test('moves a page boundary backward instead of splitting a UTF-8 code point', async () => {
    const text = `${'a'.repeat(SOURCE_ARCHIVE_READ_PAGE_MAX_BYTES - 1)}€tail`;
    const bytes = encoder.encode(text);
    const readByteRange = vi.fn(async (_path: string, start: number, endExclusive: number) =>
      bytes.slice(start, endExclusive)
    );
    const access = new SourceArchiveAccess({
      index: {
        entries: [
          {
            byteSize: bytes.byteLength,
            contentKind: 'text',
            kind: 'file',
            path: 'unicode.txt',
          },
        ],
      },
      maxContextBytes: 4_000_000,
      readByteRange,
      readBytes: async () => bytes,
    });

    const firstPage = await access.readTextPage('unicode.txt');
    const secondPage = await access.readTextPage(
      'unicode.txt',
      firstPage.nextCursorBytes as number
    );

    expect(firstPage.endByteExclusive).toBe(SOURCE_ARCHIVE_READ_PAGE_MAX_BYTES - 1);
    expect(firstPage.nextCursorBytes).toBe(SOURCE_ARCHIVE_READ_PAGE_MAX_BYTES - 1);
    expect(firstPage.text + secondPage.text).toBe(text);
    expect(readByteRange).toHaveBeenNthCalledWith(
      1,
      'unicode.txt',
      0,
      SOURCE_ARCHIVE_READ_PAGE_MAX_BYTES
    );
    expect(readByteRange).toHaveBeenNthCalledWith(
      2,
      'unicode.txt',
      SOURCE_ARCHIVE_READ_PAGE_MAX_BYTES - 1,
      bytes.byteLength
    );
  });

  test('rejects invalid cursors without clamping or reading', async () => {
    const { access, readByteRange } = createAccess();

    for (const cursorBytes of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
      await expect(access.readTextPage('readme.md', cursorBytes)).rejects.toMatchObject({
        code: 'cursor-invalid',
      });
    }
    expect(readByteRange).not.toHaveBeenCalled();
  });

  test('rejects a cursor that starts inside a UTF-8 code point', async () => {
    const bytes = encoder.encode('a€b');
    const access = new SourceArchiveAccess({
      index: {
        entries: [
          {
            byteSize: bytes.byteLength,
            contentKind: 'text',
            kind: 'file',
            path: 'unicode.txt',
          },
        ],
      },
      maxContextBytes: 1_000,
      readByteRange: async (_path, start, endExclusive) => bytes.slice(start, endExclusive),
      readBytes: async () => bytes,
    });

    await expect(access.readTextPage('unicode.txt', 2)).rejects.toMatchObject({
      code: 'cursor-invalid',
    });
  });

  test('searches every textual file literally in path, line, and column order', async () => {
    const { access, readBytes } = createAccess();

    await expect(access.searchLiteral('needle')).resolves.toEqual([
      { column: 1, line: 1, lineText: 'needle needle', path: 'src/a.ts' },
      { column: 8, line: 1, lineText: 'needle needle', path: 'src/a.ts' },
      { column: 1, line: 3, lineText: 'needle', path: 'src/a.ts' },
      { column: 1, line: 2, lineText: 'needle later', path: 'src/z.ts' },
    ]);
    expect(readBytes).not.toHaveBeenCalledWith('assets/logo.bin');
  });

  test('resolves file selectors exactly and directory selectors recursively', async () => {
    const { access } = createAccess();

    await expect(access.resolveSelector({ kind: 'file', path: 'readme.md' })).resolves.toEqual([
      { path: 'readme.md', text: TEXT_FILES['readme.md'] },
    ]);
    await expect(access.resolveSelector({ kind: 'directory', path: 'src' })).resolves.toEqual([
      { path: 'src/a.ts', text: TEXT_FILES['src/a.ts'] },
      { path: 'src/z.ts', text: TEXT_FILES['src/z.ts'] },
    ]);
  });

  test('directory selectors include every textual file and skip indexed binary files', async () => {
    const readBytes = vi.fn(async (path: string) => {
      if (path === 'mixed/lesson.txt') return encoder.encode('lesson source');
      return BINARY_FILE.slice();
    });
    const access = new SourceArchiveAccess({
      index: {
        entries: [
          { kind: 'directory', path: 'mixed' },
          {
            byteSize: BINARY_FILE.byteLength,
            contentKind: 'binary',
            kind: 'file',
            path: 'mixed/image.bin',
          },
          {
            byteSize: encoder.encode('lesson source').byteLength,
            contentKind: 'text',
            kind: 'file',
            path: 'mixed/lesson.txt',
          },
        ],
      },
      maxContextBytes: 1_000,
      readByteRange: async (path, start, endExclusive) => {
        if (path === 'mixed/lesson.txt') {
          return encoder.encode('lesson source').slice(start, endExclusive);
        }
        return BINARY_FILE.slice(start, endExclusive);
      },
      readBytes,
    });

    await expect(access.resolveSelector({ kind: 'directory', path: 'mixed' })).resolves.toEqual([
      { path: 'mixed/lesson.txt', text: 'lesson source' },
    ]);
    expect(readBytes).not.toHaveBeenCalledWith('mixed/image.bin');
  });

  test('fails closed for missing paths, kind mismatches, and binary content', async () => {
    const { access, readBytes } = createAccess();

    expect(() => access.listDirectory('missing')).toThrowError(
      expect.objectContaining<SourceArchiveAccessError>({ code: 'path-not-found' })
    );
    await expect(access.readTextPage('missing')).rejects.toMatchObject({ code: 'path-not-found' });
    await expect(
      access.resolveSelector({ kind: 'directory', path: 'readme.md' })
    ).rejects.toMatchObject({ code: 'path-kind-mismatch' });
    await expect(access.readTextPage('assets/logo.bin')).rejects.toMatchObject({
      code: 'binary-file',
    });
    expect(readBytes).not.toHaveBeenCalledWith('assets/logo.bin');
  });

  test('rejects over-limit context before reading instead of returning a subset', async () => {
    const { access, readBytes } = createAccess(30);

    await expect(access.resolveSelector({ kind: 'directory', path: 'src' })).rejects.toMatchObject({
      code: 'context-limit-exceeded',
    });
    expect(readBytes).not.toHaveBeenCalled();
  });

  test('rejects when stored bytes exceed the indexed size and cross the context limit', async () => {
    const access = new SourceArchiveAccess({
      index: {
        entries: [
          {
            byteSize: 1,
            contentKind: 'text',
            kind: 'file',
            path: 'source.txt',
          },
        ],
      },
      maxContextBytes: 30,
      readByteRange: async (_path, start, endExclusive) =>
        encoder.encode('x'.repeat(31)).slice(start, endExclusive),
      readBytes: async () => encoder.encode('x'.repeat(31)),
    });

    await expect(
      access.resolveSelector({ kind: 'file', path: 'source.txt' })
    ).rejects.toMatchObject({
      code: 'context-limit-exceeded',
    });
  });

  test('rejects invalid literal queries and wraps byte-reader failures', async () => {
    const { access } = createAccess();
    await expect(access.searchLiteral('')).rejects.toMatchObject({ code: 'query-invalid' });
    await expect(access.searchLiteral('two\nlines')).rejects.toMatchObject({
      code: 'query-invalid',
    });

    const failingAccess = new SourceArchiveAccess({
      index: { entries: INDEX_ENTRIES },
      maxContextBytes: 1_000,
      readByteRange: async () => {
        throw new Error('provider details');
      },
      readBytes: async () => {
        throw new Error('provider details');
      },
    });
    await expect(failingAccess.readTextPage('readme.md')).rejects.toMatchObject({
      code: 'read-failed',
      message: 'Source archive content could not be read.',
      name: 'SourceArchiveAccessError',
    });
  });
});
