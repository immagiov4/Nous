import { randomUUID } from 'node:crypto';
import type { LessonPlaybackBlock, PlaybackContentBlock } from '@shared/lessonPlayback';
import { hasPreparedVisualSections } from '@shared/playbackVisualSections';

import { lessonPlaybackContent, readLessonPlayback } from '../projects/lessonPlayback.js';
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
export class LessonPlaybackVoiceError extends Error {}

interface PlaybackTarget {
  userId: string;
  projectId: string;
  sectionId: string;
}
type RecordedPlaybackResult = { block: LessonPlaybackBlock; voice: string; model: string };
export type PlaybackPreparationResult =
  | RecordedPlaybackResult
  | {
      runId: string;
      blockId: string;
      voice: string;
      created: boolean;
      recorded?: RecordedPlaybackResult;
    };
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
  model: string,
  sources: readonly PlaybackContentBlock[] = []
): boolean =>
  Boolean(
    block.prepared &&
      hasPreparedVisualSections(block, sources) &&
      block.audio.some(audio => audio.voice === voice && audio.model === model)
  );

export const createLessonPlaybackApi = (dependencies: {
  projectReader: Pick<ProjectStore, 'loadProjectWithRevision'>;
  resolveTtsModel: () => Promise<string>;
  registry: WorkflowRegistry;
  store: WorkflowRunCreator;
  publishTransientEvent?: WorkflowTransientEventPublisher;
  alignRecording?: (
    target: import('./lessonPlaybackWorkflow.js').LessonPlaybackInput,
    block: LessonPlaybackBlock
  ) => Promise<void>;
}): LessonPlaybackApi => {
  const load = async (target: PlaybackTarget) => {
    const project = await dependencies.projectReader.loadProjectWithRevision(
      target.userId,
      target.projectId
    );
    const section = project && findProjectLessonSection(project.snapshot, target.sectionId);
    if (!project || !section) throw new LessonPlaybackTargetError();
    return {
      project,
      sources: lessonPlaybackContent(section),
      playback: readLessonPlayback(section),
    };
  };
  return {
    get: async target => {
      const { playback } = await load(target);
      return { lessonKey: playback.lessonKey, blocks: playback.blocks };
    },
    prepare: async input => {
      if (!ttsClient.getVoiceProfiles().some(profile => profile.id === input.voice)) {
        throw new LessonPlaybackVoiceError();
      }
      const { project, playback, sources } = await load(input);
      if (playback.lessonKey !== input.lessonKey) throw new LessonPlaybackStaleError();
      const block = playback.blocks.find(candidate => candidate.id === input.blockId);
      if (!block) throw new LessonPlaybackTargetError();
      const model = await dependencies.resolveTtsModel();
      const voice = ttsClient.resolveVoice(model, input.voice);
      if (isPlaybackBlockReady(block, voice, model, sources)) {
        // Playback receives the saved audio immediately; alignment has its own durable run.
        void dependencies
          .alignRecording?.({ ...input, incarnationId: project.incarnationId, voice, model }, block)
          .catch(error => console.warn('[recording-alignment] Could not queue recording.', error));
        return { block, voice, model };
      }
      const { run, created } = await startWorkflowRun({
        input: { ...input, incarnationId: project.incarnationId, model },
        // Voices share one block preparation so narration stays canonical; other blocks can fill the buffer.
        dedupeKey: JSON.stringify([
          LESSON_PLAYBACK_WORKFLOW_ID,
          input.projectId,
          project.incarnationId,
          input.sectionId,
          input.lessonKey,
          input.blockId,
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
      return {
        runId: run.id,
        blockId: active.blockId,
        voice: active.voice,
        created,
        ...(block.audio.some(audio => audio.voice === voice && audio.model === model)
          ? { recorded: { block, voice, model } }
          : {}),
      };
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
