import type { AnimatedLessonScene, ProportionalLessonScene } from './lessonSceneRegistry';

/** The owning lesson stage supplies its clock and complete caption cues. */
export interface SceneAnimationFrame {
  readonly elapsedMs: number;
  readonly durationMs: number;
  readonly cueTimes?: number[];
}

export type ReadSceneAnimationFrame = () => SceneAnimationFrame | undefined;

export const PROPORTIONAL_REPLICA_LIMIT = 12;

const PROPORTIONAL_AUTOMATIC_STEP_LIMIT = 12;

// Ported from notes-live-lab/interactive-model.mjs. Scene data never supplies executable formulas.
const interactionTiming = { stepMs: 2400, wordMs: 250 };

export const interactiveSelectionRules = `Gradual playback is the default.
To synchronize with words, associate every element with an exact, unique, ordered narration anchor; elements may share an anchor as a group.
For guided-path annotate every step. For proportional provide increasing cumulative cue values covering all elements through max (for example 2, 4, 6 groups the elements in pairs).
If any element is unassigned, the entire scene uses gradual playback. Never mix partial word synchronization with automatic movement.
Only an owning playback clock supplies durationMs from its actual presentation interval; omit it from generated scene data. Only the lesson playback controls affect the clock. Visual elements have no local play, seek, or manual controls; never expose this decision as a viewer setting.`;

export function playbackMode(scene: AnimatedLessonScene): 'text' | 'automatic' {
  if (scene.type === 'guided-path') {
    return scene.steps.every(step => typeof step.anchor === 'string' && step.anchor.trim())
      ? 'text'
      : 'automatic';
  }
  const cues = scene.cues;
  if (!Array.isArray(cues) || !cues.length) return 'automatic';
  let previous = 0;
  for (const cue of cues) {
    if (
      typeof cue.anchor !== 'string' ||
      !cue.anchor.trim() ||
      !Number.isInteger(cue.value) ||
      cue.value <= previous ||
      cue.value < scene.initial ||
      cue.value > scene.max
    )
      return 'automatic';
    previous = cue.value;
  }
  return previous === scene.max ? 'text' : 'automatic';
}

export function proportionalResult(scene: ProportionalLessonScene, quantity: number): number {
  if (!Number.isInteger(quantity) || quantity < scene.min || quantity > scene.max) {
    throw new Error('Quantity outside range');
  }
  // Multiply the authored decimal coefficient before converting back to the numeric contract.
  const [coefficient, exponent = '0'] = String(scene.amountPerUnit).split('e');
  const [integer, fraction = ''] = coefficient.split('.');
  const total = BigInt(integer + fraction) * BigInt(quantity);
  return Number(`${total}e${Number(exponent) - fraction.length}`);
}

export function pathFrame(elapsedMs: number, count: number) {
  const duration = count * interactionTiming.stepMs;
  const elapsed = Math.max(0, Math.min(duration, elapsedMs));
  return {
    index: Math.min(count - 1, Math.floor(elapsed / interactionTiming.stepMs)),
    progress: elapsed / duration,
    complete: elapsed === duration,
  };
}

export function cueTimes(text: string, cues: readonly { readonly anchor?: string }[]): number[] {
  if (typeof text !== 'string' || !text.trim() || !Array.isArray(cues) || !cues.length) {
    throw new Error('Missing narration cues');
  }
  let previous = -1;
  let previousAnchor: string | undefined;
  return cues.map(cue => {
    if (typeof cue.anchor !== 'string' || !cue.anchor.trim()) throw new Error('Missing anchor');
    const offset = text.indexOf(cue.anchor);
    if (
      offset < 0 ||
      text.includes(cue.anchor, offset + 1) ||
      offset < previous ||
      (offset === previous && cue.anchor !== previousAnchor)
    ) {
      throw new Error('Anchor must be unique and ordered');
    }
    previous = offset;
    previousAnchor = cue.anchor;
    return (text.slice(0, offset).match(/\S+/g)?.length ?? 0) * interactionTiming.wordMs;
  });
}

export function textFrame(elapsed: number, text: string, times: number[]) {
  const wordIndex = Math.floor(Math.max(0, elapsed) / interactionTiming.wordMs);
  return {
    wordIndex,
    index: times.reduce((last, time, index) => (time <= elapsed ? index : last), -1),
    complete: wordIndex >= text.trim().split(/\s+/).length,
  };
}

function proportionalStepCount(scene: ProportionalLessonScene): number {
  return scene.max > PROPORTIONAL_REPLICA_LIMIT
    ? Math.min(PROPORTIONAL_AUTOMATIC_STEP_LIMIT, scene.max - scene.min + 1)
    : scene.max - scene.initial + 1;
}

export function automaticDuration(scene: AnimatedLessonScene): number {
  const steps = scene.type === 'guided-path' ? scene.steps.length : proportionalStepCount(scene);
  return scene.durationMs ?? steps * interactionTiming.stepMs;
}

export function automaticQuantity(scene: ProportionalLessonScene, time: number): number {
  const progress = Math.max(0, Math.min(1, time / automaticDuration(scene)));
  if (scene.max > PROPORTIONAL_REPLICA_LIMIT) {
    const steps = proportionalStepCount(scene);
    if (steps === 1) return scene.min;
    const index = Math.min(steps - 1, Math.floor(progress * steps));
    return scene.min + Math.round((index * (scene.max - scene.min)) / (steps - 1));
  }
  return scene.initial + Math.floor(progress * (scene.max - scene.initial));
}
