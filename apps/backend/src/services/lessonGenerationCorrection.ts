import { NoObjectGeneratedError } from 'ai';
import * as z from 'zod';

export interface LessonGenerationCorrection {
  readonly code: string;
  readonly feedback: string;
  readonly message: string;
}

export class LessonGenerationCorrectionError extends Error {
  readonly code: string;
  readonly feedback: string;

  constructor(correction: LessonGenerationCorrection) {
    super(correction.message);
    this.name = 'LessonGenerationCorrectionError';
    this.code = correction.code;
    this.feedback = correction.feedback;
  }
}

export const retryLessonGenerationCorrection = (
  correction: LessonGenerationCorrection
): LessonGenerationCorrectionError => new LessonGenerationCorrectionError(correction);

export const isLessonStructuredOutputError = (error: unknown): boolean =>
  error instanceof SyntaxError || error instanceof z.ZodError || NoObjectGeneratedError.isInstance(error);
