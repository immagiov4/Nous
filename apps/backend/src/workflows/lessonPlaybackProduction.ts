import { LessonPlaybackBlockSchema } from '@shared/lessonPlaybackSchema';

import { getResolvedGlobalModelConfig } from '../config/modelConfig.js';
import { lessonPlaybackVisuals, readLessonPlayback } from '../projects/lessonPlayback.js';
import type { ProjectAssetWriter } from '../projects/projectAsset.js';
import { findProjectLessonSection } from '../projects/projectLesson.js';
import { getProjectStore } from '../projects/projectStore.js';
import type { ProjectStore } from '../projects/types.js';
import { prepareLessonPlaybackBlock } from '../services/lessonPlayback/prepareLessonPlaybackBlock.js';
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
    allowedSceneTypes
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
    if (
      isPlaybackBlockReady(block, ttsClient.resolveVoice(input.model, input.voice), input.model)
    ) {
      return { target: input, block: LessonPlaybackBlockSchema.parse(block) };
    }
    if (!providerEffect) throw new Error('Playback preparation requires durable provider results.');
    const prepared = await prepareLessonPlaybackBlock({
      allowedSceneTypes,
      block,
      lesson: {
        title: typeof section.title === 'string' ? section.title : '',
        generatedVisuals: lessonPlaybackVisuals(section),
      },
      config: await getResolvedGlobalModelConfig(),
      voice: input.voice,
      ttsModel: input.model,
      providerEffect,
      signal,
    });
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
