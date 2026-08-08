import { describe, expect, test, vi } from 'vitest';

import type { ProjectSnapshot } from '../../src/projects/types.js';
import { createCoursePreparationStage } from '../../src/workflows/courseGenerationPreparation.js';

const snapshot = (overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot => ({
  activeSectionId: null,
  createdAt: '2026-07-30T11:00:00.000Z',
  id: 'project-1',
  isLearnMode: false,
  lastOpenedAt: '2026-07-30T11:00:00.000Z',
  learningPlan: null,
  source: null,
  sourceKind: 'document',
  state: 'PLANNING',
  syllabus: [],
  updatedAt: '2026-07-30T11:00:00.000Z',
  userProfile: null,
  version: '4.1',
  ...overrides,
});

const context = (mode: 'document' | 'learn') => ({
  attemptNumber: 1,
  config: {} as never,
  execution: { nodeInstanceId: 'prepare-course', runId: 'run-1' },
  idempotencyKey: 'prepare-key',
  input: {
    assessmentHistory: [
      { role: 'user' as const, text: 'Voglio una preparazione universitaria.' },
      { role: 'model' as const, text: 'Quale livello desideri?' },
    ],
    mode,
    projectId: 'project-1',
    userId: 'user-1',
  },
  retryFeedback: '',
  signal: new AbortController().signal,
});

const storedSource = (id: string, name: string, mimeType = 'text/plain') => ({
  file: { data: 'ignored-by-preparation', mimeType, name, sourceId: id },
  ref: {
    byteSize: 42,
    hash: id.repeat(64).slice(0, 64),
    id,
    mimeType,
    name,
    objectPath: `users/user-1/projects/project-1/sources/${id}`,
  },
});

describe('course generation preparation', () => {
  test('selects learn mode from the persisted profile without requiring a source', async () => {
    const loadProjectSources = vi.fn().mockResolvedValue([]);
    const prepare = createCoursePreparationStage({
      loadProjectSources,
      loadProjectWithRevision: vi.fn().mockResolvedValue({
        revision: 7,
        snapshot: snapshot({
          isLearnMode: true,
          sourceKind: 'learn-mode',
          userProfile: {
            context: 'Studio autonomo',
            experienceLevel: 'base',
            goals: 'Capire i sistemi distribuiti',
            language: 'Italiano',
            learningStyle: 'esempi',
            topic: 'Sistemi distribuiti',
          },
        }),
      }),
    });

    const result = await prepare(context('learn'));

    expect(result).toMatchObject({
      context: {
        assessmentSummary:
          'USER: Voglio una preparazione universitaria.\nMODEL: Quale livello desideri?',
        sourceNames: [],
        topic: 'Sistemi distribuiti',
      },
      projectRevision: 7,
      strategy: 'learn',
    });
    expect(loadProjectSources).not.toHaveBeenCalled();
  });

  test.each([
    [[storedSource('a', 'source.txt')], 'single-source'],
    [[storedSource('a', 'a.txt'), storedSource('b', 'b.pdf', 'application/pdf')], 'source-set'],
  ] as const)('selects stored source strategy without checkpointing bytes', async (sources, strategy) => {
    const prepare = createCoursePreparationStage({
      loadProjectSources: vi.fn().mockResolvedValue(sources),
      loadProjectWithRevision: vi.fn().mockResolvedValue({
        revision: 3,
        snapshot: snapshot(),
      }),
    });

    const result = await prepare(context('document'));

    expect(result.strategy).toBe(strategy);
    expect(result.context.sources).toHaveLength(sources.length);
    expect(result.context.sources.map(source => source.hash)).toEqual(
      sources.map(source => source.ref.hash)
    );
    expect(JSON.stringify(result)).not.toContain('ignored-by-preparation');
  });

  test('selects archive from the persisted source identity', async () => {
    const archive = storedSource('archive', 'src.zip', 'application/zip');
    const loadProjectSources = vi.fn().mockResolvedValue([]);
    const prepare = createCoursePreparationStage({
      loadProjectSources,
      loadProjectWithRevision: vi.fn().mockResolvedValue({
        revision: 2,
        snapshot: snapshot({
          source: { kind: 'archive', name: 'src.zip', ref: archive.ref },
        }),
      }),
    });

    await expect(prepare(context('document'))).resolves.toMatchObject({
      context: {
        sourceNames: ['src.zip'],
        sources: [
          {
            hash: archive.ref.hash,
            id: 'archive',
            kind: 'archive',
            mimeType: 'application/zip',
            name: 'src.zip',
          },
        ],
      },
      strategy: 'archive',
    });
    expect(loadProjectSources).not.toHaveBeenCalled();
  });

  test('keeps failed source provenance out of the generated source context', async () => {
    const sources = [
      storedSource('ready', 'notes.md', 'text/markdown'),
      storedSource('failed', 'scan.pdf', 'application/pdf'),
    ];
    const prepare = createCoursePreparationStage({
      loadProjectSources: vi.fn().mockResolvedValue(sources),
      loadProjectWithRevision: vi.fn().mockResolvedValue({
        revision: 4,
        snapshot: snapshot({
          source: {
            kind: 'document',
            sources: [
              { id: 'ready', status: 'ready' },
              {
                errorMessage: 'Questa fonte non contiene testo PDF utilizzabile.',
                id: 'failed',
                status: 'error',
              },
            ],
          },
        }),
      }),
    });

    const result = await prepare(context('document'));

    expect(result.strategy).toBe('source-set');
    expect(result.context.sources).toEqual([
      expect.objectContaining({ id: 'ready', kind: 'markdown', name: 'notes.md' }),
    ]);
    expect(result.context.sourceNames).toEqual(['notes.md']);
  });

  test('fails permanently when a document course has no persisted source', async () => {
    const prepare = createCoursePreparationStage({
      loadProjectSources: vi.fn().mockResolvedValue([]),
      loadProjectWithRevision: vi.fn().mockResolvedValue({
        revision: 1,
        snapshot: snapshot(),
      }),
    });

    const failure = await prepare(context('document')).catch(error => error);

    expect(failure.failure).toMatchObject({
      code: 'course_source_missing',
      kind: 'permanent',
    });
  });
});
