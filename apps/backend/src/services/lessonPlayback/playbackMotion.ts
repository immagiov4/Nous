import { motionTargets, type PlaybackMotionEvent } from '@shared/lessonPlayback';
import type { LessonScene, LessonSceneType } from '@shared/lessonScene';
import * as z from 'zod';

import type { GlobalModelConfig } from '../../config/modelConfig.js';
import { isInvalidLessonVisualStructuredOutput } from '../lessonGenerationVisuals.js';
import { generateStructuredOutput } from '../structuredGeneration.js';
import { PLAYBACK_MOTION_SYSTEM_PROMPT } from './playbackMotionPrompt.js';

// Same attempt count as scene generation in workflowRuntimeComposition and scene icon choice.
export const MAX_PLAYBACK_PREPARATION_ATTEMPTS = 3;
const MAX_MOTION_EVENTS = 24; // Inherited from the lab's validateMotion contract.
const REVEAL_SCENE_TYPES: ReadonlySet<LessonSceneType> = new Set([
  'checklist',
  'steps',
  'hypothesis',
  'timeline',
  'parts',
]);
const LIST_SCENE_TYPES: ReadonlySet<LessonSceneType> = new Set([
  'checklist',
  'steps',
  'hypothesis',
  'timeline',
]);

const MotionEventsSchema = z
  .array(
    z.strictObject({
      effect: z.enum(['focus', 'reveal']),
      targets: z.array(z.string()).min(1),
      quote: z.string().min(1),
    })
  )
  .max(MAX_MOTION_EVENTS);
const MotionResponseSchema = z.strictObject({
  plans: z
    .array(
      z.strictObject({
        chunk: z.literal(0),
        events: MotionEventsSchema,
        reason: z.string(),
      })
    )
    .length(1),
});
const { $schema: _dialect, ...MOTION_OUTPUT_SCHEMA } = z.toJSONSchema(MotionResponseSchema);

const validateEvent = (
  event: PlaybackMotionEvent,
  sceneType: LessonSceneType,
  targets: ReadonlySet<string>,
  speech: string
): void => {
  if (event.targets.some(id => !targets.has(id))) throw new Error('Unknown motion target');
  const offset = speech.indexOf(event.quote);
  if (offset < 0 || speech.indexOf(event.quote, offset + 1) >= 0) {
    throw new Error('Motion requires an exact, unique source anchor');
  }
  if (new Set(event.targets).size !== event.targets.length) {
    throw new Error('Duplicate motion target');
  }
  if (event.effect === 'reveal') {
    if (!REVEAL_SCENE_TYPES.has(sceneType)) {
      throw new Error(
        'Reveal is reserved for lists and articulated parts; compact definitions and comparisons stay visible'
      );
    }
    if (event.targets.length !== 1) throw new Error('Each appearance selects one element');
    return;
  }
  if (targets.size < 2) throw new Error('Focus requires a meaningful selection');
  if (LIST_SCENE_TYPES.has(sceneType)) throw new Error('Lists use progressive appearance');
};

/** Lab validation without simulated timings; quotes are anchored in the original block speech. */
export const validatePlaybackMotion = (
  events: readonly PlaybackMotionEvent[],
  scene: LessonScene,
  speech: string
): readonly PlaybackMotionEvent[] => {
  if (!MotionEventsSchema.safeParse(events).success) throw new Error('Invalid motion plan');
  const targets = new Set(motionTargets(scene).map(target => target.id));
  for (const event of events) validateEvent(event, scene.type, targets, speech);
  const focused = new Set(
    events.filter(event => event.effect === 'focus').flatMap(event => event.targets)
  );
  if (focused.size && focused.size !== targets.size) {
    throw new Error(
      'Focus must cover every target, individually or together, or be omitted entirely'
    );
  }
  const reveals = events.filter(event => event.effect === 'reveal');
  if (
    reveals.length &&
    (reveals.length !== events.length ||
      new Set(reveals.flatMap(event => event.targets)).size !== targets.size ||
      reveals.length !== targets.size)
  ) {
    throw new Error('Progressive appearance must cover each target once');
  }
  // The lab sorts by anchorTime before validation; the player will derive those times later.
  return [...events].sort(
    (left, right) => speech.indexOf(left.quote) - speech.indexOf(right.quote)
  );
};

/** Plans one scene's motion, retrying only malformed or invalid model output. */
export const planPlaybackMotion = async ({
  scene,
  speech,
  config,
  signal,
}: {
  readonly scene: LessonScene;
  readonly speech: string;
  readonly config: GlobalModelConfig;
  readonly signal: AbortSignal;
}): Promise<readonly PlaybackMotionEvent[]> => {
  signal.throwIfAborted();
  const targets = motionTargets(scene);
  // The lab keeps sequence scenes and scenes without targetable elements static.
  if (scene.type === 'sequence' || targets.length === 0) return [];
  const request = JSON.stringify([
    { chunk: 0, type: scene.type, title: scene.title, text: speech, targets },
  ]);
  let feedback = '';
  for (let attempt = 0; attempt < MAX_PLAYBACK_PREPARATION_ATTEMPTS; attempt += 1) {
    signal.throwIfAborted();
    const response = await generateStructuredOutput<unknown>({
      config,
      output: { name: 'playback_motion', schema: MOTION_OUTPUT_SCHEMA },
      prompt: request + feedback,
      signal,
      slot: 'playbackPreparation',
      system: PLAYBACK_MOTION_SYSTEM_PROMPT,
    }).catch(error => {
      signal.throwIfAborted();
      if (!isInvalidLessonVisualStructuredOutput(error)) throw error;
      return null;
    });
    signal.throwIfAborted();
    const parsed = MotionResponseSchema.safeParse(response);
    let problem = 'The answer must follow the requested JSON structure.';
    if (parsed.success) {
      try {
        return validatePlaybackMotion(parsed.data.plans[0].events, scene, speech);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        problem = error.message;
      }
    }
    feedback = `\nRisposta precedente: ${JSON.stringify(response)}\nCorreggi la risposta completa: ${problem}. Le liste checklist/steps/hypothesis/timeline ammettono SOLO reveal di tutte le voci una per volta oppure events:[]; un bersaglio per reveal; focus condiviso ammesso per concetti nominati insieme; quote univoca esatta.`;
  }
  throw new Error('Playback motion preparation failed validation after corrective attempts.');
};
