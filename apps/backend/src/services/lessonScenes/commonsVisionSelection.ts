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
  rejections: z
    .array(
      z.strictObject({
        candidate: z.number().int().positive(),
        reason: z.enum([
          'wrong-subject',
          'target-not-visible',
          'misleading-detail',
          'unreadable',
          'less-informative',
        ]),
      })
    )
    .optional(),
});

const COMMONS_VISION_SYSTEM = [
  'Choose one of the attached images, numbered 1 onward in the order provided, or return null for chosen and annotation.',
  'Require visible evidence of at least one concrete part or relationship named in the numbered narration. A legible image may teach one detail without illustrating the whole passage. Annotate only what the pixels support.',
  'Check pixels and embedded labels. Reject substitutes, wrong variants and ambiguous evidence. Return one rejections entry per unused image. Use less-informative only when an eligible image loses to the chosen image.',
  'For lunar phases, a Moon photograph or view of surface features is insufficient. A diagram must actually show the phases or their geometric cause, as the narration requires.',
  'For a choice, provide a title, alt and up to four beats in the narration language. Use increasing b1, b2, etc. for the given numbered phrases.',
  'Give tight normalized x,y,w,h focus rectangles around the named part. Copy short labels from the narration. Omit optional labels where a highlight suffices. For a point of convergence, locate the intersection of visible edges and exclude people, statues or objects behind it. Omit a point that the image does not locate clearly.',
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

export function commonsRejectionReasons(value: unknown) {
  const parsed = VisionSelectionSchema.pick({ rejections: true }).strip().safeParse(value);
  return new Map(parsed.data?.rejections?.map(({ candidate, reason }) => [candidate, reason]));
}

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
