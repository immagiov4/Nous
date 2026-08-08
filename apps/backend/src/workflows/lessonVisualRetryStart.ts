import { findProjectLessonSection } from '../projects/projectLesson.js';
import type { ProjectSnapshot } from '../projects/types.js';
import type { LessonVisualModelConfig } from '../services/lessonVisualModelConfig.js';
import { isRecord } from '../utils/validation.js';
import type { WorkflowRegistry } from './definition.js';
import { buildLessonVisualContextFingerprint } from './lessonVisualContext.js';
import {
  LESSON_VISUAL_RETRY_WORKFLOW_ID,
  type LessonVisualWorkflowInput,
  LessonVisualWorkflowInputSchema,
} from './lessonVisualWorkflow.js';
import type { WorkflowRun } from './types.js';
import type { WorkflowTransientEventPublisher } from './workflowObservability.js';
import { WorkflowRuntimeUnavailableError } from './workflowRuntimeApi.js';
import type { WorkflowRunCreator } from './workflowStart.js';
import { startWorkflowRun } from './workflowStart.js';

export class LessonVisualRetryTargetError extends Error {
  constructor() {
    super('The lesson visual retry target was not found.');
    this.name = 'LessonVisualRetryTargetError';
  }
}

export class LessonVisualRetryPlanError extends Error {
  constructor() {
    super('The stored lesson visual retry plan is invalid.');
    this.name = 'LessonVisualRetryPlanError';
  }
}

export interface LessonVisualRetryStartInput {
  readonly aiProvider?: unknown;
  readonly aiProviderOverrides?: unknown;
  readonly projectId: string;
  readonly requestKey: string;
  readonly sectionId: string;
  readonly slotId: string;
  readonly userId: string;
}

export interface LessonVisualRetryStarter {
  start(input: LessonVisualRetryStartInput): Promise<{ created: boolean; run: WorkflowRun }>;
}

interface LessonVisualRetryStartDependencies {
  readonly projectReader: {
    loadProject(userId: string, projectId: string): Promise<ProjectSnapshot | null>;
  };
  readonly publishTransientEvent?: WorkflowTransientEventPublisher;
  readonly registry: WorkflowRegistry;
  readonly resolveVisualConfig: (input: {
    aiProvider?: unknown;
    aiProviderOverrides?: unknown;
  }) => Promise<LessonVisualModelConfig>;
  readonly store: WorkflowRunCreator & {
    getRunByRequestKey(input: {
      requestKey: string;
      userId: string;
      workflowId: string;
    }): Promise<WorkflowRun | null>;
  };
}

const unavailableStart = (): Promise<never> =>
  Promise.reject(new WorkflowRuntimeUnavailableError());

export const unavailableLessonVisualRetryStarter: LessonVisualRetryStarter = {
  start: unavailableStart,
};

const buildWorkflowInput = (snapshot: ProjectSnapshot, input: LessonVisualRetryStartInput) => {
  const section = findProjectLessonSection(snapshot, input.sectionId);
  if (
    !section ||
    !Array.isArray(section.contentBlocks) ||
    typeof section.content !== 'string' ||
    typeof section.description !== 'string' ||
    typeof section.title !== 'string'
  ) {
    throw new LessonVisualRetryTargetError();
  }
  const retryBlocks = section.contentBlocks.filter(
    block =>
      isRecord(block) &&
      block.type === 'generated-visual' &&
      block.slotId === input.slotId &&
      isRecord(block.retryPlan) &&
      typeof block.visualId !== 'string'
  );
  if (retryBlocks.length !== 1) throw new LessonVisualRetryTargetError();

  const candidate = {
    contextFingerprint: buildLessonVisualContextFingerprint({
      lessonMarkdown: section.content,
      sectionDescription: section.description,
      sectionTitle: section.title,
    }),
    lessonMarkdown: section.content,
    plan: retryBlocks[0]?.retryPlan,
    projectId: input.projectId,
    sectionDescription: section.description,
    sectionId: input.sectionId,
    sectionTitle: section.title,
    userId: input.userId,
  };
  const parsed = LessonVisualWorkflowInputSchema.safeParse(candidate);
  if (!parsed.success) throw new LessonVisualRetryPlanError();
  return parsed.data;
};

const retryDedupeKey = (input: LessonVisualRetryStartInput): string =>
  JSON.stringify([LESSON_VISUAL_RETRY_WORKFLOW_ID, input.projectId, input.sectionId, input.slotId]);

const loadExistingWorkflowInput = async (
  dependencies: LessonVisualRetryStartDependencies,
  input: LessonVisualRetryStartInput
) => {
  const run = await dependencies.store.getRunByRequestKey({
    requestKey: input.requestKey,
    userId: input.userId,
    workflowId: LESSON_VISUAL_RETRY_WORKFLOW_ID,
  });
  const parsed = run ? LessonVisualWorkflowInputSchema.safeParse(run.input) : null;
  if (
    !run ||
    !parsed?.success ||
    run.projectId !== input.projectId ||
    run.userId !== input.userId ||
    run.workflowId !== LESSON_VISUAL_RETRY_WORKFLOW_ID ||
    parsed.data.projectId !== input.projectId ||
    parsed.data.sectionId !== input.sectionId ||
    parsed.data.plan.slotId !== input.slotId ||
    parsed.data.userId !== input.userId
  ) {
    return null;
  }
  return parsed.data;
};

export const createLessonVisualRetryStarter = (
  dependencies: LessonVisualRetryStartDependencies
): LessonVisualRetryStarter => ({
  start: async input => {
    const project = await dependencies.projectReader.loadProject(input.userId, input.projectId);
    if (!project) throw new LessonVisualRetryTargetError();

    let workflowInput: LessonVisualWorkflowInput;
    try {
      workflowInput = buildWorkflowInput(project, input);
    } catch (error) {
      if (!(error instanceof LessonVisualRetryTargetError)) throw error;
      const existingInput = await loadExistingWorkflowInput(dependencies, input);
      if (!existingInput) throw error;
      workflowInput = existingInput;
    }

    const visual = await dependencies.resolveVisualConfig({
      aiProvider: input.aiProvider,
      aiProviderOverrides: input.aiProviderOverrides,
    });
    return startWorkflowRun({
      configOverride: { visual },
      dedupeKey: retryDedupeKey(input),
      input: workflowInput,
      projectId: input.projectId,
      publishTransientEvent: dependencies.publishTransientEvent,
      registry: dependencies.registry,
      requestKey: input.requestKey,
      store: dependencies.store,
      userId: input.userId,
      workflowId: LESSON_VISUAL_RETRY_WORKFLOW_ID,
    });
  },
});
