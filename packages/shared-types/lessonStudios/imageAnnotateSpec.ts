import * as z from 'zod';

const unit = z.number().min(0).max(1);
const point = z.tuple([unit, unit]);
const region = z.object({ x: unit, y: unit, w: unit.gt(0), h: unit.gt(0) });

export const ImageAnnotationSchema = z.object({
  title: z.string().min(1).regex(/\S/u),
  alt: z.string().min(1).regex(/\S/u),
  overlay: z
    .object({
      type: z.literal('vanishing-lines'),
      point,
      from: z.array(point).min(2),
    })
    .optional(),
  beats: z
    .array(
      z.object({
        at: z.string().regex(/^b[1-9]\d*$/u),
        label: z.string().min(1).regex(/\S/u).optional(),
        region: region.optional(),
        showOverlay: z.boolean().optional(),
      })
    )
    .min(1)
    .max(4),
});

export function isCommonsLink(value: string): boolean {
  const url = URL.parse(value);
  return Boolean(
    url?.origin === 'https://commons.wikimedia.org' &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith('/wiki/File:')
  );
}

export const CommonsImageCreditSchema = z.object({
  title: z.string().min(1),
  author: z.string(),
  credit: z.string().optional(),
  attribution: z.string().optional(),
  license: z.string().min(1),
  licenseUrl: z
    .string()
    .regex(/^(?:https:\/\/creativecommons\.org\/(?:licenses|publicdomain)\/[\w/.-]+)?$/u),
  source: z.string().regex(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:[^\s]+$/u),
});

export const ImageAnnotateStoredSpecSchema = ImageAnnotationSchema.extend({
  image: CommonsImageCreditSchema.extend({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
});

export function isValidImageAnnotation(spec: z.infer<typeof ImageAnnotateStoredSpecSchema>) {
  return spec.beats.every(beat => {
    const { region } = beat;
    return (
      (!beat.showOverlay || Boolean(spec.overlay)) &&
      (!region || (region.x + region.w <= 1.000001 && region.y + region.h <= 1.000001))
    );
  });
}

export const ImageAnnotateSpecSchema = ImageAnnotateStoredSpecSchema.refine(
  isValidImageAnnotation,
  'Annotations must stay in the image and reference available guides.'
);

export type ImageAnnotateSpec = z.infer<typeof ImageAnnotateSpecSchema>;
