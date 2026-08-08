import { MAX_VISUAL_LESSON_CHARS } from '@shared/lessonGenerationPolicy';
import type { TransactionSql } from 'postgres';
import type * as z from 'zod';
import type { GlobalModelConfig, TextModelSlot } from '../config/modelConfig.js';

import { resolveLessonResearchRequest } from '../services/lessonGenerationModel.js';
import {
  collectLessonVisualPlans,
  toLessonContent,
} from '../services/lessonGenerationNormalization.js';
import {
  type LessonVisualModelConfig,
  LessonVisualModelConfigSchema,
} from '../services/lessonVisualModelConfig.js';
import { WorkflowExecutionDefaultsSchema } from './config.js';
import { emit, fanOut, routeBy, sequence, step, workflow } from './definition.js';
import {
  type LessonAidsState,
  LessonAidsStateSchema,
  type LessonContextState,
  LessonContextStateSchema,
  type LessonCoverageState,
  LessonCoverageStateSchema,
  type LessonDraftState,
  LessonDraftStateSchema,
  type LessonGenerationPreparationOutcome,
  LessonGenerationPreparationOutcomeSchema,
  type LessonGenerationRequest,
  LessonGenerationRequestSchema,
  type LessonGenerationWorkflowInput,
  LessonGenerationWorkflowInputSchema,
  type LessonGenerationWorkflowResult,
  LessonGenerationWorkflowResultSchema,
  type LessonPersistenceState,
  LessonPersistenceStateSchema,
  type LessonResearchState,
  LessonResearchStateSchema,
  type LessonReviewedState,
  LessonReviewedStateSchema,
  type LessonSourcesState,
  LessonSourcesStateSchema,
  type LessonVisualFanOutState,
  LessonVisualFanOutStateSchema,
  type LessonVisualsState,
  LessonVisualsStateSchema,
  type LessonYouTubePlanState,
  LessonYouTubePlanStateSchema,
  type LessonYouTubeSearchState,
  LessonYouTubeSearchStateSchema,
  type LessonYouTubeState,
  LessonYouTubeStateSchema,
  type SublessonPlanState,
  SublessonPlanStateSchema,
  type SublessonReadyState,
  SublessonReadyStateSchema,
} from './lessonGenerationWorkflowContract.js';
import { buildLessonVisualContextFingerprint } from './lessonVisualContext.js';
import {
  createLessonVisualWorkflows,
  type LessonVisualWorkflowServices,
} from './lessonVisualWorkflow.js';
import { GlobalModelConfigSchema } from './modelConfigSchema.js';
import {
  LESSON_PROJECT_REVISION_EVENT,
  PROJECT_REVISION_EVENT_SCHEMA_VERSION,
  ProjectRevisionEventSchema,
} from './projectRevisionNotifications.js';
import { runWorkflowStage } from './retryPolicy.js';
import type {
  DeepReadonly,
  StepExecutionContext,
  StepFailure,
  WorkflowStepExecutionIdentity,
} from './types.js';
import { createWorkflowModelDiagnostic } from './workflowErrorDiagnostics.js';

const LESSON_DOCUMENT_SOURCE_TIMEOUT_MS = 90_000;

export const LessonGenerationWorkflowConfigSchema = WorkflowExecutionDefaultsSchema.extend({
  models: GlobalModelConfigSchema,
  visual: LessonVisualModelConfigSchema,
});

export type LessonGenerationWorkflowConfig = z.infer<
  typeof LessonGenerationWorkflowConfigSchema
> & {
  readonly models: GlobalModelConfig;
  readonly visual: LessonVisualModelConfig;
};

export interface LessonGenerationStageContext<Input> {
  readonly attemptNumber: number;
  readonly config: DeepReadonly<LessonGenerationWorkflowConfig>;
  readonly execution: WorkflowStepExecutionIdentity;
  readonly idempotencyKey: string;
  readonly input: Input;
  readonly previousAttemptFailure?: StepFailure;
  readonly retryFeedback: string;
  readonly signal: AbortSignal;
}

type LessonGenerationStage<Input, Output> = (
  context: LessonGenerationStageContext<Input>
) => Promise<Output>;

export interface LessonGenerationWorkflowServices extends LessonVisualWorkflowServices {
  readonly assessSourceCoverage: LessonGenerationStage<LessonContextState, LessonCoverageState>;
  readonly buildLessonPersistence: LessonGenerationStage<
    LessonVisualsState,
    LessonPersistenceState
  >;
  readonly draftLesson: LessonGenerationStage<LessonResearchState, LessonDraftState>;
  readonly finalizeLesson: LessonGenerationStage<
    LessonPersistenceState,
    LessonGenerationWorkflowResult
  >;
  readonly generateLearningAids: LessonGenerationStage<LessonReviewedState, LessonAidsState>;
  readonly normalizeLesson: LessonGenerationStage<LessonVisualFanOutState, LessonVisualsState>;
  readonly finalizeSublesson: LessonGenerationStage<SublessonPlanState, SublessonReadyState>;
  readonly persistLesson: (input: {
    execution: WorkflowStepExecutionIdentity;
    input: LessonVisualsState;
    output: LessonPersistenceState;
    transaction: TransactionSql;
  }) => Promise<void>;
  readonly persistSublesson: (input: {
    input: SublessonPlanState;
    output: SublessonReadyState;
    transaction: TransactionSql;
  }) => Promise<void>;
  readonly planSublesson: LessonGenerationStage<LessonGenerationWorkflowInput, SublessonPlanState>;
  readonly prepareLesson: LessonGenerationStage<
    LessonGenerationRequest,
    LessonGenerationPreparationOutcome
  >;
  readonly finalizeYouTubeResearch: LessonGenerationStage<
    LessonYouTubeSearchState,
    LessonYouTubeState
  >;
  readonly planYouTubeResearch: LessonGenerationStage<LessonSourcesState, LessonYouTubePlanState>;
  readonly researchFallbackYouTube: LessonGenerationStage<
    LessonYouTubeSearchState,
    LessonYouTubeSearchState
  >;
  readonly researchLesson: LessonGenerationStage<LessonYouTubeState, LessonResearchState>;
  readonly researchSpecificYouTube: LessonGenerationStage<
    LessonYouTubePlanState,
    LessonYouTubeSearchState
  >;
  readonly reviewLesson: LessonGenerationStage<LessonDraftState, LessonReviewedState>;
  readonly stageDocumentSources: LessonGenerationStage<LessonCoverageState, LessonSourcesState>;
  readonly undoLesson: (input: {
    execution: WorkflowStepExecutionIdentity;
    idempotencyKey: string;
    input: LessonVisualsState;
    output: LessonPersistenceState;
    signal: AbortSignal;
  }) => Promise<void>;
  readonly undoSublesson: (input: {
    execution: WorkflowStepExecutionIdentity;
    input: SublessonPlanState;
    output: SublessonReadyState;
    signal: AbortSignal;
  }) => Promise<void>;
}

interface StageFailure<Input> {
  readonly code: string;
  readonly message: string;
  readonly modelSlot?: TextModelSlot | ((input: Input, config: GlobalModelConfig) => TextModelSlot);
}

const runStage = async <Input, Output, Services extends LessonGenerationWorkflowServices>(
  context: StepExecutionContext<Input, LessonGenerationWorkflowConfig, Services>,
  failure: StageFailure<Input>,
  operation: (stage: LessonGenerationStageContext<Input>) => Promise<Output>
): Promise<Output> => {
  const models = context.config.models as GlobalModelConfig;
  const modelSlot =
    typeof failure.modelSlot === 'function'
      ? failure.modelSlot(context.input, models)
      : failure.modelSlot;
  return runWorkflowStage({
    failure: {
      code: failure.code,
      message: failure.message,
      ...(modelSlot
        ? { details: { model: createWorkflowModelDiagnostic(models, modelSlot) } }
        : {}),
    },
    operation: () => operation(context),
    signal: context.signal,
  });
};

const researchModelSlot = (input: LessonYouTubeState, config: GlobalModelConfig): TextModelSlot =>
  resolveLessonResearchRequest({
    config,
    coverageGaps: input.lessonInputData.coverageGaps,
    sourceContext: input.lessonInputData.sourceContext,
  }).slot;

const lessonMarkdown = (state: LessonAidsState): string =>
  toLessonContent(state.draft.contentBlocks);

const visualInputs = (state: LessonAidsState) => {
  const markdown = lessonMarkdown(state);
  const contextFingerprint = buildLessonVisualContextFingerprint({
    lessonMarkdown: markdown,
    sectionDescription: state.lessonInputData.description,
    sectionTitle: state.lessonInputData.sectionTitle,
  });
  return [...collectLessonVisualPlans(state.draft).values()].map(plan => {
    return {
      contextFingerprint,
      lessonMarkdown: markdown.slice(0, MAX_VISUAL_LESSON_CHARS),
      plan,
      projectId: state.request.projectId,
      sectionDescription: state.lessonInputData.description,
      sectionId: state.request.sectionId,
      sectionTitle: state.lessonInputData.sectionTitle,
      userId: state.request.userId,
    };
  });
};

export const createLessonGenerationWorkflow = <
  Config extends LessonGenerationWorkflowConfig = LessonGenerationWorkflowConfig,
  Services extends LessonGenerationWorkflowServices = LessonGenerationWorkflowServices,
>(
  executionDefaults: Config,
  configSchema: z.ZodType<Config> = LessonGenerationWorkflowConfigSchema as z.ZodType<Config>
) => {
  const visualWorkflow = createLessonVisualWorkflows<Config, Services>(
    executionDefaults,
    configSchema
  ).render;

  const useExistingLessonTarget = step<
    typeof LessonGenerationWorkflowInputSchema,
    typeof LessonGenerationRequestSchema,
    Config,
    Services
  >({
    id: 'use-existing-lesson-target',
    inputSchema: LessonGenerationWorkflowInputSchema,
    outputSchema: LessonGenerationRequestSchema,
    run: async ({ input }) => {
      if (input.kind !== 'existing') {
        throw new Error('The existing target route received a sublesson request.');
      }
      return input;
    },
  });

  const planSublesson = step<
    typeof LessonGenerationWorkflowInputSchema,
    typeof SublessonPlanStateSchema,
    Config,
    Services
  >({
    id: 'plan-sublesson',
    inputSchema: LessonGenerationWorkflowInputSchema,
    outputSchema: SublessonPlanStateSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'sublesson_planning_failed',
          message: 'The sublesson metadata could not be planned.',
          modelSlot: 'lesson',
        },
        stage => context.services.planSublesson(stage)
      ),
  });

  const finalizeSublesson = step<
    typeof SublessonPlanStateSchema,
    typeof SublessonReadyStateSchema,
    Config,
    Services
  >({
    commit: ({ input, output, services, transaction }) =>
      services.persistSublesson({ input, output, transaction }),
    id: 'finalize-sublesson',
    inputSchema: SublessonPlanStateSchema,
    outputSchema: SublessonReadyStateSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'sublesson_source_mapping_failed',
          message: 'The sublesson source associations could not be finalized.',
          modelSlot: 'course',
        },
        stage => context.services.finalizeSublesson(stage)
      ),
    undo: ({ execution, input, output, services, signal }) =>
      services.undoSublesson({ execution, input, output, signal }),
  });

  const compactSublessonRequest = step<
    typeof SublessonReadyStateSchema,
    typeof LessonGenerationRequestSchema,
    Config,
    Services
  >({
    id: 'compact-sublesson-request',
    inputSchema: SublessonReadyStateSchema,
    outputSchema: LessonGenerationRequestSchema,
    run: async ({ input }) => input.request,
  });

  const createSublessonTarget = sequence({
    id: 'create-sublesson-target',
    nodes: [planSublesson, finalizeSublesson, compactSublessonRequest] as const,
  });

  const routeLessonTarget = routeBy({
    cases: { existing: useExistingLessonTarget, sublesson: createSublessonTarget },
    id: 'route-lesson-target',
    inputSchema: LessonGenerationWorkflowInputSchema,
    outputSchema: LessonGenerationRequestSchema,
    select: input => input.kind,
  });

  const prepareLesson = step<
    typeof LessonGenerationRequestSchema,
    typeof LessonGenerationPreparationOutcomeSchema,
    Config,
    Services
  >({
    id: 'prepare-lesson',
    inputSchema: LessonGenerationRequestSchema,
    outputSchema: LessonGenerationPreparationOutcomeSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'lesson_preparation_failed',
          message: 'The lesson generation context could not be prepared.',
        },
        stage => context.services.prepareLesson(stage)
      ),
  });

  const returnExistingLesson = step<
    typeof LessonGenerationPreparationOutcomeSchema,
    typeof LessonGenerationWorkflowResultSchema,
    Config,
    Services
  >({
    id: 'return-existing-lesson',
    inputSchema: LessonGenerationPreparationOutcomeSchema,
    outputSchema: LessonGenerationWorkflowResultSchema,
    run: async ({ input }) => {
      if (input.kind !== 'already-completed') {
        throw new Error('The existing-lesson route received a generation context.');
      }
      return input.result;
    },
  });

  const unwrapGenerationContext = step<
    typeof LessonGenerationPreparationOutcomeSchema,
    typeof LessonContextStateSchema,
    Config,
    Services
  >({
    id: 'unwrap-generation-context',
    inputSchema: LessonGenerationPreparationOutcomeSchema,
    outputSchema: LessonContextStateSchema,
    run: async ({ input }) => {
      if (input.kind !== 'generate') {
        throw new Error('The generation route received an existing lesson.');
      }
      return input.state;
    },
  });

  const assessSourceCoverage = step<
    typeof LessonContextStateSchema,
    typeof LessonCoverageStateSchema,
    Config,
    Services
  >({
    id: 'assess-source-coverage',
    inputSchema: LessonContextStateSchema,
    outputSchema: LessonCoverageStateSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'lesson_source_coverage_failed',
          message: 'The lesson source coverage could not be assessed.',
          modelSlot: 'research',
        },
        stage => context.services.assessSourceCoverage(stage)
      ),
  });

  const stageDocumentSources = step<
    typeof LessonCoverageStateSchema,
    typeof LessonSourcesStateSchema,
    Config,
    Services
  >({
    id: 'stage-document-sources',
    inputSchema: LessonCoverageStateSchema,
    outputSchema: LessonSourcesStateSchema,
    timeoutMs: LESSON_DOCUMENT_SOURCE_TIMEOUT_MS,
    run: context =>
      runStage(
        context,
        {
          code: 'lesson_document_sources_failed',
          message: 'The lesson document sources could not be prepared.',
        },
        stage => context.services.stageDocumentSources(stage)
      ),
  });

  const bypassYouTubeResearch = step<
    typeof LessonSourcesStateSchema,
    typeof LessonYouTubeStateSchema,
    Config,
    Services
  >({
    id: 'bypass-youtube-research',
    inputSchema: LessonSourcesStateSchema,
    outputSchema: LessonYouTubeStateSchema,
    run: async ({ input }) => ({
      ...input,
      discoveredYoutubeSources: [],
      research: { context: '', youtube: null },
      stage: 'youtube',
    }),
  });

  const planYouTubeResearch = step<
    typeof LessonSourcesStateSchema,
    typeof LessonYouTubePlanStateSchema,
    Config,
    Services
  >({
    id: 'plan-youtube-research',
    inputSchema: LessonSourcesStateSchema,
    outputSchema: LessonYouTubePlanStateSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'lesson_youtube_research_failed',
          message: 'The optional lesson video research could not be completed.',
        },
        stage => context.services.planYouTubeResearch(stage)
      ),
  });

  const researchSpecificYouTube = step<
    typeof LessonYouTubePlanStateSchema,
    typeof LessonYouTubeSearchStateSchema,
    Config,
    Services
  >({
    id: 'research-specific-youtube',
    inputSchema: LessonYouTubePlanStateSchema,
    outputSchema: LessonYouTubeSearchStateSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'lesson_youtube_research_failed',
          message: 'The optional lesson video research could not be completed.',
        },
        stage => context.services.researchSpecificYouTube(stage)
      ),
  });

  const researchFallbackYouTube = step<
    typeof LessonYouTubeSearchStateSchema,
    typeof LessonYouTubeSearchStateSchema,
    Config,
    Services
  >({
    id: 'research-fallback-youtube',
    inputSchema: LessonYouTubeSearchStateSchema,
    outputSchema: LessonYouTubeSearchStateSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'lesson_youtube_research_failed',
          message: 'The optional lesson video research could not be completed.',
        },
        stage => context.services.researchFallbackYouTube(stage)
      ),
  });

  const finalizeYouTubeResearch = step<
    typeof LessonYouTubeSearchStateSchema,
    typeof LessonYouTubeStateSchema,
    Config,
    Services
  >({
    id: 'finalize-youtube-research',
    inputSchema: LessonYouTubeSearchStateSchema,
    outputSchema: LessonYouTubeStateSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'lesson_youtube_research_failed',
          message: 'The optional lesson video research could not be completed.',
        },
        stage => context.services.finalizeYouTubeResearch(stage)
      ),
  });

  const keepYouTubeSearchResult = step<
    typeof LessonYouTubeSearchStateSchema,
    typeof LessonYouTubeSearchStateSchema,
    Config,
    Services
  >({
    id: 'keep-youtube-search-result',
    inputSchema: LessonYouTubeSearchStateSchema,
    outputSchema: LessonYouTubeSearchStateSchema,
    run: async ({ input }) => input,
  });

  const routeYouTubeFallback = routeBy({
    cases: { fallback: researchFallbackYouTube, finalize: keepYouTubeSearchResult },
    id: 'route-youtube-fallback',
    inputSchema: LessonYouTubeSearchStateSchema,
    outputSchema: LessonYouTubeSearchStateSchema,
    select: input =>
      input.youtubeSearchPlan !== null &&
      input.youtubeSearchOutcome?.discoveredVideoCount === 0 &&
      input.youtubeSearchPlan.fallbackQuery !== input.youtubeSearchPlan.specificQuery
        ? 'fallback'
        : 'finalize',
  });

  const researchYouTube = sequence({
    id: 'research-youtube',
    nodes: [
      planYouTubeResearch,
      researchSpecificYouTube,
      routeYouTubeFallback,
      finalizeYouTubeResearch,
    ] as const,
  });

  const routeYouTubeResearch = routeBy({
    cases: { bypass: bypassYouTubeResearch, research: researchYouTube },
    id: 'route-youtube-research',
    inputSchema: LessonSourcesStateSchema,
    outputSchema: LessonYouTubeStateSchema,
    select: input => (input.existingDossierJson === null ? 'research' : 'bypass'),
  });

  const researchLesson = step<
    typeof LessonYouTubeStateSchema,
    typeof LessonResearchStateSchema,
    Config,
    Services
  >({
    id: 'research-lesson',
    inputSchema: LessonYouTubeStateSchema,
    outputSchema: LessonResearchStateSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'lesson_research_failed',
          message: 'The lesson research could not be completed.',
          modelSlot: researchModelSlot,
        },
        stage => context.services.researchLesson(stage)
      ),
  });

  const draftLesson = step<
    typeof LessonResearchStateSchema,
    typeof LessonDraftStateSchema,
    Config,
    Services
  >({
    id: 'draft-lesson',
    inputSchema: LessonResearchStateSchema,
    outputSchema: LessonDraftStateSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'lesson_draft_failed',
          message: 'The lesson draft could not be generated.',
          modelSlot: 'lesson',
        },
        stage => context.services.draftLesson(stage)
      ),
  });

  const reviewLesson = step<
    typeof LessonDraftStateSchema,
    typeof LessonReviewedStateSchema,
    Config,
    Services
  >({
    id: 'review-lesson',
    inputSchema: LessonDraftStateSchema,
    outputSchema: LessonReviewedStateSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'lesson_review_failed',
          message: 'The lesson draft could not be verified.',
          modelSlot: 'lesson',
        },
        stage => context.services.reviewLesson(stage)
      ),
  });

  const generateLearningAids = step<
    typeof LessonReviewedStateSchema,
    typeof LessonAidsStateSchema,
    Config,
    Services
  >({
    id: 'generate-learning-aids',
    inputSchema: LessonReviewedStateSchema,
    outputSchema: LessonAidsStateSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'lesson_learning_aids_failed',
          message: 'The optional lesson learning aids could not be generated.',
          modelSlot: 'lesson',
        },
        stage => context.services.generateLearningAids(stage)
      ),
  });

  const renderVisuals = fanOut({
    failureMode: 'collect',
    fanIn: (results, parentInput): LessonVisualFanOutState => ({
      lesson: parentInput,
      stage: 'visual-results',
      visualResults: results.map(result =>
        result.status === 'completed'
          ? {
              assetOwners: result.output.assetOwners,
              slotId: result.input.plan.slotId,
              status: 'completed',
              visual: result.output.visual,
            }
          : {
              failure: result.failure,
              slotId: result.input.plan.slotId,
              status: 'failed',
            }
      ),
    }),
    id: 'render-visuals',
    inputSchema: LessonAidsStateSchema,
    inputs: visualInputs,
    itemSchema: visualWorkflow.inputSchema,
    keyBy: input => input.plan.slotId,
    outputSchema: LessonVisualFanOutStateSchema,
    worker: visualWorkflow,
  });

  const normalizeLesson = step<
    typeof LessonVisualFanOutStateSchema,
    typeof LessonVisualsStateSchema,
    Config,
    Services
  >({
    id: 'normalize-lesson',
    inputSchema: LessonVisualFanOutStateSchema,
    outputSchema: LessonVisualsStateSchema,
    run: context =>
      runStage(
        context,
        { code: 'lesson_normalization_failed', message: 'The lesson could not be normalized.' },
        stage => context.services.normalizeLesson(stage)
      ),
  });

  const persistLesson = step<
    typeof LessonVisualsStateSchema,
    typeof LessonPersistenceStateSchema,
    Config,
    Services
  >({
    commit: ({ execution, input, output, services, transaction }) =>
      services.persistLesson({ execution, input, output, transaction }),
    id: 'persist-lesson',
    inputSchema: LessonVisualsStateSchema,
    outputSchema: LessonPersistenceStateSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'lesson_persistence_failed',
          message: 'The lesson could not be prepared for saving.',
        },
        stage => context.services.buildLessonPersistence(stage)
      ),
    undo: ({ execution, idempotencyKey, input, output, services, signal }) =>
      services.undoLesson({ execution, idempotencyKey, input, output, signal }),
  });

  const returnGeneratedLesson = step<
    typeof LessonPersistenceStateSchema,
    typeof LessonGenerationWorkflowResultSchema,
    Config,
    Services
  >({
    id: 'return-generated-lesson',
    inputSchema: LessonPersistenceStateSchema,
    outputSchema: LessonGenerationWorkflowResultSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'lesson_finalization_failed',
          message: 'The saved lesson could not be finalized.',
        },
        stage => context.services.finalizeLesson(stage)
      ),
  });

  const publishProjectRevision = emit({
    event: LESSON_PROJECT_REVISION_EVENT,
    id: 'publish-project-revision',
    inputSchema: LessonGenerationWorkflowResultSchema,
    payload: result =>
      ProjectRevisionEventSchema.parse({
        projectId: result.projectId,
        revision: result.projectRevision,
      }),
  });

  const generateLesson = sequence({
    id: 'generate-lesson',
    nodes: [
      unwrapGenerationContext,
      assessSourceCoverage,
      stageDocumentSources,
      routeYouTubeResearch,
      researchLesson,
      draftLesson,
      reviewLesson,
      generateLearningAids,
      renderVisuals,
      normalizeLesson,
      persistLesson,
      returnGeneratedLesson,
      publishProjectRevision,
    ] as const,
  });

  const routePreparedLesson = routeBy({
    cases: { 'already-completed': returnExistingLesson, generate: generateLesson },
    id: 'route-prepared-lesson',
    inputSchema: LessonGenerationPreparationOutcomeSchema,
    outputSchema: LessonGenerationWorkflowResultSchema,
    select: outcome => outcome.kind,
  });

  return workflow({
    configSchema,
    executionDefaults,
    events: {
      [LESSON_PROJECT_REVISION_EVENT]: {
        durability: 'durable',
        schema: ProjectRevisionEventSchema,
        schemaVersion: PROJECT_REVISION_EVENT_SCHEMA_VERSION,
      },
    },
    id: 'lesson-generation',
    inputSchema: LessonGenerationWorkflowInputSchema,
    outputSchema: LessonGenerationWorkflowResultSchema,
    root: sequence({
      id: 'lesson-generation',
      nodes: [routeLessonTarget, prepareLesson, routePreparedLesson] as const,
    }),
  });
};
