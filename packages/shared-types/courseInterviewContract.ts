import * as z from 'zod';

const NonEmptyTextSchema = z.string().min(1);

export const COURSE_INTERVIEW_WORKFLOW_ID = 'course-interview';
export const COURSE_INTERVIEW_EVENT_SCHEMA_VERSION = 1;
export const COURSE_INTERVIEW_ENDED_EVENT = 'course-interview-ended';
export const COURSE_INTERVIEW_MESSAGE_EVENT = 'course-interview-message';
export const COURSE_INTERVIEW_PROPOSAL_READY_EVENT = 'course-proposal-ready';
export const COURSE_INTERVIEW_GENERATION_STARTED_EVENT = 'course-generation-started';
export const COURSE_INTERVIEW_USER_ANSWER_SIGNAL = 'user-answer';
export const COURSE_INTERVIEW_DECISION_SIGNAL = 'course-decision';

export const CourseInterviewMessageSchema = z.object({
  role: z.enum(['model', 'user']),
  text: NonEmptyTextSchema,
});

export const CourseInterviewProposalSchema = z.object({
  context: NonEmptyTextSchema,
  experienceLevel: NonEmptyTextSchema,
  goals: NonEmptyTextSchema,
  language: NonEmptyTextSchema,
  learningStyle: NonEmptyTextSchema,
  topic: NonEmptyTextSchema,
});

export const CourseInterviewUserAnswerSignalSchema = z.object({ text: NonEmptyTextSchema });

export const CourseInterviewDecisionSignalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approve') }),
  z.object({ details: NonEmptyTextSchema, kind: z.literal('add-details') }),
  z.object({ kind: z.literal('cancel') }),
]);

export const CourseInterviewStartFieldsSchema = z.object({
  hasReliableSourceContext: z.boolean(),
  initialMessage: NonEmptyTextSchema.optional(),
  mode: z.enum(['document', 'learn']),
  projectId: NonEmptyTextSchema,
  requestKey: NonEmptyTextSchema,
  sourceContext: NonEmptyTextSchema.optional(),
});

export const CourseInterviewStartRequestSchema =
  CourseInterviewStartFieldsSchema.strict().superRefine((input, context) => {
    if (input.hasReliableSourceContext && !input.sourceContext) {
      context.addIssue({
        code: 'custom',
        message: 'Reliable source context requires sourceContext.',
        path: ['sourceContext'],
      });
    }
  });

export const CourseInterviewRunSchema = z.object({
  createdAt: z.string(),
  id: NonEmptyTextSchema,
  projectId: NonEmptyTextSchema,
  status: z.enum(['cancelled', 'completed', 'expired', 'failed', 'queued', 'running', 'waiting']),
  updatedAt: z.string(),
});

export const CourseInterviewMessageEventSchema = z.object({
  message: CourseInterviewMessageSchema,
});
export const CourseInterviewProposalReadyEventSchema = z.object({
  proposal: CourseInterviewProposalSchema,
});
export const CourseInterviewGenerationStartedEventSchema = z.object({
  generationRunId: NonEmptyTextSchema,
  projectId: NonEmptyTextSchema,
});

export const CourseInterviewResultSchema = z.discriminatedUnion('kind', [
  z.object({
    generationRunId: NonEmptyTextSchema,
    kind: z.literal('approved'),
    projectId: NonEmptyTextSchema,
  }),
  z.object({ kind: z.literal('cancelled'), projectId: NonEmptyTextSchema }),
  z.object({ kind: z.literal('exhausted'), projectId: NonEmptyTextSchema }),
]);

export type CourseInterviewDecisionSignal = z.infer<typeof CourseInterviewDecisionSignalSchema>;
export type CourseInterviewMessage = z.infer<typeof CourseInterviewMessageSchema>;
export type CourseInterviewProposal = z.infer<typeof CourseInterviewProposalSchema>;
export type CourseInterviewResult = z.infer<typeof CourseInterviewResultSchema>;
export type CourseInterviewRun = z.infer<typeof CourseInterviewRunSchema>;
export type CourseInterviewStartRequest = z.infer<typeof CourseInterviewStartRequestSchema>;
