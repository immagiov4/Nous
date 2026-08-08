import { SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES } from '@shared/sourceArchiveSelectors';
import { describe, expect, test, vi } from 'vitest';

import { SourceArchiveAccess } from '../../src/projects/sourceArchiveAccess.js';
import {
  createCourseArchivePlanningStages,
  type OpenedCourseArchive,
} from '../../src/workflows/courseGenerationArchivePlanning.js';
import { CourseResearchStateSchema } from '../../src/workflows/courseGenerationWorkflowContract.js';

const researchState = CourseResearchStateSchema.parse({
  context: {
    assessmentSummary: 'USER: Voglio capire questa base di codice.',
    language: 'Italiano',
    profile: null,
    sourceNames: ['src.zip'],
    sources: [
      {
        hash: 'a'.repeat(64),
        id: 'source-archive',
        kind: 'archive',
        mimeType: 'application/zip',
        name: 'src.zip',
      },
    ],
    topic: 'Architettura del progetto',
  },
  projectRevision: 4,
  request: { mode: 'document', projectId: 'project-1', userId: 'user-1' },
  research: {
    web: { brief: 'Panoramica esterna.', sources: [] },
    youtube: { candidates: [], context: '', rationale: '', status: 'unavailable' },
  },
  stage: 'research',
  strategy: 'archive',
});

const rawArchivePlan = (path = 'src/index.ts') => ({
  lessonCountReason: 'Una lezione introduce il confine principale.',
  modules: [
    {
      description: 'Ingresso e dipendenze',
      lessons: [
        {
          description: 'Comprendere il punto di ingresso.',
          guidingQuestions: ['Come parte il sistema?'],
          instructionPacks: [],
          keyConcepts: ['bootstrap'],
          miniLab: null,
          prerequisites: [],
          simplificationRisks: [],
          sourceArchiveSelectors: [{ kind: 'file' as const, path }],
          sourceUrls: [],
          title: 'Il punto di ingresso',
          type: 'core' as const,
        },
      ],
      title: 'Fondamenti',
      type: 'core' as const,
    },
  ],
  summary: 'Percorso nella base di codice.',
  title: 'Architettura del progetto',
});

const createArchive = (byteSize = 32): OpenedCourseArchive => {
  const bytes = new TextEncoder().encode('export const start = () => undefined;');
  const entries = [
    { kind: 'directory' as const, path: 'src' },
    {
      byteSize,
      contentKind: 'text' as const,
      hash: 'b'.repeat(64),
      kind: 'file' as const,
      path: 'src/index.ts',
      preview: 'export const start = () => undefined;',
    },
  ];
  return {
    access: new SourceArchiveAccess({
      index: { entries },
      maxContextBytes: SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES,
      readByteRange: async (_path, start, endExclusive) => bytes.slice(start, endExclusive),
      readBytes: async () => bytes,
    }),
    index: { entries, version: { sourceHash: 'a'.repeat(64), sourceId: 'source-archive' } },
  };
};

const stageContext = (input: typeof researchState) => ({
  attemptNumber: 1,
  config: { maxAttempts: 3, models: {} as never, timeoutMs: 1 },
  execution: { nodeInstanceId: 'draft-archive-course', runId: 'run-1' },
  idempotencyKey: 'draft-key',
  input,
  retryFeedback: '',
  signal: new AbortController().signal,
});

describe('course archive planning', () => {
  test('offers bounded archive tools and persists exact validated selectors', async () => {
    const archive = createArchive();
    const generateObject = vi.fn(async request => {
      await request.tools.get_source_tree.execute({});
      await request.tools.read_source_file.execute({ cursorBytes: 0, path: 'src/index.ts' });
      return rawArchivePlan();
    });
    const stages = createCourseArchivePlanningStages({
      generateObject: generateObject as never,
      now: () => '2026-07-30T12:00:00.000Z',
      openArchive: vi.fn(async () => archive),
    });

    const result = await stages.draftArchiveCourse(stageContext(researchState));

    expect(result.plan.modules[0]?.children[0]).toMatchObject({
      id: 'module-1-lesson-1',
      sourceArchiveSelectors: [{ kind: 'file', path: 'src/index.ts' }],
    });
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        maxToolSteps: 12,
        tools: expect.objectContaining({
          get_source_tree: expect.any(Object),
          list_source_directory: expect.any(Object),
          read_source_file: expect.any(Object),
          search_source_text: expect.any(Object),
        }),
      })
    );
  });

  test('returns corrective feedback for a selector that exceeds the established lesson limit', async () => {
    const stages = createCourseArchivePlanningStages({
      generateObject: vi.fn(async () => rawArchivePlan()) as never,
      openArchive: vi.fn(async () => createArchive(SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES + 1)),
    });

    await expect(stages.draftArchiveCourse(stageContext(researchState))).rejects.toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({
          code: 'course_archive_selector_invalid',
          kind: 'corrective',
        }),
      })
    );
  });

  test('refines the durable draft without invoking the draft stage again', async () => {
    const archive = createArchive();
    const generateObject = vi.fn(async () => rawArchivePlan());
    const stages = createCourseArchivePlanningStages({
      generateObject: generateObject as never,
      openArchive: vi.fn(async () => archive),
    });
    const draft = await stages.draftArchiveCourse(stageContext(researchState));

    const result = await stages.refineArchiveCourse({
      ...stageContext(researchState),
      execution: { nodeInstanceId: 'refine-archive-course', runId: 'run-1' },
      idempotencyKey: 'refine-key',
      input: draft,
    });

    expect(result.plan.modules[0]?.children[0]).toMatchObject({
      sourceArchiveSelectors: [{ kind: 'file', path: 'src/index.ts' }],
    });
    expect(generateObject).toHaveBeenCalledTimes(2);
  });
});
