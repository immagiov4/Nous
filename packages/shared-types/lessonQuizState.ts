import * as z from 'zod';

export const LessonQuizStateSchema = z.object({
  answers: z.array(z.number().int().min(-1)),
  isSubmitted: z.boolean(),
});

export type LessonQuizState = z.infer<typeof LessonQuizStateSchema>;
