import { LessonPlaybackBlockSchema } from '@shared/lessonPlaybackSchema';
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
export const LessonPlaybackResultSchema = z.object({
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
    >
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

export const createLessonPlaybackWorkflow = (executionDefaults: WorkflowExecutionDefaults) => {
  const prepare = step<
    typeof LessonPlaybackInputSchema,
    typeof LessonPlaybackResultSchema,
    WorkflowExecutionDefaults,
    LessonPlaybackServices
  >({
    id: 'prepare-block',
    externalEffect: 'provider-with-postprocessing',
    inputSchema: LessonPlaybackInputSchema,
    outputSchema: LessonPlaybackResultSchema,
    run: context => context.services.preparePlayback(context),
  });
  const persist = step<
    typeof LessonPlaybackResultSchema,
    typeof LessonPlaybackResultSchema,
    WorkflowExecutionDefaults,
    LessonPlaybackServices
  >({
    id: 'persist-block',
    inputSchema: LessonPlaybackResultSchema,
    outputSchema: LessonPlaybackResultSchema,
    run: async ({ input }) => input,
    commit: context => context.services.persistPlayback(context),
  });
  return workflow({
    id: LESSON_PLAYBACK_WORKFLOW_ID,
    compatibilityId: 'prepare-lesson-playback-block-v1',
    configSchema: WorkflowExecutionDefaultsSchema,
    executionDefaults,
    inputSchema: LessonPlaybackInputSchema,
    outputSchema: LessonPlaybackResultSchema,
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
