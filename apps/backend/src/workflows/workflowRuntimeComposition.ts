import { randomUUID } from 'node:crypto';

import { getGlobalModelConfig, getResolvedModelConfigForProvider } from '../config/modelConfig.js';
import type { ProjectAssetObjectStorage } from '../projects/projectAsset.js';
import {
  type ProjectAssetReader,
  unavailableProjectAssetReader,
} from '../projects/projectAssetReader.js';
import { getProjectStore } from '../projects/projectStore.js';
import {
  type LessonVisualModelConfig,
  resolveLessonVisualModelConfig,
} from '../services/lessonVisualModelConfig.js';
import {
  type ArtifactDraftApi,
  createArtifactDraftApi,
  unavailableArtifactDraftApi,
} from './artifactDraftApi.js';
import { createArtifactDraftWorkflow } from './artifactDraftWorkflow.js';
import {
  type CourseGenerationApi,
  createCourseGenerationApi,
  unavailableCourseGenerationApi,
} from './courseGenerationApi.js';
import { createProductionCourseGenerationServices } from './courseGenerationProduction.js';
import { createCourseGenerationStarter } from './courseGenerationStart.js';
import {
  COURSE_GENERATION_WORKFLOW_ID,
  CourseGenerationWorkflowConfigSchema,
  createCourseGenerationWorkflow,
  createPreviousCourseGenerationWorkflow,
} from './courseGenerationWorkflow.js';
import {
  type CourseInterviewApi,
  createCourseInterviewApi,
  projectCourseInterviewEvents,
  unavailableCourseInterviewApi,
} from './courseInterviewApi.js';
import { createProductionCourseInterviewServices } from './courseInterviewProduction.js';
import { createCourseInterviewStarter } from './courseInterviewStart.js';
import {
  COURSE_INTERVIEW_WORKFLOW_ID,
  CourseInterviewWorkflowConfigSchema,
  createCourseInterviewWorkflow,
} from './courseInterviewWorkflow.js';
import {
  createWorkflowRegistry,
  preCompatibilityIdAndExternalEffectPrevious,
  preExternalEffectPrevious,
  preProviderPostprocessingPrevious,
  type WorkflowRegistry,
} from './definition.js';
import {
  createLessonGenerationApi,
  type LessonGenerationApi,
  unavailableLessonGenerationApi,
} from './lessonGenerationApi.js';
import { createProductionLessonGenerationServices } from './lessonGenerationProduction.js';
import {
  createLessonGenerationStarter,
  LESSON_GENERATION_WORKFLOW_ID,
} from './lessonGenerationStart.js';
import { createLessonGenerationWorkflow } from './lessonGenerationWorkflow.js';
import {
  createLessonVisualRetryStarter,
  type LessonVisualRetryStarter,
  unavailableLessonVisualRetryStarter,
} from './lessonVisualRetryStart.js';
import {
  createLessonVisualWorkflows,
  LESSON_VISUAL_RETRY_WORKFLOW_ID,
} from './lessonVisualWorkflow.js';
import {
  createPdfMappingRepairApi,
  createPdfMappingRepairStarter,
  type PdfMappingRepairApi,
  unavailablePdfMappingRepairApi,
} from './pdfMappingRepairApi.js';
import {
  createPdfMappingRepairWorkflow,
  createProductionPdfMappingRepairServices,
  PDF_MAPPING_REPAIR_WORKFLOW_ID,
} from './pdfMappingRepairWorkflow.js';
import type { PostgresWorkflowOutboxStore } from './postgresWorkflowOutboxStore.js';
import { PostgresWorkflowStore } from './postgresWorkflowStore.js';
import {
  COURSE_PROJECT_REVISION_EVENT,
  courseProjectRevisionEventProjector,
  createProjectRevisionNotificationDelivery,
  LESSON_PROJECT_REVISION_EVENT,
  lessonProjectRevisionEventProjector,
  type ProjectRevisionNotificationReceiver,
} from './projectRevisionNotifications.js';
import { reconcileUnavailableWorkflowDefinitions } from './workflowDefinitionReconciler.js';
import {
  publishWorkflowTransientEvent,
  type WorkflowTransientEventPublisher,
} from './workflowObservability.js';
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
// Increment only when the production registry adds or removes a workflow ID.
const WORKFLOW_SET_VERSION = 2;

const createPublishedEventProjectors = (
  overrides?: ReadonlyMap<string, WorkflowPublishedEventProjector>
): ReadonlyMap<string, WorkflowPublishedEventProjector> =>
  new Map([
    [COURSE_INTERVIEW_WORKFLOW_ID, projectCourseInterviewEvents],
    [COURSE_GENERATION_WORKFLOW_ID, courseProjectRevisionEventProjector],
    [PDF_MAPPING_REPAIR_WORKFLOW_ID, courseProjectRevisionEventProjector],
    [LESSON_GENERATION_WORKFLOW_ID, lessonProjectRevisionEventProjector],
    [LESSON_VISUAL_RETRY_WORKFLOW_ID, lessonProjectRevisionEventProjector],
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

export const createProductionRegistry = (): WorkflowRegistry => {
  const registry = createWorkflowRegistry();
  const models = getGlobalModelConfig();
  const visual = resolveLessonVisualModelConfig(models);
  const retryWorkflow = createLessonVisualWorkflows({
    maxAttempts: VISUAL_WORKFLOW_MAX_ATTEMPTS,
    timeoutMs: VISUAL_WORKFLOW_TIMEOUT_MS,
    visual,
  }).retry;
  const artifactDraftWorkflow = createArtifactDraftWorkflow({
    maxAttempts: VISUAL_WORKFLOW_MAX_ATTEMPTS,
    timeoutMs: VISUAL_WORKFLOW_TIMEOUT_MS,
    visual,
  });
  const courseWorkflow = createCourseGenerationWorkflow({
    maxAttempts: GENERATION_WORKFLOW_MAX_ATTEMPTS,
    models,
    timeoutMs: GENERATION_WORKFLOW_TIMEOUT_MS,
  });
  const previousCourseWorkflow = createPreviousCourseGenerationWorkflow(
    courseWorkflow.executionDefaults
  );
  const courseInterviewWorkflow = createCourseInterviewWorkflow(
    {
      maxAttempts: GENERATION_WORKFLOW_MAX_ATTEMPTS,
      models,
      timeoutMs: GENERATION_WORKFLOW_TIMEOUT_MS,
    },
    COURSE_INTERVIEW_MAX_ITERATIONS
  );
  const previousCourseInterviewWorkflow = createCourseInterviewWorkflow(
    courseInterviewWorkflow.executionDefaults,
    COURSE_INTERVIEW_MAX_ITERATIONS,
    CourseInterviewWorkflowConfigSchema,
    'run'
  );
  const lessonWorkflow = createLessonGenerationWorkflow({
    maxAttempts: GENERATION_WORKFLOW_MAX_ATTEMPTS,
    models,
    timeoutMs: GENERATION_WORKFLOW_TIMEOUT_MS,
    visual,
  });
  const previousLessonWorkflow = createLessonGenerationWorkflow(lessonWorkflow.executionDefaults);
  const pdfMappingRepairWorkflow = createPdfMappingRepairWorkflow({
    maxAttempts: GENERATION_WORKFLOW_MAX_ATTEMPTS,
    models,
    timeoutMs: GENERATION_WORKFLOW_TIMEOUT_MS,
  });
  const previousPdfMappingRepairWorkflow = createPdfMappingRepairWorkflow(
    pdfMappingRepairWorkflow.executionDefaults,
    CourseGenerationWorkflowConfigSchema
  );
  registry.register({
    current: artifactDraftWorkflow,
    previous: [
      preProviderPostprocessingPrevious(artifactDraftWorkflow),
      preExternalEffectPrevious(artifactDraftWorkflow),
      preCompatibilityIdAndExternalEffectPrevious(artifactDraftWorkflow),
    ],
  });
  registry.register({
    current: retryWorkflow,
    previous: [
      preProviderPostprocessingPrevious(retryWorkflow),
      preExternalEffectPrevious(retryWorkflow),
      preCompatibilityIdAndExternalEffectPrevious(retryWorkflow),
    ],
  });
  registry.register({
    current: courseInterviewWorkflow,
    previous: [
      preExternalEffectPrevious(courseInterviewWorkflow),
      preCompatibilityIdAndExternalEffectPrevious(previousCourseInterviewWorkflow),
    ],
  });
  registry.register({
    current: courseWorkflow,
    previous: [
      preProviderPostprocessingPrevious(courseWorkflow),
      preExternalEffectPrevious(courseWorkflow),
      preExternalEffectPrevious(previousCourseWorkflow),
      preCompatibilityIdAndExternalEffectPrevious(previousCourseWorkflow),
    ],
  });
  registry.register({
    current: lessonWorkflow,
    previous: [
      preProviderPostprocessingPrevious(lessonWorkflow),
      preExternalEffectPrevious(lessonWorkflow),
      preCompatibilityIdAndExternalEffectPrevious(previousLessonWorkflow),
    ],
  });
  registry.register({
    current: pdfMappingRepairWorkflow,
    previous: [
      preExternalEffectPrevious(pdfMappingRepairWorkflow),
      preCompatibilityIdAndExternalEffectPrevious(previousPdfMappingRepairWorkflow),
    ],
  });
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
              resolveModels: getResolvedModelConfigForProvider,
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
