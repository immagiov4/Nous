import * as z from 'zod';
import { cueTimes, studioCueOffset } from '../lessonSceneAnimation';
import { arrayCopy } from './array-algorithm.copy.it';
import { type ArraySpec, ArraySpecSchema, arrayTrace, calloutIndices } from './arrayAlgorithm';
import { checkHeapBeats, type HeapSpec, HeapSpecSchema, heapTrace } from './heap';
import { heapTitle } from './heap.copy.it';
import { hasDeadStage, type StudioActiveWindow } from './layoutValidation';
import { MOVE } from './motionTiming';
import { arrayEventTimes, heapEventTimes } from './traceTiming';

export const AlgorithmStudioSchema = z.discriminatedUnion('id', [
  z.object({ id: z.literal('array-algorithm'), spec: ArraySpecSchema }),
  z.object({ id: z.literal('heap'), spec: HeapSpecSchema }),
]);

type AlgorithmStudio = z.infer<typeof AlgorithmStudioSchema>;

export const algorithmStudioTitle = (studio: AlgorithmStudio): string =>
  studio.id === 'heap' ? heapTitle(studio.spec.operation) : arrayCopy.titles[studio.spec.algorithm];

export const FrozenStudioNarrationCueSchema = z.object({
  anchor: z.string().min(1).regex(/\S/u),
  occurrence: z.number().int().nonnegative().optional(),
});

const StudioNarrationCueSchema = FrozenStudioNarrationCueSchema.extend({
  hold: z.string().min(1).regex(/\S/u).optional(),
});

export const AlgorithmDataSchema = z.object({
  autoplay: z.boolean(),
  durationMs: z.number().positive().optional(),
  narration: z.string().min(1).regex(/\S/u),
  studio: AlgorithmStudioSchema,
  studioCues: z.array(StudioNarrationCueSchema),
});

export function findAlgorithmProblems(scene: unknown, narration?: string): string[] {
  const { studio, studioCues, narration: storedNarration } = AlgorithmDataSchema.parse(scene);
  const beats = studio.id === 'heap' ? studio.spec.beats : studio.spec.callouts;
  if (beats.length !== studioCues.length) return ['Each studio beat needs one narration cue.'];
  if (
    new Set(studioCues.map(cue => studioCueOffset(storedNarration, cue))).size !== studioCues.length
  )
    return ['Studio narration anchors must be unique and ordered.'];
  try {
    if (studio.id === 'heap') checkHeapBeats(studio.spec);
    else calloutIndices(studio.spec);
    if (studioCues.length) {
      cueTimes(storedNarration, studioCues);
      if (narration !== undefined && narration !== storedNarration) cueTimes(narration, studioCues);
    }
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

function arrayChanges(spec: ArraySpec, cueMs: number[], durationSeconds: number) {
  const events = arrayTrace(spec);
  const starts = arrayEventTimes(events, calloutIndices(spec, events), cueMs, durationSeconds);
  const states = events.map(({ order, focus, confirmed, search }) =>
    JSON.stringify([order, focus, confirmed, search])
  );
  return starts.filter((_, index) => states[index] !== states[index - 1]);
}

function heapChanges(spec: HeapSpec, cueMs: number[], durationSeconds: number) {
  const events = heapTrace(spec.input, spec.operation);
  const starts = heapEventTimes(
    events,
    spec.beats.map(beat => beat.event),
    cueMs,
    durationSeconds
  );
  const states = events.map(({ order, focus, size, largerChild }) =>
    JSON.stringify([order, focus, size, largerChild])
  );
  return starts.filter((_, index) => states[index] !== states[index - 1]);
}

/** Uses the very same trace and event schedule as the renderers. */
export function algorithmHasDeadStage(
  scene: z.infer<typeof AlgorithmDataSchema>,
  durationMs: number,
  holds: readonly StudioActiveWindow[] = []
) {
  const { studio, studioCues, narration } = scene;
  const cues = studioCues.length ? cueTimes(narration, studioCues) : [];
  const duration = durationMs / 1000;
  const starts =
    studio.id === 'array-algorithm'
      ? arrayChanges(studio.spec, cues, duration)
      : heapChanges(studio.spec, cues, duration);
  return hasDeadStage({
    firstMeaningfulMs: 0,
    durationMs,
    active: [
      ...holds,
      ...starts.map((time, index) => ({
        startMs: time * 1000,
        endMs: Math.min(time + MOVE.duration, starts[index + 1] ?? duration) * 1000,
      })),
    ],
  });
}
