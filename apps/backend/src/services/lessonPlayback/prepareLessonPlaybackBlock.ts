import { MAX_VISUAL_LESSON_CHARS } from '@shared/lessonGenerationPolicy';
import type { LessonPlaybackBlock } from '@shared/lessonPlayback';
import {
  LessonSceneSchema,
  PlaybackAudioSchema,
  PlaybackPreparedSchema,
} from '@shared/lessonPlaybackSchema';
import type { LessonScene } from '@shared/lessonScene';
import type { ProjectLessonVisual } from '@shared/projectAsset';
import * as z from 'zod';
import type { GlobalModelConfig } from '../../config/modelConfig.js';
import type { WorkflowProviderEffectExecutor } from '../../workflows/types.js';
import { generateLessonScene } from '../lessonScenes/lessonSceneGeneration.js';
import { resolveLessonVisualModelConfig } from '../lessonVisualModelConfig.js';
import { type PreparedPlaybackAudio, preparePlaybackAudio } from './playbackAudio.js';
import { MAX_PLAYBACK_PREPARATION_ATTEMPTS, planPlaybackMotion } from './playbackMotion.js';

interface PrepareLessonPlaybackBlockInput {
  readonly providerEffect?: WorkflowProviderEffectExecutor;
  readonly ttsModel?: string;
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
  // Audio does not depend on the scene, so both are prepared at the same time.
  const [prepared, audio] = await Promise.all([prepareVisuals(input), prepareAudio(input)]);
  signal.throwIfAborted();
  return { prepared, audio };
};

const prepareVisuals = async (
  input: PrepareLessonPlaybackBlockInput
): Promise<PreparedLessonPlaybackBlock['prepared']> => {
  const { block, config, signal } = input;
  let prepared = block.prepared;
  if (!prepared) {
    const scene = input.providerEffect
      ? (
          await input.providerEffect.run({
            key: 'scene',
            outputSchema: z.object({ scene: LessonSceneSchema.optional() }),
            operation: async () => ({ scene: await prepareScene(input) }),
          })
        ).scene
      : await prepareScene(input);
    const planMotion = async () =>
      scene ? await planPlaybackMotion({ scene, speech: block.speech, config, signal }) : [];
    const motion = input.providerEffect
      ? await input.providerEffect.run({
          key: 'motion',
          outputSchema: PlaybackPreparedSchema.shape.motion,
          operation: planMotion,
        })
      : await planMotion();
    prepared = { ...(scene ? { scene } : {}), motion };
  }
  return prepared;
};

const prepareAudio = async (
  input: PrepareLessonPlaybackBlockInput
): Promise<PreparedPlaybackAudio> => {
  const { block, voice, signal } = input;
  const generateAudio = () =>
    preparePlaybackAudio({
      text: block.speech,
      voice,
      signal,
      ...(input.ttsModel ? { model: input.ttsModel } : {}),
    });
  let audio: PreparedPlaybackAudio;
  if (input.providerEffect) {
    const stored = await input.providerEffect.run({
      key: 'audio',
      outputSchema: PlaybackAudioSchema.omit({ asset: true }).extend({
        data: z.string(),
        mediaType: z.literal('audio/mpeg'),
      }),
      operation: async () => {
        const { bytes, ...metadata } = await generateAudio();
        return { ...metadata, data: Buffer.from(bytes).toString('base64') };
      },
    });
    const { data, ...metadata } = stored;
    audio = { ...metadata, bytes: Buffer.from(data, 'base64') };
  } else {
    audio = await generateAudio();
  }
  return audio;
};
