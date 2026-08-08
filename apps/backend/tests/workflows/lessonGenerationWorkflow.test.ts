import { MAX_VISUAL_LESSON_CHARS } from '@shared/lessonGenerationPolicy';
import { APICallError } from 'ai';
import type { TransactionSql } from 'postgres';
import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { resolveLessonVisualModelConfig } from '../../src/services/lessonVisualModelConfig.js';
import { createWorkflowRegistry } from '../../src/workflows/definition.js';
import {
  createLessonGenerationWorkflow,
  type LessonGenerationWorkflowConfig,
  type LessonGenerationWorkflowServices,
} from '../../src/workflows/lessonGenerationWorkflow.js';
import {
  type LessonAidsState,
  LessonAidsStateSchema,
  type LessonPersistenceState,
  LessonPersistenceStateSchema,
  type LessonResearchState,
  LessonResearchStateSchema,
  type LessonSourcesState,
  type LessonVisualsState,
  LessonVisualsStateSchema,
  type LessonYouTubeSearchState,
  type SublessonPlanState,
  SublessonPlanStateSchema,
  type SublessonReadyState,
  SublessonReadyStateSchema,
} from '../../src/workflows/lessonGenerationWorkflowContract.js';
import { buildLessonVisualContextFingerprint } from '../../src/workflows/lessonVisualContext.js';
import type {
  LessonVisualWorkflowInput,
  LessonVisualWorkflowResult,
} from '../../src/workflows/lessonVisualWorkflow.js';
import type {
  EmitDefinition,
  FanOutDefinition,
  FanOutResult,
  RouteByDefinition,
  StepDefinition,
  WorkflowNode,
} from '../../src/workflows/types.js';
import { createWorkflowModelDiagnostic } from '../../src/workflows/workflowErrorDiagnostics.js';
import { indexWorkflowNodes } from '../../src/workflows/workflowNodeIndex.js';

const modelConfig = getGlobalModelConfig();
const config: LessonGenerationWorkflowConfig = {
  maxAttempts: 3,
  models: modelConfig,
  timeoutMs: 90_000,
  visual: resolveLessonVisualModelConfig(modelConfig),
};

const visualPlan = {
  altText: 'Tre processi collegati da frecce temporali',
  anchorHeading: 'Relazione happens-before',
  complexity: 'moderate' as const,
  concept: 'Ordine causale degli eventi',
  coverage: 'complete_synthesis' as const,
  coverageRationale: 'Riunisce processi, eventi e messaggi.',
  factualRequirements: ['Le frecce seguono la direzione dei messaggi.'],
  interactionLevel: 'none' as const,
  pedagogicalGoal: 'Rendere visibile l’ordine parziale.',
  reason: 'Il diagramma riduce l’ambiguità del testo.',
  requiresDepiction: false,
  slotId: 'causal-order',
  title: 'Ordine causale',
  visualDirection: 'Diagramma essenziale con tre linee temporali.',
  visualType: 'structural_svg' as const,
};

const aidsState: LessonAidsState = LessonAidsStateSchema.parse({
  discoveredYoutubeSources: [],
  draft: {
    contentBlocks: [
      {
        markdown: '## Relazione happens-before\nLa causalità induce un ordine parziale.',
        type: 'markdown',
      },
      { slotId: visualPlan.slotId, type: 'generated-visual' },
    ],
    generatedVisuals: [visualPlan],
    imageRefs: [],
  },
  documentAssetOwners: [],
  documentSourceHash: null,
  existingDossierJson: null,
  existingSources: [],
  learningAids: [],
  lessonInputData: {
    description: 'Comunicazione a messaggi senza orologio globale.',
    imageCandidates: [],
    instructionPacks: [],
    language: 'Italiano',
    pedagogicalContext: '',
    previousLessonTitles: ['Unità di calcolo'],
    sectionTitle: 'Comunicazioni a messaggi e assenza di orologio globale',
    sourceContext: 'Estratti originali già selezionati per la lezione.',
  },
  lessonSources: [],
  originalSources: [],
  pdfImages: [],
  request: {
    forceRegenerate: true,
    projectId: 'project-1',
    sectionId: 'section-1',
    userId: 'user-1',
  },
  requiresCoverageAssessment: false,
  research: { context: '', summary: null, youtube: null },
  sourceFingerprint: 'd'.repeat(64),
  stage: 'aids',
  targetFingerprint: 'e'.repeat(64),
  warnings: [],
  youtubePlanning: {
    courseTitle: 'Fondamenti dei sistemi distribuiti',
    keyConcepts: ['happens-before'],
  },
});

const planningDecision = {
  initial: { outcome: 'none' as const, plans: [], rationale: 'Nessuna visuale aggiuntiva.' },
  reviewed: { outcome: 'none' as const, plans: [], rationale: 'Nessuna visuale aggiuntiva.' },
  reviewedAt: '2026-07-29T20:00:00.000Z',
};

const visualsState: LessonVisualsState = LessonVisualsStateSchema.parse({
  ...aidsState,
  content: '## Relazione happens-before\nLa causalità induce un ordine parziale.',
  contentBlocks: aidsState.draft.contentBlocks.filter(block => block.type !== 'generated-visual'),
  documentAssets: null,
  generatedVisuals: [],
  imageRefs: [],
  quiz: [],
  stage: 'visuals',
  visualAssetOwners: [],
  visualPlanningDecision: planningDecision,
});

const persistenceState: LessonPersistenceState = LessonPersistenceStateSchema.parse({
  committedTargetFingerprint: 'f'.repeat(64),
  persistedAt: '2026-07-29T20:00:00.000Z',
  previous: {
    documentAssetsJson: null,
    researchDossierJson: null,
    sectionJson: '{}',
  },
  result: {
    content: visualsState.content,
    contentBlocks: visualsState.contentBlocks,
    documentAssets: null,
    generatedVisuals: [],
    imageRefs: [],
    learningAids: [],
    projectId: 'project-1',
    quiz: [],
    researchDossier: {
      sectionId: 'section-1',
      sources: [],
      title: 'Comunicazioni a messaggi e assenza di orologio globale',
    },
    sectionId: 'section-1',
    visualPlanningDecision: planningDecision,
    warnings: [],
  },
  stage: 'persistence',
  userId: 'user-1',
});

const sublessonPlanState: SublessonPlanState = SublessonPlanStateSchema.parse({
  parentSectionId: 'section-1',
  previousActiveSectionId: 'section-1',
  projectRevision: 4,
  request: {
    forceRegenerate: false,
    projectId: 'project-1',
    sectionId: 'sublesson-1',
    userId: 'user-1',
  },
  section: {
    contextPrompt: 'Approfondisci l’assenza di un orologio globale.',
    description: 'Relazioni causali senza tempo globale.',
    id: 'sublesson-1',
    instructionPacks: ['technical-sources'],
    isCompleted: false,
    kind: 'lesson',
    parentId: 'section-1',
    title: 'Ordine causale senza orologio globale',
    type: 'deep-dive',
  },
  stage: 'sublesson-plan',
});

const sublessonReadyState: SublessonReadyState = SublessonReadyStateSchema.parse({
  ...sublessonPlanState,
  createdDocumentIndex: null,
  stage: 'sublesson-ready',
});

const makeServices = (
  overrides: Partial<LessonGenerationWorkflowServices> = {}
): LessonGenerationWorkflowServices => ({
  assessSourceCoverage: vi.fn(async ({ input }) => ({ ...input, stage: 'coverage' })),
  assets: { stage: vi.fn(async () => Promise.reject(new Error('not used'))) },
  buildLessonPersistence: vi.fn(async () => persistenceState),
  draftLesson: vi.fn(async () => Promise.reject(new Error('not used'))),
  finalizeLesson: vi.fn(async ({ input }) => input.result),
  generateLearningAids: vi.fn(async ({ input }) => ({
    ...input,
    learningAids: [],
    stage: 'aids',
  })),
  generateArtifact: vi.fn(async () => ({
    code: '<svg></svg>',
    imageRequests: [],
    kind: 'svg' as const,
  })),
  generateEmbeddedImage: vi.fn(async () => Promise.reject(new Error('not used'))),
  generateRaster: vi.fn(async () => Promise.reject(new Error('not used'))),
  normalizeLesson: vi.fn(async () => visualsState),
  now: () => '2026-07-29T20:00:00.000Z',
  persistLesson: vi.fn(async () => undefined),
  persistSublesson: vi.fn(async () => undefined),
  planSublesson: vi.fn(async () => sublessonPlanState),
  persistRetryResult: vi.fn(async () => undefined),
  prepareLesson: vi.fn(async () => Promise.reject(new Error('not used'))),
  reviseArtifact: vi.fn(async ({ visual }) => visual),
  researchLesson: vi.fn(async () => Promise.reject(new Error('not used'))),
  finalizeYouTubeResearch: vi.fn(async () => Promise.reject(new Error('not used'))),
  planYouTubeResearch: vi.fn(async () => Promise.reject(new Error('not used'))),
  researchFallbackYouTube: vi.fn(async () => Promise.reject(new Error('not used'))),
  researchSpecificYouTube: vi.fn(async () => Promise.reject(new Error('not used'))),
  reviewLesson: vi.fn(async () => Promise.reject(new Error('not used'))),
  stageDocumentSources: vi.fn(async () => Promise.reject(new Error('not used'))),
  finalizeSublesson: vi.fn(async () => sublessonReadyState),
  undoLesson: vi.fn(async () => undefined),
  undoSublesson: vi.fn(async () => undefined),
  undoRetryResult: vi.fn(async () => undefined),
  ...overrides,
});

const findNode = (id: string): WorkflowNode => {
  const definition = createLessonGenerationWorkflow(config);
  const node = [...indexWorkflowNodes(definition).values()].find(
    entry => entry.node.id === id
  )?.node;
  if (!node) throw new Error(`Missing test workflow node ${id}.`);
  return node;
};

describe('lesson generation workflow', () => {
  test('registers the real resumable lesson stages and nested visual renderer', () => {
    const definition = createLessonGenerationWorkflow(config);
    const registered = createWorkflowRegistry().register({ current: definition }).current;
    const nodeIds = [...indexWorkflowNodes(definition).values()].map(entry => entry.node.id);

    expect(registered.id).toBe('lesson-generation');
    expect(nodeIds).toEqual(
      expect.arrayContaining([
        'prepare-lesson',
        'plan-sublesson',
        'finalize-sublesson',
        'compact-sublesson-request',
        'assess-source-coverage',
        'stage-document-sources',
        'route-youtube-research',
        'bypass-youtube-research',
        'plan-youtube-research',
        'research-specific-youtube',
        'route-youtube-fallback',
        'research-fallback-youtube',
        'finalize-youtube-research',
        'research-lesson',
        'draft-lesson',
        'review-lesson',
        'generate-learning-aids',
        'render-visuals',
        'render-lesson-visual',
        'normalize-lesson',
        'persist-lesson',
        'publish-project-revision',
      ])
    );
  });

  test('routes YouTube bypass and fallback from durable state only', () => {
    const researchRoute = findNode('route-youtube-research') as RouteByDefinition<
      LessonSourcesState,
      unknown,
      LessonGenerationWorkflowConfig,
      LessonGenerationWorkflowServices
    >;
    const fallbackRoute = findNode('route-youtube-fallback') as RouteByDefinition<
      LessonYouTubeSearchState,
      unknown,
      LessonGenerationWorkflowConfig,
      LessonGenerationWorkflowServices
    >;
    const searchState = {
      youtubeSearchOutcome: { discoveredVideoCount: 0 },
      youtubeSearchPlan: { fallbackQuery: 'generale', specificQuery: 'specifica' },
    } as LessonYouTubeSearchState;

    expect(
      researchRoute.select({
        existingDossierJson: '{"factualSummary":"saved"}',
      } as LessonSourcesState)
    ).toBe('bypass');
    expect(researchRoute.select({ existingDossierJson: null } as LessonSourcesState)).toBe(
      'research'
    );
    expect(fallbackRoute.select(searchState)).toBe('fallback');
    expect(
      fallbackRoute.select({
        ...searchState,
        youtubeSearchPlan: { fallbackQuery: 'specifica', specificQuery: 'specifica' },
      })
    ).toBe('finalize');
    expect(
      fallbackRoute.select({
        ...searchState,
        youtubeSearchOutcome: { discoveredVideoCount: 1 },
      })
    ).toBe('finalize');
  });

  test('commits a planned sublesson before compacting into the unchanged lesson pipeline', async () => {
    const persistSublesson = vi.fn(async () => undefined);
    const undoSublesson = vi.fn(async () => undefined);
    const services = makeServices({ persistSublesson, undoSublesson });
    const finalize = findNode('finalize-sublesson') as StepDefinition<
      SublessonPlanState,
      SublessonReadyState,
      LessonGenerationWorkflowConfig,
      LessonGenerationWorkflowServices
    >;
    const compact = findNode('compact-sublesson-request') as StepDefinition<
      SublessonReadyState,
      unknown,
      LessonGenerationWorkflowConfig,
      LessonGenerationWorkflowServices
    >;
    const execution = { nodeInstanceId: 'finalize-sublesson', runId: 'run-1' };
    const transaction = {} as TransactionSql;

    const output = await finalize.run({
      attemptNumber: 1,
      config,
      execution,
      idempotencyKey: 'sublesson-key',
      input: sublessonPlanState,
      retryFeedback: '',
      services,
      signal: new AbortController().signal,
    });
    await finalize.commit?.({
      config,
      execution,
      input: sublessonPlanState,
      output,
      services,
      transaction,
    });
    await finalize.undo?.({
      config,
      execution,
      idempotencyKey: 'undo-sublesson-key',
      input: sublessonPlanState,
      output,
      services,
      signal: new AbortController().signal,
    });
    const request = await compact.run({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'compact-sublesson-request', runId: 'run-1' },
      idempotencyKey: 'compact-key',
      input: output,
      retryFeedback: '',
      services,
      signal: new AbortController().signal,
    });

    expect(output).toEqual(sublessonReadyState);
    expect(persistSublesson).toHaveBeenCalledWith({
      input: sublessonPlanState,
      output: sublessonReadyState,
      transaction,
    });
    expect(undoSublesson).toHaveBeenCalledWith({
      execution,
      input: sublessonPlanState,
      output: sublessonReadyState,
      signal: expect.any(AbortSignal),
    });
    expect(request).toEqual(sublessonReadyState.request);
  });

  test('maps an unexpected provider error to a stable stage failure without persisting its message', async () => {
    const draftStep = findNode('draft-lesson') as StepDefinition<
      LessonResearchState,
      unknown,
      LessonGenerationWorkflowConfig,
      LessonGenerationWorkflowServices
    >;
    const researchState = LessonResearchStateSchema.parse({
      discoveredYoutubeSources: [],
      documentAssetOwners: [],
      documentSourceHash: null,
      existingDossierJson: null,
      existingSources: [],
      lessonInputData: {
        description: aidsState.lessonInputData.description,
        imageCandidates: [],
        instructionPacks: [],
        language: 'Italiano',
        pedagogicalContext: '',
        previousLessonTitles: ['Unità di calcolo'],
        sectionTitle: aidsState.lessonInputData.sectionTitle,
        sourceContext: 'Estratti originali già selezionati per la lezione.',
      },
      lessonSources: [],
      originalSources: [],
      pdfImages: [],
      request: aidsState.request,
      requiresCoverageAssessment: false,
      research: { context: '', summary: null, youtube: null },
      sourceFingerprint: aidsState.sourceFingerprint,
      stage: 'research',
      targetFingerprint: aidsState.targetFingerprint,
      warnings: [],
      youtubePlanning: {
        courseTitle: 'Fondamenti dei sistemi distribuiti',
        keyConcepts: ['happens-before'],
      },
    });
    const services = makeServices({
      draftLesson: vi.fn(async () => {
        const providerError = new APICallError({
          data: {
            error: {
              code: 400,
              message: 'must-not-be-checkpointed',
              metadata: {
                error_type: 'invalid_request',
                provider_code: 'reasoning_required',
              },
              param: 'reasoning',
            },
          },
          message: 'must-not-be-checkpointed',
          requestBodyValues: { prompt: 'must-not-be-checkpointed' },
          responseBody: 'response=must-not-be-checkpointed',
          responseHeaders: { 'retry-after': '17' },
          statusCode: 400,
          url: 'https://openrouter.ai/api/v1/chat/completions',
        });
        throw Object.assign(new Error('token=must-not-be-checkpointed', { cause: providerError }), {
          code: 'lesson_provider_failed',
          name: 'ProviderTransientError',
        });
      }),
    });

    const failure = await draftStep
      .run({
        attemptNumber: 1,
        config,
        execution: { nodeInstanceId: 'draft-lesson', runId: 'run-1' },
        idempotencyKey: 'draft-key',
        input: researchState,
        retryFeedback: '',
        services,
        signal: new AbortController().signal,
      })
      .catch(error => error);

    expect(failure.failure).toEqual({
      code: 'lesson_draft_failed',
      details: {
        diagnostic: {
          cause: {
            code: 400,
            message: 'Provider error: invalid_request.',
            parameter: 'reasoning',
            providerCode: 'reasoning_required',
            providerErrorType: 'invalid_request',
            status: 400,
            type: 'AI_APICallError',
          },
          code: 'lesson_provider_failed',
          message: 'The lesson draft could not be generated.',
          type: 'ProviderTransientError',
        },
        model: createWorkflowModelDiagnostic(modelConfig, 'lesson'),
      },
      kind: 'operational',
      message: 'The lesson draft could not be generated.',
      retryAfterMs: 17_000,
    });
    expect(JSON.stringify(failure)).not.toContain('must-not-be-checkpointed');
  });

  test('fans out minimal visual inputs and returns failures beside the unchanged lesson state', () => {
    const visualFanOut = findNode('render-visuals') as FanOutDefinition<
      LessonAidsState,
      LessonVisualWorkflowInput,
      LessonVisualWorkflowResult,
      unknown,
      LessonGenerationWorkflowConfig,
      LessonGenerationWorkflowServices
    >;
    const visualInputs = visualFanOut.inputs(aidsState);
    const failure = {
      code: 'lesson_visual_generation_incomplete',
      kind: 'operational' as const,
      message: 'The lesson visual could not be completed.',
    };
    const visualInput = visualInputs[0];
    if (!visualInput) throw new Error('The visual fan-out did not produce its declared input.');
    const results: readonly FanOutResult<(typeof visualInputs)[number], unknown>[] = [
      { failure, input: visualInput, key: visualPlan.slotId, status: 'failed' },
    ];
    const combined = visualFanOut.fanIn(results, aidsState);

    expect(visualInputs).toHaveLength(1);
    expect(visualInputs[0]).toMatchObject({
      contextFingerprint: buildLessonVisualContextFingerprint({
        lessonMarkdown: '## Relazione happens-before\nLa causalità induce un ordine parziale.',
        sectionDescription: aidsState.lessonInputData.description,
        sectionTitle: aidsState.lessonInputData.sectionTitle,
      }),
      plan: visualPlan,
      projectId: 'project-1',
      sectionId: 'section-1',
      userId: 'user-1',
    });
    expect(visualInputs[0]).not.toHaveProperty('lessonSources');
    expect(combined).toEqual({
      lesson: aidsState,
      stage: 'visual-results',
      visualResults: [{ failure, slotId: visualPlan.slotId, status: 'failed' }],
    });

    const fullMarkdown = 'contenuto esteso '.repeat(MAX_VISUAL_LESSON_CHARS);
    const longLessonState = LessonAidsStateSchema.parse({
      ...aidsState,
      draft: {
        ...aidsState.draft,
        contentBlocks: [
          { markdown: fullMarkdown, type: 'markdown' },
          { slotId: visualPlan.slotId, type: 'generated-visual' },
        ],
      },
    });
    const [boundedInput] = visualFanOut.inputs(longLessonState);

    expect(boundedInput?.lessonMarkdown).toHaveLength(MAX_VISUAL_LESSON_CHARS);
    expect(boundedInput?.contextFingerprint).toBe(
      buildLessonVisualContextFingerprint({
        lessonMarkdown: fullMarkdown.trim(),
        sectionDescription: longLessonState.lessonInputData.description,
        sectionTitle: longLessonState.lessonInputData.sectionTitle,
      })
    );

    const filteredState = LessonAidsStateSchema.parse({
      ...aidsState,
      draft: {
        ...aidsState.draft,
        contentBlocks: [
          { markdown: 'Testo', type: 'markdown' },
          { slotId: visualPlan.slotId, type: 'generated-visual' },
          { slotId: 'repeated-block', type: 'generated-visual' },
          { slotId: 'repeated-block', type: 'generated-visual' },
        ],
        generatedVisuals: [
          visualPlan,
          { ...visualPlan, title: 'Duplicato ignorato' },
          { ...visualPlan, slotId: 'orphan-plan' },
          { ...visualPlan, slotId: 'repeated-block' },
        ],
      },
    });

    expect(visualFanOut.inputs(filteredState).map(input => input.plan.slotId)).toEqual([
      visualPlan.slotId,
    ]);
  });

  test('routes depiction plans to the raster renderer before fan-out', () => {
    const visualFanOut = findNode('render-visuals') as FanOutDefinition<
      LessonAidsState,
      LessonVisualWorkflowInput,
      LessonVisualWorkflowResult,
      unknown,
      LessonGenerationWorkflowConfig,
      LessonGenerationWorkflowServices
    >;
    const depictionState = LessonAidsStateSchema.parse({
      ...aidsState,
      draft: {
        ...aidsState.draft,
        generatedVisuals: [
          { ...visualPlan, requiresDepiction: true, visualType: 'structural_svg' },
        ],
      },
    });

    expect(visualFanOut.inputs(depictionState)[0]?.plan).toMatchObject({
      requiresDepiction: true,
      visualType: 'illustrative_image',
    });
  });

  test('delegates the atomic lesson commit and its idempotent undo', async () => {
    const persistLesson = vi.fn(async () => undefined);
    const undoLesson = vi.fn(async () => undefined);
    const services = makeServices({ persistLesson, undoLesson });
    const persistStep = findNode('persist-lesson') as StepDefinition<
      LessonVisualsState,
      LessonPersistenceState,
      LessonGenerationWorkflowConfig,
      LessonGenerationWorkflowServices
    >;
    const execution = { nodeInstanceId: 'persist-lesson', runId: 'run-1' };
    const transaction = {} as TransactionSql;

    const output = await persistStep.run({
      attemptNumber: 1,
      config,
      execution,
      idempotencyKey: 'persist-key',
      input: visualsState,
      retryFeedback: '',
      services,
      signal: new AbortController().signal,
    });
    await persistStep.commit?.({
      config,
      execution,
      input: visualsState,
      output,
      services,
      transaction,
    });
    await persistStep.undo?.({
      config,
      execution,
      idempotencyKey: 'undo-key',
      input: visualsState,
      output,
      services,
      signal: new AbortController().signal,
    });

    expect(output).toEqual(persistenceState);
    expect(persistLesson).toHaveBeenCalledWith({
      execution,
      input: visualsState,
      output: persistenceState,
      transaction,
    });
    expect(undoLesson).toHaveBeenCalledWith({
      execution,
      idempotencyKey: 'undo-key',
      input: visualsState,
      output: persistenceState,
      signal: expect.any(AbortSignal),
    });
  });

  test('finalizes the public result and publishes its revision', async () => {
    const finalResult = { ...persistenceState.result, projectRevision: 4 };
    const finalizeLesson = vi.fn(async () => finalResult);
    const services = makeServices({ finalizeLesson });
    const returnStep = findNode('return-generated-lesson') as StepDefinition<
      LessonPersistenceState,
      typeof finalResult,
      LessonGenerationWorkflowConfig,
      LessonGenerationWorkflowServices
    >;
    const execution = { nodeInstanceId: 'return-generated-lesson', runId: 'run-1' };

    const output = await returnStep.run({
      attemptNumber: 1,
      config,
      execution,
      idempotencyKey: 'finalize-key',
      input: persistenceState,
      retryFeedback: '',
      services,
      signal: new AbortController().signal,
    });
    expect(output).toEqual(finalResult);
    expect(finalizeLesson).toHaveBeenCalledWith(
      expect.objectContaining({ execution, input: persistenceState })
    );
    const publishRevision = findNode('publish-project-revision') as EmitDefinition<
      typeof finalResult
    >;
    expect(publishRevision.payload(output)).toEqual({
      projectId: 'project-1',
      revision: 4,
    });
  });
});
