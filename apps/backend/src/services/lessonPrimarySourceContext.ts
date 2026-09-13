import * as z from 'zod';

const PrimarySourceIdentitySchema = z.object({
  title: z.string(),
  sourceId: z.string().optional(),
  chunkIds: z.array(z.string()).optional(),
  pageStart: z.number().optional(),
  pageEnd: z.number().optional(),
  path: z.string().optional(),
});
const PrimarySourceContextSchema = z.object({
  kind: z.literal('lesson-primary-source-context'),
  parts: z.array(z.object({ source: PrimarySourceIdentitySchema, text: z.string() })),
});

export type LessonPrimarySourceIdentity = z.infer<typeof PrimarySourceIdentitySchema>;
export type LessonPrimarySourcePart = z.infer<typeof PrimarySourceContextSchema>['parts'][number];

export const encodeLessonPrimarySources = (parts: LessonPrimarySourcePart[]): string =>
  parts.length ? JSON.stringify({ kind: 'lesson-primary-source-context', parts }) : '';

/** Old durable runs retain plain source text; new preparation carries authoritative provenance. */
export const readLessonPrimarySources = (context: string): LessonPrimarySourcePart[] | null => {
  let value: unknown;
  try {
    value = JSON.parse(context);
  } catch {
    return null;
  }
  const parsed = PrimarySourceContextSchema.safeParse(value);
  return parsed.success ? parsed.data.parts : null;
};
