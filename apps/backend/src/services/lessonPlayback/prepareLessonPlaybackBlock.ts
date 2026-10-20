import { MAX_VISUAL_LESSON_CHARS } from '@shared/lessonGenerationPolicy';
import {
  type LessonPlaybackBlock,
  resolvePlaybackNarration,
  validatePlaybackSpokenMath,
} from '@shared/lessonPlayback';
import {
  LessonSceneSchema,
  PlaybackAudioSchema,
  PlaybackPreparedSchema,
  PlaybackSpokenMathSchema,
} from '@shared/lessonPlaybackSchema';
import { isAnimatedLessonScene, type LessonScene, type LessonSceneType } from '@shared/lessonScene';
import type { ProjectLessonVisual } from '@shared/projectAsset';
import * as z from 'zod';
import type { GlobalModelConfig } from '../../config/modelConfig.js';
import { failPermanently } from '../../workflows/retryPolicy.js';
import type { WorkflowProviderEffectExecutor } from '../../workflows/types.js';
import type { WorkflowErrorDiagnostic } from '../../workflows/workflowErrorDiagnostics.js';
import { generateLessonScene } from '../lessonScenes/lessonSceneGeneration.js';
import { resolveLessonVisualModelConfig } from '../lessonVisualModelConfig.js';
import {
  type PreparedPlaybackAudio,
  preparePlaybackAudio,
  validatePlaybackText,
} from './playbackAudio.js';
import { MAX_PLAYBACK_PREPARATION_ATTEMPTS, planPlaybackMotion } from './playbackMotion.js';
import {
  generatePlaybackNarration,
  generatePlaybackSpokenMath,
  PlaybackNarrationResponseSchema,
} from './playbackSpokenMath.js';

interface PrepareLessonPlaybackBlockInput {
  readonly supportsSpokenMath?: boolean;
  readonly supportsFencedCode?: boolean;
  readonly allowedSceneTypes?: readonly LessonSceneType[];
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

const existingScenes = ({
  block,
  lesson,
}: Pick<PrepareLessonPlaybackBlockInput, 'block' | 'lesson'>): LessonScene[] =>
  block.visuals.flatMap(visual => {
    if (visual.kind === 'scene') return [visual.scene];
    if (visual.kind !== 'generated-visual') return [];
    const render = lesson.generatedVisuals?.find(stored => stored.id === visual.visualId)?.render;
    return render?.kind === 'scene' ? [render.scene] : [];
  });

/** Check persisted scenes against the resumed catalog before starting provider or asset work. */
export const validatePlaybackSceneTypes = (
  input: Pick<PrepareLessonPlaybackBlockInput, 'block' | 'lesson' | 'allowedSceneTypes'>
): void => {
  const { allowedSceneTypes } = input;
  if (!allowedSceneTypes) return;
  const scenes = existingScenes(input);
  if (input.block.prepared?.scene) scenes.push(input.block.prepared.scene);
  if (scenes.some(scene => !allowedSceneTypes.includes(scene.type))) {
    throw failPermanently({
      code: 'lesson_playback_scene_invalid',
      message: 'A stored playback scene is outside the resumed visual contract.',
    });
  }
};

const prepareScene = async (
  input: PrepareLessonPlaybackBlockInput
): Promise<LessonScene | undefined> => {
  const { block, config, signal } = input;
  if (block.visuals.length) {
    const scenes = existingScenes(input);
    // Motion events carry no scene id, so a block with several scenes shows them without motion.
    return scenes.length === 1 ? scenes[0] : undefined;
  }
  // A prepared block must cover its complete speech, not silently inherit the lesson excerpt cut.
  if (block.speech.length > MAX_VISUAL_LESSON_CHARS) {
    throw new Error('Playback block speech exceeds the scene generation text limit.');
  }
  let retryFeedback: string | undefined;
  let diagnostic: WorkflowErrorDiagnostic | undefined;
  for (let attempt = 0; attempt < MAX_PLAYBACK_PREPARATION_ATTEMPTS; attempt += 1) {
    signal.throwIfAborted();
    const outcome = await generateLessonScene({
      allowedSceneTypes: input.allowedSceneTypes,
      config: resolveLessonVisualModelConfig(config),
      lessonMarkdown: block.speech,
      retryFeedback,
      // Only this block is admissible evidence; lesson metadata can describe other passages.
      sectionDescription: '',
      sectionTitle: '',
      signal,
    });
    signal.throwIfAborted();
    if (outcome.kind === 'scene') return outcome.scene;
    retryFeedback = outcome.problems.join('\n');
    diagnostic = outcome.diagnostic;
  }
  throw failPermanently({
    code: 'lesson_playback_scene_invalid',
    message: 'Playback scene preparation failed validation after corrective attempts.',
    ...(diagnostic ? { details: { diagnostic } } : {}),
  });
};

/** Prepares one block's visual cues and audio; the caller owns its eventual asset reference. */
export const prepareLessonPlaybackBlock = async (
  input: PrepareLessonPlaybackBlockInput
): Promise<PreparedLessonPlaybackBlock> => {
  const { signal } = input;
  signal.throwIfAborted();
  validatePlaybackText(input.block.speech);
  validatePlaybackSceneTypes(input);
  const narration = await prepareNarration(input);
  signal.throwIfAborted();
  const request = {
    ...input,
    block: resolvePlaybackNarration(input.block, narration.spokenMath, narration.fencedCode),
  };
  validatePlaybackText(request.block.speech);
  // Audio does not depend on the scene, so both are prepared at the same time. Both settle
  // before a failure propagates, so a retry never overlaps paid work still in flight.
  const [visuals, audio] = await Promise.allSettled([
    prepareVisuals(request),
    prepareAudio(request),
  ]);
  if (visuals.status === 'rejected') throw visuals.reason;
  if (audio.status === 'rejected') throw audio.reason;
  signal.throwIfAborted();
  return {
    prepared: !input.block.prepared ? { ...visuals.value, ...narration } : visuals.value,
    audio: audio.value,
  };
};

const prepareNarration = async (input: PrepareLessonPlaybackBlockInput) => {
  const { block } = input;
  if (block.prepared)
    return { spokenMath: block.prepared.spokenMath, fencedCode: block.prepared.fencedCode };
  if (input.supportsFencedCode !== false && block.spans.some(span => span.fencedCode)) {
    return input.providerEffect
      ? input.providerEffect.run({
          key: 'narration',
          outputSchema: PlaybackNarrationResponseSchema,
          operation: () => generatePlaybackNarration(input),
        })
      : generatePlaybackNarration(input);
  }
  const spokenMath = await prepareSpokenMath(input);
  return spokenMath ? { spokenMath } : {};
};

const prepareSpokenMath = async (input: PrepareLessonPlaybackBlockInput) => {
  const { block } = input;
  if (block.prepared) return block.prepared.spokenMath;
  if (input.supportsSpokenMath === false || !block.spans.some(span => span.math)) return undefined;
  const operation = () => generatePlaybackSpokenMath(input);
  const spokenMath = input.providerEffect
    ? await input.providerEffect.run({
        key: 'spoken-math',
        outputSchema: PlaybackSpokenMathSchema,
        operation,
      })
    : await operation();
  validatePlaybackSpokenMath(block, spokenMath);
  return spokenMath;
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
      scene && !isAnimatedLessonScene(scene)
        ? await planPlaybackMotion({ scene, speech: block.speech, config, signal })
        : [];
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
