import { NoObjectGeneratedError } from 'ai';
import * as z from 'zod';

const ReviewDiagnosticRootSchema = z.enum(['fencedCode', 'verificationReport']);
const ReviewDiagnosticIndexSchema = z.number().int().nonnegative();
export const LessonReviewDiagnosticSchema = z.object({
  reason: z.enum([
    'schema-invalid',
    'count-mismatch',
    'source-mismatch',
    'prose-remains',
    'unknown-check',
    'duplicate-check',
    'missing-check',
    'action-missing',
    'not-applicable-forbidden',
    'judgment-required',
  ]),
  requiredCheckIndex: ReviewDiagnosticIndexSchema.optional(),
  path: z.union([
    z.tuple([ReviewDiagnosticRootSchema]),
    z.tuple([ReviewDiagnosticRootSchema, ReviewDiagnosticIndexSchema]),
    z.tuple([z.literal('fencedCode'), ReviewDiagnosticIndexSchema, z.enum(['source', 'kind'])]),
    z.tuple([
      z.literal('verificationReport'),
      ReviewDiagnosticIndexSchema,
      z.enum(['checkId', 'status', 'evidence', 'action']),
    ]),
  ]),
});
export type LessonReviewDiagnostic = z.infer<typeof LessonReviewDiagnosticSchema>;

export interface LessonGenerationCorrection {
  readonly code: string;
  readonly feedback: string;
  readonly message: string;
  readonly validation?: LessonReviewDiagnostic;
}

export class LessonGenerationCorrectionError extends Error {
  readonly code: string;
  readonly feedback: string;
  readonly validation?: LessonReviewDiagnostic;

  constructor(correction: LessonGenerationCorrection) {
    super(correction.message);
    this.name = 'LessonGenerationCorrectionError';
    this.code = correction.code;
    this.validation = correction.validation
      ? LessonReviewDiagnosticSchema.parse(correction.validation)
      : undefined;
    this.feedback = this.validation
      ? `${correction.feedback}\nRejected contract: ${JSON.stringify(this.validation)}`
      : correction.feedback;
  }
}

export const retryLessonGenerationCorrection = (
  correction: LessonGenerationCorrection
): LessonGenerationCorrectionError => new LessonGenerationCorrectionError(correction);

export const isLessonStructuredOutputError = (error: unknown): boolean =>
  error instanceof SyntaxError ||
  error instanceof z.ZodError ||
  NoObjectGeneratedError.isInstance(error);
