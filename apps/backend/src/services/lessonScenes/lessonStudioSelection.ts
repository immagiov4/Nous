import { type AlgorithmLessonScene, findLessonSceneProblems } from '@shared/lessonScene';
import { automaticDuration, type StudioNarrationCue } from '@shared/lessonSceneAnimation';
import {
  AlgorithmStudioSchema,
  algorithmHasDeadStage,
  algorithmStudioTitle,
} from '@shared/lessonStudios/algorithm';
import { checkAlgorithmGeometry } from '@shared/lessonStudios/algorithmLayout';
import { ArraySpecSchema } from '@shared/lessonStudios/arrayAlgorithm';
import { readerStudioViewports } from '@shared/lessonStudios/chartDimensions';
import { HEAP_MAX_BEATS, HeapSpecSchema } from '@shared/lessonStudios/heap';
import type { StudioCheck } from '@shared/lessonStudios/layoutValidation';
import * as z from 'zod';
import {
  heapOperationFromNarration,
  matchesStatedStudioOperands,
} from './studioOperandGrounding.js';

const MIN_PHRASE_WORDS = 4;
const MAX_PHRASE_WORDS = 14;
const beatId = z.strictObject({ at: z.number().int().positive(), event: z.string() });
const draftBase = { type: z.literal('algorithm') };
const arrayDraft = z.strictObject({
  ...draftBase,
  studio: z.literal('array-algorithm'),
  spec: z.strictObject({
    ...ArraySpecSchema.shape,
    callouts: z.array(beatId),
  }),
});
const heapDraft = z.strictObject({
  ...draftBase,
  studio: z.literal('heap'),
  spec: z.strictObject({
    ...HeapSpecSchema.shape,
    operation: HeapSpecSchema.shape.operation.unwrap(),
    beats: z.array(beatId).max(HEAP_MAX_BEATS),
  }),
});

export const StudioSelectionDraftSchema = z.discriminatedUnion('studio', [arrayDraft, heapDraft]);

export const studioFallbackKinds = {
  'array-algorithm': 'beforeafter',
  heap: 'beforeafter',
} as const;

export const STUDIO_SELECTION_RULE = `Prefer a studio when the numbered passage explains a mechanism that benefits from visible changes. A definition or a static illustration uses the existing catalog. Use type algorithm with studio array-algorithm for bubble, insertion (adjacent swaps), selection, or binary-search. Supply 1–10 input numbers and preserve any explicit input list in its stated order. Binary search requires ascending input and a target. Callout events: compare#N, swap#N, pass-end#N, no-swap-pass, found, not-found, done. Use studio heap with operation build for max-heap construction or sort for heapsort. Both operations support start, sift#N and heapified. Only sort supports extract#N and done. N is 1-based. Each beat has a strictly increasing integer at identifying a phrase ID. Name only events the trace computes. Omit narration and visible labels. Use the whole passage only if the studio can explain it.`;

function breakPriority(word: string, gap: string) {
  if (gap.includes('\n') || /[.!?][”"»')\]]*$/u.test(word)) return 2;
  if (/[,;:–—][”"»')\]]*$/u.test(word)) return 1;
  return 0;
}

/** Segment narration exactly as in the lab phrase-ID evaluation, preserving authored text. */
export function segmentStudioPhrases(narration: string): string[] {
  const words = [...narration.matchAll(/\S+/gu)];
  if (words.length < MIN_PHRASE_WORDS) return [];
  const phrases: string[] = [];
  for (let start = 0; start < words.length; ) {
    let cut = Math.min(start + MAX_PHRASE_WORDS, words.length);
    if (words.length - cut < MIN_PHRASE_WORDS && cut < words.length)
      cut = words.length - MIN_PHRASE_WORDS;
    let best = 0;
    const latestBreak = Math.min(cut, words.length - MIN_PHRASE_WORDS);
    for (let end = start + MIN_PHRASE_WORDS; end <= latestBreak; end++) {
      const last = words[end - 1];
      const score = breakPriority(
        last[0],
        narration.slice(last.index + last[0].length, words[end].index)
      );
      if (score > best) {
        cut = end;
        best = score;
      }
    }
    const last = words[cut - 1];
    phrases.push(narration.slice(words[start].index, last.index + last[0].length));
    start = cut;
  }
  return phrases;
}

function addressPhrases(narration: string, phrases: readonly string[]) {
  let end = 0;
  return phrases.map((anchor): StudioNarrationCue | undefined => {
    const start = narration.indexOf(anchor, end);
    if (start < 0) return undefined;
    end = start + anchor.length;
    let first = narration.indexOf(anchor);
    if (first === start && !narration.includes(anchor, start + 1)) return { anchor };
    let occurrence = 0;
    while (first < start) {
      first = narration.indexOf(anchor, first + 1);
      occurrence++;
    }
    return { anchor, occurrence };
  });
}

export function decodeStudioDraft(
  value: unknown,
  narration: string,
  phrases: readonly string[]
): AlgorithmLessonScene | undefined {
  const draft = StudioSelectionDraftSchema.safeParse(value);
  if (!draft.success) return undefined;
  const { data } = draft;
  const beats = data.studio === 'heap' ? data.spec.beats : data.spec.callouts;
  const addresses = addressPhrases(narration, phrases);
  let previous = 0;
  const studioCues: StudioNarrationCue[] = [];
  for (const { at } of beats) {
    const cue = addresses[at - 1];
    if (at <= previous || cue === undefined) return undefined;
    studioCues.push(cue);
    previous = at;
  }
  const events = beats.map(({ event }) => ({ event }));
  const studio = AlgorithmStudioSchema.safeParse({
    id: data.studio,
    spec:
      data.studio === 'heap' ? { ...data.spec, beats: events } : { ...data.spec, callouts: events },
  });
  if (!studio.success) return undefined;
  const scene = {
    type: 'algorithm' as const,
    title: algorithmStudioTitle(studio.data),
    body: '',
    groups: [],
    items: [],
    note: '',
    quote: '',
    autoplay: true,
    narration,
    studio: studio.data,
    studioCues,
  };
  return findLessonSceneProblems(scene, undefined, narration).length ? undefined : scene;
}

export function checkStudioCandidate(scene: AlgorithmLessonScene): StudioCheck[] {
  if (!matchesStatedStudioOperands(scene.studio.spec.input, scene.narration)) {
    return ['operand-grounding'];
  }
  if (
    scene.studio.id === 'heap' &&
    scene.studio.spec.operation !== heapOperationFromNarration(scene.narration)
  ) {
    return ['operation-grounding'];
  }
  const checks = Object.values(readerStudioViewports).flatMap(viewport =>
    checkAlgorithmGeometry(scene, viewport)
  );
  if (algorithmHasDeadStage(scene, automaticDuration(scene))) checks.push('dead-stage');
  return [...new Set(checks)];
}
