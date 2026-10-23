import { isAnimatedLessonScene, type LessonScene } from '@shared/lessonScene';
import { cueTimes, playbackMode } from '@shared/lessonSceneAnimation';
import * as z from 'zod';
import type { GlobalModelConfig } from '../../config/modelConfig.js';
import { generateStructuredOutput } from '../structuredGeneration.js';

const CuePlanSchema = z.strictObject({
  cues: z.array(z.strictObject({ anchor: z.string(), value: z.number().int() })),
});
const { $schema: _dialect, ...schema } = z.toJSONSchema(CuePlanSchema);

/** Resolves semantic steps to exact narration citations; an empty plan keeps the scene static. */
export async function resolvePlaybackAnimationCues(input: {
  scene: LessonScene;
  speech: string;
  config: GlobalModelConfig;
  signal: AbortSignal;
}): Promise<LessonScene> {
  const { scene, speech, signal } = input;
  if (!isAnimatedLessonScene(scene)) return scene;
  if (playbackMode(scene) === 'text') {
    const cues = scene.type === 'guided-path' ? scene.steps : scene.cues;
    try {
      cueTimes(speech, cues ?? []);
      return scene;
    } catch {
      /* Resolve invalid stored citations too. */
    }
  }
  const response = CuePlanSchema.parse(
    await generateStructuredOutput<unknown>({
      config: input.config,
      output: { name: 'playback_animation_cues', schema },
      prompt: JSON.stringify({ speech, scene }),
      signal,
      slot: 'playbackPreparation',
      system:
        'Associate each visual change with the narration words that express it. Return exact, unique, ordered quotations from speech. For guided-path return one cue per step in step order, with value equal to its zero-based index. Steps mentioned together may share one quotation. For proportional return increasing cumulative quantity values, ending at max. Never invent a quotation or a semantic association. If the narration cannot support every step or quantity change, return cues:[]; the scene will remain static.',
    })
  );
  signal.throwIfAborted();
  const cues = response.cues;
  let resolved = scene;
  if (
    scene.type === 'guided-path' &&
    cues.length === scene.steps.length &&
    cues.every((cue, index) => cue.value === index)
  ) {
    resolved = {
      ...scene,
      steps: scene.steps.map((step, index) => ({ ...step, anchor: cues[index].anchor })),
    };
  } else if (scene.type === 'proportional') {
    resolved = { ...scene, cues };
  }
  try {
    const anchors = resolved.type === 'guided-path' ? resolved.steps : resolved.cues;
    if (playbackMode(resolved) !== 'text') throw new Error('Incomplete semantic cue plan');
    cueTimes(speech, anchors ?? []);
    return resolved;
  } catch {
    console.warn(
      '[lesson-playback] Narration cannot anchor every animation change; keeping the scene static.',
      { sceneType: scene.type }
    );
    return scene.type === 'guided-path'
      ? { ...scene, steps: scene.steps.map(step => ({ ...step, anchor: undefined })) }
      : { ...scene, cues: [] };
  }
}
