import {
  PDF_MAPPING_MAX_CHUNK_CANDIDATES,
  PDF_MAPPING_MAX_CHUNK_PREVIEW_CHARS,
  PDF_MAPPING_MAX_LESSONS_PER_REQUEST,
  PDF_MAPPING_RECOVERY_EXHAUSTED_WARNING,
  PDF_MAPPING_REPAIR_MAX_CHUNK_CANDIDATES,
  PDF_MAPPING_REPAIR_MAX_LESSONS_PER_REQUEST,
  PDF_MAPPING_TARGET_PROMPT_CHARS,
} from '@shared/pdfDocumentPolicy';
import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  buildCourseChunkMappingBatches,
  type CourseChunkMappingBatch,
  type CourseChunkMappingBatchResult,
  createCourseLessonChunkBatchMapper,
} from '../../src/workflows/courseChunkMapping.js';
import { CourseModelProviderError } from '../../src/workflows/courseGenerationModel.js';
import {
  type CourseGenerationWorkflowConfig,
  type CourseGenerationWorkflowServices,
  createCourseGenerationWorkflow,
} from '../../src/workflows/courseGenerationWorkflow.js';
import {
  type CoursePlanState,
  CoursePlanStateSchema,
} from '../../src/workflows/courseGenerationWorkflowContract.js';
import {
  buildFallbackMappings,
  type CourseSourceMappingProgress,
  type CourseSourcePreparationOutcome,
  createCourseSourceFinalizationServices,
} from '../../src/workflows/courseSourceFinalization.js';
import { retryOperational } from '../../src/workflows/retryPolicy.js';
import type { FanOutDefinition, StepDefinition, WorkflowNode } from '../../src/workflows/types.js';
import { indexWorkflowNodes } from '../../src/workflows/workflowNodeIndex.js';

const source = (id: string, kind: string, name: string) => ({
  hash: id.at(-1)?.repeat(64) || 'a'.repeat(64),
  id,
  kind,
  mimeType: kind === 'pdf' ? 'application/pdf' : 'text/markdown',
  name,
});

const planState = (strategy: 'archive' | 'learn' | 'single-source' | 'source-set') =>
  CoursePlanStateSchema.parse({
    context: {
      assessmentSummary: 'USER: Voglio capire il materiale.',
      language: 'Italiano',
      profile: null,
      sourceNames:
        strategy === 'learn' ? [] : strategy === 'source-set' ? ['a.pdf', 'b.md'] : ['a.pdf'],
      sources:
        strategy === 'learn'
          ? []
          : strategy === 'source-set'
            ? [source('source-1', 'pdf', 'a.pdf'), source('source-2', 'markdown', 'b.md')]
            : [source('source-1', strategy === 'archive' ? 'archive' : 'pdf', 'a.pdf')],
      topic: 'Sistemi distribuiti',
    },
    plan: {
      applicationExercisePlanningStatus: 'not-run',
      modules: [
        {
          children: [
            {
              description: 'Nodi e processi.',
              id: 'lesson-1',
              isCompleted: false,
              kind: 'lesson',
              title: 'Nodi',
              type: 'core',
            },
            {
              description: 'Riepilogo.',
              id: 'summary-1',
              isCompleted: false,
              kind: 'lesson',
              title: 'Riepilogo',
              type: 'summary',
            },
            {
              description: 'Messaggi e ritardi.',
              id: 'lesson-2',
              isCompleted: false,
              kind: 'lesson',
              title: 'Messaggi',
              type: 'core',
            },
          ],
          id: 'module-1',
          title: 'Fondamenti',
        },
      ],
      summary: 'Percorso.',
      title: 'Sistemi distribuiti',
    },
    projectRevision: 2,
    request: { mode: strategy === 'learn' ? 'learn' : 'document', projectId: 'p1', userId: 'u1' },
    research: {
      web: { brief: '', sources: [] },
      youtube: { candidates: [], context: '', rationale: '', status: 'unavailable' },
    },
    researchCoursePlan: null,
    stage: 'plan',
    strategy,
    syllabus: [],
  });

const documentIndex = {
  chunks: [
    {
      endOffset: 100,
      headingPath: ['a.pdf'],
      id: 'source-1:chunk-001',
      pageEnd: 1,
      pageStart: 1,
      sequence: 0,
      sourceId: 'source-1',
      startOffset: 0,
      text: 'Primo chunk',
    },
    {
      endOffset: 200,
      headingPath: ['b.md'],
      id: 'source-2:chunk-001',
      sequence: 1,
      sourceId: 'source-2',
      startOffset: 100,
      text: 'Secondo chunk',
    },
  ],
  documentTitle: 'a.pdf, b.md',
  kind: 'pdf-text-index' as const,
  parsedAt: '2026-07-30T12:00:00.000Z',
  sourceHash: `${'1'.repeat(64)}:${'2'.repeat(64)}`,
  sourceIds: ['source-1', 'source-2'],
};

const config: CourseGenerationWorkflowConfig = {
  maxAttempts: 3,
  models: getGlobalModelConfig(),
  timeoutMs: 600_000,
};

const stageContext = <Input>(input: Input, attemptNumber = 1, maxAttempts = 3) => ({
  attemptNumber,
  config: { ...config, maxAttempts },
  execution: { nodeInstanceId: 'finalize-course-sources', runId: 'run-1' },
  idempotencyKey: 'source-key',
  input,
  retryFeedback: '',
  signal: new AbortController().signal,
});

const findNode = (id: string): WorkflowNode => {
  const definition = createCourseGenerationWorkflow(config);
  const node = [...indexWorkflowNodes(definition).values()].find(
    entry => entry.node.id === id
  )?.node;
  if (!node) throw new Error(`Missing test workflow node ${id}.`);
  return node;
};

const runStep = <Input, Output>(
  id: string,
  input: Input,
  services: CourseGenerationWorkflowServices,
  attemptNumber = 1,
  maxAttempts = 3
): Promise<Output> => {
  const node = findNode(id);
  if (node.kind !== 'step') throw new Error(`${id} is not a step.`);
  return (
    node as StepDefinition<
      Input,
      Output,
      CourseGenerationWorkflowConfig,
      CourseGenerationWorkflowServices
    >
  ).run({ ...stageContext(input, attemptNumber, maxAttempts), services });
};

const sourceServices = (
  services: ReturnType<typeof createCourseSourceFinalizationServices>
): CourseGenerationWorkflowServices => services as CourseGenerationWorkflowServices;

const mappingState = (
  plan: CoursePlanState = planState('source-set'),
  index = documentIndex
): Extract<CourseSourcePreparationOutcome, { kind: 'mapping' }> => ({
  index,
  kind: 'mapping',
  lessonIds: ['lesson-1', 'lesson-2'],
  planState: plan,
});

const mappingProgress = (
  mappings: CourseSourceMappingProgress['mappings'],
  mappingFailed = false,
  state = mappingState()
): CourseSourceMappingProgress => ({ mappingFailed, mappings, state });

type BatchAttempt =
  | { result: CourseChunkMappingBatchResult; status: 'completed' }
  | { batchIndex: number; status: 'failed' };

describe('course source finalization', () => {
  test('batches large mapping requests within the established prompt and candidate limits', async () => {
    const basePlan = planState('source-set').plan;
    const plan = {
      ...basePlan,
      modules: [
        {
          ...basePlan.modules[0],
          children: Array.from({ length: 9 }, (_, index) => ({
            description: `Description ${index + 1}`,
            id: `lesson-${index + 1}`,
            isCompleted: false,
            kind: 'lesson' as const,
            title: `Lesson ${index + 1}`,
            type: 'core' as const,
          })),
        },
      ],
    };
    const index = {
      ...documentIndex,
      chunks: Array.from({ length: 120 }, (_, sequence) => ({
        endOffset: (sequence + 1) * 1_000,
        headingPath: [`Section ${sequence + 1}`],
        id: `source-1:chunk-${String(sequence + 1).padStart(3, '0')}`,
        sequence,
        sourceId: 'source-1',
        startOffset: sequence * 1_000,
        text: `Chunk ${sequence + 1} ${'x'.repeat(2_000)}`,
      })),
    };
    const generateObject = vi.fn(
      async (request: {
        prompt: string;
        schema: {
          parse: (value: unknown) => unknown;
          safeParse: (value: unknown) => { success: boolean };
        };
      }) => {
        const input = JSON.parse(request.prompt) as {
          chunks: Array<{ id: string }>;
          lessons: Array<{ lessonId: string }>;
        };
        return request.schema.parse({
          mappings: input.lessons.map(lesson => ({
            chunkIds: [input.chunks[0]?.id],
            lessonId: lesson.lessonId,
          })),
        });
      }
    );
    const config = getGlobalModelConfig();
    const signal = new AbortController().signal;
    const batches = buildCourseChunkMappingBatches({
      index,
      lessonIds: Array.from({ length: 9 }, (_, lessonIndex) => `lesson-${lessonIndex + 1}`),
      mode: 'fast',
      plan,
    });
    const mapBatch = createCourseLessonChunkBatchMapper(generateObject as never);
    const results = await Promise.all(
      batches.map(batch => mapBatch({ batch, config, retryFeedback: '', signal }))
    );
    const mappedLessonCount = results.reduce((total, result) => total + result.mappings.length, 0);
    const requests = generateObject.mock.calls.map(call => call[0]);
    const inputs = requests.map(request => JSON.parse(request.prompt));

    expect(inputs.map(input => input.lessons.length)).toEqual([
      PDF_MAPPING_MAX_LESSONS_PER_REQUEST,
      1,
    ]);
    expect(mappedLessonCount).toBe(9);
    for (const [requestIndex, request] of requests.entries()) {
      const input = inputs[requestIndex];
      expect(request.prompt.length).toBeLessThanOrEqual(PDF_MAPPING_TARGET_PROMPT_CHARS);
      expect(input.chunks.length).toBeLessThanOrEqual(PDF_MAPPING_MAX_CHUNK_CANDIDATES);
      expect(input.chunks.length).toBeLessThan(index.chunks.length);
      expect(
        input.chunks.every(
          (chunk: { text?: string; textPreview: string }) =>
            chunk.text === undefined &&
            chunk.textPreview.length <= PDF_MAPPING_MAX_CHUNK_PREVIEW_CHARS
        )
      ).toBe(true);
    }

    const firstRequest = requests[0];
    const firstInput = inputs[0] as {
      chunks: Array<{ id: string }>;
      lessons: Array<{ lessonId: string }>;
    };
    const validMappings = firstInput.lessons.map(lesson => ({
      chunkIds: [firstInput.chunks[0]?.id],
      lessonId: lesson.lessonId,
    }));
    expect(
      firstRequest.schema.safeParse({
        mappings: [
          { ...validMappings[0], chunkIds: ['outside-candidate-window'] },
          ...validMappings.slice(1),
        ],
      }).success
    ).toBe(false);
    expect(
      firstRequest.schema.safeParse({
        mappings: [
          { ...validMappings[0], lessonId: 'outside-requested-lessons' },
          ...validMappings.slice(1),
        ],
      }).success
    ).toBe(false);
    expect(firstRequest.schema.safeParse({ mappings: validMappings.slice(1) }).success).toBe(true);
    expect(
      firstRequest.schema.safeParse({
        mappings: [validMappings[0], ...validMappings.slice(0, -1)],
      }).success
    ).toBe(false);
  });

  test('fits an individually oversized lesson inside the established mapping prompt limit', async () => {
    const basePlan = planState('source-set').plan;
    const plan = {
      ...basePlan,
      modules: [
        {
          ...basePlan.modules[0],
          children: basePlan.modules[0].children.map((lesson, index) =>
            index === 0
              ? { ...lesson, description: 'x'.repeat(PDF_MAPPING_TARGET_PROMPT_CHARS * 2) }
              : lesson
          ),
        },
      ],
    };
    const generateObject = vi.fn(
      async (request: { prompt: string; schema: { parse: (value: unknown) => unknown } }) => {
        const input = JSON.parse(request.prompt) as {
          chunks: Array<{ id: string }>;
          lessons: Array<{ lessonId: string }>;
        };
        return request.schema.parse({
          mappings: input.lessons.map(lesson => ({
            chunkIds: [input.chunks[0]?.id],
            lessonId: lesson.lessonId,
          })),
        });
      }
    );

    const config = getGlobalModelConfig();
    const signal = new AbortController().signal;
    const batches = buildCourseChunkMappingBatches({
      index: documentIndex,
      lessonIds: ['lesson-1', 'lesson-2'],
      mode: 'fast',
      plan,
    });
    const mapBatch = createCourseLessonChunkBatchMapper(generateObject as never);
    await Promise.all(batches.map(batch => mapBatch({ batch, config, retryFeedback: '', signal })));

    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(
      generateObject.mock.calls.every(
        ([request]) => request.prompt.length <= PDF_MAPPING_TARGET_PROMPT_CHARS
      )
    ).toBe(true);
  });

  test('maps one repair lesson per request and passes durable corrective feedback', async () => {
    const generateObject = vi.fn(
      async (request: { prompt: string; schema: { parse: (value: unknown) => unknown } }) => {
        const input = JSON.parse(request.prompt) as {
          chunks: Array<{ id: string }>;
          lessons: Array<{ lessonId: string }>;
        };
        return request.schema.parse({
          mappings: [{ chunkIds: [input.chunks[0]?.id], lessonId: input.lessons[0]?.lessonId }],
        });
      }
    );
    const config = getGlobalModelConfig();
    const signal = new AbortController().signal;
    const plan = planState('source-set').plan;
    const batches = buildCourseChunkMappingBatches({
      index: documentIndex,
      lessonIds: ['lesson-1', 'lesson-2'],
      mode: 'repair',
      plan,
    });
    const mapBatch = createCourseLessonChunkBatchMapper(generateObject as never);
    const results = await Promise.all(
      batches.map(batch =>
        mapBatch({
          batch,
          config,
          retryFeedback: 'Use a valid candidate for every requested lesson.',
          signal,
        })
      )
    );
    const inputs = generateObject.mock.calls.map(call => JSON.parse(call[0].prompt));

    expect(inputs).toHaveLength(2);
    expect(results.flatMap(result => result.mappings)).toHaveLength(2);
    expect(
      inputs.every(
        input =>
          input.correction === 'Use a valid candidate for every requested lesson.' &&
          input.lessons.length === PDF_MAPPING_REPAIR_MAX_LESSONS_PER_REQUEST &&
          input.chunks.length <= PDF_MAPPING_REPAIR_MAX_CHUNK_CANDIDATES &&
          input.mode === 'repair'
      )
    ).toBe(true);
  });

  test.each([
    'learn',
    'archive',
  ] as const)('does not invent a document index for %s courses', async strategy => {
    const readSourceMaterials = vi.fn();
    const services = createCourseSourceFinalizationServices({
      buildDocumentIndex: vi.fn(),
      mapBatch: vi.fn(),
      readSourceMaterials,
    });

    const outcome = await services.prepareCourseSourceFinalization(
      stageContext(planState(strategy))
    );

    expect(outcome).toMatchObject({
      kind: 'ready',
      result: { documentIndex: null, plan: planState(strategy).plan },
    });
    expect(readSourceMaterials).not.toHaveBeenCalled();
  });

  test('persists complete structured mappings and exact source references', async () => {
    const services = createCourseSourceFinalizationServices({
      buildDocumentIndex: vi.fn(() => documentIndex),
      mapBatch: vi.fn(),
      now: () => '2026-07-30T13:00:00.000Z',
      readSourceMaterials: vi.fn().mockResolvedValue([]),
    });
    const progress = mappingProgress([
      { chunkIds: ['source-1:chunk-001'], lessonId: 'lesson-1' },
      { chunkIds: ['source-2:chunk-001'], lessonId: 'lesson-2' },
    ]);

    const result = await services.completeCourseSourceFinalization(stageContext(progress));
    const lessons = result.plan.modules[0]?.children.filter(child => child.kind === 'lesson');

    expect(lessons?.[0]).toMatchObject({
      primaryChunkIds: ['source-1:chunk-001'],
      primaryChunkMappingSource: 'mapped',
      sourceReferences: [
        { chunkIds: ['source-1:chunk-001'], pageEnd: 1, pageStart: 1, sourceId: 'source-1' },
      ],
    });
    expect(lessons?.[1]).not.toHaveProperty('primaryChunkIds');
    expect(lessons?.[2]).toMatchObject({
      primaryChunkIds: ['source-2:chunk-001'],
      primaryChunkMappingSource: 'mapped',
      sourceReferences: [{ chunkIds: ['source-2:chunk-001'], sourceId: 'source-2' }],
    });
    expect(result.documentIndex).toMatchObject({
      mappingQuality: { lessonCount: 2, mappedLessonCount: 2, mappingSource: 'mapped' },
      mappingRecovery: undefined,
    });
    expect(result.documentIndex?.mappingQuality).not.toHaveProperty('coverageRatio');
    expect(result.documentIndex?.mappingQuality).not.toHaveProperty('gapCount');
  });

  test('records substantive PDF page coverage and gaps from accepted mappings', async () => {
    const pagedIndex = {
      ...documentIndex,
      chunks: [
        { ...documentIndex.chunks[0], pageEnd: 2, pageStart: 1 },
        {
          ...documentIndex.chunks[0],
          endOffset: 1_000,
          id: 'source-1:chunk-010',
          pageEnd: 10,
          pageStart: 9,
          sequence: 1,
          startOffset: 900,
        },
      ],
      pageCount: 10,
    };
    const services = createCourseSourceFinalizationServices({
      buildDocumentIndex: vi.fn(),
      mapBatch: vi.fn(),
      readSourceMaterials: vi.fn(),
    });
    const progress = mappingProgress(
      [
        { chunkIds: ['source-1:chunk-001'], lessonId: 'lesson-1' },
        { chunkIds: ['source-1:chunk-010'], lessonId: 'lesson-2' },
      ],
      false,
      mappingState(planState('single-source'), pagedIndex)
    );

    const result = await services.completeCourseSourceFinalization(stageContext(progress));

    expect(result.documentIndex?.mappingQuality).toMatchObject({
      coverageRatio: 0.4,
      gapCount: 1,
      mappingSource: 'mapped',
    });
  });

  test('runs fast batches in order and repairs only missing lessons', () => {
    const fastNode = findNode('map-course-source-fast-batches');
    const repairNode = findNode('map-course-source-repair-batches');
    const fastWorker = findNode('map-course-source-fast-batch');
    const repairWorker = findNode('map-course-source-repair-batch');
    if (
      fastNode.kind !== 'fanOut' ||
      repairNode.kind !== 'fanOut' ||
      fastWorker.kind !== 'step' ||
      repairWorker.kind !== 'step'
    ) {
      throw new Error('Course source mapping composition is incomplete.');
    }
    const fast = fastNode as FanOutDefinition<
      CourseSourcePreparationOutcome,
      CourseChunkMappingBatch,
      BatchAttempt,
      CourseSourceMappingProgress
    >;
    const repair = repairNode as FanOutDefinition<
      CourseSourceMappingProgress,
      CourseChunkMappingBatch,
      BatchAttempt,
      CourseSourceMappingProgress
    >;
    const state = mappingState();
    const [fastBatch] = fast.inputs(state);
    if (!fastBatch) throw new Error('Expected one fast mapping batch.');
    const fastProgress = fast.fanIn(
      [
        {
          input: fastBatch,
          key: '0',
          output: {
            result: {
              batchIndex: 0,
              mappings: [{ chunkIds: ['source-1:chunk-001'], lessonId: 'lesson-1' }],
            },
            status: 'completed',
          },
          status: 'completed',
        },
      ],
      state
    );
    const repairInputs = repair.inputs(fastProgress);

    expect(fast.failureMode).toBe('fail-fast');
    expect(fast.inputs(state).map(batch => fast.keyBy(batch))).toEqual(['0']);
    expect(repairInputs).toHaveLength(1);
    expect(repairInputs[0]).toMatchObject({
      lessons: [{ lessonId: 'lesson-2' }],
      mode: 'repair',
    });
    expect(fastWorker.timeoutMs).toBe(90_000);
    expect(repairWorker.timeoutMs).toBe(90_000);
  });

  test('lets each durable batch retry before returning a fallback outcome', async () => {
    const providerError = retryOperational({
      code: 'course_source_mapping_unavailable',
      message: 'The course source mapping provider is unavailable.',
    });
    const services = createCourseSourceFinalizationServices({
      buildDocumentIndex: vi.fn(),
      mapBatch: vi.fn().mockRejectedValue(providerError),
      readSourceMaterials: vi.fn(),
    });
    const fastNode = findNode('map-course-source-fast-batches') as FanOutDefinition<
      CourseSourcePreparationOutcome,
      CourseChunkMappingBatch
    >;
    const [batch] = fastNode.inputs(mappingState());
    if (!batch) throw new Error('Expected one fast mapping batch.');

    await expect(
      runStep('map-course-source-fast-batch', batch, sourceServices(services), 2, 3)
    ).rejects.toBe(providerError);
    await expect(
      runStep('map-course-source-fast-batch', batch, sourceServices(services), 3, 3)
    ).resolves.toEqual({ batchIndex: 0, status: 'failed' });
  });

  test('persists deterministic fallback and the recovery marker after exhausted batches', async () => {
    const services = createCourseSourceFinalizationServices({
      buildDocumentIndex: vi.fn(),
      mapBatch: vi.fn(),
      now: () => '2026-07-30T13:00:00.000Z',
      readSourceMaterials: vi.fn(),
    });

    const result = await services.completeCourseSourceFinalization(
      stageContext(mappingProgress([], true))
    );
    const lessons = result.plan.modules[0]?.children.filter(
      child => child.kind === 'lesson' && child.type !== 'summary'
    );

    expect(lessons).toEqual([
      expect.objectContaining({
        primaryChunkIds: ['source-1:chunk-001'],
        primaryChunkMappingSource: 'fallback',
      }),
      expect.objectContaining({
        primaryChunkIds: ['source-2:chunk-001'],
        primaryChunkMappingSource: 'fallback',
      }),
    ]);
    expect(result.documentIndex).toMatchObject({
      mappingQuality: { mappingSource: 'fallback' },
      mappingRecovery: { status: 'exhausted', updatedAt: '2026-07-30T13:00:00.000Z' },
      mappingWarnings: [PDF_MAPPING_RECOVERY_EXHAUSTED_WARNING],
    });
  });

  test('keeps legacy chunks without page spans out of PDF edge pages', () => {
    const legacyIndex = {
      ...documentIndex,
      chunks: Array.from({ length: 20 }, (_, sequence) => ({
        endOffset: (sequence + 1) * 100,
        headingPath: [`Section ${sequence + 1}`],
        id: `source-1:chunk-${String(sequence + 1).padStart(3, '0')}`,
        sequence,
        sourceId: 'source-1',
        startOffset: sequence * 100,
        text: `Chunk ${sequence + 1}`,
      })),
      pageCount: 20,
    };

    expect(buildFallbackMappings(planState('single-source').plan, legacyIndex)).toEqual(
      new Map([
        ['lesson-1', ['source-1:chunk-002', 'source-1:chunk-003']],
        ['lesson-2', ['source-1:chunk-018', 'source-1:chunk-019']],
      ])
    );
  });

  test('uses the final-attempt fallback outcome for raw model provider failures', async () => {
    const services = createCourseSourceFinalizationServices({
      buildDocumentIndex: vi.fn(),
      mapBatch: vi.fn().mockRejectedValue(new CourseModelProviderError(new Error('provider'))),
      readSourceMaterials: vi.fn(),
    });
    const fastNode = findNode('map-course-source-fast-batches') as FanOutDefinition<
      CourseSourcePreparationOutcome,
      CourseChunkMappingBatch
    >;
    const [batch] = fastNode.inputs(mappingState());
    if (!batch) throw new Error('Expected one fast mapping batch.');

    await expect(
      runStep('map-course-source-fast-batch', batch, sourceServices(services), 3, 3)
    ).resolves.toEqual({ batchIndex: 0, status: 'failed' });
  });

  test('does not turn programming errors into a successful fallback', async () => {
    const defect = new TypeError('unexpected mapper state');
    const services = createCourseSourceFinalizationServices({
      buildDocumentIndex: vi.fn(),
      mapBatch: vi.fn().mockRejectedValue(defect),
      readSourceMaterials: vi.fn(),
    });
    const fastNode = findNode('map-course-source-fast-batches') as FanOutDefinition<
      CourseSourcePreparationOutcome,
      CourseChunkMappingBatch
    >;
    const [batch] = fastNode.inputs(mappingState());
    if (!batch) throw new Error('Expected one fast mapping batch.');

    await expect(
      runStep('map-course-source-fast-batch', batch, sourceServices(services), 3, 3)
    ).rejects.toBe(defect);
  });
});
