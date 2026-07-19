import {
  resolveSourceArchiveSelection,
  SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES,
} from '@shared/sourceArchiveSelectors';
import { describe, expect, test } from 'vitest';

const INDEX = [
  { kind: 'directory' as const, path: 'assets' },
  {
    byteSize: 2_000_000,
    contentKind: 'binary' as const,
    kind: 'file' as const,
    path: 'assets/logo.bin',
  },
  { kind: 'directory' as const, path: 'src' },
  {
    byteSize: 2_500_000,
    contentKind: 'text' as const,
    kind: 'file' as const,
    path: 'src/main.ts',
  },
  {
    byteSize: 1_500_000,
    contentKind: 'text' as const,
    kind: 'file' as const,
    path: 'src/runtime.ts',
  },
] as const;

describe('source archive selector contract', () => {
  test('deduplicates file and directory overlap while excluding binary descendants', () => {
    expect(
      resolveSourceArchiveSelection(INDEX, [
        { kind: 'file', path: 'src/main.ts' },
        { kind: 'directory', path: 'src' },
      ])
    ).toEqual({
      expandedTextBytes: SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES,
      selectors: [
        { kind: 'file', path: 'src/main.ts' },
        { kind: 'directory', path: 'src' },
      ],
      textFilePaths: ['src/main.ts', 'src/runtime.ts'],
    });
  });

  test.each([
    {
      selectors: [],
      code: 'empty-selectors',
    },
    {
      selectors: [{ kind: 'file' as const, path: 'src/missing.ts' }],
      code: 'invalid-selector',
    },
    {
      selectors: [{ kind: 'file' as const, path: 'assets/logo.bin' }],
      code: 'selector-not-textual',
    },
    {
      selectors: [{ kind: 'directory' as const, path: 'assets' }],
      code: 'selector-not-textual',
    },
  ])('rejects invalid lesson selectors with $code', ({ selectors, code }) => {
    expect(() => resolveSourceArchiveSelection(INDEX, selectors)).toThrow(
      expect.objectContaining({ code })
    );
  });

  test('rejects a directory whose expanded textual bytes exceed the lesson cap', () => {
    expect(() =>
      resolveSourceArchiveSelection(
        [
          ...INDEX,
          {
            byteSize: 1,
            contentKind: 'text' as const,
            kind: 'file' as const,
            path: 'src/extra.ts',
          },
        ],
        [{ kind: 'directory', path: 'src' }]
      )
    ).toThrow(expect.objectContaining({ code: 'context-limit-exceeded' }));
  });
});
