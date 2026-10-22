import { createHash } from 'node:crypto';
import { MAX_VISUAL_LESSON_CHARS } from '@shared/lessonGenerationPolicy';
import {
  getPlaybackMathMarkdown,
  type LessonPlaybackBlock,
  motionTargets,
  type PlaybackMotionEvent,
} from '@shared/lessonPlayback';
import {
  LessonSceneSchema,
  PlaybackAudioSchema,
  PlaybackPreparedSchema,
} from '@shared/lessonPlaybackSchema';
import { isAnimatedLessonScene, type LessonScene, type LessonSceneType } from '@shared/lessonScene';
import type { ProjectLessonVisual } from '@shared/projectAsset';
import * as z from 'zod';
import type { GlobalModelConfig } from '../../config/modelConfig.js';
import { failPermanently } from '../../workflows/retryPolicy.js';
import type { WorkflowProviderEffectExecutor } from '../../workflows/types.js';
import type { WorkflowErrorDiagnostic } from '../../workflows/workflowErrorDiagnostics.js';
import type { LessonSourceProvenance } from '../lessonPrimarySourceContext.js';
import { generateLessonScene } from '../lessonScenes/lessonSceneGeneration.js';
import { resolveLessonVisualModelConfig } from '../lessonVisualModelConfig.js';
import { prepareSpeech } from '../speechPreparation.js';
import {
  type PreparedPlaybackAudio,
  preparePlaybackAudio,
  validatePlaybackText,
} from './playbackAudio.js';
import { MAX_PLAYBACK_PREPARATION_ATTEMPTS, planPlaybackMotion } from './playbackMotion.js';

interface PrepareLessonPlaybackBlockInput {
  readonly userId: string;
  readonly supportsSpokenMath?: boolean;
  readonly supportsFencedCode?: boolean;
  readonly allowedSceneTypes?: readonly LessonSceneType[];
  readonly providerEffect?: WorkflowProviderEffectExecutor;
  readonly ttsModel?: string;
  readonly block: LessonPlaybackBlock;
  readonly lesson: {
    readonly title: string;
    readonly description?: string;
    readonly sourceProvenance?: LessonSourceProvenance;
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
  input: PrepareLessonPlaybackBlockInput,
  onValidatedScene?: (scene: LessonScene) => void
): Promise<LessonScene | undefined> => {
  const { block, config, signal } = input;
  const mathMarkdown = getPlaybackMathMarkdown(block);
  if (block.visuals.length && !mathMarkdown) {
    const scenes = existingScenes(input);
    // Motion events carry no scene id, so a block with several scenes shows them without motion.
    return scenes.length === 1 ? scenes[0] : undefined;
  }
  // A prepared block must cover its complete speech, not silently inherit the lesson excerpt cut.
  if (Math.max(block.speech.length, mathMarkdown?.length ?? 0) > MAX_VISUAL_LESSON_CHARS) {
    throw new Error('Playback block speech exceeds the scene generation text limit.');
  }
  let retryFeedback: string | undefined;
  let diagnostic: WorkflowErrorDiagnostic | undefined;
  for (let attempt = 0; attempt < MAX_PLAYBACK_PREPARATION_ATTEMPTS; attempt += 1) {
    signal.throwIfAborted();
    const outcome = await generateLessonScene({
      onValidatedScene,
      allowedSceneTypes: input.allowedSceneTypes,
      config: resolveLessonVisualModelConfig(config),
      lessonMarkdown: mathMarkdown ?? block.speech,
      narration: block.speech,
      allowTextFallback: true,
      retryFeedback,
      // Only this block is admissible evidence; lesson metadata can describe other passages.
      sectionDescription: '',
      sourceProvenance: input.lesson.sourceProvenance,
      sectionTitle: '',
      signal,
    });
    signal.throwIfAborted();
    if (outcome.kind === 'scene') return outcome.scene;
    if (outcome.kind === 'text') return undefined;
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
  const speech = await prepareSpeech({ ...input, sourceProvenance: input.lesson.sourceProvenance });
  const { narration } = speech;
  signal.throwIfAborted();
  const request = {
    ...input,
    block: speech.block,
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

const prepareVisuals = async (
  input: PrepareLessonPlaybackBlockInput
): Promise<PreparedLessonPlaybackBlock['prepared']> => {
  const { block, config, signal } = input;
  let prepared = block.prepared;
  if (!prepared) {
    const motions = new Map<string, Promise<readonly PlaybackMotionEvent[]>>();
    const prepareMotion = (scene?: LessonScene) => {
      // Icons do not affect motion targets. A failed icon request can regenerate a different scene.
      const sceneKey = createHash('sha256')
        .update(
          JSON.stringify(
            scene ? { type: scene.type, title: scene.title, targets: motionTargets(scene) } : null
          )
        )
        .digest('hex');
      const planMotion = async () =>
        scene && scene.type !== 'formula-spotlight' && !isAnimatedLessonScene(scene)
          ? await planPlaybackMotion({
              scene,
              speech: block.speech,
              config,
              signal,
              sourceProvenance: input.lesson.sourceProvenance,
            })
          : [];
      let motion = motions.get(sceneKey);
      if (!motion) {
        motion = input.providerEffect
          ? input.providerEffect.run({
              key: `motion:${sceneKey}`,
              outputSchema: PlaybackPreparedSchema.shape.motion,
              operation: planMotion,
            })
          : planMotion();
        motions.set(sceneKey, motion);
      }
      return motion;
    };
    // The owner awaits this promise after icons, retaining its failure until both settle.
    const onValidatedScene = (scene: LessonScene) => {
      void prepareMotion(scene).catch(() => {});
    };
    try {
      const scene = input.providerEffect
        ? (
            await input.providerEffect.run({
              key: 'scene',
              outputSchema: z.object({ scene: LessonSceneSchema.optional() }),
              operation: async () => ({ scene: await prepareScene(input, onValidatedScene) }),
            })
          ).scene
        : await prepareScene(input, onValidatedScene);
      const savedMotion = input.providerEffect
        ? await input.providerEffect.run({
            key: 'motion',
            outputSchema: PlaybackPreparedSchema.shape.motion,
            operation: () => prepareMotion(scene),
          })
        : await prepareMotion(scene);
      prepared = { ...(scene ? { scene } : {}), motion: savedMotion };
    } finally {
      // A competing workflow attempt can commit a different authoritative scene.
      await Promise.allSettled(motions.values());
    }
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
