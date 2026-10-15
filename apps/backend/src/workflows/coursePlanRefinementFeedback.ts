import * as z from 'zod';
import {
  CoursePlanVerificationSchema,
  type CoursePlanVerificationState,
  CourseRawArchivePlanSchema,
  CourseRawPlanSchema,
} from './courseGenerationWorkflowContract.js';
import { retryCorrective, WorkflowStepError } from './retryPolicy.js';

const RefinementFeedbackSchema = z.object({
  rejectedCandidate: z.object({
    rawPlan: z.unknown(),
  }),
  verification: CoursePlanVerificationSchema,
});

const readRefinementFeedback = (input: CoursePlanVerificationState, feedback?: string) => {
  if (!feedback) return undefined;
  try {
    const parsed = RefinementFeedbackSchema.safeParse(JSON.parse(feedback));
    if (!parsed.success) return undefined;
    const planSchema =
      input.strategy === 'archive' ? CourseRawArchivePlanSchema : CourseRawPlanSchema;
    const plan = planSchema.safeParse(parsed.data.rejectedCandidate.rawPlan);
    return plan.success ? { ...parsed.data, rejectedCandidate: { rawPlan: plan.data } } : undefined;
  } catch {
    // Other corrective failures use plain feedback rather than a refinement snapshot.
    return undefined;
  }
};

/** Resume the latest checked candidate, carrying only its original unmet conditions forward. */
export const resumeCoursePlanRefinementInput = (
  input: CoursePlanVerificationState,
  feedback?: string
): CoursePlanVerificationState => {
  const snapshot = readRefinementFeedback(input, feedback);
  return snapshot
    ? {
        ...input,
        rawDraftPlan: snapshot.rejectedCandidate.rawPlan,
        verification: snapshot.verification,
      }
    : input;
};

/** Keep settled conditions across corrective output errors as well as rejected candidates. */
export const preserveCoursePlanRefinementFeedback = async <Output>(
  input: CoursePlanVerificationState,
  operation: () => Promise<Output>
): Promise<Output> => {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof WorkflowStepError &&
      error.failure.kind === 'corrective' &&
      !readRefinementFeedback(input, error.failure.feedback)
    ) {
      throw retryCorrective({
        ...error.failure,
        feedback: JSON.stringify({
          rejectedCandidate: { rawPlan: input.rawDraftPlan },
          verification: input.verification,
          correction: error.failure.feedback,
        }),
      });
    }
    throw error;
  }
};
