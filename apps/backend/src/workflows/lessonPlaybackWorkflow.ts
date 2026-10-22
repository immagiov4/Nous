import { LessonPlaybackBlockSchema } from '@shared/lessonPlaybackSchema';
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
  queueRecordingAlignment?: (result: LessonPlaybackResult) => Promise<void>;
  preparePlayback: (
    context: StepExecutionContext<
      LessonPlaybackInput,
      WorkflowExecutionDefaults,
      LessonPlaybackServices
    >,
    allowedSceneTypes?: readonly LessonSceneType[],
    supportsSpokenMath?: boolean,
    supportsFencedCode?: boolean,
    supportsUnlinkedFormulaSymbols?: boolean,
    synchronizeAnimations?: boolean
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
  blockSchema = LessonPlaybackBlockSchema,
  queueAlignment = false,
  synchronizeAnimations = false
) => {
  const resultSchema = LessonPlaybackResultSchema.extend({ block: blockSchema });
  const sceneTypes = blockSchema.shape.prepared.unwrap().shape.scene.unwrap().shape.type.options;
  const supportsFencedCode = 'fencedCode' in blockSchema.shape.prepared.unwrap().shape;
  const supportsSpokenMath = 'spokenMath' in blockSchema.shape.prepared.unwrap().shape;
  const sceneSchema = blockSchema.shape.prepared.unwrap().shape.scene.unwrap();
  const supportsUnlinkedFormulaSymbols =
    sceneTypes.includes('formula-spotlight') &&
    sceneSchema.shape.symbols.unwrap().element.shape.anchor.safeParse('').success;
  const prepare = step<
    typeof LessonPlaybackInputSchema,
    typeof resultSchema,
    WorkflowExecutionDefaults,
    LessonPlaybackServices
  >({
    id: synchronizeAnimations ? 'prepare-synchronized-block' : 'prepare-block',
    externalEffect: 'provider-with-postprocessing',
    inputSchema: LessonPlaybackInputSchema,
    outputSchema: resultSchema,
    run: context =>
      context.services.preparePlayback(
        context,
        sceneTypes,
        supportsSpokenMath,
        supportsFencedCode,
        supportsUnlinkedFormulaSymbols,
        synchronizeAnimations
      ),
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
  const align = step<
    typeof resultSchema,
    typeof resultSchema,
    WorkflowExecutionDefaults,
    LessonPlaybackServices
  >({
    id: 'queue-alignment',
    inputSchema: resultSchema,
    outputSchema: resultSchema,
    run: async ({ input, services }) => {
      try {
        await services.queueRecordingAlignment?.(input);
      } catch (error) {
        console.warn('[recording-alignment] Could not queue new recording.', error);
      }
      return input;
    },
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
    root: sequence({
      id: 'root',
      nodes: queueAlignment ? ([prepare, persist, align] as const) : ([prepare, persist] as const),
    }),
  });
};
