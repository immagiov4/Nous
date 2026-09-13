import * as z from 'zod';

import type { LessonGenerationCorrection } from '../services/lessonGenerationCorrection.js';

const ReviewRetrySchema = z.object({
  kind: z.literal('lesson-review-retry-v1'),
  pedagogicalRevision: z.number().int().nonnegative(),
  feedback: z.string(),
});

/** The revision survives factual and transport retries through durable corrective feedback. */
export const readLessonReviewRetry = (feedback: string): z.infer<typeof ReviewRetrySchema> => {
  try {
    const parsed = ReviewRetrySchema.safeParse(JSON.parse(feedback));
    if (parsed.success) return parsed.data;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return { kind: 'lesson-review-retry-v1', pedagogicalRevision: 0, feedback };
};

export const serializeLessonReviewRetry = (
  retry: z.infer<typeof ReviewRetrySchema>,
  correction: LessonGenerationCorrection
): string =>
  JSON.stringify({
    ...retry,
    pedagogicalRevision:
      retry.pedagogicalRevision +
      (correction.code === 'lesson_factual_support_failed' ||
      correction.code === 'lesson_clip_evidence_missing'
        ? 1
        : 0),
    feedback: correction.feedback,
  });
