import type { GlobalModelConfig } from '../config/modelConfig.js';
import { COURSE_GENERATION_WORKFLOW_ID } from './courseGenerationWorkflow.js';
import type { CourseGenerationWorkflowInput } from './courseGenerationWorkflowContract.js';
import type { WorkflowRegistry } from './definition.js';
import type { DeepReadonly, WorkflowRun } from './types.js';
import type { WorkflowTransientEventPublisher } from './workflowObservability.js';
import type { WorkflowRunCreator } from './workflowStart.js';
import { startWorkflowRun } from './workflowStart.js';

export interface CourseGenerationStartInput extends CourseGenerationWorkflowInput {
  readonly aiProvider?: unknown;
  readonly aiProviderOverrides?: unknown;
  readonly requestKey: string;
}

export interface CourseGenerationStarter {
  start(input: CourseGenerationStartInput): Promise<{ created: boolean; run: WorkflowRun }>;
}

export interface CourseGenerationResolvedStartInput extends CourseGenerationWorkflowInput {
  readonly models: DeepReadonly<GlobalModelConfig>;
  readonly requestKey: string;
}

export interface CourseGenerationResolvedStartDependencies {
  readonly registry: WorkflowRegistry;
  readonly publishTransientEvent?: WorkflowTransientEventPublisher;
  readonly store: WorkflowRunCreator;
}

interface CourseGenerationStartDependencies extends CourseGenerationResolvedStartDependencies {
  readonly resolveModels: (
    aiProvider?: unknown,
    aiProviderOverrides?: unknown
  ) => Promise<GlobalModelConfig>;
}

const courseGenerationDedupeKey = (projectId: string): string =>
  JSON.stringify([COURSE_GENERATION_WORKFLOW_ID, projectId]);

export const startCourseGenerationWithModels = (
  dependencies: CourseGenerationResolvedStartDependencies,
  input: CourseGenerationResolvedStartInput
): Promise<{ created: boolean; run: WorkflowRun }> =>
  startWorkflowRun({
    configOverride: { models: input.models },
    dedupeKey: courseGenerationDedupeKey(input.projectId),
    input: {
      assessmentHistory: input.assessmentHistory,
      mode: input.mode,
      projectId: input.projectId,
      userId: input.userId,
    },
    projectId: input.projectId,
    publishTransientEvent: dependencies.publishTransientEvent,
    registry: dependencies.registry,
    requestKey: input.requestKey,
    store: dependencies.store,
    userId: input.userId,
    workflowId: COURSE_GENERATION_WORKFLOW_ID,
  });

export const createCourseGenerationStarter = (
  dependencies: CourseGenerationStartDependencies
): CourseGenerationStarter => ({
  start: async input => {
    const models = await dependencies.resolveModels(input.aiProvider, input.aiProviderOverrides);
    return startCourseGenerationWithModels(dependencies, {
      assessmentHistory: input.assessmentHistory,
      mode: input.mode,
      models,
      projectId: input.projectId,
      requestKey: input.requestKey,
      userId: input.userId,
    });
  },
});
