import { createHash } from 'node:crypto';
import { resolvePlaybackNarration } from '@shared/lessonPlayback';
import { PlaybackWordAlignmentSchema } from '@shared/lessonPlaybackSchema';
import * as z from 'zod';
import { readLessonPlayback } from '../projects/lessonPlayback.js';
import type { ProjectAssetReader } from '../projects/projectAssetReader.js';
import { findProjectLessonSection } from '../projects/projectLesson.js';
import { getProjectStore } from '../projects/projectStore.js';
import {
  type LockedProjectSnapshot,
  patchProjectInTransaction,
} from '../projects/projectTransaction.js';
import { readProjectLanguage } from '../services/lessonGenerationSources.js';
import { alignRecording } from '../services/lessonPlayback/alignRecording.js';
import { timestampIso } from '../utils/time.js';
import { WorkflowExecutionDefaultsSchema } from './config.js';
import { step, type WorkflowRegistry, workflow } from './definition.js';
import { LessonPlaybackInputSchema } from './lessonPlaybackWorkflow.js';
import {
  appendProjectRevisionNotification,
  LESSON_PROJECT_REVISION_EVENT,
  PROJECT_REVISION_EVENT_SCHEMA_VERSION,
  ProjectRevisionEventSchema,
} from './projectRevisionNotifications.js';
import type {
  StepCommitContext,
  StepExecutionContext,
  WorkflowExecutionDefaults,
} from './types.js';
import { startWorkflowRun, type WorkflowRunCreator } from './workflowStart.js';

export const RECORDING_ALIGNMENT_WORKFLOW_ID = 'align-playback-recording';
const InputSchema = LessonPlaybackInputSchema.extend({ assetId: z.string().length(64) });
const ResultSchema = z.object({
  target: InputSchema,
  speech: z.string(),
  alignment: PlaybackWordAlignmentSchema.nullable(),
});
type AlignmentInput = z.infer<typeof InputSchema>;
type AlignmentResult = z.infer<typeof ResultSchema>;
interface AlignmentServices {
  alignPlaybackRecording(
    context: StepExecutionContext<AlignmentInput, WorkflowExecutionDefaults, AlignmentServices>
  ): Promise<AlignmentResult>;
  persistRecordingAlignment(
    context: StepCommitContext<
      AlignmentInput,
      AlignmentResult,
      WorkflowExecutionDefaults,
      AlignmentServices
    >
  ): Promise<void>;
}

export function createRecordingAlignmentWorkflow(executionDefaults: WorkflowExecutionDefaults) {
  return workflow({
    id: RECORDING_ALIGNMENT_WORKFLOW_ID,
    compatibilityId: 'align-playback-recording-v1',
    configSchema: WorkflowExecutionDefaultsSchema,
    executionDefaults,
    inputSchema: InputSchema,
    outputSchema: ResultSchema,
    events: {
      [LESSON_PROJECT_REVISION_EVENT]: {
        durability: 'durable',
        schema: ProjectRevisionEventSchema,
        schemaVersion: PROJECT_REVISION_EVENT_SCHEMA_VERSION,
      },
    },
    root: step<
      typeof InputSchema,
      typeof ResultSchema,
      WorkflowExecutionDefaults,
      AlignmentServices
    >({
      id: 'align-recording',
      inputSchema: InputSchema,
      outputSchema: ResultSchema,
      run: context => context.services.alignPlaybackRecording(context),
      commit: context => context.services.persistRecordingAlignment(context),
    }),
  });
}

export function buildRecordingAlignmentPatch(
  project: LockedProjectSnapshot,
  result: AlignmentResult
) {
  const { target, alignment } = result;
  const section = findProjectLessonSection(project.snapshot, target.sectionId);
  const playback = section && readLessonPlayback(section);
  const block = playback?.blocks.find(block => block.id === target.blockId);
  if (
    !alignment ||
    !playback ||
    !block ||
    project.incarnationId !== target.incarnationId ||
    playback.lessonKey !== target.lessonKey ||
    resolvePlaybackNarration(block).speech !== result.speech ||
    !block.audio.some(audio => audio.asset.id === target.assetId && !audio.wordAlignment)
  )
    return null;
  return {
    section: {
      sectionId: target.sectionId,
      playback: {
        ...playback,
        blocks: playback.blocks.map(saved =>
          saved.id !== block.id
            ? saved
            : {
                ...saved,
                audio: saved.audio.map(audio =>
                  audio.asset.id !== target.assetId || audio.wordAlignment
                    ? audio
                    : { ...audio, wordAlignment: alignment }
                ),
              }
        ),
      },
    },
  };
}

export function createProductionRecordingAlignmentServices(
  assets: ProjectAssetReader
): AlignmentServices {
  return {
    alignPlaybackRecording: async ({ input: target, signal }) => {
      const project = await getProjectStore().loadProjectWithRevision(
        target.userId,
        target.projectId
      );
      const section = project && findProjectLessonSection(project.snapshot, target.sectionId);
      const playback = section && readLessonPlayback(section);
      const block = playback?.blocks.find(block => block.id === target.blockId);
      const audio = block?.audio.find(audio => audio.asset.id === target.assetId);
      const speech = block ? resolvePlaybackNarration(block).speech : '';
      if (
        !audio ||
        audio.wordAlignment ||
        project?.incarnationId !== target.incarnationId ||
        playback?.lessonKey !== target.lessonKey
      )
        return { target, speech, alignment: null };
      try {
        const file = await assets.readActive({ ...target, assetId: target.assetId });
        if (!file) throw new Error('Recording asset is unavailable.');
        const alignment = await alignRecording({
          ...file,
          speech,
          language: readProjectLanguage(project.snapshot),
          durationSeconds: audio.durationSeconds,
          signal,
        });
        return { target, speech, alignment };
      } catch (error) {
        signal.throwIfAborted();
        console.warn('[recording-alignment] Keeping estimated word timing.', error);
        return { target, speech, alignment: { status: 'failed' } };
      }
    },
    persistRecordingAlignment: async ({ output, transaction, execution }) => {
      const saved = await patchProjectInTransaction(transaction, {
        projectId: output.target.projectId,
        userId: output.target.userId,
        playbackWrite: true,
        updatedAt: timestampIso(),
        buildPatch: project => buildRecordingAlignmentPatch(project, output),
      });
      if (saved.projectChanged) {
        if (saved.meta.revision === undefined)
          throw new Error('Recording alignment revision is missing.');
        await appendProjectRevisionNotification(transaction, {
          eventType: LESSON_PROJECT_REVISION_EVENT,
          projectId: output.target.projectId,
          revision: saved.meta.revision,
          runId: execution.runId,
        });
      }
    },
  };
}

/** Stable request identity also deduplicates completed attempts and concurrent API readers. */
export function createRecordingAlignmentStarter(dependencies: {
  registry: WorkflowRegistry;
  store: WorkflowRunCreator;
}) {
  return async (
    target: z.infer<typeof LessonPlaybackInputSchema>,
    block: import('@shared/lessonPlayback').LessonPlaybackBlock
  ) => {
    for (const audio of block.audio) {
      if (audio.wordAlignment) continue;
      const input = { ...target, voice: audio.voice, model: audio.model, assetId: audio.asset.id };
      const identity = createHash('sha256')
        .update(
          JSON.stringify([
            input.userId,
            input.projectId,
            input.incarnationId,
            input.sectionId,
            input.lessonKey,
            input.blockId,
            input.assetId,
            input.model,
            input.voice,
          ])
        )
        .digest('hex');
      await startWorkflowRun({
        ...dependencies,
        input,
        userId: target.userId,
        projectId: target.projectId,
        workflowId: RECORDING_ALIGNMENT_WORKFLOW_ID,
        requestKey: identity,
        dedupeKey: `${RECORDING_ALIGNMENT_WORKFLOW_ID}:${identity}`,
      });
    }
  };
}
