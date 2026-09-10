import type { TransactionSql } from 'postgres';
import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  type CourseGenerationWorkflowConfig,
  type CourseGenerationWorkflowServices,
  createCourseGenerationWorkflow,
  createPreviousControlsCourseGenerationWorkflow,
  createPreviousCourseGenerationWorkflow,
  createPreviousPreferencesCourseGenerationWorkflow,
} from '../../src/workflows/courseGenerationWorkflow.js';
import {
  type CourseDraftPlanState,
  CourseDraftPlanStateSchema,
  type CoursePersistenceState,
  CoursePersistenceStateSchema,
  type CoursePlanState,
  CoursePlanStateSchema,
  type CoursePlanVerificationState,
  CoursePlanVerificationStateSchema,
  type CoursePreparationState,
  CoursePreparationStateSchema,
  type CourseRefinedPlanState,
  CourseRefinedPlanStateSchema,
  type CourseResearchState,
  CourseResearchStateSchema,
} from '../../src/workflows/courseGenerationWorkflowContract.js';
import {
  createWorkflowRegistry,
  preCompatibilityIdAndExternalEffectPrevious,
  preExternalEffectPrevious,
  preProviderPostprocessingPrevious,
} from '../../src/workflows/definition.js';
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

const rawPlan = {
  lessonCountReason: 'Una lezione introduce il nucleo del materiale.',
  modules: [
    {
      description: 'Fondamenti dei sistemi distribuiti',
      lessons: [
        {
          description: 'Processi, nodi e unita di esecuzione.',
          guidingQuestions: ['Come collaborano i nodi?'],
          instructionPacks: [],
          keyConcepts: ['processi', 'nodi'],
          miniLab: null,
          prerequisites: [],
          simplificationRisks: [],
          sourceUrls: [],
          title: 'Unita di calcolo',
          type: 'core' as const,
        },
      ],
      title: 'Fondamenti dei sistemi distribuiti',
      type: 'core' as const,
    },
  ],
  summary: 'Dalle unita di calcolo alla comunicazione distribuita.',
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
  rawDraftPlan: rawPlan,
  research: {
    web: { brief: '', sources: [] },
    youtube: { candidates: [], context: '', rationale: '', status: 'completed' },
  },
  stage: 'plan-draft',
});

const verification = {
  coverage: { feedback: 'Copertura adeguata.', status: 'pass' as const },
  duplication: { feedback: 'Nessuna duplicazione.', status: 'pass' as const },
  fragmentation: {
    canGroupCoherently: false,
    feedback: 'La struttura non e frammentata.',
    moduleIds: [],
  },
  granularity: { feedback: 'Granularita adeguata.', status: 'pass' as const },
  moduleCohesion: { feedback: 'Moduli coesi.', status: 'pass' as const },
  prerequisites: { feedback: 'Prerequisiti coerenti.', status: 'pass' as const },
  progression: { feedback: 'Progressione coerente.', status: 'pass' as const },
  proportionality: { feedback: 'Proporzioni adeguate.', status: 'pass' as const },
  summary: 'Il piano puo essere raffinato senza correzioni strutturali.',
  verdict: 'pass' as const,
};

const verificationState: CoursePlanVerificationState = CoursePlanVerificationStateSchema.parse({
  ...draftPlanState,
  stage: 'plan-verification',
  verification,
});

const refinedPlanState: CourseRefinedPlanState = CourseRefinedPlanStateSchema.parse({
  ...verificationState,
  refinedPlan: {
    plan,
    researchCoursePlan: null,
    syllabus: [],
  },
  refinedVerification: verification,
  rawRefinedPlan: rawPlan,
  stage: 'plan-refined',
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
  draftCoursePlan: vi.fn(async () => draftPlanState),
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
  refineCoursePlan: vi.fn(async () => refinedPlanState),
  undoCourse: vi.fn(async () => undefined),
  verifyCoursePlan: vi.fn(async () => verificationState),
  ...overrides,
});

const findNode = (
  id: string,
  definition = createCourseGenerationWorkflow(config)
): WorkflowNode => {
  const node = [...indexWorkflowNodes(definition).values()].find(
    entry => entry.node.id === id
  )?.node;
  if (!node) throw new Error(`Missing test workflow node ${id}.`);
  return node;
};

describe('course generation workflow', () => {
  test('retains the independently captured pre-controls manifests', () => {
    const previous = createPreviousControlsCourseGenerationWorkflow(config);
    const registration = createWorkflowRegistry().register({
      current: createCourseGenerationWorkflow(config),
      previous: [
        previous,
        preProviderPostprocessingPrevious(previous),
        preExternalEffectPrevious(previous),
      ],
    });
    // Captured from c7c324d before extending the profile schema.
    expect(registration.previousDefinitions.map(definition => definition.definitionHash)).toEqual([
      '452251ed24ff921c1ae469d29dde230330da3fc6925602d7fd518d956b956933',
      'f7057b758c7cb42f8fc5781c3fdd54b108146ee04d50dee9e6445e81c348cc41',
      'c7d422c826d84c2ae08ae729a797d0b7f251707a40e8bc7e7c1f3a93e129c797',
    ]);
  });

  test('retains the main-branch manifests from before account preferences', () => {
    const previous = createPreviousPreferencesCourseGenerationWorkflow(config);
    const registration = createWorkflowRegistry().register({
      current: createCourseGenerationWorkflow(config),
      previous: [
        previous,
        preProviderPostprocessingPrevious(previous),
        preExternalEffectPrevious(previous),
      ],
    });
    // Generated from the unmodified e042482 sources, independently of the compatibility factory.
    expect(registration.previousDefinitions.map(definition => definition.definitionHash)).toEqual([
      '7a7eae555d7000a34417e56eb408bd46ffa59df9ffc90ac54c9031447ec02202',
      '71ff9be9f1879c72a4a195d1a7f46c192158ad139b6f01c20edf8fbc60de448f',
      '8a3cd86a51b085ac89331435cebe6b1f00007213aab0e5bb681f3d0258a0e4d4',
    ]);
  });

  test.each([
    'current',
    'previous',
  ] as const)('preserves the %s profile contract through research, planning and source finalization', async version => {
    const definition =
      version === 'current'
        ? createCourseGenerationWorkflow(config)
        : createPreviousPreferencesCourseGenerationWorkflow(config);
    const profile = {
      context: 'University',
      experienceLevel: 'Beginner',
      goals: 'Understand',
      language: 'Italiano',
      learningStyle: 'Examples',
      topic: 'Systems',
      ...(version === 'current' ? { teachingPreferences: 'One step at a time.' } : {}),
    };
    const prepared = { ...preparationState, context: { ...preparationState.context, profile } };
    const research = findNode('gather-course-research', definition);
    expect(research.inputSchema.parse(prepared)).toMatchObject({ context: { profile } });
    const researched = CourseResearchStateSchema.parse({
      ...prepared,
      research: draftPlanState.research,
      stage: 'research',
    });
    const drafted = { ...draftPlanState, context: prepared.context };
    const draft = findNode('draft-course-plan', definition) as StepDefinition<
      CourseResearchState,
      CourseDraftPlanState,
      CourseGenerationWorkflowConfig,
      CourseGenerationWorkflowServices
    >;
    const services = makeServices({
      draftCoursePlan: vi.fn(async ({ input }) => ({ ...drafted, context: input.context })),
    });
    const context = {
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'draft', runId: 'resumed' },
      idempotencyKey: 'draft',
      input: researched,
      retryFeedback: '',
      services,
      signal: new AbortController().signal,
    };
    const output = draft.outputSchema.parse(await draft.run(context));
    expect(output.context.profile).toEqual(profile);
    expect(services.draftCoursePlan).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ context: prepared.context }) })
    );
    const finalization = findNode(
      'prepare-course-source-finalization',
      definition
    ) as StepDefinition<
      CoursePlanState,
      unknown,
      CourseGenerationWorkflowConfig,
      CourseGenerationWorkflowServices
    >;
    const finalized = finalization.outputSchema.parse(
      await finalization.run({ ...context, input: { ...planState, context: prepared.context } })
    );
    expect(finalized).toMatchObject({ kind: 'ready', result: { context: { profile } } });
  });
  test('routes every strategy through the same durable planning contract', () => {
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
        'draft-course-plan',
        'verify-course-plan',
        'refine-course-plan',
        'validate-course-plan',
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
    const planningContract = nodeIds.filter(id =>
      [
        'draft-course-plan',
        'verify-course-plan',
        'refine-course-plan',
        'validate-course-plan',
      ].includes(id)
    );
    expect(planningContract).toEqual([
      'draft-course-plan',
      'verify-course-plan',
      'refine-course-plan',
      'validate-course-plan',
    ]);
    expect(nodeIds).not.toContain('route-course-planning');
  });

  test('retains the exact previous durable topology and its pre-compatibility bridge', () => {
    const current = createCourseGenerationWorkflow(config);
    const previous = createPreviousCourseGenerationWorkflow(config);
    const registration = createWorkflowRegistry().register({
      current,
      previous: [
        preExternalEffectPrevious(previous),
        preCompatibilityIdAndExternalEffectPrevious(previous),
      ],
    });
    const previousNodeIds = [...indexWorkflowNodes(previous).values()].map(entry => entry.node.id);

    expect(registration.previousDefinitions.map(definition => definition.definitionHash)).toEqual([
      'ba27907a0d985174ad4148847a75651bde963a9d7346598ff51b4274eac37b9b',
      '857fccae0b778311272e590013df93f14871ce03f63097b0fb393e8ec1498345',
    ]);
    expect(previousNodeIds).toEqual(
      expect.arrayContaining([
        'route-course-planning',
        'plan-learn-course',
        'draft-source-course',
        'refine-source-course',
        'plan-source-set-course',
        'draft-archive-course',
        'refine-archive-course',
      ])
    );
    expect(
      previousNodeIds.filter(id =>
        [
          'draft-course-plan',
          'verify-course-plan',
          'refine-course-plan',
          'validate-course-plan',
        ].includes(id)
      )
    ).toEqual([]);
  });

  test('runs a resumed source-set planning node through the shared quality contract', async () => {
    const services = makeServices();
    const previous = createPreviousCourseGenerationWorkflow(config);
    const sourceSetPlanning = findNode('plan-source-set-course', previous) as StepDefinition<
      CourseResearchState,
      CoursePlanState,
      CourseGenerationWorkflowConfig,
      CourseGenerationWorkflowServices
    >;
    const researchState = CourseResearchStateSchema.parse({
      ...draftPlanState,
      stage: 'research',
      strategy: 'source-set',
    });

    const output = await sourceSetPlanning.run({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'plan-source-set-course', runId: 'run-1' },
      idempotencyKey: 'previous-source-set',
      input: researchState,
      retryFeedback: '',
      services,
      signal: new AbortController().signal,
    });

    expect(output.stage).toBe('plan');
    expect(services.draftCoursePlan).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'previous-source-set:draft' })
    );
    expect(services.verifyCoursePlan).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'previous-source-set:verify' })
    );
    expect(services.refineCoursePlan).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'previous-source-set:refine' })
    );
  });

  test('keeps draft, verification and refined outputs on distinct durable nodes', async () => {
    const services = makeServices();
    const draft = findNode('draft-course-plan') as StepDefinition<
      unknown,
      CourseDraftPlanState,
      CourseGenerationWorkflowConfig,
      CourseGenerationWorkflowServices
    >;
    const verify = findNode('verify-course-plan') as StepDefinition<
      CourseDraftPlanState,
      CoursePlanVerificationState,
      CourseGenerationWorkflowConfig,
      CourseGenerationWorkflowServices
    >;
    const refine = findNode('refine-course-plan') as StepDefinition<
      CoursePlanVerificationState,
      CourseRefinedPlanState,
      CourseGenerationWorkflowConfig,
      CourseGenerationWorkflowServices
    >;
    const stageContext = {
      attemptNumber: 1,
      config,
      retryFeedback: '',
      services,
      signal: new AbortController().signal,
    };

    const draftOutput = await draft.run({
      ...stageContext,
      execution: { nodeInstanceId: 'draft-course-plan', runId: 'run-1' },
      idempotencyKey: 'draft-key',
      input: draftPlanState,
    });
    const verificationOutput = await verify.run({
      ...stageContext,
      execution: { nodeInstanceId: 'verify-course-plan', runId: 'run-1' },
      idempotencyKey: 'verify-key',
      input: draftOutput,
    });
    const refinedOutput = await refine.run({
      ...stageContext,
      execution: { nodeInstanceId: 'refine-course-plan', runId: 'run-1' },
      idempotencyKey: 'refine-key',
      input: verificationOutput,
    });

    expect(draftOutput.plan).toEqual(plan);
    expect(draftOutput.rawDraftPlan).toEqual(rawPlan);
    expect(verificationOutput.verification).toEqual(verification);
    expect(refinedOutput.refinedPlan.plan).toEqual(plan);
    expect(refinedOutput.rawRefinedPlan).toEqual(rawPlan);
  });

  test('fails final validation permanently when refined semantic findings remain', async () => {
    const validate = findNode('validate-course-plan') as StepDefinition<
      CourseRefinedPlanState,
      CoursePlanState,
      CourseGenerationWorkflowConfig,
      CourseGenerationWorkflowServices
    >;
    const input = CourseRefinedPlanStateSchema.parse({
      ...refinedPlanState,
      refinedVerification: {
        ...verification,
        granularity: { feedback: 'La struttura resta frammentata.', status: 'needs-refinement' },
        verdict: 'refine',
      },
    });

    await expect(
      validate.run({
        attemptNumber: 1,
        config,
        execution: { nodeInstanceId: 'validate-course-plan', runId: 'run-1' },
        idempotencyKey: 'validate-key',
        input,
        retryFeedback: '',
        services: makeServices(),
        signal: new AbortController().signal,
      })
    ).rejects.toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({
          code: 'course_plan_validation_failed',
          kind: 'permanent',
        }),
      })
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
