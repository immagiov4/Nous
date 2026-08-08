import type { GlobalModelConfig } from '../config/modelConfig.js';
import { resolveLessonVisualModelConfig } from '../services/lessonVisualModelConfig.js';
import type { WorkflowRegistry } from './definition.js';
import {
  type LessonGenerationWorkflowInput,
  LessonGenerationWorkflowInputSchema,
  SublessonFocusSchema,
  SublessonGenerationInputSchema,
} from './lessonGenerationWorkflowContract.js';
import type { JsonValue, WorkflowRun } from './types.js';
import type { WorkflowTransientEventPublisher } from './workflowObservability.js';
import type { WorkflowRunCreator } from './workflowStart.js';
import { startWorkflowRun } from './workflowStart.js';

export const LESSON_GENERATION_WORKFLOW_ID = 'lesson-generation';

export type LessonGenerationStartInput = LessonGenerationWorkflowInput & {
  readonly aiProvider?: unknown;
  readonly aiProviderOverrides?: unknown;
  readonly idempotencyInput?: unknown;
  readonly requestKey: string;
};

export interface LessonGenerationStarter {
  start(input: LessonGenerationStartInput): Promise<{ created: boolean; run: WorkflowRun }>;
}

interface LessonGenerationStartDependencies {
  readonly registry: WorkflowRegistry;
  readonly publishTransientEvent?: WorkflowTransientEventPublisher;
  readonly resolveModels: (
    aiProvider?: unknown,
    aiProviderOverrides?: unknown
  ) => Promise<GlobalModelConfig>;
  readonly store: WorkflowRunCreator;
}

export const lessonGenerationDedupeKey = (projectId: string): string =>
  JSON.stringify([LESSON_GENERATION_WORKFLOW_ID, projectId]);

const PreviousSublessonWorkflowInputSchema = SublessonGenerationInputSchema.extend({
  focus: SublessonFocusSchema.strict(),
}).strict();

export const mapPreviousSublessonIdempotencyInput = (
  workflowInput: unknown
): JsonValue | undefined => {
  const parsed = PreviousSublessonWorkflowInputSchema.safeParse(workflowInput);
  if (!parsed.success) return undefined;
  return {
    focus: parsed.data.focus,
    kind: parsed.data.kind,
    parentSectionId: parsed.data.parentSectionId,
    projectId: parsed.data.projectId,
    userId: parsed.data.userId,
  };
};

export const createLessonGenerationStarter = (
  dependencies: LessonGenerationStartDependencies
): LessonGenerationStarter => ({
  start: async input => {
    const models = await dependencies.resolveModels(input.aiProvider, input.aiProviderOverrides);
    const workflowInput = LessonGenerationWorkflowInputSchema.parse(input);
    return startWorkflowRun({
      configOverride: { models, visual: resolveLessonVisualModelConfig(models) },
      dedupeKey: lessonGenerationDedupeKey(input.projectId),
      ...(input.idempotencyInput === undefined ? {} : { idempotencyInput: input.idempotencyInput }),
      input: workflowInput,
      ...(workflowInput.kind === 'sublesson'
        ? { mapPreviousIdempotencyInput: mapPreviousSublessonIdempotencyInput }
        : {}),
      projectId: input.projectId,
      publishTransientEvent: dependencies.publishTransientEvent,
      registry: dependencies.registry,
      requestKey: input.requestKey,
      store: dependencies.store,
      userId: input.userId,
      workflowId: LESSON_GENERATION_WORKFLOW_ID,
    });
  },
});
