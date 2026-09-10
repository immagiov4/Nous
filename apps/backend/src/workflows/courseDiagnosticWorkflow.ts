import {
  DIAGNOSTIC_STAGE_EVENT,
  DIAGNOSTIC_SUBMISSION_SIGNAL,
  DiagnosticSubmissionSchema,
} from '@shared/priorKnowledgeDiagnostic.js';
import * as z from 'zod';
import type {
  CourseInterviewStateSchema,
  CourseInterviewWorkflowConfig,
  CourseInterviewWorkflowServices,
} from './courseInterviewWorkflow.js';
import {
  continueRepeatWith,
  emit,
  finishRepeat,
  repeat,
  repeatDecisionSchema,
  sequence,
  step,
  waitForSignal,
} from './definition.js';
import { saveDiagnosticSnapshot } from './persistence/postgresDiagnosticSnapshotStore.js';
import { DiagnosticSnapshotSchema } from './priorKnowledgeDiagnosticSnapshot.js';
import { acceptDiagnosticSubmission } from './priorKnowledgeDiagnosticState.js';
import type { WorkflowNode } from './types.js';

/** Keeps each submitted pass fixed until its successor has been checkpointed. */
export function createCourseDiagnosticSequence(
  hostSchema: typeof CourseInterviewStateSchema,
  maxIterations: number
) {
  const sessionSchema = z.object({
    host: hostSchema,
    snapshot: DiagnosticSnapshotSchema,
  });
  const decisionSchema = repeatDecisionSchema(sessionSchema);
  type Config = CourseInterviewWorkflowConfig;
  type Services = CourseInterviewWorkflowServices;
  const start = step<typeof hostSchema, typeof sessionSchema, Config, Services>({
    id: 'start-prior-knowledge-diagnostic',
    inputSchema: hostSchema,
    outputSchema: sessionSchema,
    externalEffect: 'provider',
    run: async ({ input, execution, idempotencyKey, attemptNumber, config, services, signal }) => {
      if (!input.profile || !services.diagnostic)
        throw new Error('Diagnostic interview services and profile are required.');
      const incarnationId = await services.diagnostic.readIncarnation(
        input.userId,
        input.projectId
      );
      const collection = await services.diagnostic.model.start({
        ...input,
        profile: input.profile,
        config: config.models,
        signal,
        runId: execution.runId,
        outputId: idempotencyKey,
        providerAttemptRef: `${execution.nodeInstanceId}:${attemptNumber}`,
      });
      return {
        host: input,
        snapshot: {
          ref: {
            userId: input.userId,
            projectId: input.projectId,
            incarnationId,
            diagnosticId: collection.collectionId,
            revisionId: idempotencyKey,
          },
          recordedAt: new Date().toISOString(),
          collection,
        },
      };
    },
    commit: ({ output, services, transaction }) =>
      services.diagnostic!.saveSnapshot(transaction, output.snapshot),
  });
  const publish = (id: string) =>
    emit({
      id,
      event: DIAGNOSTIC_STAGE_EVENT,
      inputSchema: sessionSchema,
      payload: input => ({
        collectionId: input.snapshot.collection.collectionId,
        stage: input.snapshot.collection.passes.at(-1)!.stage,
      }),
    });
  const wait = waitForSignal({
    id: 'wait-for-diagnostic-submission',
    inputSchema: sessionSchema,
    outputSchema: sessionSchema,
    signal: DIAGNOSTIC_SUBMISSION_SIGNAL,
    payloadSchema: DiagnosticSubmissionSchema,
    resume: (input, payload, receivedAt) => {
      if (!receivedAt)
        throw new Error('Diagnostic signal acceptance requires the server timestamp.');
      return {
        ...input,
        snapshot: {
          ...input.snapshot,
          ref: {
            ...input.snapshot.ref,
            revisionId: `${input.snapshot.ref.revisionId}:submission:${payload.requestId}`,
          },
          recordedAt: receivedAt,
          collection: acceptDiagnosticSubmission(input.snapshot.collection, payload, receivedAt),
        },
      };
    },
    commit: ({ output, transaction }) => saveDiagnosticSnapshot(transaction, output.snapshot),
  });
  const advance = step<typeof sessionSchema, typeof sessionSchema, Config, Services>({
    id: 'adapt-prior-knowledge-diagnostic',
    inputSchema: sessionSchema,
    outputSchema: sessionSchema,
    externalEffect: 'provider',
    run: async ({ input, execution, idempotencyKey, attemptNumber, config, services, signal }) => {
      if (
        !input.snapshot.collection.passes.at(-1)?.submission ||
        !input.host.profile ||
        !services.diagnostic
      )
        throw new Error('Diagnostic pass is not ready for interpretation.');
      const collection = await services.diagnostic.model.advance({
        ...input.host,
        profile: input.host.profile,
        config: config.models,
        signal,
        runId: execution.runId,
        outputId: idempotencyKey,
        providerAttemptRef: `${execution.nodeInstanceId}:${attemptNumber}`,
        collection: input.snapshot.collection,
      });
      return {
        host: input.host,
        snapshot: {
          ...input.snapshot,
          ref: { ...input.snapshot.ref, revisionId: idempotencyKey },
          recordedAt: new Date().toISOString(),
          collection,
        },
      };
    },
    commit: ({ output, services, transaction }) =>
      services.diagnostic!.saveSnapshot(transaction, output.snapshot),
  });
  const decide = step<typeof sessionSchema, typeof decisionSchema, Config, Services>({
    id: 'continue-or-finish-diagnostic',
    inputSchema: sessionSchema,
    outputSchema: decisionSchema,
    run: async ({ input }) =>
      input.snapshot.collection.collectionEnd ? finishRepeat(input) : continueRepeatWith(input),
  });
  const collect = repeat({
    id: 'collect-prior-knowledge',
    stateSchema: sessionSchema,
    maxIterations,
    body: sequence({
      id: 'diagnostic-pass',
      nodes: [
        wait as WorkflowNode<
          z.infer<typeof sessionSchema>,
          z.infer<typeof sessionSchema>,
          Config,
          Services
        >,
        advance,
        publish('publish-next-diagnostic-stage'),
        decide,
      ] as const,
    }),
    onExhausted: () => {
      throw new Error('Diagnostic collection reached the interview safety fuse.');
    },
  });
  const finish = step<typeof sessionSchema, typeof hostSchema, Config, Services>({
    id: 'retain-approved-diagnostic-reference',
    inputSchema: sessionSchema,
    outputSchema: hostSchema,
    run: async ({ input }) => ({ ...input.host, diagnosticRef: input.snapshot.ref }),
  });
  return sequence({
    id: 'course-prior-knowledge-diagnostic',
    nodes: [start, publish('publish-initial-diagnostic-stage'), collect, finish] as const,
  });
}
