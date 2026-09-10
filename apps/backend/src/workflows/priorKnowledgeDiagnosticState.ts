import {
  CourseInterviewMessageSchema,
  CourseInterviewProposalSchema,
} from '@shared/courseInterviewContract.js';
import { CoursePlanningPreferencesSchema } from '@shared/coursePlanningControls.js';
import {
  DiagnosticAnswerSchema,
  DiagnosticResponseFormatSchema,
  DiagnosticStageSchema,
  type DiagnosticSubmission,
  DiagnosticSubmissionSchema,
} from '@shared/priorKnowledgeDiagnostic.js';
import * as z from 'zod';

const Text = z.string().min(1);

export const DiagnosticNodeSchema = z.object({
  nodeId: Text,
  parentNodeId: Text.nullable(),
  title: Text,
  scope: Text,
});

export const DiagnosticTaskSchema = z.object({
  taskId: Text,
  nodeIds: z.array(Text).min(1),
  claim: z.object({ claimId: Text, statement: Text, scope: Text }),
  criteria: z.array(z.object({ criterionId: Text, expectedEvidence: Text })).min(1),
  learnerPrompt: Text,
  responseFormatDefinition: DiagnosticResponseFormatSchema,
  selectionReason: Text,
});

export const DiagnosticInterpretationSchema = z.object({
  attemptId: Text,
  criterionId: Text,
  observation: Text,
  assessment: Text,
  limitations: z.array(Text),
});

const GapSchema = z.object({ nodeIds: z.array(Text), question: Text, reason: Text });
const ConflictSchema = z.object({
  nodeIds: z.array(Text),
  relatedItemIds: z.array(Text).min(1),
  description: Text,
});

export const DiagnosticEvaluationSchema = z.object({
  interpretations: z.array(DiagnosticInterpretationSchema),
  missingInformation: z.array(GapSchema),
  conflicts: z.array(ConflictSchema),
});

/** Each pass keeps the exact administered tasks and raw submission, including omissions. */
export const DiagnosticPassSchema = z.object({
  stage: DiagnosticStageSchema,
  tasks: z.array(DiagnosticTaskSchema),
  submission: DiagnosticSubmissionSchema.optional(),
  receivedAt: z.string().optional(),
  attempts: z.array(
    z.object({
      attemptId: Text,
      taskId: Text,
      response: DiagnosticAnswerSchema,
      recordedAt: Text,
    })
  ),
});

export const DiagnosticCollectionSchema = z.object({
  schemaVersion: z.literal(1),
  collectionId: Text,
  interviewRunId: Text,
  projectId: Text,
  profile: CourseInterviewProposalSchema.extend(CoursePlanningPreferencesSchema.shape),
  context: z.object({
    sourceContext: z.string().optional(),
    hasReliableSourceContext: z.boolean(),
    messages: z.array(CourseInterviewMessageSchema),
  }),
  modelOutputs: z
    .array(
      z.object({
        outputId: Text,
        model: Text,
        providerAttemptRef: Text,
        recordedAt: Text,
        value: Text,
      })
    )
    .min(1),
  nodes: z.array(DiagnosticNodeSchema).min(1),
  passes: z.array(DiagnosticPassSchema).min(1),
  evaluations: z.array(
    z.object({
      revisionId: Text,
      recordedAt: Text,
      evaluator: Text,
      evaluation: DiagnosticEvaluationSchema,
    })
  ),
  collectionEnd: z
    .object({
      eventRef: Text,
      reason: Text,
      recordedAt: Text,
      unresolvedLimitations: z.array(Text),
    })
    .optional(),
});

export type DiagnosticCollection = z.infer<typeof DiagnosticCollectionSchema>;
export type DiagnosticTask = z.infer<typeof DiagnosticTaskSchema>;
export type DiagnosticEvaluation = z.infer<typeof DiagnosticEvaluationSchema>;

/** The signal describes every item exactly once; order is the server's published order. */
export function acceptDiagnosticSubmission(
  collection: DiagnosticCollection,
  submission: DiagnosticSubmission,
  receivedAt: string
): DiagnosticCollection {
  const pass = collection.passes.at(-1);
  if (!pass || pass.stage.kind === 'complete' || pass.submission || collection.collectionEnd) {
    throw new Error('The diagnostic collection is not waiting for a submission.');
  }
  if (submission.collectionId !== collection.collectionId || submission.stageId !== pass.stage.id) {
    throw new Error('The diagnostic submission targets a different collection or pass.');
  }
  const expectedIds =
    pass.stage.kind === 'self-assessment'
      ? collection.nodes.map(node => node.nodeId)
      : pass.stage.questions.map(question => question.id);
  const responses = new Map(submission.answers.map(answer => [answer.itemId, answer.response]));
  if (responses.size !== submission.answers.length || responses.size !== expectedIds.length) {
    throw new Error('A diagnostic submission must include every item exactly once.');
  }
  const orderedAnswers: DiagnosticSubmission['answers'] = [];
  for (const id of expectedIds) {
    const response = responses.get(id);
    if (!response) throw new Error('The diagnostic submission is missing an item.');
    orderedAnswers.push({ itemId: id, response });
    if (response.kind === 'not-submitted') continue;
    if (pass.stage.kind === 'self-assessment') {
      if (response.kind !== 'self-report') throw new Error('Expected a self report.');
      continue;
    }
    const question = pass.stage.questions.find(question => question.id === id);
    if (!question || question.format !== response.kind)
      throw new Error('Unexpected response format.');
    if (
      question.format === 'choice' &&
      response.kind === 'choice' &&
      !question.options.some(option => option.id === response.optionId)
    ) {
      throw new Error('The selected option was not administered.');
    }
  }
  return {
    ...collection,
    passes: [
      ...collection.passes.slice(0, -1),
      {
        ...pass,
        receivedAt,
        attempts:
          pass.stage.kind === 'round'
            ? orderedAnswers.map(({ itemId: taskId, response }, index) => ({
                attemptId: `${submission.requestId}:attempt:${index}`,
                taskId,
                response,
                recordedAt: receivedAt,
              }))
            : [],
        submission: {
          ...submission,
          answers: orderedAnswers,
        },
      },
    ],
  };
}

/** Reject invented evidence references before persisting model interpretations. */
export function validateDiagnosticEvaluation(
  collection: DiagnosticCollection,
  evaluation: DiagnosticEvaluation
): void {
  const nodeIds = new Set(collection.nodes.map(node => node.nodeId));
  const tasks = new Map(
    collection.passes.flatMap(pass => pass.tasks.map(task => [task.taskId, task] as const))
  );
  const responses = new Map(
    collection.passes.flatMap(
      pass =>
        pass.submission?.answers.map(answer => [answer.itemId, answer.response] as const) ?? []
    )
  );
  const attempts = new Map(
    collection.passes.flatMap(pass =>
      pass.attempts.map(attempt => [attempt.attemptId, attempt] as const)
    )
  );
  const interpreted = new Set<string>();
  for (const interpretation of evaluation.interpretations) {
    const attempt = attempts.get(interpretation.attemptId);
    const task = attempt && tasks.get(attempt.taskId);
    const response = attempt?.response;
    const key = `${interpretation.attemptId}:${interpretation.criterionId}`;
    if (
      !task ||
      !response ||
      response.kind === 'not-submitted' ||
      !task.criteria.some(criterion => criterion.criterionId === interpretation.criterionId) ||
      interpreted.has(key)
    ) {
      throw new Error(
        'The diagnostic interpretation does not identify submitted criterion evidence.'
      );
    }
    interpreted.add(key);
  }
  for (const entry of [...evaluation.missingInformation, ...evaluation.conflicts]) {
    if (entry.nodeIds.some(nodeId => !nodeIds.has(nodeId)))
      throw new Error('Unknown diagnostic node reference.');
  }
  for (const conflict of evaluation.conflicts) {
    if (conflict.relatedItemIds.some(itemId => !responses.has(itemId))) {
      throw new Error('Unknown diagnostic conflict evidence reference.');
    }
  }
}
