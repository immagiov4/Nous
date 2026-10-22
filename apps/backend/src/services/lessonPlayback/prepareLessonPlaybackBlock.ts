import { type FormulaSpotlightData, formulaSpotlightCovers } from '@shared/formulaSpotlight';
import { MAX_VISUAL_LESSON_CHARS } from '@shared/lessonGenerationPolicy';
import {
  getPlaybackFormulaMarkdown,
  getPlaybackFormulaSources,
  type LessonPlaybackBlock,
  type PlaybackContentBlock,
} from '@shared/lessonPlayback';
import {
  LessonSceneSchema,
  PlaybackAudioSchema,
  PlaybackPreparedSchema,
} from '@shared/lessonPlaybackSchema';
import {
  isAnimatedLessonScene,
  LESSON_SCENE_TYPES,
  type LessonScene,
  type LessonSceneType,
} from '@shared/lessonScene';
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
  readonly supportsUnlinkedFormulaSymbols?: boolean;
  readonly allowedSceneTypes?: readonly LessonSceneType[];
  readonly providerEffect?: WorkflowProviderEffectExecutor;
  readonly ttsModel?: string;
  readonly block: LessonPlaybackBlock;
  readonly lesson: {
    readonly title: string;
    readonly description?: string;
    readonly sourceProvenance?: LessonSourceProvenance;
    readonly sources?: readonly PlaybackContentBlock[];
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
  input: Pick<
    PrepareLessonPlaybackBlockInput,
    'block' | 'lesson' | 'allowedSceneTypes' | 'supportsUnlinkedFormulaSymbols'
  >
): void => {
  const { allowedSceneTypes } = input;
  const scenes = existingScenes(input);
  if (input.block.prepared?.scene) scenes.push(input.block.prepared.scene);
  const unsupported = scenes.some(
    scene =>
      (allowedSceneTypes && !allowedSceneTypes.includes(scene.type)) ||
      (input.supportsUnlinkedFormulaSymbols === false &&
        scene.type === 'formula-spotlight' &&
        (scene as FormulaSpotlightData).symbols.some(symbol => !symbol.anchor))
  );
  if (unsupported) {
    throw failPermanently({
      code: 'lesson_playback_scene_invalid',
      message: 'A stored playback scene is outside the resumed visual contract.',
    });
  }
};

/** A structured spotlight may replace source equations only when their mathematics is complete. */
const sceneRetainsSourceMath = (scene: LessonScene, formulas: readonly string[]): boolean =>
  scene.type !== 'formula-spotlight' ||
  formulaSpotlightCovers(scene as FormulaSpotlightData, formulas);

/** Historical frozen contracts require an anchor for every symbol; choose another visual form. */
const compatibleSceneTypes = (input: PrepareLessonPlaybackBlockInput) =>
  input.supportsUnlinkedFormulaSymbols === false
    ? (input.allowedSceneTypes ?? LESSON_SCENE_TYPES).filter(type => type !== 'formula-spotlight')
    : input.allowedSceneTypes;

const prepareScene = async (
  input: PrepareLessonPlaybackBlockInput
): Promise<LessonScene | undefined> => {
  const { block, config, signal } = input;
  const formulas = getPlaybackFormulaMarkdown(block, input.lesson.sources);
  const mathMarkdown = formulas?.concat('\n\n', block.speech);
  if (block.visuals.length && !mathMarkdown) {
    const scenes = existingScenes(input);
    // Motion events carry no scene id, so a block with several scenes shows them without motion.
    return scenes.length === 1 ? scenes[0] : undefined;
  }
  // A prepared block must cover its complete speech, not silently inherit the lesson excerpt cut.
  if (Math.max(block.speech.length, mathMarkdown?.length ?? 0) > MAX_VISUAL_LESSON_CHARS) {
    throw new Error('Playback block speech exceeds the scene generation text limit.');
  }
  const allowedSceneTypes = compatibleSceneTypes(input);
  let retryFeedback: string | undefined;
  let diagnostic: WorkflowErrorDiagnostic | undefined;
  for (let attempt = 0; attempt < MAX_PLAYBACK_PREPARATION_ATTEMPTS; attempt += 1) {
    signal.throwIfAborted();
    const outcome = await generateLessonScene({
      allowedSceneTypes,
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
    if (outcome.kind === 'scene') {
      if (
        sceneRetainsSourceMath(
          outcome.scene,
          getPlaybackFormulaSources(block, input.lesson.sources)
        )
      )
        return outcome.scene;
      retryFeedback =
        'The spotlight must retain every complete authored expression, including scripts, conditions and operators. Return the complete equations or choose text for the sourced-formula presentation.';
      continue;
    }
    if (outcome.kind === 'text') return undefined;
    retryFeedback = outcome.problems.join('\n');
    diagnostic = outcome.diagnostic;
  }
  console.warn('[lesson-playback] Scene did not validate; retaining source visuals.', {
    diagnostic,
    retryFeedback,
  });
  return undefined;
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
      scene && scene.type !== 'formula-spotlight' && !isAnimatedLessonScene(scene)
        ? await planPlaybackMotion({
            scene,
            speech: block.speech,
            config,
            signal,
            sourceProvenance: input.lesson.sourceProvenance,
          })
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
