import { describe, expect, test, vi } from 'vitest';

import { createCourseArchiveOpener } from '../../src/workflows/courseGenerationArchiveAccess.js';

const archiveState = {
  context: {
    sources: [
      {
        hash: 'a'.repeat(64),
        id: 'source-archive',
        kind: 'archive',
        mimeType: 'application/zip',
        name: 'src.zip',
      },
    ],
  },
  projectRevision: 4,
  request: { projectId: 'project-1', userId: 'user-1' },
};

describe('course archive access', () => {
  test('opens only the frozen archive version and reads through the project store', async () => {
    const bytes = new TextEncoder().encode('export const answer = 42;');
    const version = {
      representationHash: 'b'.repeat(64),
      sourceHash: 'a'.repeat(64),
      sourceId: 'source-archive',
    };
    const loadProjectSourceArchiveEntry = vi.fn(async () => bytes);
    const loadProjectSourceArchiveEntryRange = vi.fn(
      async (_userId, _projectId, _path, _version, start, endExclusive) =>
        bytes.slice(start, endExclusive)
    );
    const openArchive = createCourseArchiveOpener({
      loadProjectSourceArchiveEntry,
      loadProjectSourceArchiveEntryRange,
      loadProjectSourceArchiveIndex: vi.fn(async () => ({
        entries: [
          { kind: 'directory' as const, path: 'src' },
          {
            byteSize: bytes.byteLength,
            contentKind: 'text' as const,
            hash: 'b'.repeat(64),
            kind: 'file' as const,
            path: 'src/index.ts',
            preview: 'export const answer = 42;',
          },
        ],
        version,
      })),
      loadProjectWithRevision: vi.fn(async () => ({ revision: 4, snapshot: {} as never })),
    });

    const archive = await openArchive(archiveState, new AbortController().signal);

    await expect(archive.access.readTextPage('src/index.ts')).resolves.toMatchObject({
      nextCursorBytes: null,
      path: 'src/index.ts',
      text: 'export const answer = 42;',
    });
    expect(loadProjectSourceArchiveEntryRange).toHaveBeenCalledWith(
      'user-1',
      'project-1',
      'src/index.ts',
      version,
      0,
      bytes.byteLength
    );
    expect(loadProjectSourceArchiveEntry).not.toHaveBeenCalled();
  });

  test('fails permanently when the project revision or archive version changed', async () => {
    const openArchive = createCourseArchiveOpener({
      loadProjectSourceArchiveEntry: vi.fn(),
      loadProjectSourceArchiveEntryRange: vi.fn(),
      loadProjectSourceArchiveIndex: vi.fn(async () => ({
        entries: [],
        version: {
          representationHash: 'd'.repeat(64),
          sourceHash: 'c'.repeat(64),
          sourceId: 'source-archive',
        },
      })),
      loadProjectWithRevision: vi.fn(async () => ({ revision: 4, snapshot: {} as never })),
    });

    await expect(openArchive(archiveState, new AbortController().signal)).rejects.toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({ code: 'course_source_changed', kind: 'permanent' }),
      })
    );
  });
});
