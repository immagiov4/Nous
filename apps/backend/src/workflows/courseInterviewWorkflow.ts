import {
  COURSE_INTERVIEW_DECISION_SIGNAL,
  COURSE_INTERVIEW_ENDED_EVENT,
  COURSE_INTERVIEW_EVENT_SCHEMA_VERSION,
  COURSE_INTERVIEW_GENERATION_STARTED_EVENT,
  COURSE_INTERVIEW_MESSAGE_EVENT,
  COURSE_INTERVIEW_PROPOSAL_READY_EVENT,
  COURSE_INTERVIEW_USER_ANSWER_SIGNAL,
  COURSE_INTERVIEW_WORKFLOW_ID,
  CourseInterviewDecisionSignalSchema,
  CourseInterviewGenerationStartedEventSchema,
  CourseInterviewMessageEventSchema,
  CourseInterviewMessageSchema,
  CourseInterviewProposalReadyEventSchema,
  CourseInterviewResultSchema,
  CourseInterviewStartFieldsSchema,
  CourseInterviewUserAnswerSignalSchema,
} from '@shared/courseInterviewContract.js';
import * as z from 'zod';

import type { GlobalModelConfig } from '../config/modelConfig.js';
import { WorkflowExecutionDefaultsSchema } from './config.js';
import type { CourseInterviewTurn } from './courseInterviewModel.js';
import { CourseInterviewTurnSchema } from './courseInterviewModel.js';
import {
  continueRepeatWith,
  emit,
  finishRepeat,
  repeat,
  repeatDecisionSchema,
  routeBy,
  sequence,
  step,
  waitForSignal,
  workflow,
} from './definition.js';
import { GlobalModelConfigSchema } from './modelConfigSchema.js';
import type {
  DeepReadonly,
  WorkflowExecutionDefaults,
  WorkflowNode,
  WorkflowStepExecutionIdentity,
} from './types.js';

export { COURSE_INTERVIEW_WORKFLOW_ID } from '@shared/courseInterviewContract.js';

export const CourseInterviewWorkflowInputSchema = CourseInterviewStartFieldsSchema.omit({
  requestKey: true,
}).extend({ userId: z.string().min(1) });

export type CourseInterviewWorkflowInput = z.infer<typeof CourseInterviewWorkflowInputSchema>;

export const CourseInterviewWorkflowConfigSchema = WorkflowExecutionDefaultsSchema.extend({
  models: GlobalModelConfigSchema,
});

export type CourseInterviewWorkflowConfig = WorkflowExecutionDefaults & {
  readonly models: GlobalModelConfig;
};

const CourseInterviewDecisionStateSchema = z.enum(['active', 'approve', 'cancel', 'exhausted']);

const CourseInterviewStateSchema = CourseInterviewWorkflowInputSchema.omit({
  initialMessage: true,
}).extend({
  decision: CourseInterviewDecisionStateSchema,
  generationRunId: z.string().min(1).optional(),
  messages: z.array(CourseInterviewMessageSchema),
  profile: CourseInterviewProposalReadyEventSchema.shape.proposal.optional(),
});

const CourseInterviewTurnStateSchema = z.object({
  state: CourseInterviewStateSchema,
  turn: CourseInterviewTurnSchema,
});

const CourseInterviewRepeatDecisionSchema = repeatDecisionSchema(CourseInterviewStateSchema);

type CourseInterviewState = z.infer<typeof CourseInterviewStateSchema>;
type CourseInterviewTurnState = z.infer<typeof CourseInterviewTurnStateSchema>;

interface CourseInterviewCleanupInput {
  readonly execution: WorkflowStepExecutionIdentity;
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly signal: AbortSignal;
  readonly userId: string;
}

export interface CourseInterviewWorkflowServices {
  readonly assessTurn: (input: {
    config: DeepReadonly<GlobalModelConfig>;
    hasReliableSourceContext: boolean;
    messages: readonly z.infer<typeof CourseInterviewMessageSchema>[];
    mode: 'document' | 'learn';
    projectId: string;
    signal: AbortSignal;
    sourceContext?: string;
    userId: string;
  }) => Promise<CourseInterviewTurn>;
  /** Deletes the draft only when no course-generation run has claimed the same project. */
  readonly discardUnclaimedDraftProject: (input: CourseInterviewCleanupInput) => Promise<void>;
  readonly saveCourseProfile: (input: {
    execution: WorkflowStepExecutionIdentity;
    idempotencyKey: string;
    mode: 'document' | 'learn';
    profile: z.infer<typeof CourseInterviewProposalReadyEventSchema>['proposal'];
    projectId: string;
    signal: AbortSignal;
    userId: string;
  }) => Promise<void>;
  readonly startCourseGeneration: (input: {
    assessmentHistory: readonly z.infer<typeof CourseInterviewMessageSchema>[];
    idempotencyKey: string;
    mode: 'document' | 'learn';
    models: DeepReadonly<GlobalModelConfig>;
    projectId: string;
    signal: AbortSignal;
    userId: string;
  }) => Promise<{ runId: string }>;
}

const appendModelMessage = (
  state: CourseInterviewState,
  turn: CourseInterviewTurn
): CourseInterviewState => ({
  ...state,
  messages: [...state.messages, { role: 'model', text: turn.message }],
});

const latestMessage = (state: CourseInterviewState) => {
  const message = state.messages.at(-1);
  if (!message) throw new Error('Course interview state must contain a message.');
  return message;
};

export const createCourseInterviewWorkflow = (
  executionDefaults: CourseInterviewWorkflowConfig,
  maxIterations: number
) => {
  const emitInitialMessage = emit({
    event: COURSE_INTERVIEW_MESSAGE_EVENT,
    id: 'emit-initial-course-interview-message',
    inputSchema: CourseInterviewWorkflowInputSchema,
    payload: input => {
      if (!input.initialMessage) {
        throw new Error('Initial course interview event requires a message.');
      }
      return { message: { role: 'user' as const, text: input.initialMessage } };
    },
  });

  const skipInitialMessage = step<
    typeof CourseInterviewWorkflowInputSchema,
    typeof CourseInterviewWorkflowInputSchema,
    CourseInterviewWorkflowConfig,
    CourseInterviewWorkflowServices
  >({
    id: 'skip-empty-course-interview-message',
    inputSchema: CourseInterviewWorkflowInputSchema,
    outputSchema: CourseInterviewWorkflowInputSchema,
    run: async ({ input }) => input,
  });

  const routeInitialMessage = routeBy<
    typeof CourseInterviewWorkflowInputSchema,
    typeof CourseInterviewWorkflowInputSchema,
    CourseInterviewWorkflowConfig,
    CourseInterviewWorkflowServices
  >({
    cases: { empty: skipInitialMessage, message: emitInitialMessage },
    id: 'route-initial-course-interview-message',
    inputSchema: CourseInterviewWorkflowInputSchema,
    outputSchema: CourseInterviewWorkflowInputSchema,
    select: input => (input.initialMessage ? 'message' : 'empty'),
  });

  const ownDraftLifetime = step<
    typeof CourseInterviewWorkflowInputSchema,
    typeof CourseInterviewWorkflowInputSchema,
    CourseInterviewWorkflowConfig,
    CourseInterviewWorkflowServices
  >({
    id: 'own-course-interview-draft-lifetime',
    inputSchema: CourseInterviewWorkflowInputSchema,
    outputSchema: CourseInterviewWorkflowInputSchema,
    run: async ({ input }) => input,
    undo: ({ execution, idempotencyKey, input, services, signal }) =>
      services.discardUnclaimedDraftProject({
        execution,
        idempotencyKey,
        projectId: input.projectId,
        signal,
        userId: input.userId,
      }),
  });

  const initializeInterview = step<
    typeof CourseInterviewWorkflowInputSchema,
    typeof CourseInterviewStateSchema,
    CourseInterviewWorkflowConfig,
    CourseInterviewWorkflowServices
  >({
    id: 'initialize-course-interview',
    inputSchema: CourseInterviewWorkflowInputSchema,
    outputSchema: CourseInterviewStateSchema,
    run: async ({ input }) => ({
      decision: 'active',
      hasReliableSourceContext: input.hasReliableSourceContext,
      messages: input.initialMessage ? [{ role: 'user', text: input.initialMessage }] : [],
      mode: input.mode,
      projectId: input.projectId,
      ...(input.sourceContext ? { sourceContext: input.sourceContext } : {}),
      userId: input.userId,
    }),
  });

  const assessInterview = step<
    typeof CourseInterviewStateSchema,
    typeof CourseInterviewTurnStateSchema,
    CourseInterviewWorkflowConfig,
    CourseInterviewWorkflowServices
  >({
    id: 'assess-course-interview',
    inputSchema: CourseInterviewStateSchema,
    outputSchema: CourseInterviewTurnStateSchema,
    run: async ({ config, input, services, signal }) => ({
      state: input,
      turn: await services.assessTurn({
        config: config.models,
        hasReliableSourceContext: input.hasReliableSourceContext,
        messages: input.messages,
        mode: input.mode,
        projectId: input.projectId,
        signal,
        ...(input.sourceContext ? { sourceContext: input.sourceContext } : {}),
        userId: input.userId,
      }),
    }),
  });

  const emitQuestion = emit({
    event: COURSE_INTERVIEW_MESSAGE_EVENT,
    id: 'emit-course-interview-question',
    inputSchema: CourseInterviewTurnStateSchema,
    payload: input => ({
      message: { role: 'model' as const, text: input.turn.message },
    }),
  });

  const waitForUserAnswer = waitForSignal({
    id: 'wait-for-course-interview-answer',
    inputSchema: CourseInterviewTurnStateSchema,
    outputSchema: CourseInterviewStateSchema,
    payloadSchema: CourseInterviewUserAnswerSignalSchema,
    resume: (input, payload) => ({
      ...appendModelMessage(input.state, input.turn),
      decision: 'active' as const,
      messages: [
        ...appendModelMessage(input.state, input.turn).messages,
        { role: 'user' as const, text: payload.text },
      ],
    }),
    signal: COURSE_INTERVIEW_USER_ANSWER_SIGNAL,
  });

  const emitLatestUserMessage = (id: string) =>
    emit({
      event: COURSE_INTERVIEW_MESSAGE_EVENT,
      id,
      inputSchema: CourseInterviewStateSchema,
      payload: state => ({ message: latestMessage(state) }),
    });

  const continueInterview = (id: string) =>
    step<
      typeof CourseInterviewStateSchema,
      typeof CourseInterviewRepeatDecisionSchema,
      CourseInterviewWorkflowConfig,
      CourseInterviewWorkflowServices
    >({
      id,
      inputSchema: CourseInterviewStateSchema,
      outputSchema: CourseInterviewRepeatDecisionSchema,
      run: async ({ input }) => continueRepeatWith(input),
    });

  const emitProposalMessage = emit({
    event: COURSE_INTERVIEW_MESSAGE_EVENT,
    id: 'emit-course-interview-proposal-message',
    inputSchema: CourseInterviewTurnStateSchema,
    payload: input => ({
      message: { role: 'model' as const, text: input.turn.message },
    }),
  });

  const emitCancellationMessage = emit({
    event: COURSE_INTERVIEW_MESSAGE_EVENT,
    id: 'emit-model-cancelled-course-interview-message',
    inputSchema: CourseInterviewTurnStateSchema,
    payload: input => ({
      message: { role: 'model' as const, text: input.turn.message },
    }),
  });

  const emitProposal = emit({
    event: COURSE_INTERVIEW_PROPOSAL_READY_EVENT,
    id: 'emit-course-interview-proposal',
    inputSchema: CourseInterviewTurnStateSchema,
    payload: input => {
      if (input.turn.kind !== 'proposal') {
        throw new Error('Course proposal event requires a proposal turn.');
      }
      return { proposal: input.turn.proposal };
    },
  });

  const waitForCourseDecision = waitForSignal({
    id: 'wait-for-course-interview-decision',
    inputSchema: CourseInterviewTurnStateSchema,
    outputSchema: CourseInterviewStateSchema,
    payloadSchema: CourseInterviewDecisionSignalSchema,
    resume: (input, decision) => {
      const state = appendModelMessage(input.state, input.turn);
      if (input.turn.kind !== 'proposal') {
        throw new Error('Course decision requires a proposal turn.');
      }
      if (decision.kind === 'add-details') {
        return {
          ...state,
          decision: 'active' as const,
          messages: [...state.messages, { role: 'user' as const, text: decision.details }],
          profile: input.turn.proposal,
        };
      }
      return { ...state, decision: decision.kind, profile: input.turn.proposal };
    },
    signal: COURSE_INTERVIEW_DECISION_SIGNAL,
  });

  const startCourseGeneration = step<
    typeof CourseInterviewStateSchema,
    typeof CourseInterviewStateSchema,
    CourseInterviewWorkflowConfig,
    CourseInterviewWorkflowServices
  >({
    id: 'start-course-generation-from-interview',
    inputSchema: CourseInterviewStateSchema,
    outputSchema: CourseInterviewStateSchema,
    run: async ({ config, idempotencyKey, input, services, signal }) => {
      const generation = await services.startCourseGeneration({
        assessmentHistory: input.messages,
        idempotencyKey,
        mode: input.mode,
        models: config.models,
        projectId: input.projectId,
        signal,
        userId: input.userId,
      });
      return { ...input, generationRunId: generation.runId };
    },
  });

  const saveCourseProfile = step<
    typeof CourseInterviewStateSchema,
    typeof CourseInterviewStateSchema,
    CourseInterviewWorkflowConfig,
    CourseInterviewWorkflowServices
  >({
    id: 'save-course-interview-profile',
    inputSchema: CourseInterviewStateSchema,
    outputSchema: CourseInterviewStateSchema,
    run: async ({ execution, idempotencyKey, input, services, signal }) => {
      if (!input.profile) throw new Error('Approved course interview requires a profile.');
      await services.saveCourseProfile({
        execution,
        idempotencyKey,
        mode: input.mode,
        profile: input.profile,
        projectId: input.projectId,
        signal,
        userId: input.userId,
      });
      return input;
    },
  });

  const emitGenerationStarted = emit({
    event: COURSE_INTERVIEW_GENERATION_STARTED_EVENT,
    id: 'emit-course-generation-started',
    inputSchema: CourseInterviewStateSchema,
    payload: state => {
      if (!state.generationRunId) {
        throw new Error('Course generation event requires a run id.');
      }
      return { generationRunId: state.generationRunId, projectId: state.projectId };
    },
  });

  const finishInterview = (id: string) =>
    step<
      typeof CourseInterviewStateSchema,
      typeof CourseInterviewRepeatDecisionSchema,
      CourseInterviewWorkflowConfig,
      CourseInterviewWorkflowServices
    >({
      id,
      inputSchema: CourseInterviewStateSchema,
      outputSchema: CourseInterviewRepeatDecisionSchema,
      run: async ({ input }) => finishRepeat(input),
    });

  const discardDraft = (id: string) =>
    step<
      typeof CourseInterviewStateSchema,
      typeof CourseInterviewStateSchema,
      CourseInterviewWorkflowConfig,
      CourseInterviewWorkflowServices
    >({
      id,
      inputSchema: CourseInterviewStateSchema,
      outputSchema: CourseInterviewStateSchema,
      run: async ({ execution, idempotencyKey, input, services, signal }) => {
        await services.discardUnclaimedDraftProject({
          execution,
          idempotencyKey,
          projectId: input.projectId,
          signal,
          userId: input.userId,
        });
        return input;
      },
    });

  const markModelCancellation = step<
    typeof CourseInterviewTurnStateSchema,
    typeof CourseInterviewStateSchema,
    CourseInterviewWorkflowConfig,
    CourseInterviewWorkflowServices
  >({
    id: 'mark-model-cancelled-course-interview',
    inputSchema: CourseInterviewTurnStateSchema,
    outputSchema: CourseInterviewStateSchema,
    run: async ({ input }) => ({
      ...appendModelMessage(input.state, input.turn),
      decision: 'cancel',
    }),
  });

  const routeDecision = routeBy<
    typeof CourseInterviewStateSchema,
    typeof CourseInterviewRepeatDecisionSchema,
    CourseInterviewWorkflowConfig,
    CourseInterviewWorkflowServices
  >({
    cases: {
      active: sequence({
        id: 'add-course-interview-details',
        nodes: [
          emitLatestUserMessage('emit-added-course-interview-details'),
          continueInterview('continue-course-interview-after-details'),
        ] as const,
      }),
      approve: sequence({
        id: 'approve-course-interview',
        nodes: [
          saveCourseProfile,
          startCourseGeneration,
          emitGenerationStarted,
          finishInterview('finish-approved-course-interview'),
        ] as const,
      }),
      cancel: sequence({
        id: 'cancel-course-interview',
        nodes: [
          discardDraft('discard-cancelled-course-interview-draft'),
          finishInterview('finish-cancelled-course-interview'),
        ] as const,
      }),
    },
    id: 'route-course-interview-decision',
    inputSchema: CourseInterviewStateSchema,
    outputSchema: CourseInterviewRepeatDecisionSchema,
    select: state => state.decision,
  });

  const routeTurn = routeBy<
    typeof CourseInterviewTurnStateSchema,
    typeof CourseInterviewRepeatDecisionSchema,
    CourseInterviewWorkflowConfig,
    CourseInterviewWorkflowServices
  >({
    cases: {
      cancelled: sequence({
        id: 'cancel-course-interview-from-model',
        nodes: [
          emitCancellationMessage,
          markModelCancellation,
          discardDraft('discard-model-cancelled-course-interview-draft'),
          finishInterview('finish-model-cancelled-course-interview'),
        ] as const,
      }),
      proposal: sequence({
        id: 'propose-course',
        nodes: [
          emitProposalMessage,
          emitProposal,
          waitForCourseDecision as unknown as WorkflowNode<
            CourseInterviewTurnState,
            CourseInterviewState,
            CourseInterviewWorkflowConfig,
            CourseInterviewWorkflowServices
          >,
          routeDecision,
        ] as const,
      }),
      question: sequence({
        id: 'ask-course-interview-question',
        nodes: [
          emitQuestion,
          waitForUserAnswer as unknown as WorkflowNode<
            CourseInterviewTurnState,
            CourseInterviewState,
            CourseInterviewWorkflowConfig,
            CourseInterviewWorkflowServices
          >,
          emitLatestUserMessage('emit-course-interview-answer'),
          continueInterview('continue-course-interview-after-answer'),
        ] as const,
      }),
    },
    id: 'route-course-interview-turn',
    inputSchema: CourseInterviewTurnStateSchema,
    outputSchema: CourseInterviewRepeatDecisionSchema,
    select: input => input.turn.kind,
  });

  const interviewLoop = repeat({
    body: sequence({
      id: 'course-interview-iteration',
      nodes: [assessInterview, routeTurn] as const,
    }),
    id: 'repeat-course-interview',
    maxIterations,
    onExhausted: state => ({ ...state, decision: 'exhausted' as const }),
    stateSchema: CourseInterviewStateSchema,
  });

  const preserveTerminalState = step<
    typeof CourseInterviewStateSchema,
    typeof CourseInterviewStateSchema,
    CourseInterviewWorkflowConfig,
    CourseInterviewWorkflowServices
  >({
    id: 'preserve-terminal-course-interview-state',
    inputSchema: CourseInterviewStateSchema,
    outputSchema: CourseInterviewStateSchema,
    run: async ({ input }) => input,
  });

  const cleanupExhaustedInterview = routeBy<
    typeof CourseInterviewStateSchema,
    typeof CourseInterviewStateSchema,
    CourseInterviewWorkflowConfig,
    CourseInterviewWorkflowServices
  >({
    cases: {
      exhausted: discardDraft('discard-exhausted-course-interview-draft'),
      terminal: preserveTerminalState,
    },
    id: 'cleanup-exhausted-course-interview',
    inputSchema: CourseInterviewStateSchema,
    outputSchema: CourseInterviewStateSchema,
    select: state => (state.decision === 'exhausted' ? 'exhausted' : 'terminal'),
  });

  const returnResult = step<
    typeof CourseInterviewStateSchema,
    typeof CourseInterviewResultSchema,
    CourseInterviewWorkflowConfig,
    CourseInterviewWorkflowServices
  >({
    id: 'return-course-interview-result',
    inputSchema: CourseInterviewStateSchema,
    outputSchema: CourseInterviewResultSchema,
    run: async ({ input }) => {
      if (input.decision === 'approve' && input.generationRunId) {
        return {
          generationRunId: input.generationRunId,
          kind: 'approved',
          projectId: input.projectId,
        };
      }
      if (input.decision === 'cancel') {
        return { kind: 'cancelled', projectId: input.projectId };
      }
      if (input.decision === 'exhausted') {
        return { kind: 'exhausted', projectId: input.projectId };
      }
      throw new Error('Course interview cannot finish from an active state.');
    },
  });

  const emitInterviewEnded = emit({
    event: COURSE_INTERVIEW_ENDED_EVENT,
    id: 'emit-course-interview-ended',
    inputSchema: CourseInterviewResultSchema,
    payload: result => result,
  });

  return workflow({
    configSchema: CourseInterviewWorkflowConfigSchema,
    events: {
      [COURSE_INTERVIEW_ENDED_EVENT]: {
        durability: 'durable',
        schema: CourseInterviewResultSchema,
        schemaVersion: COURSE_INTERVIEW_EVENT_SCHEMA_VERSION,
      },
      [COURSE_INTERVIEW_GENERATION_STARTED_EVENT]: {
        durability: 'durable',
        schema: CourseInterviewGenerationStartedEventSchema,
        schemaVersion: COURSE_INTERVIEW_EVENT_SCHEMA_VERSION,
      },
      [COURSE_INTERVIEW_MESSAGE_EVENT]: {
        durability: 'durable',
        schema: CourseInterviewMessageEventSchema,
        schemaVersion: COURSE_INTERVIEW_EVENT_SCHEMA_VERSION,
      },
      [COURSE_INTERVIEW_PROPOSAL_READY_EVENT]: {
        durability: 'durable',
        schema: CourseInterviewProposalReadyEventSchema,
        schemaVersion: COURSE_INTERVIEW_EVENT_SCHEMA_VERSION,
      },
    },
    executionDefaults,
    id: COURSE_INTERVIEW_WORKFLOW_ID,
    inputSchema: CourseInterviewWorkflowInputSchema,
    outputSchema: CourseInterviewResultSchema,
    root: sequence({
      id: COURSE_INTERVIEW_WORKFLOW_ID,
      nodes: [
        ownDraftLifetime,
        routeInitialMessage,
        initializeInterview,
        interviewLoop,
        cleanupExhaustedInterview,
        returnResult,
        emitInterviewEnded,
      ] as const,
    }),
    signals: {
      [COURSE_INTERVIEW_DECISION_SIGNAL]: {
        schema: CourseInterviewDecisionSignalSchema,
        schemaVersion: COURSE_INTERVIEW_EVENT_SCHEMA_VERSION,
      },
      [COURSE_INTERVIEW_USER_ANSWER_SIGNAL]: {
        schema: CourseInterviewUserAnswerSignalSchema,
        schemaVersion: COURSE_INTERVIEW_EVENT_SCHEMA_VERSION,
      },
    },
  });
};
