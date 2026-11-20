import * as z from 'zod';

export const geometryBeatFields = {
  at: z
    .string()
    .regex(/^b[1-9]\d*$/u)
    .optional(),
  anchor: z.string().trim().min(1).optional(),
  callout: z.boolean().optional(),
  label: z.string().trim().min(1).optional(),
};
export const studioEntityId = z.string().regex(/^[\w-]+$/u);
