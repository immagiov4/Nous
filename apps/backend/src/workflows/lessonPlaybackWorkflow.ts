import {
  LessonPlaybackBlockSchema,
  type PreAnimatedLessonPlaybackBlockSchema,
} from '@shared/lessonPlaybackSchema';
import type { LessonSceneType } from '@shared/lessonScene';
import * as z from 'zod';

import { WorkflowExecutionDefaultsSchema } from './config.js';
import { sequence, step, workflow } from './definition.js';
import {
  LESSON_PROJECT_REVISION_EVENT,
  PROJECT_REVISION_EVENT_SCHEMA_VERSION,
  ProjectRevisionEventSchema,
} from './projectRevisionNotifications.js';
import type {
  StepCommitContext,
  StepExecutionContext,
  WorkflowExecutionDefaults,
} from './types.js';

export const LESSON_PLAYBACK_WORKFLOW_ID = 'prepare-lesson-playback-block';
export const LessonPlaybackInputSchema = z.object({
  userId: z.string().min(1),
  projectId: z.string().min(1),
  incarnationId: z.string().min(1),
  sectionId: z.string().min(1),
  lessonKey: z.string().length(64),
  blockId: z.string().min(1),
  voice: z.string().min(1),
  model: z.string().min(1),
});
const LessonPlaybackResultSchema = z.object({
  target: LessonPlaybackInputSchema,
  block: LessonPlaybackBlockSchema,
  assetOwner: z.string().optional(),
});
export type LessonPlaybackInput = z.infer<typeof LessonPlaybackInputSchema>;
export type LessonPlaybackResult = z.infer<typeof LessonPlaybackResultSchema>;

export interface LessonPlaybackServices {
  preparePlayback: (
    context: StepExecutionContext<
      LessonPlaybackInput,
      WorkflowExecutionDefaults,
      LessonPlaybackServices
    >,
    allowedSceneTypes?: readonly LessonSceneType[]
  ) => Promise<LessonPlaybackResult>;
  persistPlayback: (
    context: StepCommitContext<
      LessonPlaybackResult,
      LessonPlaybackResult,
      WorkflowExecutionDefaults,
      LessonPlaybackServices
    >
  ) => Promise<void>;
}

export const createLessonPlaybackWorkflow = (
  executionDefaults: WorkflowExecutionDefaults,
  blockSchema:
    | typeof LessonPlaybackBlockSchema
    | typeof PreAnimatedLessonPlaybackBlockSchema = LessonPlaybackBlockSchema
) => {
  const resultSchema = LessonPlaybackResultSchema.extend({ block: blockSchema });
  const sceneTypes = blockSchema.shape.prepared.unwrap().shape.scene.unwrap().shape.type.options;
  const prepare = step<
    typeof LessonPlaybackInputSchema,
    typeof resultSchema,
    WorkflowExecutionDefaults,
    LessonPlaybackServices
  >({
    id: 'prepare-block',
    externalEffect: 'provider-with-postprocessing',
    inputSchema: LessonPlaybackInputSchema,
    outputSchema: resultSchema,
    run: context => context.services.preparePlayback(context, sceneTypes),
  });
  const persist = step<
    typeof resultSchema,
    typeof resultSchema,
    WorkflowExecutionDefaults,
    LessonPlaybackServices
  >({
    id: 'persist-block',
    inputSchema: resultSchema,
    outputSchema: resultSchema,
    run: async ({ input }) => input,
    commit: context => context.services.persistPlayback(context),
  });
  return workflow({
    id: LESSON_PLAYBACK_WORKFLOW_ID,
    compatibilityId: 'prepare-lesson-playback-block-v1',
    configSchema: WorkflowExecutionDefaultsSchema,
    executionDefaults,
    inputSchema: LessonPlaybackInputSchema,
    outputSchema: resultSchema,
    events: {
      [LESSON_PROJECT_REVISION_EVENT]: {
        durability: 'durable',
        schema: ProjectRevisionEventSchema,
        schemaVersion: PROJECT_REVISION_EVENT_SCHEMA_VERSION,
      },
    },
    root: sequence({ id: 'root', nodes: [prepare, persist] as const }),
  });
};
