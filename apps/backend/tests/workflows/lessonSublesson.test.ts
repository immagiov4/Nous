import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import type { ProjectSnapshot, ProjectStore } from '../../src/projects/types.js';
import {
  type SublessonGenerationInput,
  SublessonPlanStateSchema,
} from '../../src/workflows/lessonGenerationWorkflowContract.js';
import { createLessonSublessonStages } from '../../src/workflows/lessonSublesson.js';
import { retryCorrective } from '../../src/workflows/retryPolicy.js';

const config = {
  maxAttempts: 3,
  models: getGlobalModelConfig(),
  timeoutMs: 600_000,
  visual: {},
} as never;

const input: SublessonGenerationInput = {
  focus: {
    annotationNote: 'Collega alla nota personale.',
    contextAfter: 'Dopo la selezione.',
    contextBefore: 'Prima della selezione.',
    instructions: 'Usa un esempio concreto.',
    selectedText: 'assenza di orologio globale',
  },
  forceRegenerate: false,
  kind: 'sublesson',
  parentSectionId: 'lesson-1',
  projectId: 'project-1',
  sectionId: 'sublesson-1',
  userId: 'user-1',
};

const snapshot = (overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot => ({
  activeSectionId: 'lesson-1',
  createdAt: '2026-07-30T18:00:00.000Z',
  id: 'project-1',
  isLearnMode: true,
  lastOpenedAt: '2026-07-30T18:00:00.000Z',
  learningPlan: {
    applicationExercisePlanningStatus: 'not-run',
    modules: [
      {
        children: [
          {
            content: 'Contenuto autorevole della lezione padre.',
            description: 'Come comunicano i nodi distribuiti.',
            id: 'lesson-1',
            isCompleted: false,
            kind: 'lesson',
            title: 'Comunicazione a messaggi',
            type: 'core',
          },
          {
            description: 'Ordine causale.',
            id: 'lesson-2',
            isCompleted: false,
            kind: 'lesson',
            title: 'Happens-before',
            type: 'core',
          },
        ],
        id: 'module-1',
        title: 'Fondamenti dei sistemi distribuiti',
      },
    ],
    summary: 'Fondamenti dei sistemi distribuiti.',
    title: 'Sistemi distribuiti',
  },
  source: null,
  sourceKind: 'document',
  updatedAt: '2026-07-30T18:00:00.000Z',
  userProfile: { language: 'Italiano', topic: 'Sistemi distribuiti' },
  version: '4.1',
  ...overrides,
});

const store = (project: ProjectSnapshot, overrides: Record<string, unknown> = {}) =>
  ({
    loadProjectSourceArchiveEntry: vi.fn(),
    loadProjectSourceArchiveEntryRange: vi.fn(),
    loadProjectSourceArchiveIndex: vi.fn(),
    loadProjectSources: vi.fn().mockResolvedValue([]),
    loadProjectWithRevision: vi.fn().mockResolvedValue({ revision: 4, snapshot: project }),
    ...overrides,
  }) as unknown as ProjectStore;

const context = <Input>(stageInput: Input) => ({
  attemptNumber: 1,
  config,
  execution: { nodeInstanceId: 'plan-sublesson', runId: 'run-1' },
  idempotencyKey: 'sublesson-key',
  input: stageInput,
  retryFeedback: '',
  signal: new AbortController().signal,
});

const metadata = {
  contextPrompt: 'Spiega causalità e sincronizzazione senza assumere un tempo globale.',
  description: 'Comprendere perché i processi osservano ordini locali diversi.',
  instructionPacks: ['technical-sources'],
  title: 'Causalità senza orologio globale',
};

const documentIndex = {
  chunks: [
    {
      endOffset: 120,
      headingPath: ['Tempo e causalità'],
      id: 'source-1:chunk-001',
      pageEnd: 4,
      pageStart: 3,
      sequence: 0,
      sourceId: 'source-1',
      startOffset: 0,
      text: 'Un sistema distribuito non dispone di un orologio globale osservabile.',
    },
  ],
  kind: 'pdf-text-index' as const,
  pageCount: 8,
  parsedAt: '2026-07-30T18:00:00.000Z',
  sourceHash: 'a'.repeat(64),
  sourceIds: ['source-1'],
};

describe('durable sublesson stages', () => {
  test('plans from authoritative parent content and fileless course context', async () => {
    const generateObject = vi.fn(async () => metadata);
    const stages = createLessonSublessonStages({
      generateObject: generateObject as never,
      projectStore: store(snapshot()),
    });

    const result = await stages.planSublesson(context(input));

    expect(result).toMatchObject({
      parentSectionId: 'lesson-1',
      previousActiveSectionId: 'lesson-1',
      projectRevision: 4,
      request: { projectId: 'project-1', sectionId: 'sublesson-1', userId: 'user-1' },
      section: {
        ...metadata,
        id: 'sublesson-1',
        isCompleted: false,
        kind: 'lesson',
        parentId: 'lesson-1',
        type: 'deep-dive',
      },
      stage: 'sublesson-plan',
    });
    const request = generateObject.mock.calls[0]?.[0];
    expect(request?.slot).toBe('lesson');
    expect(request?.prompt).toContain('Contenuto autorevole della lezione padre.');
    expect(request?.prompt).toContain('assenza di orologio globale');
    expect(request?.prompt).toContain('Fondamenti dei sistemi distribuiti');
    expect(request?.prompt).toContain('Sistemi distribuiti');
  });

  test('preserves an explicit empty archive selection and exposes bounded archive tools', async () => {
    const archiveIndex = {
      entries: [{ contentKind: 'text', kind: 'file', path: 'src/clock.ts' }],
      version: { sourceHash: 'b'.repeat(64), sourceId: 'archive-1' },
    } as never;
    const project = snapshot({
      source: {
        kind: 'archive',
        ref: { hash: 'b'.repeat(64), id: 'archive-1' },
      },
      sourceKind: 'archive',
    });
    const generateObject = vi.fn(async () => ({ ...metadata, sourceArchiveSelectors: [] }));
    const stages = createLessonSublessonStages({
      generateObject: generateObject as never,
      openArchive: vi.fn().mockResolvedValue({
        access: {
          getTree: vi.fn(),
          listDirectory: vi.fn(),
          readTextPage: vi.fn(),
          searchLiteral: vi.fn(),
        },
        index: archiveIndex,
      }) as never,
      projectStore: store(project),
    });

    const result = await stages.planSublesson(context(input));
    const request = generateObject.mock.calls[0]?.[0];

    expect(result.section).toHaveProperty('sourceArchiveSelectors', []);
    expect(request?.tools).toEqual(
      expect.objectContaining({
        get_source_tree: expect.any(Object),
        read_source_file: expect.any(Object),
        search_source_text: expect.any(Object),
      })
    );
    expect(request?.prompt).toContain('src/clock.ts');
  });

  test('maps only the new lesson against an existing document index', async () => {
    const project = snapshot({ documentIndex });
    const mapLessonChunkBatch = vi.fn(async ({ batch }: { batch: { batchIndex: number } }) => ({
      batchIndex: batch.batchIndex,
      mappings: [{ chunkIds: ['source-1:chunk-001'], lessonId: 'sublesson-1' }],
    }));
    const stages = createLessonSublessonStages({
      mapLessonChunkBatch: mapLessonChunkBatch as never,
      projectStore: store(project),
    });
    const plan = SublessonPlanStateSchema.parse({
      parentSectionId: 'lesson-1',
      previousActiveSectionId: 'lesson-1',
      projectRevision: 4,
      request: {
        forceRegenerate: false,
        projectId: 'project-1',
        sectionId: 'sublesson-1',
        userId: 'user-1',
      },
      section: {
        ...metadata,
        id: 'sublesson-1',
        isCompleted: false,
        kind: 'lesson',
        parentId: 'lesson-1',
        type: 'deep-dive',
      },
      stage: 'sublesson-plan',
    });

    const result = await stages.finalizeSublesson(context(plan));

    expect(mapLessonChunkBatch).toHaveBeenCalledWith(
      expect.objectContaining({ batch: expect.objectContaining({ mode: 'fast' }) })
    );
    expect(result).toMatchObject({
      createdDocumentIndex: null,
      section: {
        primaryChunkIds: ['source-1:chunk-001'],
        primaryChunkMappingSource: 'mapped',
        sourceReferences: [
          {
            chunkIds: ['source-1:chunk-001'],
            pageEnd: 4,
            pageStart: 3,
            sourceId: 'source-1',
          },
        ],
      },
      stage: 'sublesson-ready',
    });
  });

  test('creates a missing source index, while a source-free project skips mapping', async () => {
    const source = {
      file: { data: 'dGVzdG8=', mimeType: 'application/pdf', name: 'fonte.pdf' },
      ref: {
        byteSize: 6,
        hash: 'a'.repeat(64),
        id: 'source-1',
        mimeType: 'application/pdf',
        name: 'fonte.pdf',
        objectPath: 'sources/fonte.pdf',
      },
    };
    const mapLessonChunkBatch = vi.fn(async ({ batch }: { batch: { batchIndex: number } }) => ({
      batchIndex: batch.batchIndex,
      mappings: [{ chunkIds: ['source-1:chunk-001'], lessonId: 'sublesson-1' }],
    }));
    const generateObject = vi.fn(async () => metadata);
    const projectStore = store(snapshot(), {
      loadProjectSources: vi.fn().mockResolvedValue([source]),
    });
    const stages = createLessonSublessonStages({
      buildDocumentIndex: vi.fn(() => documentIndex),
      generateObject: generateObject as never,
      mapLessonChunkBatch: mapLessonChunkBatch as never,
      projectStore,
      readSourceMaterial: vi.fn().mockResolvedValue({ text: 'testo sorgente' }),
    });
    const plan = await stages.planSublesson(context(input));
    const mapped = await stages.finalizeSublesson(context(plan));

    expect(mapped.createdDocumentIndex).toEqual(documentIndex);
    expect(mapped.section.primaryChunkIds).toEqual(['source-1:chunk-001']);

    const sourceFreeStages = createLessonSublessonStages({ projectStore: store(snapshot()) });
    const sourceFree = await sourceFreeStages.finalizeSublesson(context(plan));
    expect(sourceFree).toMatchObject({
      createdDocumentIndex: null,
      section: plan.section,
      stage: 'sublesson-ready',
    });
  });

  test('retries a failed mapping before using the established deterministic fallback', async () => {
    const project = snapshot({ documentIndex });
    const mappingFailure = retryCorrective({
      code: 'course_chunk_mapping_invalid',
      feedback: 'Return one valid mapping.',
      message: 'Invalid mapping.',
    });
    const mapLessonChunkBatch = vi.fn().mockRejectedValue(mappingFailure);
    const stages = createLessonSublessonStages({
      mapLessonChunkBatch,
      projectStore: store(project),
    });
    const plan = SublessonPlanStateSchema.parse({
      parentSectionId: 'lesson-1',
      previousActiveSectionId: 'lesson-1',
      projectRevision: 4,
      request: {
        forceRegenerate: false,
        projectId: 'project-1',
        sectionId: 'sublesson-1',
        userId: 'user-1',
      },
      section: {
        ...metadata,
        id: 'sublesson-1',
        isCompleted: false,
        kind: 'lesson',
        parentId: 'lesson-1',
        type: 'deep-dive',
      },
      stage: 'sublesson-plan',
    });

    await expect(stages.finalizeSublesson(context(plan))).rejects.toBe(mappingFailure);
    const exhausted = await stages.finalizeSublesson({
      ...context(plan),
      attemptNumber: config.maxAttempts,
    });

    expect(exhausted.section).toMatchObject({
      primaryChunkIds: ['source-1:chunk-001'],
      primaryChunkMappingSource: 'fallback',
    });
  });
});
