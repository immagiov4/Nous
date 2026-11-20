import * as z from 'zod';

export const geometryBeatFields = {
  at: z
    .string()
    .regex(/^b[1-9]\d*$/u)
    .optional(),
  anchor: z.string().min(1).regex(/\S/u).optional(),
  callout: z.boolean().optional(),
  label: z.string().min(1).regex(/\S/u).optional(),
};
export const studioEntityId = z.string().regex(/^[\w-]+$/u);

/** Both axes require a finite positive span. */
export function checkAxisRange([low, high]: [number, number]) {
  if (low >= high || !Number.isFinite(high - low))
    throw new Error('Axis must have ascending endpoints and finite span');
}
