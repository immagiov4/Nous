import {
  COURSE_INTERVIEW_DECISION_SIGNAL,
  COURSE_INTERVIEW_ENDED_EVENT,
  COURSE_INTERVIEW_EVENT_SCHEMA_VERSION,
  COURSE_INTERVIEW_GENERATION_STARTED_EVENT,
  COURSE_INTERVIEW_MESSAGE_EVENT,
  COURSE_INTERVIEW_PROPOSAL_READY_EVENT,
  COURSE_INTERVIEW_USER_ANSWER_SIGNAL,
  COURSE_INTERVIEW_WORKFLOW_ID,
  type CourseInterviewDecisionSignal,
  CourseInterviewDecisionSignalSchema,
  CourseInterviewGenerationStartedEventSchema,
  type CourseInterviewMessage,
  CourseInterviewMessageEventSchema,
  type CourseInterviewProposal,
  CourseInterviewProposalReadyEventSchema,
  type CourseInterviewResult,
  CourseInterviewResultSchema,
  CourseInterviewRunSchema,
  type CourseInterviewStartRequest,
  CourseInterviewStartRequestSchema,
  CourseInterviewUserAnswerSignalSchema,
} from '@shared/courseInterviewContract';

import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { logBackendFailureCorrelationId } from '../feedback/browserDiagnostics.ts';
import { getBackendUrl } from './config.ts';
import {
  acquireWorkflowRequestKey,
  assertWorkflowPollResponse,
  isDefinitiveWorkflowStartRejection,
  isTransientWorkflowPollError,
  pollWorkflow,
  readWorkflowJson,
  readWorkflowPollJson,
  WORKFLOW_NOT_FOUND_STATUS,
} from './workflowClientTransport.ts';

const COURSE_INTERVIEW_ERROR = 'L’intervista per il corso non è riuscita. Riprova.';
const COURSE_INTERVIEW_REQUEST_KEY_PREFIX = 'nous:course-interview-request:';
const COURSE_INTERVIEW_SIGNAL_KEY_PREFIX = 'nous:course-interview-signal:';
const ACTIVE_INTERVIEW_STATUSES = new Set(['queued', 'running']);
const COURSE_INTERVIEW_STATUSES = new Set([
  'cancelled',
  'completed',
  'expired',
  'failed',
  'queued',
  'running',
  'waiting',
]);
const COURSE_INTERVIEW_SIGNAL_TYPES = new Set([
  COURSE_INTERVIEW_USER_ANSWER_SIGNAL,
  COURSE_INTERVIEW_DECISION_SIGNAL,
]);
const TERMINAL_INTERVIEW_STATUSES = new Set(['cancelled', 'completed', 'expired', 'failed']);

type WorkflowCleanupStatus = 'completed' | 'failed' | 'not-required' | 'pending' | 'running';

type CourseInterviewStatus =
  | 'cancelled'
  | 'completed'
  | 'expired'
  | 'failed'
  | 'queued'
  | 'running'
  | 'waiting';

const isCourseInterviewStatus = (value: string): value is CourseInterviewStatus =>
  COURSE_INTERVIEW_STATUSES.has(value);

const isCourseInterviewSignalType = (value: string): value is CourseInterviewWait['signalType'] =>
  COURSE_INTERVIEW_SIGNAL_TYPES.has(value);

export interface CourseInterviewWait {
  readonly expiresAt: string;
  readonly signalType:
    | typeof COURSE_INTERVIEW_USER_ANSWER_SIGNAL
    | typeof COURSE_INTERVIEW_DECISION_SIGNAL;
  readonly waitId: string;
}

export interface CourseInterviewSnapshot {
  readonly errorCode?: string;
  readonly generationRunId?: string;
  readonly messages: readonly CourseInterviewMessage[];
  readonly projectId: string;
  readonly proposal: CourseInterviewProposal | null;
  readonly result: CourseInterviewResult | null;
  readonly runId: string;
  readonly status: CourseInterviewStatus;
  readonly wait: CourseInterviewWait | null;
}

export type StartCourseInterviewInput = Omit<CourseInterviewStartRequest, 'requestKey'>;

interface CourseInterviewClientOptions {
  readonly onSnapshot?: (snapshot: CourseInterviewSnapshot) => void;
  readonly signal?: AbortSignal;
}

interface SendCourseInterviewAnswerInput {
  readonly projectId: string;
  readonly runId: string;
  readonly text: string;
  readonly waitId: string;
}

interface SendCourseInterviewDecisionInput {
  readonly decision: CourseInterviewDecisionSignal;
  readonly projectId: string;
  readonly runId: string;
  readonly waitId: string;
}

interface CancelCourseInterviewInput {
  readonly projectId: string;
  readonly runId: string;
}

interface WorkflowEventSnapshot {
  readonly eventType: string;
  readonly payload: unknown;
  readonly schemaVersion: number;
  readonly sequence: string;
}

interface WorkflowWaitSnapshot {
  readonly expiresAt: string;
  readonly schemaVersion: number;
  readonly signalType: CourseInterviewWait['signalType'];
  readonly waitId: string;
}

interface CourseInterviewRunSnapshot {
  readonly cleanupStatus: WorkflowCleanupStatus;
  readonly correlationId?: string;
  readonly errorCode?: string;
  readonly events: readonly WorkflowEventSnapshot[];
  readonly projectId: string;
  readonly runId: string;
  readonly status: CourseInterviewStatus;
  readonly waits: readonly WorkflowWaitSnapshot[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readRunSummary = async (response: Response, projectId: string) => {
  const payload = await readWorkflowJson(response);
  if (!response.ok || !isRecord(payload) || payload.success !== true) {
    throw new Error(COURSE_INTERVIEW_ERROR);
  }
  const parsed = CourseInterviewRunSchema.safeParse(payload.run);
  if (!parsed.success) throw new Error(COURSE_INTERVIEW_ERROR);
  if (parsed.data.projectId !== projectId) throw new Error(COURSE_INTERVIEW_ERROR);
  return parsed.data;
};

const readWorkflowEvent = (value: unknown): WorkflowEventSnapshot | null => {
  if (!isRecord(value)) return null;
  const { eventType, payload, schemaVersion, sequence } = value;
  if (
    typeof eventType !== 'string' ||
    !Number.isSafeInteger(schemaVersion) ||
    typeof sequence !== 'string' ||
    !/^\d+$/.test(sequence)
  ) {
    return null;
  }
  return { eventType, payload, schemaVersion: Number(schemaVersion), sequence };
};

const readWorkflowWait = (value: unknown): WorkflowWaitSnapshot | null => {
  if (!isRecord(value)) return null;
  const { expiresAt, schemaVersion, signalType, waitId } = value;
  if (
    typeof expiresAt !== 'string' ||
    !expiresAt ||
    !Number.isSafeInteger(schemaVersion) ||
    typeof signalType !== 'string' ||
    !isCourseInterviewSignalType(signalType) ||
    typeof waitId !== 'string' ||
    !waitId
  ) {
    return null;
  }
  return { expiresAt, schemaVersion: Number(schemaVersion), signalType, waitId };
};

const parseRunState = (
  payload: unknown,
  expectedRunId: string,
  expectedProjectId: string
): CourseInterviewRunSnapshot => {
  if (
    !isRecord(payload) ||
    payload.success !== true ||
    !isRecord(payload.state) ||
    !isRecord(payload.state.run) ||
    !Array.isArray(payload.state.publishedEvents) ||
    !Array.isArray(payload.state.waits)
  ) {
    throw new Error(COURSE_INTERVIEW_ERROR);
  }
  const run = payload.state.run;
  const cleanupStatus = run.cleanupStatus;
  if (
    run.id !== expectedRunId ||
    run.projectId !== expectedProjectId ||
    run.workflowId !== COURSE_INTERVIEW_WORKFLOW_ID ||
    typeof run.status !== 'string' ||
    !isCourseInterviewStatus(run.status) ||
    (cleanupStatus !== 'completed' &&
      cleanupStatus !== 'failed' &&
      cleanupStatus !== 'not-required' &&
      cleanupStatus !== 'pending' &&
      cleanupStatus !== 'running')
  ) {
    throw new Error(COURSE_INTERVIEW_ERROR);
  }
  const events = payload.state.publishedEvents.map(value => {
    const event = readWorkflowEvent(value);
    if (!event) throw new Error(COURSE_INTERVIEW_ERROR);
    return event;
  });
  const waits = payload.state.waits.map(value => {
    const wait = readWorkflowWait(value);
    if (!wait) throw new Error(COURSE_INTERVIEW_ERROR);
    return wait;
  });
  const errorCode =
    isRecord(run.error) && typeof run.error.code === 'string' ? run.error.code : undefined;
  const correlationId = typeof run.correlationId === 'string' ? run.correlationId : undefined;
  return {
    cleanupStatus,
    ...(correlationId ? { correlationId } : {}),
    ...(errorCode ? { errorCode } : {}),
    events,
    projectId: expectedProjectId,
    runId: expectedRunId,
    status: run.status,
    waits,
  };
};

const fetchRunStateIfPresent = async (
  runId: string,
  projectId: string,
  signal?: AbortSignal,
  notFoundIsExpected = false
): Promise<CourseInterviewRunSnapshot | null> => {
  const url = `${getBackendUrl()}/api/workflows/runs/${encodeURIComponent(runId)}`;
  const request = { cache: 'no-store' as const, signal };
  const response = notFoundIsExpected
    ? await fetchWithSupabaseAuth(url, request, {
        expectedStatuses: [WORKFLOW_NOT_FOUND_STATUS],
      })
    : await fetchWithSupabaseAuth(url, request);
  if (response.status === WORKFLOW_NOT_FOUND_STATUS) return null;
  assertWorkflowPollResponse(response, COURSE_INTERVIEW_ERROR);
  return parseRunState(
    await readWorkflowPollJson(response, COURSE_INTERVIEW_ERROR),
    runId,
    projectId
  );
};

const fetchRunState = async (
  runId: string,
  projectId: string,
  signal?: AbortSignal
): Promise<CourseInterviewRunSnapshot> => {
  const state = await fetchRunStateIfPresent(runId, projectId, signal);
  if (!state) throw new Error(COURSE_INTERVIEW_ERROR);
  return state;
};

interface CourseInterviewProjection {
  generationRunId?: string;
  messages: CourseInterviewMessage[];
  proposal: CourseInterviewProposal | null;
  result: CourseInterviewResult | null;
}

const compareEventSequence = (
  left: WorkflowEventSnapshot,
  right: WorkflowEventSnapshot
): number => {
  const difference = BigInt(left.sequence) - BigInt(right.sequence);
  if (difference < 0n) return -1;
  if (difference > 0n) return 1;
  return 0;
};

const projectCourseInterviewEvent = (
  projection: CourseInterviewProjection,
  event: WorkflowEventSnapshot,
  projectId: string
): void => {
  if (event.schemaVersion !== COURSE_INTERVIEW_EVENT_SCHEMA_VERSION) return;
  if (event.eventType === COURSE_INTERVIEW_MESSAGE_EVENT) {
    const parsed = CourseInterviewMessageEventSchema.safeParse(event.payload);
    if (!parsed.success) throw new Error(COURSE_INTERVIEW_ERROR);
    projection.messages.push(parsed.data.message);
  } else if (event.eventType === COURSE_INTERVIEW_PROPOSAL_READY_EVENT) {
    const parsed = CourseInterviewProposalReadyEventSchema.safeParse(event.payload);
    if (!parsed.success) throw new Error(COURSE_INTERVIEW_ERROR);
    projection.proposal = parsed.data.proposal;
  } else if (event.eventType === COURSE_INTERVIEW_GENERATION_STARTED_EVENT) {
    const parsed = CourseInterviewGenerationStartedEventSchema.safeParse(event.payload);
    if (!parsed.success || parsed.data.projectId !== projectId) {
      throw new Error(COURSE_INTERVIEW_ERROR);
    }
    projection.generationRunId = parsed.data.generationRunId;
  } else if (event.eventType === COURSE_INTERVIEW_ENDED_EVENT) {
    const parsed = CourseInterviewResultSchema.safeParse(event.payload);
    if (!parsed.success || parsed.data.projectId !== projectId) {
      throw new Error(COURSE_INTERVIEW_ERROR);
    }
    projection.result = parsed.data;
  }
};

const mapActiveWait = (state: CourseInterviewRunSnapshot): CourseInterviewWait | null => {
  if (state.waits.length > 1 || (state.status === 'waiting') !== (state.waits.length === 1)) {
    throw new Error(COURSE_INTERVIEW_ERROR);
  }
  const activeWait = state.waits[0];
  if (!activeWait) return null;
  if (activeWait.schemaVersion !== COURSE_INTERVIEW_EVENT_SCHEMA_VERSION) {
    throw new Error(COURSE_INTERVIEW_ERROR);
  }
  return {
    expiresAt: activeWait.expiresAt,
    signalType: activeWait.signalType,
    waitId: activeWait.waitId,
  };
};

const mapCourseInterviewSnapshot = (state: CourseInterviewRunSnapshot): CourseInterviewSnapshot => {
  const projection: CourseInterviewProjection = {
    messages: [],
    proposal: null,
    result: null,
  };
  for (const event of [...state.events].sort(compareEventSequence)) {
    projectCourseInterviewEvent(projection, event, state.projectId);
  }

  if (
    projection.result?.kind === 'approved' &&
    projection.generationRunId !== undefined &&
    projection.result.generationRunId !== projection.generationRunId
  ) {
    throw new Error(COURSE_INTERVIEW_ERROR);
  }
  if (state.status === 'completed' && !projection.result) throw new Error(COURSE_INTERVIEW_ERROR);
  const activeWait = mapActiveWait(state);
  const proposal =
    activeWait?.signalType === COURSE_INTERVIEW_DECISION_SIGNAL ? projection.proposal : null;
  if (activeWait?.signalType === COURSE_INTERVIEW_DECISION_SIGNAL && !proposal) {
    throw new Error(COURSE_INTERVIEW_ERROR);
  }

  return {
    ...(state.errorCode ? { errorCode: state.errorCode } : {}),
    ...(projection.generationRunId ? { generationRunId: projection.generationRunId } : {}),
    messages: projection.messages,
    projectId: state.projectId,
    proposal,
    result: projection.result,
    runId: state.runId,
    status: state.status,
    wait: activeWait,
  };
};

const mapCourseInterviewSnapshotWithDiagnostics = (
  state: CourseInterviewRunSnapshot
): CourseInterviewSnapshot => {
  try {
    return mapCourseInterviewSnapshot(state);
  } catch (error) {
    logBackendFailureCorrelationId(state.correlationId);
    throw error;
  }
};

const waitForActionableSnapshot = async (
  runId: string,
  projectId: string,
  options: CourseInterviewClientOptions,
  missingSnapshot?: CourseInterviewSnapshot
): Promise<CourseInterviewSnapshot> => {
  const readState = async (signal?: AbortSignal): Promise<CourseInterviewRunSnapshot | null> => {
    const state = await fetchRunStateIfPresent(runId, projectId, signal, Boolean(missingSnapshot));
    if (!state && !missingSnapshot) throw new Error(COURSE_INTERVIEW_ERROR);
    return state;
  };
  const initialState = await readState(options.signal)
    .then(run => ({ run }))
    .catch((error): { run: CourseInterviewRunSnapshot | null } => {
      if (options.signal?.aborted || !isTransientWorkflowPollError(error)) throw error;
      return {
        run: {
          cleanupStatus: 'not-required',
          events: [],
          projectId,
          runId,
          status: 'running',
          waits: [],
        },
      };
    });
  const terminalState = await pollWorkflow({
    initialState,
    isTerminal: state => state.run === null || !ACTIVE_INTERVIEW_STATUSES.has(state.run.status),
    onState: state => {
      if (state.run) options.onSnapshot?.(mapCourseInterviewSnapshotWithDiagnostics(state.run));
    },
    readState: async (_state, signal) => ({ run: await readState(signal) }),
    signal: options.signal,
  });
  if (!terminalState.run) {
    if (missingSnapshot) return missingSnapshot;
    throw new Error(COURSE_INTERVIEW_ERROR);
  }
  if (terminalState.run.status === 'failed' || terminalState.run.status === 'expired') {
    logBackendFailureCorrelationId(terminalState.run.correlationId);
  }
  return mapCourseInterviewSnapshotWithDiagnostics(terminalState.run);
};

const sendInterviewSignal = async (
  input: {
    readonly payload: unknown;
    readonly projectId: string;
    readonly runId: string;
    readonly signalType: string;
    readonly waitId: string;
    readonly missingSnapshot?: CourseInterviewSnapshot;
  },
  options: CourseInterviewClientOptions
): Promise<CourseInterviewSnapshot> => {
  const request = acquireWorkflowRequestKey(
    `${COURSE_INTERVIEW_SIGNAL_KEY_PREFIX}${input.runId}:${input.waitId}`
  );
  const response = await fetchWithSupabaseAuth(
    `${getBackendUrl()}/api/workflows/runs/${encodeURIComponent(input.runId)}/waits/${encodeURIComponent(input.waitId)}/signals`,
    {
      body: JSON.stringify({
        payload: input.payload,
        requestKey: request.requestKey,
        signalType: input.signalType,
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: options.signal,
    }
  );
  if (isDefinitiveWorkflowStartRejection(response)) request.clear();
  const payload = await readWorkflowJson(response);
  if (!response.ok || !isRecord(payload) || payload.success !== true) {
    throw new Error(COURSE_INTERVIEW_ERROR);
  }
  request.clear();
  return waitForActionableSnapshot(input.runId, input.projectId, options, input.missingSnapshot);
};

export const startCourseInterview = async (
  input: StartCourseInterviewInput,
  options: CourseInterviewClientOptions = {}
): Promise<CourseInterviewSnapshot> => {
  const request = acquireWorkflowRequestKey(
    `${COURSE_INTERVIEW_REQUEST_KEY_PREFIX}${input.projectId}`
  );
  const body = CourseInterviewStartRequestSchema.parse({
    ...input,
    requestKey: request.requestKey,
  });
  const response = await fetchWithSupabaseAuth(`${getBackendUrl()}/api/course-interviews`, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
    signal: options.signal,
  });
  if (isDefinitiveWorkflowStartRejection(response)) request.clear();
  const run = await readRunSummary(response, body.projectId);
  request.clear();
  return waitForActionableSnapshot(run.id, body.projectId, options);
};

export const getActiveCourseInterview = async (
  projectId: string,
  options: CourseInterviewClientOptions = {}
): Promise<CourseInterviewSnapshot | null> => {
  const response = await fetchWithSupabaseAuth(
    `${getBackendUrl()}/api/course-interviews/${encodeURIComponent(projectId)}/active`,
    { cache: 'no-store', signal: options.signal },
    { expectedStatuses: [WORKFLOW_NOT_FOUND_STATUS] }
  );
  if (response.status === WORKFLOW_NOT_FOUND_STATUS) return null;
  assertWorkflowPollResponse(response, COURSE_INTERVIEW_ERROR);
  const run = await readRunSummary(response, projectId);
  return waitForActionableSnapshot(run.id, projectId, options);
};

export const sendCourseInterviewAnswer = (
  input: SendCourseInterviewAnswerInput,
  options: CourseInterviewClientOptions = {}
): Promise<CourseInterviewSnapshot> => {
  const payload = CourseInterviewUserAnswerSignalSchema.parse({ text: input.text });
  return sendInterviewSignal(
    { ...input, payload, signalType: COURSE_INTERVIEW_USER_ANSWER_SIGNAL },
    options
  );
};

export const sendCourseInterviewDecision = (
  input: SendCourseInterviewDecisionInput,
  options: CourseInterviewClientOptions = {}
): Promise<CourseInterviewSnapshot> => {
  const payload = CourseInterviewDecisionSignalSchema.parse(input.decision);
  const missingSnapshot: CourseInterviewSnapshot | undefined =
    payload.kind === 'cancel'
      ? {
          messages: [],
          projectId: input.projectId,
          proposal: null,
          result: { kind: 'cancelled', projectId: input.projectId },
          runId: input.runId,
          status: 'cancelled',
          wait: null,
        }
      : undefined;
  return sendInterviewSignal(
    { ...input, missingSnapshot, payload, signalType: COURSE_INTERVIEW_DECISION_SIGNAL },
    options
  );
};

export const cancelCourseInterview = async (
  input: CancelCourseInterviewInput,
  options: CourseInterviewClientOptions = {}
): Promise<void> => {
  await fetchRunState(input.runId, input.projectId, options.signal);
  const response = await fetchWithSupabaseAuth(
    `${getBackendUrl()}/api/workflows/runs/${encodeURIComponent(input.runId)}/cancellation`,
    {
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: options.signal,
    }
  );
  const payload = await readWorkflowJson(response);
  if (!response.ok || !isRecord(payload) || payload.success !== true) {
    throw new Error(COURSE_INTERVIEW_ERROR);
  }

  const readCancellationState = async (
    signal?: AbortSignal
  ): Promise<{ readonly run: CourseInterviewRunSnapshot | null }> => {
    const stateResponse = await fetchWithSupabaseAuth(
      `${getBackendUrl()}/api/workflows/runs/${encodeURIComponent(input.runId)}`,
      { cache: 'no-store', signal },
      { expectedStatuses: [WORKFLOW_NOT_FOUND_STATUS] }
    );
    if (stateResponse.status === WORKFLOW_NOT_FOUND_STATUS) return { run: null };
    assertWorkflowPollResponse(stateResponse, COURSE_INTERVIEW_ERROR);
    return {
      run: parseRunState(
        await readWorkflowPollJson(stateResponse, COURSE_INTERVIEW_ERROR),
        input.runId,
        input.projectId
      ),
    };
  };
  const cancellation = await pollWorkflow({
    initialState: await readCancellationState(options.signal),
    isTerminal: state =>
      state.run === null ||
      state.run.cleanupStatus === 'completed' ||
      state.run.cleanupStatus === 'failed' ||
      (state.run.cleanupStatus === 'not-required' &&
        TERMINAL_INTERVIEW_STATUSES.has(state.run.status)),
    readState: (_state, signal) => readCancellationState(signal),
    signal: options.signal,
  });
  if (cancellation.run?.cleanupStatus === 'failed') {
    logBackendFailureCorrelationId(cancellation.run.correlationId);
    throw new Error(COURSE_INTERVIEW_ERROR);
  }
};
