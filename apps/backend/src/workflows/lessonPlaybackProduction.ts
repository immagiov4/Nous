import { resolvePlaybackNarration } from '@shared/lessonPlayback';
import { LessonPlaybackBlockSchema } from '@shared/lessonPlaybackSchema';
import { isRetiredLessonScene } from '@shared/lessonScene';
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
  prepareLessonPlaybackVisuals,
  validatePlaybackSceneTypes,
} from '../services/lessonPlayback/prepareLessonPlaybackBlock.js';
import { readLessonSpeechProvenance } from '../services/lessonSpeechSource.js';
import { ttsClient } from '../services/ttsClient.js';
import { isPlaybackBlockReady, isPlaybackVisualReady } from './lessonPlaybackApi.js';
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
    allowedSceneTypes,
    supportsSpokenMath = true,
    supportsFencedCode = true,
    supportsUnlinkedFormulaSymbols = true,
    synchronizeAnimations = false,
    supportsVisualSections = true
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
    const visualSources = supportsVisualSections ? lesson.sources : [];
    if (
      input.visualOnly
        ? isPlaybackVisualReady(block, visualSources)
        : isPlaybackBlockReady(block, ttsClient.resolveVoice(input.model, input.voice), input.model)
    ) {
      return { target: input, block: LessonPlaybackBlockSchema.parse(block) };
    }
    if (!providerEffect) throw new Error('Playback preparation requires durable provider results.');
    const preparationInput = {
      userId: input.userId,
      synchronizeAnimations,
      supportsVisualSections,
      allowedSceneTypes,
      supportsSpokenMath,
      supportsFencedCode,
      supportsUnlinkedFormulaSymbols,
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
    if (input.visualOnly) {
      const resolved = resolvePlaybackNarration(block);
      const prepared = await prepareLessonPlaybackVisuals(
        {
          ...preparationInput,
          block: {
            ...resolved,
            visuals: [],
            prepared: { ...block.prepared, scene: undefined, motion: [] },
          },
        },
        true
      );
      if (!prepared.scene || isRetiredLessonScene(prepared.scene))
        throw failPermanently({
          code: 'lesson_playback_scene_invalid',
          message: 'No usable passage visual was prepared.',
        });
      return { target: input, block: LessonPlaybackBlockSchema.parse({ ...block, prepared }) };
    }
    const prepared = await prepareLessonPlaybackBlock(preparationInput);
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
