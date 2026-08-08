import {
  COURSE_INTERVIEW_WORKFLOW_ID,
  type CourseInterviewStartRequest,
} from '@shared/courseInterviewContract.js';

import type { GlobalModelConfig } from '../config/modelConfig.js';
import type { WorkflowRegistry } from './definition.js';
import type { WorkflowRun } from './types.js';
import type { WorkflowTransientEventPublisher } from './workflowObservability.js';
import { startWorkflowRun, type WorkflowRunCreator } from './workflowStart.js';

export interface CourseInterviewStartInput extends CourseInterviewStartRequest {
  readonly aiProvider?: unknown;
  readonly aiProviderOverrides?: unknown;
  readonly userId: string;
}

export interface CourseInterviewStarter {
  start(input: CourseInterviewStartInput): Promise<{ created: boolean; run: WorkflowRun }>;
}

interface CourseInterviewStartDependencies {
  readonly registry: WorkflowRegistry;
  readonly publishTransientEvent?: WorkflowTransientEventPublisher;
  readonly resolveModels: (
    aiProvider?: unknown,
    aiProviderOverrides?: unknown
  ) => Promise<GlobalModelConfig>;
  readonly store: WorkflowRunCreator;
}

export const createCourseInterviewStarter = (
  dependencies: CourseInterviewStartDependencies
): CourseInterviewStarter => ({
  start: async input => {
    const models = await dependencies.resolveModels(input.aiProvider, input.aiProviderOverrides);
    return startWorkflowRun({
      configOverride: { models },
      input: {
        hasReliableSourceContext: input.hasReliableSourceContext,
        initialMessage: input.initialMessage,
        mode: input.mode,
        projectId: input.projectId,
        ...(input.sourceContext ? { sourceContext: input.sourceContext } : {}),
        userId: input.userId,
      },
      projectId: input.projectId,
      publishTransientEvent: dependencies.publishTransientEvent,
      registry: dependencies.registry,
      requestKey: input.requestKey,
      store: dependencies.store,
      userId: input.userId,
      workflowId: COURSE_INTERVIEW_WORKFLOW_ID,
    });
  },
});
