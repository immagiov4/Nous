import type { TransactionSql } from 'postgres';
import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  type CourseGenerationWorkflowConfig,
  type CourseGenerationWorkflowServices,
  createCourseGenerationWorkflow,
} from '../../src/workflows/courseGenerationWorkflow.js';
import {
  type CourseDraftPlanState,
  CourseDraftPlanStateSchema,
  type CoursePersistenceState,
  CoursePersistenceStateSchema,
  type CoursePlanState,
  CoursePlanStateSchema,
  type CoursePreparationState,
  CoursePreparationStateSchema,
} from '../../src/workflows/courseGenerationWorkflowContract.js';
import { createWorkflowRegistry } from '../../src/workflows/definition.js';
import type { EmitDefinition, StepDefinition, WorkflowNode } from '../../src/workflows/types.js';
import { indexWorkflowNodes } from '../../src/workflows/workflowNodeIndex.js';

const config: CourseGenerationWorkflowConfig = {
  maxAttempts: 3,
  models: getGlobalModelConfig(),
  timeoutMs: 10 * 60_000,
};

const plan = {
  applicationExercisePlanningStatus: 'completed' as const,
  modules: [
    {
      children: [
        {
          description: 'Processi, nodi e unità di esecuzione.',
          id: 'lesson-1',
          isCompleted: false,
          kind: 'lesson' as const,
          title: 'Unità di calcolo',
          type: 'core' as const,
        },
      ],
      id: 'module-1',
      title: 'Fondamenti dei sistemi distribuiti',
    },
  ],
  summary: 'Dalle unità di calcolo alla comunicazione distribuita.',
  title: 'Fondamenti dei sistemi distribuiti',
};

const preparationState: CoursePreparationState = CoursePreparationStateSchema.parse({
  context: {
    assessmentSummary: 'Voglio capire i sistemi distribuiti partendo dalle basi.',
    language: 'Italiano',
    profile: null,
    sourceNames: ['distributed-systems.pdf'],
    sources: [
      {
        hash: 'a'.repeat(64),
        id: 'source-1',
        kind: 'pdf',
        mimeType: 'application/pdf',
        name: 'distributed-systems.pdf',
      },
    ],
    topic: 'Sistemi distribuiti',
  },
  projectRevision: 2,
  request: {
    mode: 'document',
    projectId: 'project-1',
    userId: 'user-1',
  },
  stage: 'prepared',
  strategy: 'single-source',
});

const planState: CoursePlanState = CoursePlanStateSchema.parse({
  ...preparationState,
  plan,
  researchCoursePlan: null,
  stage: 'plan',
  syllabus: [],
});

const draftPlanState: CourseDraftPlanState = CourseDraftPlanStateSchema.parse({
  ...planState,
  research: {
    web: { brief: '', sources: [] },
    youtube: { candidates: [], context: '', rationale: '', status: 'completed' },
  },
});

const persistenceState: CoursePersistenceState = CoursePersistenceStateSchema.parse({
  committedCourseFingerprint: 'f'.repeat(64),
  committedRunId: 'run-1',
  persistedAt: '2026-07-30T12:00:00.000Z',
  previous: {
    activeSectionId: null,
    documentIndexJson: null,
    isLearnMode: false,
    lastCourseGenerationRunId: null,
    learningPlanJson: null,
    researchCoursePlanJson: null,
    researchDossiersJson: null,
    state: 'PLANNING',
    syllabusJson: '[]',
    userProfileJson: null,
  },
  result: {
    firstSectionId: 'lesson-1',
    projectId: 'project-1',
    projectRevision: 3,
  },
  stage: 'persistence',
  userId: 'user-1',
});

const makeServices = (
  overrides: Partial<CourseGenerationWorkflowServices> = {}
): CourseGenerationWorkflowServices => ({
  buildCoursePersistence: vi.fn(async () => persistenceState),
  completeCourseSourceFinalization: vi.fn(async ({ input }) => ({
    ...input.state.planState,
    documentIndex: input.state.index,
    stage: 'sources-finalized' as const,
  })),
  draftArchiveCourse: vi.fn(async () => draftPlanState),
  draftSourceCourse: vi.fn(async () => draftPlanState),
  finalizeCourse: vi.fn(async ({ input }) => input.result),
  mapCourseSourceBatch: vi.fn(async ({ input }) => ({
    batchIndex: input.batchIndex,
    mappings: [],
  })),
  planCourseYoutubeQueries: vi.fn(async () => ({ queries: ['first query', 'second query'] })),
  persistCourse: vi.fn(async () => undefined),
  placeApplicationExercises: vi.fn(async ({ input }) => ({
    ...input,
    stage: 'exercises',
  })),
  planLearnCourse: vi.fn(async () => planState),
  planSourceSetCourse: vi.fn(async () => planState),
  prepareCourse: vi.fn(async () => preparationState),
  prepareCourseSourceFinalization: vi.fn(async ({ input }) => ({
    kind: 'ready' as const,
    result: { ...input, documentIndex: null, stage: 'sources-finalized' as const },
  })),
  researchCourseWeb: vi.fn(async () => ({ brief: '', sources: [] })),
  researchCourseYoutubeQuery: vi.fn(async () => ({
    context: '',
    discoveredVideoCount: 0,
    rationale: '',
    videoCandidates: [],
  })),
  refineArchiveCourse: vi.fn(async ({ input }) => CoursePlanStateSchema.parse(input)),
  refineSourceCourse: vi.fn(async ({ input }) => CoursePlanStateSchema.parse(input)),
  undoCourse: vi.fn(async () => undefined),
  ...overrides,
});

const findNode = (id: string): WorkflowNode => {
  const definition = createCourseGenerationWorkflow(config);
  const node = [...indexWorkflowNodes(definition).values()].find(
    entry => entry.node.id === id
  )?.node;
  if (!node) throw new Error(`Missing test workflow node ${id}.`);
  return node;
};

describe('course generation workflow', () => {
  test('registers distinct durable boundaries for every planning strategy', () => {
    const definition = createCourseGenerationWorkflow(config);
    const registered = createWorkflowRegistry().register({ current: definition }).current;
    const nodeIds = [...indexWorkflowNodes(definition).values()].map(entry => entry.node.id);

    expect(registered.id).toBe('course-generation');
    expect(nodeIds).toEqual(
      expect.arrayContaining([
        'prepare-course',
        'gather-course-research',
        'route-course-research',
        'research-course-web',
        'research-course-youtube',
        'plan-course-youtube-queries',
        'research-course-youtube-queries',
        'research-course-youtube-query',
        'finalize-course-youtube-research',
        'route-course-planning',
        'plan-learn-course',
        'draft-source-course',
        'refine-source-course',
        'plan-source-set-course',
        'draft-archive-course',
        'refine-archive-course',
        'finalize-course-sources',
        'prepare-course-source-finalization',
        'route-course-source-finalization',
        'return-course-without-source-mapping',
        'map-course-source-fast-batches',
        'map-course-source-repair-batches',
        'map-course-source-fast-batch',
        'map-course-source-repair-batch',
        'complete-course-source-finalization',
        'place-application-exercises',
        'persist-course',
        'publish-course-project-revision',
      ])
    );
  });

  test('delegates the atomic course commit and its idempotent undo', async () => {
    const persistCourse = vi.fn(async () => undefined);
    const undoCourse = vi.fn(async () => undefined);
    const services = makeServices({ persistCourse, undoCourse });
    const persist = findNode('persist-course') as StepDefinition<
      unknown,
      CoursePersistenceState,
      CourseGenerationWorkflowConfig,
      CourseGenerationWorkflowServices
    >;
    const transaction = {} as TransactionSql;
    const execution = { nodeInstanceId: 'persist-course', runId: 'run-1' };
    const input = { ...planState, documentIndex: null, stage: 'exercises' as const };

    const output = await persist.run({
      attemptNumber: 1,
      config,
      execution,
      idempotencyKey: 'persist-key',
      input,
      retryFeedback: '',
      services,
      signal: new AbortController().signal,
    });
    await persist.commit?.({ config, execution, input, output, services, transaction });
    await persist.undo?.({
      config,
      execution,
      idempotencyKey: 'undo-key',
      input,
      output,
      services,
      signal: new AbortController().signal,
    });

    expect(persistCourse).toHaveBeenCalledWith({ execution, input, output, transaction });
    expect(undoCourse).toHaveBeenCalledWith({
      execution,
      idempotencyKey: 'undo-key',
      input,
      output,
      signal: expect.any(AbortSignal),
    });
  });

  test('publishes the revision only after the persisted result exists', () => {
    const publish = findNode('publish-course-project-revision') as EmitDefinition<
      CoursePersistenceState['result']
    >;
    expect(publish.payload(persistenceState.result)).toEqual({
      projectId: 'project-1',
      revision: 3,
    });
  });
});
