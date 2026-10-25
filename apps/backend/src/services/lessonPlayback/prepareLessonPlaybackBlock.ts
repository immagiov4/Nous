import { createHash } from 'node:crypto';
import { type FormulaSpotlightData, formulaSpotlightCovers } from '@shared/formulaSpotlight';
import { MAX_VISUAL_LESSON_CHARS } from '@shared/lessonGenerationPolicy';
import {
  getPlaybackFormulaMarkdown,
  getPlaybackFormulaSources,
  getPlaybackPassageContext,
  type LessonPlaybackBlock,
  motionTargets,
  needsPlaybackFormulaSpotlights,
  type PlaybackContentBlock,
  type PlaybackMotionEvent,
  playbackFormulaTargets,
} from '@shared/lessonPlayback';
import {
  LessonSceneSchema,
  PlaybackAudioSchema,
  PlaybackPreparedSchema,
} from '@shared/lessonPlaybackSchema';
import {
  isAnimatedLessonScene,
  isRetiredLessonScene,
  LESSON_SCENE_TYPES,
  type LessonScene,
  type LessonSceneType,
} from '@shared/lessonScene';
import type { ProjectLessonVisual } from '@shared/projectAsset';
import * as z from 'zod';
import type { GlobalModelConfig } from '../../config/modelConfig.js';
import { failPermanently } from '../../workflows/retryPolicy.js';
import type { WorkflowProviderEffectExecutor } from '../../workflows/types.js';
import {
  toWorkflowErrorDiagnostic,
  type WorkflowErrorDiagnostic,
} from '../../workflows/workflowErrorDiagnostics.js';
import type { LessonSourceProvenance } from '../lessonPrimarySourceContext.js';
import { generateLessonScene } from '../lessonScenes/lessonSceneGeneration.js';
import { resolveLessonVisualModelConfig } from '../lessonVisualModelConfig.js';
import { prepareSpeech } from '../speechPreparation.js';
import { resolvePlaybackAnimationCues } from './playbackAnimationCues.js';
import {
  type PreparedPlaybackAudio,
  preparePlaybackAudio,
  validatePlaybackText,
} from './playbackAudio.js';
import { preparePlaybackFormulaSpotlights } from './playbackFormulaSpotlights.js';
import { MAX_PLAYBACK_PREPARATION_ATTEMPTS, planPlaybackMotion } from './playbackMotion.js';

interface PrepareLessonPlaybackBlockInput {
  readonly userId: string;
  readonly synchronizeAnimations?: boolean;
  readonly supportsSpokenMath?: boolean;
  readonly supportsFormulaSpotlights?: boolean;
  readonly spokenMath?: NonNullable<LessonPlaybackBlock['prepared']>['spokenMath'];
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
    if (visual.kind === 'scene') return isRetiredLessonScene(visual.scene) ? [] : [visual.scene];
    if (visual.kind !== 'generated-visual') return [];
    const render = lesson.generatedVisuals?.find(stored => stored.id === visual.visualId)?.render;
    return render?.kind === 'scene' && !isRetiredLessonScene(render.scene) ? [render.scene] : [];
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
      !isRetiredLessonScene(scene) &&
      ((allowedSceneTypes && !allowedSceneTypes.includes(scene.type)) ||
        (input.supportsUnlinkedFormulaSymbols === false &&
          scene.type === 'formula-spotlight' &&
          (scene as FormulaSpotlightData).symbols.some(symbol => !symbol.anchor)))
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

/** Scene service failures retain narration and the source presentation; cancellation still propagates. */
const generatePlaybackScene = async (
  input: Parameters<typeof generateLessonScene>[0] & { allowTextFallback?: boolean }
) => {
  try {
    return await generateLessonScene(input);
  } catch (error) {
    input.signal.throwIfAborted();
    console.warn('Playback scene generation unavailable.', {
      diagnostic: toWorkflowErrorDiagnostic(error),
    });
    return { kind: 'text' as const };
  }
};

/** Select source at authored heading boundaries while keeping the heard passage the visual's target. */
const playbackSceneMarkdown = (
  input: PrepareLessonPlaybackBlockInput,
  formulas?: string
): string => {
  const { block } = input;
  if (formulas) return formulas.concat('\n\n', block.speech);
  const context = getPlaybackPassageContext(block, input.lesson.sources);
  return context && context !== block.speech
    ? `${block.speech}\n\nAUTHORING CONTEXT:\n${context}`
    : block.speech;
};

const prepareScene = async (
  input: PrepareLessonPlaybackBlockInput,
  onValidatedScene?: (scene: LessonScene) => void
): Promise<LessonScene | undefined> => {
  const { block, config, signal } = input;
  const formulas = getPlaybackFormulaMarkdown(block, input.lesson.sources);
  const scenes = existingScenes(input);
  const hasSourceVisual =
    scenes.length ||
    block.visuals.some(visual => {
      if (visual.kind === 'scene') return false;
      if (visual.kind !== 'generated-visual') return true;
      const render = input.lesson.generatedVisuals?.find(
        stored => stored.id === visual.visualId
      )?.render;
      return render && render.kind !== 'scene';
    });
  if (hasSourceVisual && !formulas) {
    // Motion events carry no scene id, so a block with several scenes shows them without motion.
    return scenes.length === 1 ? scenes[0] : undefined;
  }
  const lessonMarkdown = playbackSceneMarkdown(input, formulas);
  // A prepared block must cover its complete speech, not silently inherit the lesson excerpt cut.
  const targetLength = formulas
    ? formulas.length + '\n\n'.length + block.speech.length
    : block.speech.length;
  if (targetLength > MAX_VISUAL_LESSON_CHARS) {
    throw new Error('Playback block speech exceeds the scene generation text limit.');
  }
  const allowedSceneTypes = compatibleSceneTypes(input);
  const allowTextFallback = Boolean(formulas);
  let retryFeedback: string | undefined;
  let diagnostic: WorkflowErrorDiagnostic | undefined;
  for (let attempt = 0; attempt < MAX_PLAYBACK_PREPARATION_ATTEMPTS; attempt += 1) {
    signal.throwIfAborted();
    const outcome = await generatePlaybackScene({
      onValidatedScene,
      allowedSceneTypes,
      config: resolveLessonVisualModelConfig(config),
      lessonMarkdown,
      narration: block.speech,
      allowTextFallback,
      retryFeedback,
      // Authored heading boundaries provide context; general lesson metadata is not source evidence.
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
    spokenMath: narration.spokenMath,
  };
  validatePlaybackText(request.block.speech);
  // Audio does not depend on the scene, so both are prepared at the same time. Both settle
  // before a failure propagates, so a retry never overlaps paid work still in flight.
  const [visuals, audio] = await Promise.allSettled([
    prepareLessonPlaybackVisuals(request),
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

const prepareAnimationCues = async (
  input: PrepareLessonPlaybackBlockInput,
  scene: LessonScene | undefined
) => {
  if (!scene || !input.synchronizeAnimations) return scene;
  const operation = async () => ({
    scene: await resolvePlaybackAnimationCues({
      scene,
      speech: input.block.speech,
      config: input.config,
      signal: input.signal,
    }),
  });
  const resolved = input.providerEffect
    ? await input.providerEffect.run({
        key: 'animation-cues',
        outputSchema: z.object({ scene: LessonSceneSchema }),
        operation,
      })
    : await operation();
  return resolved.scene;
};

export const prepareLessonPlaybackVisuals = async (
  input: PrepareLessonPlaybackBlockInput,
  force = false
): Promise<PreparedLessonPlaybackBlock['prepared']> => {
  const { block, config, signal } = input;
  let prepared = block.prepared;
  const hasFormulaVisual =
    input.supportsFormulaSpotlights !== false &&
    playbackFormulaTargets(block, input.lesson.generatedVisuals, input.lesson.sources).length > 0;
  if (
    force ||
    !prepared ||
    (prepared.scene && isRetiredLessonScene(prepared.scene) && !hasFormulaVisual)
  ) {
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
        scene &&
        scene.type !== 'formula-spotlight' &&
        !isAnimatedLessonScene(scene) &&
        motionTargets(scene).length > 0
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
      const synchronizedScene = await prepareAnimationCues(input, scene);
      prepared = {
        ...block.prepared,
        scene: undefined,
        ...(synchronizedScene ? { scene: synchronizedScene } : {}),
        motion: savedMotion,
      };
    } finally {
      // A competing workflow attempt can commit a different authoritative scene.
      await Promise.allSettled(motions.values());
    }
  }
  const candidate = {
    ...block,
    prepared: {
      ...prepared,
      ...(input.spokenMath ? { spokenMath: input.spokenMath } : {}),
    },
  };
  if (
    input.supportsFormulaSpotlights !== false &&
    needsPlaybackFormulaSpotlights(candidate, input.lesson.generatedVisuals, input.lesson.sources)
  ) {
    return {
      ...candidate.prepared,
      formulaSpotlights: await preparePlaybackFormulaSpotlights({
        ...input,
        block: candidate,
        storedVisuals: input.lesson.generatedVisuals,
        sources: input.lesson.sources,
      }),
    };
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
