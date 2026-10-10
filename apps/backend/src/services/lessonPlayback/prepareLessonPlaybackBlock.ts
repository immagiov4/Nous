import { MAX_VISUAL_LESSON_CHARS } from '@shared/lessonGenerationPolicy';
import type { LessonPlaybackBlock } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import type { ProjectLessonVisual } from '@shared/projectAsset';

import type { GlobalModelConfig } from '../../config/modelConfig.js';
import { generateLessonScene } from '../lessonScenes/lessonSceneGeneration.js';
import { resolveLessonVisualModelConfig } from '../lessonVisualModelConfig.js';
import { type PreparedPlaybackAudio, preparePlaybackAudio } from './playbackAudio.js';
import { MAX_PLAYBACK_PREPARATION_ATTEMPTS, planPlaybackMotion } from './playbackMotion.js';

interface PrepareLessonPlaybackBlockInput {
  readonly block: LessonPlaybackBlock;
  readonly lesson: {
    readonly title: string;
    readonly description?: string;
    readonly generatedVisuals?: readonly ProjectLessonVisual[];
  };
  readonly voice: string;
  readonly config: GlobalModelConfig;
  readonly signal: AbortSignal;
}

export interface PreparedLessonPlaybackBlock {
  readonly prepared: NonNullable<LessonPlaybackBlock['prepared']>;
  readonly audio: PreparedPlaybackAudio;
}

const existingScene = ({
  block,
  lesson,
}: PrepareLessonPlaybackBlockInput): LessonScene | undefined => {
  const scenes = block.visuals.flatMap(visual => {
    if (visual.kind === 'scene') return [visual.scene];
    if (visual.kind !== 'generated-visual') return [];
    const render = lesson.generatedVisuals?.find(stored => stored.id === visual.visualId)?.render;
    return render?.kind === 'scene' ? [render.scene] : [];
  });
  // Motion events carry no scene id, so a block with several scenes shows them without motion.
  return scenes.length === 1 ? scenes[0] : undefined;
};

const prepareScene = async (
  input: PrepareLessonPlaybackBlockInput
): Promise<LessonScene | undefined> => {
  const { block, lesson, config, signal } = input;
  if (block.visuals.length) return existingScene(input);
  // A prepared block must cover its complete speech, not silently inherit the lesson excerpt cut.
  if (block.speech.length > MAX_VISUAL_LESSON_CHARS) {
    throw new Error('Playback block speech exceeds the scene generation text limit.');
  }
  let retryFeedback: string | undefined;
  for (let attempt = 0; attempt < MAX_PLAYBACK_PREPARATION_ATTEMPTS; attempt += 1) {
    signal.throwIfAborted();
    const outcome = await generateLessonScene({
      config: resolveLessonVisualModelConfig(config),
      lessonMarkdown: block.speech,
      retryFeedback,
      sectionDescription: lesson.description ?? '',
      sectionTitle: block.heading || lesson.title,
      signal,
    });
    signal.throwIfAborted();
    if (outcome.kind === 'scene') return outcome.scene;
    retryFeedback = outcome.problems.join('\n');
  }
  throw new Error('Playback scene preparation failed validation after corrective attempts.');
};

/** Prepares one block's visual cues and audio; the caller owns its eventual asset reference. */
export const prepareLessonPlaybackBlock = async (
  input: PrepareLessonPlaybackBlockInput
): Promise<PreparedLessonPlaybackBlock> => {
  const { block, voice, config, signal } = input;
  signal.throwIfAborted();
  let prepared = block.prepared;
  if (!prepared) {
    const scene = await prepareScene(input);
    const motion = scene
      ? await planPlaybackMotion({ scene, speech: block.speech, config, signal })
      : [];
    prepared = { ...(scene ? { scene } : {}), motion };
  }
  const audio = await preparePlaybackAudio({ text: block.speech, voice, signal });
  signal.throwIfAborted();
  return { prepared, audio };
};
