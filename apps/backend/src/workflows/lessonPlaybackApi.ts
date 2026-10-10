import { randomUUID } from 'node:crypto';
import type { LessonPlaybackBlock } from '@shared/lessonPlayback';

import { readLessonPlayback } from '../projects/lessonPlayback.js';
import { findProjectLessonSection } from '../projects/projectLesson.js';
import type { ProjectStore } from '../projects/types.js';
import { ttsClient } from '../services/ttsClient.js';
import type { WorkflowRegistry } from './definition.js';
import {
  LESSON_PLAYBACK_WORKFLOW_ID,
  LessonPlaybackInputSchema,
} from './lessonPlaybackWorkflow.js';
import { WorkflowRuntimeUnavailableError } from './runtime/workflowRuntimeApi.js';
import type { WorkflowTransientEventPublisher } from './workflowObservability.js';
import { startWorkflowRun, type WorkflowRunCreator } from './workflowStart.js';

export class LessonPlaybackTargetError extends Error {}
export class LessonPlaybackStaleError extends Error {}

interface PlaybackTarget {
  userId: string;
  projectId: string;
  sectionId: string;
}
export type PlaybackPreparationResult =
  | { block: LessonPlaybackBlock }
  | { runId: string; blockId: string; voice: string };
export interface LessonPlaybackApi {
  get(
    target: PlaybackTarget
  ): Promise<{ lessonKey: string; blocks: readonly LessonPlaybackBlock[] }>;
  prepare(
    input: PlaybackTarget & { lessonKey: string; blockId: string; voice: string }
  ): Promise<PlaybackPreparationResult>;
}

export const isPlaybackBlockReady = (
  block: LessonPlaybackBlock,
  voice: string,
  model: string
): boolean =>
  Boolean(
    block.prepared && block.audio.some(audio => audio.voice === voice && audio.model === model)
  );

export const createLessonPlaybackApi = (dependencies: {
  projectReader: Pick<ProjectStore, 'loadProjectWithRevision'>;
  resolveTtsModel: () => Promise<string>;
  registry: WorkflowRegistry;
  store: WorkflowRunCreator;
  publishTransientEvent?: WorkflowTransientEventPublisher;
}): LessonPlaybackApi => {
  const load = async (target: PlaybackTarget) => {
    const project = await dependencies.projectReader.loadProjectWithRevision(
      target.userId,
      target.projectId
    );
    const section = project && findProjectLessonSection(project.snapshot, target.sectionId);
    if (!project || !section) throw new LessonPlaybackTargetError();
    return { project, playback: readLessonPlayback(section) };
  };
  return {
    get: async target => {
      const { playback } = await load(target);
      return { lessonKey: playback.lessonKey, blocks: playback.blocks };
    },
    prepare: async input => {
      const { project, playback } = await load(input);
      if (playback.lessonKey !== input.lessonKey) throw new LessonPlaybackStaleError();
      const block = playback.blocks.find(candidate => candidate.id === input.blockId);
      if (!block) throw new LessonPlaybackTargetError();
      const model = await dependencies.resolveTtsModel();
      const voice = ttsClient.resolveVoice(model, input.voice);
      if (isPlaybackBlockReady(block, voice, model)) return { block };
      const { run } = await startWorkflowRun({
        input: { ...input, incarnationId: project.incarnationId, model },
        // One active preparation for the whole lesson also serializes different voices/blocks.
        dedupeKey: JSON.stringify([
          LESSON_PLAYBACK_WORKFLOW_ID,
          input.projectId,
          project.incarnationId,
          input.sectionId,
        ]),
        projectId: input.projectId,
        requestKey: randomUUID(),
        userId: input.userId,
        workflowId: LESSON_PLAYBACK_WORKFLOW_ID,
        registry: dependencies.registry,
        store: dependencies.store,
        publishTransientEvent: dependencies.publishTransientEvent,
      });
      const active = LessonPlaybackInputSchema.parse(run.input);
      return { runId: run.id, blockId: active.blockId, voice: active.voice };
    },
  };
};

const unavailable = async (): Promise<never> => {
  throw new WorkflowRuntimeUnavailableError();
};
export const unavailableLessonPlaybackApi: LessonPlaybackApi = {
  get: unavailable,
  prepare: unavailable,
};
