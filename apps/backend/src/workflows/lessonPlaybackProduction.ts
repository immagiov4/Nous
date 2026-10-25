import { LessonPlaybackBlockSchema } from '@shared/lessonPlaybackSchema';
import { getResolvedGlobalModelConfig } from '../config/modelConfig.js';
import {
  lessonPlaybackContent,
  lessonPlaybackVisuals,
  readLessonPlayback,
} from '../projects/lessonPlayback.js';
import type { ProjectAssetWriter } from '../projects/projectAsset.js';
import { findProjectLessonSection } from '../projects/projectLesson.js';
import { getProjectStore } from '../projects/projectStore.js';
import type { ProjectStore } from '../projects/types.js';
import {
  prepareLessonPlaybackBlock,
  prepareVisuals,
  validatePlaybackSceneTypes,
} from '../services/lessonPlayback/prepareLessonPlaybackBlock.js';
import { readLessonSpeechProvenance } from '../services/lessonSpeechSource.js';
import { ttsClient } from '../services/ttsClient.js';
import { isPlaybackBlockReady } from './lessonPlaybackApi.js';
import { createLessonPlaybackPersistence } from './lessonPlaybackPersistence.js';
import type { LessonPlaybackServices } from './lessonPlaybackWorkflow.js';
import { failPermanently } from './retryPolicy.js';

export const createProductionLessonPlaybackServices = (
  assets: ProjectAssetWriter,
  projectStore: Pick<ProjectStore, 'loadProjectWithRevision'> = getProjectStore()
): LessonPlaybackServices => ({
  persistPlayback: createLessonPlaybackPersistence({ assets }),
  preparePlayback: async (
    { input, signal, execution, idempotencyKey, providerEffect },
    {
      allowedSceneTypes,
      supportsSpokenMath = true,
      supportsFencedCode = true,
      supportsUnlinkedFormulaSymbols = true,
      synchronizeAnimations = false,
      supportsFormulaSpotlights = true,
    } = {}
  ) => {
    const project = await projectStore.loadProjectWithRevision(input.userId, input.projectId);
    const section = project && findProjectLessonSection(project.snapshot, input.sectionId);
    const playback = section && readLessonPlayback(section);
    const block = playback?.blocks.find(candidate => candidate.id === input.blockId);
    if (
      !section ||
      !block ||
      project?.incarnationId !== input.incarnationId ||
      playback?.lessonKey !== input.lessonKey
    ) {
      throw failPermanently({
        code: 'lesson_playback_stale',
        message: 'The lesson changed before playback preparation.',
      });
    }
    signal.throwIfAborted();
    const lesson = {
      title: typeof section.title === 'string' ? section.title : '',
      description: typeof section.description === 'string' ? section.description : '',
      generatedVisuals: lessonPlaybackVisuals(section),
      sources: lessonPlaybackContent(section),
    };
    validatePlaybackSceneTypes({
      block,
      lesson,
      allowedSceneTypes,
      supportsUnlinkedFormulaSymbols,
    });
    if (
      isPlaybackBlockReady(block, ttsClient.resolveVoice(input.model, input.voice), input.model, {
        supportsFormulaSpotlights,
        storedVisuals: lesson.generatedVisuals,
        sources: lesson.sources,
      })
    ) {
      return { target: input, block: LessonPlaybackBlockSchema.parse(block) };
    }
    if (!providerEffect) throw new Error('Playback preparation requires durable provider results.');
    const request = {
      userId: input.userId,
      synchronizeAnimations,
      allowedSceneTypes,
      supportsSpokenMath,
      supportsFencedCode,
      supportsUnlinkedFormulaSymbols,
      supportsFormulaSpotlights,
      block,
      lesson: {
        ...lesson,
        sourceProvenance: readLessonSpeechProvenance(project.snapshot, input.sectionId),
      },
      config: await getResolvedGlobalModelConfig(),
      voice: input.voice,
      ttsModel: input.model,
      providerEffect,
      signal,
    };
    const recording = block.audio.find(
      audio =>
        audio.voice === ttsClient.resolveVoice(input.model, input.voice) &&
        audio.model === input.model
    );
    if (block.prepared && recording) {
      return {
        target: input,
        block: LessonPlaybackBlockSchema.parse({
          ...block,
          prepared: await prepareVisuals(request),
        }),
      };
    }
    const prepared = await prepareLessonPlaybackBlock(request);
    const { bytes, mediaType, ...audio } = prepared.audio;
    const asset = await assets.stage({
      bytes,
      mediaType,
      idempotencyKey,
      ...execution,
      projectId: input.projectId,
      userId: input.userId,
      signal,
    });
    return {
      target: input,
      assetOwner: execution.nodeInstanceId,
      block: LessonPlaybackBlockSchema.parse({
        ...block,
        prepared: prepared.prepared,
        audio: [{ ...audio, asset }],
      }),
    };
  },
});
