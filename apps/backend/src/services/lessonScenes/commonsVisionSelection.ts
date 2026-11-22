import { ImageAnnotationSchema } from '@shared/lessonStudios/imageAnnotateSpec';
import * as z from 'zod';
import type { CommonsImageCandidate } from '../commonsImageSearch.js';

const normalizedPoint = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
const VisionAnnotationSchema = ImageAnnotationSchema.extend({
  overlay: z
    .strictObject({
      type: z.literal('vanishing-lines'),
      point: normalizedPoint,
      from: z.array(normalizedPoint).min(2),
    })
    .optional(),
});

const VisionSelectionSchema = z.strictObject({
  chosen: z.number().int().positive().nullable(),
  annotation: VisionAnnotationSchema.nullable(),
});

const COMMONS_VISION_SYSTEM = [
  'Choose one of the attached images, numbered 1 onward in the order provided, or return null for both fields.',
  'Require visible evidence of the exact relation, mechanism or sequence in the numbered narration.',
  'Check the actual pixels and embedded labels. A subject in common is insufficient. Reject substitutes, wrong variants, ambiguous evidence and partial illustrations.',
  'For lunar phases, a Moon photograph or view of surface features is insufficient. A diagram must actually show the phases or their geometric cause, as the narration requires.',
  'For a choice, provide a title, alt and up to four beats in the narration language. Use increasing b1, b2, etc. for the given numbered phrases.',
  'Give normalized x,y,w,h focus rectangles around visible evidence. Copy short labels from the narration. Omit optional labels where a highlight suffices.',
  'Use the vanishing-lines overlay only when real edges visibly converge to the same point. Use normalized {x,y} objects for point and from, and only show the guides on relevant beats.',
].join(' ');

export function commonsVisionRequest(numbered: string, images: readonly string[]) {
  return {
    images,
    output: { name: 'lesson_image_annotation', schema: z.toJSONSchema(VisionSelectionSchema) },
    prompt: `NUMBERED NARRATION:\n${numbered}`,
    system: COMMONS_VISION_SYSTEM,
  };
}

const pointPair = ({ x, y }: z.infer<typeof normalizedPoint>): [number, number] => [x, y];

export function decodeCommonsChoice(value: unknown, candidates: readonly CommonsImageCandidate[]) {
  const result = VisionSelectionSchema.safeParse(value);
  if (!result.success) return undefined;
  const { chosen, annotation } = result.data;
  if (chosen === null && annotation === null) return null;
  const candidate = chosen === null ? undefined : candidates[chosen - 1];
  if (!candidate || !annotation) return undefined;
  const { overlay, ...description } = annotation;
  return {
    candidate,
    annotation: {
      ...description,
      ...(overlay
        ? {
            overlay: {
              ...overlay,
              point: pointPair(overlay.point),
              from: overlay.from.map(pointPair),
            },
          }
        : {}),
    },
  };
}
