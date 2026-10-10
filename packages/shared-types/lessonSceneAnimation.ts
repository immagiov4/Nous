import type { AnimatedLessonScene, ProportionalLessonScene } from './lessonScene';

// Ported from notes-live-lab/interactive-model.mjs. Scene data never supplies executable formulas.
export const interactionTiming = { stepMs: 2400, wordMs: 250 };

export const interactiveSelectionRules = `Gradual playback is the default.
To synchronize with words, associate every element with an exact, unique, ordered narration anchor; elements may share an anchor as a group.
For guided-path annotate every step. For proportional provide increasing cumulative cue values covering all elements through max (for example 2, 4, 6 groups the elements in pairs).
If any element is unassigned, the entire scene uses gradual playback. Never mix partial word synchronization with automatic movement.
Set durationMs to the available presentation interval. Only the lesson playback controls affect the clock. Visual elements have no local play, seek, or manual controls; never expose this decision as a viewer setting.`;

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
  return quantity * scene.amountPerUnit;
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
  return cues.map(cue => {
    if (typeof cue.anchor !== 'string' || !cue.anchor.trim()) throw new Error('Missing anchor');
    const offset = text.indexOf(cue.anchor);
    if (offset < 0 || text.indexOf(cue.anchor, offset + 1) !== -1 || offset < previous) {
      throw new Error('Anchor must be unique and ordered');
    }
    previous = offset;
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

export function automaticDuration(scene: AnimatedLessonScene): number {
  return (
    scene.durationMs ??
    (scene.type === 'guided-path' ? scene.steps.length : scene.max - scene.initial + 1) *
      interactionTiming.stepMs
  );
}

export function automaticQuantity(scene: ProportionalLessonScene, time: number): number {
  const progress = Math.max(0, Math.min(1, time / automaticDuration(scene)));
  return scene.initial + Math.floor(progress * (scene.max - scene.initial));
}
