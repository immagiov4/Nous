import { randomUUID } from 'node:crypto';
import {
  createLessonPlaybackBlockSchema,
  HistoricalLessonSceneSchemas,
  LessonSceneSchema,
} from '@shared/lessonPlaybackSchema';
import { readCurrentAccountPreferences } from '../../account/accountStore.js';
import {
  getGlobalModelConfig,
  getResolvedGlobalModelConfig,
  getResolvedModelConfigForProvider,
} from '../../config/modelConfig.js';
import type { ProjectAssetObjectStorage } from '../../projects/projectAsset.js';
import {
  type ProjectAssetReader,
  unavailableProjectAssetReader,
} from '../../projects/projectAssetReader.js';
import { getProjectStore } from '../../projects/projectStore.js';
import {
  type LessonVisualModelConfig,
  resolveLessonVisualModelConfig,
} from '../../services/lessonVisualModelConfig.js';
import {
  type ArtifactDraftApi,
  createArtifactDraftApi,
  unavailableArtifactDraftApi,
} from '../artifactDraftApi.js';
import { createArtifactDraftWorkflow } from '../artifactDraftWorkflow.js';
import { WorkflowExecutionDefaultsSchema } from '../config.js';
import {
  type CourseGenerationApi,
  createCourseGenerationApi,
  unavailableCourseGenerationApi,
} from '../courseGenerationApi.js';
import { createProductionCourseGenerationServices } from '../courseGenerationProduction.js';
import { createCourseGenerationStarter } from '../courseGenerationStart.js';
import {
  COURSE_GENERATION_WORKFLOW_ID,
  createCourseGenerationWorkflow,
  createPreviousControlsCourseGenerationWorkflow,
  createPreviousCourseGenerationWorkflow,
  createPreviousDiagnosticCourseGenerationWorkflow,
  createPreviousPreferencesCourseGenerationWorkflow,
  createPreviousRoutingCourseGenerationWorkflow,
  createPreviousVerificationCriteriaCourseGenerationWorkflow,
} from '../courseGenerationWorkflow.js';
import {
  courseGenerationStateSchemas,
  preControlsCourseGenerationStateSchemas,
  preDiagnosticCourseGenerationStateSchemas,
  previousCourseGenerationStateSchemas,
} from '../courseGenerationWorkflowContract.js';
import {
  type CourseInterviewApi,
  createCourseInterviewApi,
  projectCourseInterviewEvents,
  unavailableCourseInterviewApi,
} from '../courseInterviewApi.js';
import { createProductionCourseInterviewServices } from '../courseInterviewProduction.js';
import { createCourseInterviewStarter } from '../courseInterviewStart.js';
import {
  COURSE_INTERVIEW_WORKFLOW_ID,
  CourseInterviewWorkflowConfigSchema,
  createCourseInterviewWorkflow,
} from '../courseInterviewWorkflow.js';
import {
  createWorkflowRegistry,
  preCompatibilityIdAndExternalEffectPrevious,
  preExternalEffectPrevious,
  preProviderPostprocessingPrevious,
  type WorkflowRegistry,
} from '../definition.js';
import {
  createPreOpenAiRemovalModelConfig,
  PreOpenAiRemovalGlobalModelConfigSchema,
  PreOpenAiRemovalLessonVisualModelConfigSchema,
} from '../historicalModelConfigSchema.js';
import {
  createLessonGenerationApi,
  type LessonGenerationApi,
  unavailableLessonGenerationApi,
} from '../lessonGenerationApi.js';
import { createProductionLessonGenerationServices } from '../lessonGenerationProduction.js';
import {
  createLessonGenerationStarter,
  LESSON_GENERATION_WORKFLOW_ID,
} from '../lessonGenerationStart.js';
import {
  createLessonGenerationWorkflow,
  createPreviousEvidenceLessonGenerationWorkflow,
  createPreviousLessonGenerationWorkflow,
  createPreviousPreSceneLessonGenerationWorkflow,
  createPreviousQuizExplanationLessonGenerationWorkflow,
  createPreviousResearchContractLessonGenerationWorkflow,
  createPreviousRoutingLessonGenerationWorkflow,
} from '../lessonGenerationWorkflow.js';
import { createSceneLessonGenerationDurableSchemaSet } from '../lessonGenerationWorkflowContract.js';
import {
  createSceneLessonVisualContractSchemas,
  LegacyLessonVisualContractSchemas,
} from '../lessonGenerationWorkflowSchemas.js';
import {
  createLessonPlaybackApi,
  type LessonPlaybackApi,
  unavailableLessonPlaybackApi,
} from '../lessonPlaybackApi.js';
import { createProductionLessonPlaybackServices } from '../lessonPlaybackProduction.js';
import {
  createLessonPlaybackWorkflow,
  LESSON_PLAYBACK_WORKFLOW_ID,
} from '../lessonPlaybackWorkflow.js';
import {
  createLessonVisualRetryStarter,
  type LessonVisualRetryStarter,
  unavailableLessonVisualRetryStarter,
} from '../lessonVisualRetryStart.js';
import {
  createLessonVisualWorkflows,
  LESSON_VISUAL_RETRY_WORKFLOW_ID,
} from '../lessonVisualWorkflow.js';
import {
  createPdfMappingRepairApi,
  createPdfMappingRepairStarter,
  type PdfMappingRepairApi,
  unavailablePdfMappingRepairApi,
} from '../pdfMappingRepairApi.js';
import {
  createPdfMappingRepairWorkflow,
  createProductionPdfMappingRepairServices,
  PDF_MAPPING_REPAIR_WORKFLOW_ID,
  PREVIOUS_PDF_MAPPING_REPAIR_COMPATIBILITY_ID,
} from '../pdfMappingRepairWorkflow.js';
import { PostgresWorkflowStore } from '../persistence/postgresWorkflowStore.js';
import type { PostgresWorkflowOutboxStore } from '../postgresWorkflowOutboxStore.js';
import {
  COURSE_PROJECT_REVISION_EVENT,
  courseProjectRevisionEventProjector,
  createProjectRevisionNotificationDelivery,
  LESSON_PROJECT_REVISION_EVENT,
  lessonProjectRevisionEventProjector,
  type ProjectRevisionNotificationReceiver,
} from '../projectRevisionNotifications.js';
import {
  createProductionRecordingAlignmentServices,
  createRecordingAlignmentStarter,
  createRecordingAlignmentWorkflow,
  RECORDING_ALIGNMENT_WORKFLOW_ID,
} from '../recordingAlignment.js';
import { schemasMatch } from '../schemaFingerprint.js';
import { reconcileUnavailableWorkflowDefinitions } from '../workflowDefinitionReconciler.js';
import {
  publishWorkflowTransientEvent,
  type WorkflowTransientEventPublisher,
} from '../workflowObservability.js';
import {
  createWorkflowRuntimeApi,
  type WorkflowPublishedEventProjector,
  type WorkflowRuntimeApi,
  type WorkflowRuntimeApiStore,
} from './workflowRuntimeApi.js';
import { createWorkflowRuntimeWorker } from './workflowRuntimeWorker.js';

const VISUAL_WORKFLOW_MAX_ATTEMPTS = 3;
const VISUAL_WORKFLOW_TIMEOUT_MS = 10 * 60_000;
const GENERATION_WORKFLOW_MAX_ATTEMPTS = 3;
const GENERATION_WORKFLOW_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_WORKFLOW_POLL_INTERVAL_MS = 1_000;
const DEFAULT_WORKFLOW_STEP_CONCURRENCY = 4;
// Safety fuse, not a product target. Tune from real interview traces.
const COURSE_INTERVIEW_MAX_ITERATIONS = 12;
// Increment whenever a current registered contract changes; freeze its manifest in tests.
export const WORKFLOW_SET_VERSION = 4;

const createPublishedEventProjectors = (
  overrides?: ReadonlyMap<string, WorkflowPublishedEventProjector>
): ReadonlyMap<string, WorkflowPublishedEventProjector> =>
  new Map([
    [COURSE_INTERVIEW_WORKFLOW_ID, projectCourseInterviewEvents],
    [COURSE_GENERATION_WORKFLOW_ID, courseProjectRevisionEventProjector],
    [PDF_MAPPING_REPAIR_WORKFLOW_ID, courseProjectRevisionEventProjector],
    [LESSON_GENERATION_WORKFLOW_ID, lessonProjectRevisionEventProjector],
    [LESSON_VISUAL_RETRY_WORKFLOW_ID, lessonProjectRevisionEventProjector],
    [LESSON_PLAYBACK_WORKFLOW_ID, lessonProjectRevisionEventProjector],
    [RECORDING_ALIGNMENT_WORKFLOW_ID, lessonProjectRevisionEventProjector],
    ...(overrides ?? []),
  ]);

export const createRuntimeProjectRevisionNotificationDelivery = (
  receiveNotification: ProjectRevisionNotificationReceiver
) =>
  createProjectRevisionNotificationDelivery({
    eventTypes: new Set([COURSE_PROJECT_REVISION_EVENT, LESSON_PROJECT_REVISION_EVENT]),
    receiveNotification,
  });

export interface WorkflowRuntimeCompositionStore extends WorkflowRuntimeApiStore {
  readonly outbox: Pick<PostgresWorkflowOutboxStore, 'listDeadLetters' | 'retryDeadLetter'>;
  readonly projectAssets?: ProjectAssetReader;
  close(): Promise<void>;
}

export interface WorkflowRuntimeLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface WorkflowRuntimeComposition {
  readonly api: WorkflowRuntimeApi;
  readonly artifactDraftApi: ArtifactDraftApi;
  readonly courseGenerationApi: CourseGenerationApi;
  readonly courseInterviewApi: CourseInterviewApi;
  readonly lessonGenerationApi: LessonGenerationApi;
  readonly lessonPlaybackApi: LessonPlaybackApi;
  readonly lessonVisualRetryStarter: LessonVisualRetryStarter;
  readonly pdfMappingRepairApi: PdfMappingRepairApi;
  readonly projectAssetReader: ProjectAssetReader;
  readonly workflowOutboxAdmin: Pick<
    PostgresWorkflowOutboxStore,
    'listDeadLetters' | 'retryDeadLetter'
  >;
  close(): Promise<void>;
  start(): Promise<void>;
}

export interface CreateWorkflowRuntimeCompositionOptions {
  readonly artifactDraftApi?: ArtifactDraftApi;
  readonly courseGenerationApi?: CourseGenerationApi;
  readonly courseInterviewApi?: CourseInterviewApi;
  readonly lessonGenerationApi?: LessonGenerationApi;
  readonly resolveLessonModels?: Parameters<
    typeof createLessonGenerationStarter
  >[0]['resolveModels'];
  readonly lessonPlaybackApi?: LessonPlaybackApi;
  readonly lessonVisualRetryStarter?: LessonVisualRetryStarter;
  readonly pdfMappingRepairApi?: PdfMappingRepairApi;
  readonly projectAssetReader?: ProjectAssetReader;
  readonly publishedEventProjectors?: ReadonlyMap<string, WorkflowPublishedEventProjector>;
  readonly publishTransientEvent?: WorkflowTransientEventPublisher;
  readonly projectAssetStorage?: ProjectAssetObjectStorage;
  readonly registry?: WorkflowRegistry;
  readonly store?: WorkflowRuntimeCompositionStore;
  readonly worker?: WorkflowRuntimeLifecycle;
}

export const createProductionRegistry = (sceneSchema = LessonSceneSchema): WorkflowRegistry => {
  const registry = createWorkflowRegistry();
  const models = getGlobalModelConfig();
  const visual = resolveLessonVisualModelConfig(models);
  const visualExecutionDefaults = {
    maxAttempts: VISUAL_WORKFLOW_MAX_ATTEMPTS,
    timeoutMs: VISUAL_WORKFLOW_TIMEOUT_MS,
    visual,
  };
  const historicalModels = createPreOpenAiRemovalModelConfig(models);
  const historicalModelConfigSchema = WorkflowExecutionDefaultsSchema.extend({
    models: PreOpenAiRemovalGlobalModelConfigSchema,
  });
  const historicalVisualConfigSchema = WorkflowExecutionDefaultsSchema.extend({
    visual: PreOpenAiRemovalLessonVisualModelConfigSchema,
  });
  const historicalLessonConfigSchema = historicalModelConfigSchema.extend({
    visual: PreOpenAiRemovalLessonVisualModelConfigSchema,
  });
  const historicalGenerationDefaults = {
    maxAttempts: GENERATION_WORKFLOW_MAX_ATTEMPTS,
    models: historicalModels,
    timeoutMs: GENERATION_WORKFLOW_TIMEOUT_MS,
    visual,
  };
  // Each catalog is rebuilt with both current and frozen provider contracts.
  const playbackExecutionDefaults = {
    maxAttempts: VISUAL_WORKFLOW_MAX_ATTEMPTS,
    timeoutMs: VISUAL_WORKFLOW_TIMEOUT_MS,
  };
  const sceneSchemas = [
    sceneSchema,
    ...HistoricalLessonSceneSchemas.filter(schema => !schemasMatch(schema, sceneSchema)),
  ];
  const [currentScenes, ...historicalScenes] = sceneSchemas.map(schema => {
    const contract = createSceneLessonVisualContractSchemas(schema);
    return {
      artifact: createArtifactDraftWorkflow(visualExecutionDefaults, contract),
      retry: createLessonVisualWorkflows(visualExecutionDefaults, undefined, contract).retry,
      lesson: createLessonGenerationWorkflow(
        {
          maxAttempts: GENERATION_WORKFLOW_MAX_ATTEMPTS,
          models,
          timeoutMs: GENERATION_WORKFLOW_TIMEOUT_MS,
          visual,
        },
        undefined,
        createSceneLessonGenerationDurableSchemaSet(contract)
      ),
      legacyVisualPlayback: createLessonPlaybackWorkflow(
        playbackExecutionDefaults,
        createLessonPlaybackBlockSchema(schema, true, true, true)
      ),
      legacyVisualSpokenMathPlayback: createLessonPlaybackWorkflow(
        playbackExecutionDefaults,
        createLessonPlaybackBlockSchema(schema, true, false, true)
      ),
      fencedCodePlayback: createLessonPlaybackWorkflow(
        playbackExecutionDefaults,
        createLessonPlaybackBlockSchema(schema, true, true)
      ),
      spokenMathPlayback: createLessonPlaybackWorkflow(
        playbackExecutionDefaults,
        createLessonPlaybackBlockSchema(schema, true)
      ),
      playback: createLessonPlaybackWorkflow(
        playbackExecutionDefaults,
        createLessonPlaybackBlockSchema(schema)
      ),
    };
  });
  const preOpenAiRemovalScenes = sceneSchemas.map(schema => {
    const contract = createSceneLessonVisualContractSchemas(schema);
    return {
      artifact: createArtifactDraftWorkflow(
        visualExecutionDefaults,
        contract,
        historicalVisualConfigSchema
      ),
      retry: createLessonVisualWorkflows(
        visualExecutionDefaults,
        historicalVisualConfigSchema,
        contract
      ).retry,
      lesson: createLessonGenerationWorkflow(
        historicalGenerationDefaults,
        historicalLessonConfigSchema,
        createSceneLessonGenerationDurableSchemaSet(contract)
      ),
    };
  });
  const lessonWorkflow = currentScenes.lesson;
  // Definitions deployed before lesson scenes keep the legacy visual contract.
  const preSceneRetryWorkflow = createLessonVisualWorkflows(
    visualExecutionDefaults,
    historicalVisualConfigSchema,
    LegacyLessonVisualContractSchemas
  ).retry;
  const preSceneArtifactDraftWorkflow = createArtifactDraftWorkflow(
    visualExecutionDefaults,
    LegacyLessonVisualContractSchemas,
    historicalVisualConfigSchema
  );
  const courseWorkflow = createCourseGenerationWorkflow({
    maxAttempts: GENERATION_WORKFLOW_MAX_ATTEMPTS,
    models,
    timeoutMs: GENERATION_WORKFLOW_TIMEOUT_MS,
  });
  const previousRoutingCourseWorkflow = createPreviousRoutingCourseGenerationWorkflow(
    historicalGenerationDefaults,
    historicalModelConfigSchema
  );
  const previousCourseWorkflow = createPreviousCourseGenerationWorkflow(
    historicalGenerationDefaults,
    historicalModelConfigSchema
  );
  const previousControlsCourseWorkflow = createPreviousControlsCourseGenerationWorkflow(
    historicalGenerationDefaults,
    historicalModelConfigSchema
  );
  const previousDiagnosticCourseWorkflow = createPreviousDiagnosticCourseGenerationWorkflow(
    historicalGenerationDefaults,
    historicalModelConfigSchema
  );
  const previousPreferencesCourseWorkflow = createPreviousPreferencesCourseGenerationWorkflow(
    historicalGenerationDefaults,
    historicalModelConfigSchema
  );
  const courseInterviewWorkflow = createCourseInterviewWorkflow(
    {
      maxAttempts: GENERATION_WORKFLOW_MAX_ATTEMPTS,
      models,
      timeoutMs: GENERATION_WORKFLOW_TIMEOUT_MS,
    },
    COURSE_INTERVIEW_MAX_ITERATIONS,
    CourseInterviewWorkflowConfigSchema,
    'commit',
    'diagnostic'
  );
  const previousCourseInterviewWorkflow = createCourseInterviewWorkflow(
    historicalGenerationDefaults,
    COURSE_INTERVIEW_MAX_ITERATIONS,
    historicalModelConfigSchema,
    'run',
    'previous'
  );
  const previousDiagnosticInterviewWorkflow = createCourseInterviewWorkflow(
    historicalGenerationDefaults,
    COURSE_INTERVIEW_MAX_ITERATIONS,
    historicalModelConfigSchema,
    'commit',
    'current'
  );
  const previousPreferencesCourseInterviewWorkflow = createCourseInterviewWorkflow(
    historicalGenerationDefaults,
    COURSE_INTERVIEW_MAX_ITERATIONS,
    historicalModelConfigSchema,
    'commit',
    'previous'
  );
  const previousPreSceneLessonWorkflow = createPreviousPreSceneLessonGenerationWorkflow(
    historicalGenerationDefaults,
    historicalLessonConfigSchema
  );
  const previousRoutingLessonWorkflow = createPreviousRoutingLessonGenerationWorkflow(
    historicalGenerationDefaults,
    historicalLessonConfigSchema
  );
  const previousLessonWorkflow = createPreviousLessonGenerationWorkflow(
    historicalGenerationDefaults,
    historicalLessonConfigSchema
  );
  const previousResearchContractLessonWorkflow =
    createPreviousResearchContractLessonGenerationWorkflow(
      historicalGenerationDefaults,
      historicalLessonConfigSchema
    );
  const previousQuizExplanationLessonWorkflow =
    createPreviousQuizExplanationLessonGenerationWorkflow(
      historicalGenerationDefaults,
      historicalLessonConfigSchema
    );
  const previousEvidenceLessonWorkflow = createPreviousEvidenceLessonGenerationWorkflow(
    historicalGenerationDefaults,
    historicalLessonConfigSchema
  );
  const pdfMappingRepairWorkflow = createPdfMappingRepairWorkflow({
    maxAttempts: GENERATION_WORKFLOW_MAX_ATTEMPTS,
    models,
    timeoutMs: GENERATION_WORKFLOW_TIMEOUT_MS,
  });
  const previousPdfMappingRepairWorkflow = createPdfMappingRepairWorkflow(
    historicalGenerationDefaults,
    historicalModelConfigSchema,
    courseGenerationStateSchemas,
    PREVIOUS_PDF_MAPPING_REPAIR_COMPATIBILITY_ID
  );
  const previousControlsPdfMappingRepairWorkflow = createPdfMappingRepairWorkflow(
    historicalGenerationDefaults,
    historicalModelConfigSchema,
    preControlsCourseGenerationStateSchemas
  );
  const previousDiagnosticPdfMappingRepairWorkflow = createPdfMappingRepairWorkflow(
    historicalGenerationDefaults,
    historicalModelConfigSchema,
    preDiagnosticCourseGenerationStateSchemas
  );
  const previousDiagnosticLegacyPdfMappingRepairWorkflow = createPdfMappingRepairWorkflow(
    historicalGenerationDefaults,
    historicalModelConfigSchema,
    preDiagnosticCourseGenerationStateSchemas,
    PREVIOUS_PDF_MAPPING_REPAIR_COMPATIBILITY_ID
  );
  const previousControlsLegacyPdfMappingRepairWorkflow = createPdfMappingRepairWorkflow(
    historicalGenerationDefaults,
    historicalModelConfigSchema,
    preControlsCourseGenerationStateSchemas,
    PREVIOUS_PDF_MAPPING_REPAIR_COMPATIBILITY_ID
  );
  const previousPreferencesPdfMappingRepairWorkflow = createPdfMappingRepairWorkflow(
    historicalGenerationDefaults,
    historicalModelConfigSchema,
    previousCourseGenerationStateSchemas,
    PREVIOUS_PDF_MAPPING_REPAIR_COMPATIBILITY_ID
  );
  registry.register({
    current: currentScenes.artifact,
    previous: [
      ...historicalScenes.map(definition => definition.artifact),
      ...preOpenAiRemovalScenes.map(definition => definition.artifact),
      preSceneArtifactDraftWorkflow,
      preProviderPostprocessingPrevious(preSceneArtifactDraftWorkflow),
      preExternalEffectPrevious(preSceneArtifactDraftWorkflow),
      preCompatibilityIdAndExternalEffectPrevious(preSceneArtifactDraftWorkflow),
    ],
  });
  registry.register({
    current: currentScenes.retry,
    previous: [
      ...historicalScenes.map(definition => definition.retry),
      ...preOpenAiRemovalScenes.map(definition => definition.retry),
      preSceneRetryWorkflow,
      preProviderPostprocessingPrevious(preSceneRetryWorkflow),
      preExternalEffectPrevious(preSceneRetryWorkflow),
      preCompatibilityIdAndExternalEffectPrevious(preSceneRetryWorkflow),
    ],
  });
  registry.register({
    current: courseInterviewWorkflow,
    previous: [
      createCourseInterviewWorkflow(
        historicalGenerationDefaults,
        COURSE_INTERVIEW_MAX_ITERATIONS,
        historicalModelConfigSchema,
        'commit',
        'diagnostic'
      ),
      previousDiagnosticInterviewWorkflow,
      previousPreferencesCourseInterviewWorkflow,
      preExternalEffectPrevious(previousPreferencesCourseInterviewWorkflow),
      preCompatibilityIdAndExternalEffectPrevious(previousCourseInterviewWorkflow),
    ],
  });
  registry.register({
    current: courseWorkflow,
    previous: [
      createPreviousVerificationCriteriaCourseGenerationWorkflow({
        maxAttempts: GENERATION_WORKFLOW_MAX_ATTEMPTS,
        models,
        timeoutMs: GENERATION_WORKFLOW_TIMEOUT_MS,
      }),
      createPreviousVerificationCriteriaCourseGenerationWorkflow(
        historicalGenerationDefaults,
        historicalModelConfigSchema
      ),
      previousRoutingCourseWorkflow,
      previousDiagnosticCourseWorkflow,
      previousControlsCourseWorkflow,
      preProviderPostprocessingPrevious(previousControlsCourseWorkflow),
      preExternalEffectPrevious(previousControlsCourseWorkflow),
      previousPreferencesCourseWorkflow,
      preProviderPostprocessingPrevious(previousPreferencesCourseWorkflow),
      preExternalEffectPrevious(previousPreferencesCourseWorkflow),
      preExternalEffectPrevious(previousCourseWorkflow),
      preCompatibilityIdAndExternalEffectPrevious(previousCourseWorkflow),
    ],
  });
  registry.register({
    current: lessonWorkflow,
    previous: [
      ...historicalScenes.map(definition => definition.lesson),
      ...preOpenAiRemovalScenes.map(definition => definition.lesson),
      previousPreSceneLessonWorkflow,
      previousRoutingLessonWorkflow,
      previousQuizExplanationLessonWorkflow,
      previousEvidenceLessonWorkflow,
      previousResearchContractLessonWorkflow,
      previousLessonWorkflow,
      preProviderPostprocessingPrevious(previousLessonWorkflow),
      preExternalEffectPrevious(previousLessonWorkflow),
      preCompatibilityIdAndExternalEffectPrevious(previousLessonWorkflow),
    ],
  });
  registry.register({
    current: pdfMappingRepairWorkflow,
    previous: [
      createPdfMappingRepairWorkflow(historicalGenerationDefaults, historicalModelConfigSchema),
      previousDiagnosticPdfMappingRepairWorkflow,
      previousDiagnosticLegacyPdfMappingRepairWorkflow,
      previousControlsPdfMappingRepairWorkflow,
      previousControlsLegacyPdfMappingRepairWorkflow,
      preExternalEffectPrevious(previousControlsLegacyPdfMappingRepairWorkflow),
      preCompatibilityIdAndExternalEffectPrevious(previousControlsLegacyPdfMappingRepairWorkflow),
      previousPdfMappingRepairWorkflow,
      previousPreferencesPdfMappingRepairWorkflow,
      preExternalEffectPrevious(previousPreferencesPdfMappingRepairWorkflow),
      preCompatibilityIdAndExternalEffectPrevious(previousPreferencesPdfMappingRepairWorkflow),
      preExternalEffectPrevious(previousPdfMappingRepairWorkflow),
      preCompatibilityIdAndExternalEffectPrevious(previousPdfMappingRepairWorkflow),
    ],
  });
  registry.register({
    current: createLessonPlaybackWorkflow(
      playbackExecutionDefaults,
      createLessonPlaybackBlockSchema(sceneSchema, true, true, true),
      true
    ),
    previous: [
      currentScenes.legacyVisualPlayback,
      ...[currentScenes, ...historicalScenes].map(definition => definition.playback),
      ...[currentScenes, ...historicalScenes].map(definition => definition.spokenMathPlayback),
      ...[currentScenes, ...historicalScenes].map(definition => definition.fencedCodePlayback),
      ...[currentScenes, ...historicalScenes].map(
        definition => definition.legacyVisualSpokenMathPlayback
      ),
      ...historicalScenes.map(definition => definition.legacyVisualPlayback),
    ],
  });
  registry.register({ current: createRecordingAlignmentWorkflow(playbackExecutionDefaults) });
  return registry;
};

const resolveVisualConfig = async (input: {
  aiProvider?: unknown;
  aiProviderOverrides?: unknown;
}): Promise<LessonVisualModelConfig> =>
  resolveLessonVisualModelConfig(
    await getResolvedModelConfigForProvider(input.aiProvider, input.aiProviderOverrides)
  );

const readPollInterval = (): number => {
  const configured = Number(process.env.WORKFLOW_RUNTIME_POLL_INTERVAL_MS);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_WORKFLOW_POLL_INTERVAL_MS;
};

const readStepConcurrency = (): number => {
  const configured = Number(process.env.WORKFLOW_RUNTIME_STEP_CONCURRENCY);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_WORKFLOW_STEP_CONCURRENCY;
};

const createProductionWorker = (
  store: PostgresWorkflowStore,
  registry: WorkflowRegistry,
  publishTransientEvent?: WorkflowTransientEventPublisher
): WorkflowRuntimeLifecycle => {
  const services = {
    ...createProductionCourseInterviewServices({
      projectStore: getProjectStore(),
      publishTransientEvent,
      registry,
      runStore: store,
    }),
    ...createProductionCourseGenerationServices(store),
    ...createProductionLessonGenerationServices(store),
    ...createProductionLessonPlaybackServices(store.projectAssets),
    ...createProductionRecordingAlignmentServices(store.projectAssets),
    queueRecordingAlignment: async (
      result: import('../lessonPlaybackWorkflow.js').LessonPlaybackResult
    ) => {
      await createRecordingAlignmentStarter({ registry, store })(result.target, result.block);
    },
    ...createProductionPdfMappingRepairServices(),
  };
  const worker = createWorkflowRuntimeWorker({
    assetCleanup: {
      claimNextCleanup: input => store.projectAssets.claimNextCleanup(input),
      claimNextQueuedObject: input => store.projectAssetDeletions.claimNextQueuedObject(input),
      cleanup: claim => store.projectAssets.cleanup(claim),
      cleanupQueuedObject: claim => store.projectAssetDeletions.cleanupQueuedObject(claim),
      queueNextTerminalRunAssets: () => store.projectAssets.queueNextTerminalRunAssets(),
    },
    deliverNotification: createRuntimeProjectRevisionNotificationDelivery(
      store.projectRevisionInbox.deliver
    ),
    onLoopError: error => console.error('[Workflow] Runtime loop failed.', error),
    pollIntervalMs: readPollInterval(),
    publishTransientEvent,
    reconcileUnavailableDefinitions: () =>
      reconcileUnavailableWorkflowDefinitions({
        registry,
        store: store.definitionReconciliation,
      }).then(() => undefined),
    registry,
    services,
    stepConcurrency: readStepConcurrency(),
    store,
    wakeSource: store.wake,
    workerId: `workflow:${process.pid}:${randomUUID()}`,
  });
  return {
    start: async () => {
      await store.projectRevisionInbox.start();
      try {
        await worker.start();
      } catch (error) {
        await store.projectRevisionInbox.stop();
        throw error;
      }
    },
    stop: () => worker.stop(),
  };
};

/** Composes the production runtime while leaving process lifecycle under server ownership. */
export const createWorkflowRuntimeComposition = (
  options: CreateWorkflowRuntimeCompositionOptions = {}
): WorkflowRuntimeComposition => {
  const productionStore = options.store
    ? null
    : new PostgresWorkflowStore({
        projectAssetStorage: options.projectAssetStorage,
        workflowSetVersion: WORKFLOW_SET_VERSION,
      });
  const store = options.store ?? productionStore;
  if (!store) throw new Error('Workflow runtime store is required.');
  const registry = options.registry ?? createProductionRegistry();
  const publishTransientEvent = options.publishTransientEvent ?? publishWorkflowTransientEvent;
  const worker =
    options.worker ??
    (productionStore
      ? createProductionWorker(productionStore, registry, publishTransientEvent)
      : undefined);
  const lessonVisualRetryStarter =
    options.lessonVisualRetryStarter ??
    (productionStore
      ? createLessonVisualRetryStarter({
          projectReader: getProjectStore(),
          publishTransientEvent,
          registry,
          resolveVisualConfig,
          store: productionStore,
        })
      : unavailableLessonVisualRetryStarter);
  let closePromise: Promise<void> | null = null;
  return {
    api: createWorkflowRuntimeApi({
      publishedEventProjectors: createPublishedEventProjectors(options.publishedEventProjectors),
      publishTransientEvent,
      registry,
      store,
    }),
    artifactDraftApi:
      options.artifactDraftApi ??
      (productionStore
        ? createArtifactDraftApi({
            projectReader: getProjectStore(),
            publishTransientEvent,
            registry,
            resolveVisualConfig,
            runReader: productionStore,
            runStore: productionStore,
          })
        : unavailableArtifactDraftApi),
    courseGenerationApi:
      options.courseGenerationApi ??
      (productionStore
        ? createCourseGenerationApi({
            projectReader: getProjectStore(),
            runReader: productionStore,
            starter: createCourseGenerationStarter({
              registry,
              publishTransientEvent,
              resolveModels: getResolvedModelConfigForProvider,
              store: productionStore,
            }),
          })
        : unavailableCourseGenerationApi),
    courseInterviewApi:
      options.courseInterviewApi ??
      (productionStore
        ? createCourseInterviewApi({
            projectReader: getProjectStore(),
            runReader: productionStore,
            starter: createCourseInterviewStarter({
              readPreferences: readCurrentAccountPreferences,
              publishTransientEvent,
              registry,
              resolveModels: getResolvedModelConfigForProvider,
              store: productionStore,
            }),
          })
        : unavailableCourseInterviewApi),
    lessonGenerationApi:
      options.lessonGenerationApi ??
      (productionStore
        ? createLessonGenerationApi({
            createSectionId: () => randomUUID(),
            projectReader: getProjectStore(),
            runReader: productionStore,
            starter: createLessonGenerationStarter({
              registry,
              publishTransientEvent,
              resolveModels: options.resolveLessonModels ?? getResolvedModelConfigForProvider,
              store: productionStore,
            }),
          })
        : unavailableLessonGenerationApi),
    pdfMappingRepairApi:
      options.pdfMappingRepairApi ??
      (productionStore
        ? createPdfMappingRepairApi({
            projectReader: getProjectStore(),
            runReader: productionStore,
            starter: createPdfMappingRepairStarter({
              registry,
              publishTransientEvent,
              resolveModels: getResolvedModelConfigForProvider,
              store: productionStore,
            }),
          })
        : unavailablePdfMappingRepairApi),
    lessonPlaybackApi:
      options.lessonPlaybackApi ??
      (productionStore
        ? createLessonPlaybackApi({
            projectReader: getProjectStore(),
            registry,
            store: productionStore,
            publishTransientEvent,
            resolveTtsModel: async () => (await getResolvedGlobalModelConfig()).ttsModel,
            alignRecording: createRecordingAlignmentStarter({ registry, store: productionStore }),
          })
        : unavailableLessonPlaybackApi),
    lessonVisualRetryStarter,
    projectAssetReader:
      options.projectAssetReader ?? store.projectAssets ?? unavailableProjectAssetReader,
    workflowOutboxAdmin: store.outbox,
    close: () => {
      closePromise ??= (async () => {
        let workerFailure: unknown;
        try {
          if (worker) await worker.stop();
        } catch (error) {
          workerFailure = error;
        }
        try {
          await store.close();
        } catch (error_) {
          if (workerFailure) {
            throw new AggregateError(
              [workerFailure, error_],
              'Workflow worker and store shutdown both failed.'
            );
          }
          throw error_;
        }
        if (workerFailure) throw workerFailure;
      })();
      return closePromise;
    },
    start: () => worker?.start() ?? Promise.resolve(),
  };
};
