import * as z from 'zod';

export const DIAGNOSTIC_STAGE_EVENT = 'course-diagnostic-stage';
export const DIAGNOSTIC_SUBMISSION_SIGNAL = 'diagnostic-submission';

const Identifier = z.string().min(1);
const Text = z.string().regex(/\S/);

const SelfAssessmentSchema = z.enum([
  'unfamiliar',
  'heard-of',
  'basics',
  'independent',
  'uncertain',
]);

export const DiagnosticResponseFormatSchema = z.discriminatedUnion('format', [
  z.object({ format: z.literal('text') }),
  z.object({
    format: z.literal('choice'),
    options: z.array(z.object({ id: Identifier, text: Text })).min(2),
  }),
]);

const QuestionFields = z.object({ id: Identifier, topic: Text, prompt: Text });
const DiagnosticQuestionSchema = z.discriminatedUnion('format', [
  QuestionFields.extend(DiagnosticResponseFormatSchema.options[0].shape),
  QuestionFields.extend(DiagnosticResponseFormatSchema.options[1].shape),
]);

/** Public projection: no expected answers, criteria or intermediate interpretations. */
export const DiagnosticStageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('self-assessment'),
    id: Identifier,
    title: Text,
    topics: z
      .array(z.object({ id: Identifier, parentId: Identifier.nullable(), title: Text }))
      .min(1),
  }),
  z.object({
    kind: z.literal('round'),
    id: Identifier,
    title: Text,
    questions: z.array(DiagnosticQuestionSchema).min(1),
  }),
  z.object({ kind: z.literal('complete'), id: Identifier, title: Text, feedback: Text }),
]);

export const DiagnosticAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('self-report'), value: SelfAssessmentSchema }),
  z.object({ kind: z.literal('text'), text: z.string().regex(/\S/) }),
  z.object({ kind: z.literal('choice'), optionId: Identifier }),
  z.object({ kind: z.literal('not-submitted') }),
]);

export const DiagnosticSubmissionSchema = z.object({
  collectionId: Identifier,
  stageId: Identifier,
  requestId: Identifier,
  answers: z.array(z.object({ itemId: Identifier, response: DiagnosticAnswerSchema })),
});

export const DiagnosticStageEventSchema = z.object({
  collectionId: Identifier,
  stage: DiagnosticStageSchema,
});

export type DiagnosticStage = z.infer<typeof DiagnosticStageSchema>;
export type DiagnosticSubmission = z.infer<typeof DiagnosticSubmissionSchema>;
