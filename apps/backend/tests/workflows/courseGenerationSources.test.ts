import { describe, expect, test, vi } from 'vitest';

import { createCourseSourceMaterialReader } from '../../src/workflows/courseGenerationSources.js';

const preparedState = {
  context: {
    assessmentSummary: 'USER: Fammi un corso.',
    language: 'Italiano',
    profile: null,
    sourceNames: ['notes.md'],
    sources: [
      {
        hash: 'a'.repeat(64),
        id: 'source-ready',
        kind: 'markdown',
        mimeType: 'text/markdown',
        name: 'notes.md',
      },
    ],
    topic: 'Corso',
  },
  projectRevision: 4,
  request: { mode: 'document' as const, projectId: 'project-1', userId: 'user-1' },
  stage: 'prepared' as const,
  strategy: 'source-set' as const,
};

const storedSource = (id: string, hash: string, data: string) => ({
  file: { data, mimeType: 'text/markdown', name: `${id}.md`, sourceId: id },
  ref: {
    byteSize: data.length,
    hash,
    id,
    mimeType: 'text/markdown',
    name: `${id}.md`,
    objectPath: `users/user-1/projects/project-1/sources/${id}`,
  },
});

describe('course generation source material reader', () => {
  test('loads only the frozen source identities in their prepared order', async () => {
    const readSourceMaterial = vi.fn().mockResolvedValue({ text: 'contenuto valido' });
    const reader = createCourseSourceMaterialReader({
      loadProjectSources: vi
        .fn()
        .mockResolvedValue([
          storedSource('source-failed', 'b'.repeat(64), 'ignored'),
          storedSource('source-ready', 'a'.repeat(64), 'encoded'),
        ]),
      loadProjectWithRevision: vi.fn().mockResolvedValue({ revision: 4, snapshot: {} }),
      readSourceMaterial,
    });

    const result = await reader(preparedState);

    expect(result).toEqual([
      {
        descriptor: preparedState.context.sources[0],
        text: 'contenuto valido',
      },
    ]);
    expect(readSourceMaterial).toHaveBeenCalledTimes(1);
    expect(readSourceMaterial).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'source-ready.md' })
    );
  });

  test.each([
    {
      code: 'course_source_changed',
      loadProjectSources: [storedSource('source-ready', 'a'.repeat(64), 'encoded')],
      revision: 5,
    },
    {
      code: 'course_source_changed',
      loadProjectSources: [storedSource('source-ready', 'c'.repeat(64), 'encoded')],
      revision: 4,
    },
  ])('fails permanently when frozen source identity changes', async input => {
    const reader = createCourseSourceMaterialReader({
      loadProjectSources: vi.fn().mockResolvedValue(input.loadProjectSources),
      loadProjectWithRevision: vi.fn().mockResolvedValue({
        revision: input.revision,
        snapshot: {},
      }),
      readSourceMaterial: vi.fn().mockResolvedValue({ text: 'contenuto' }),
    });

    const failure = await reader(preparedState).catch(error => error);

    expect(failure.failure).toMatchObject({ code: input.code, kind: 'permanent' });
  });

  test('rejects a source without readable text before planning', async () => {
    const reader = createCourseSourceMaterialReader({
      loadProjectSources: vi
        .fn()
        .mockResolvedValue([storedSource('source-ready', 'a'.repeat(64), 'encoded')]),
      loadProjectWithRevision: vi.fn().mockResolvedValue({ revision: 4, snapshot: {} }),
      readSourceMaterial: vi.fn().mockResolvedValue({ text: '   ' }),
    });

    const failure = await reader(preparedState).catch(error => error);

    expect(failure.failure).toMatchObject({
      code: 'course_source_text_missing',
      kind: 'permanent',
    });
  });
});
