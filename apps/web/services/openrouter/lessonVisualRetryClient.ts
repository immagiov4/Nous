import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { logBackendFailureCorrelationId } from '../feedback/browserDiagnostics.ts';
import { getBackendUrl } from './config.ts';
import {
  acquireWorkflowRequestKey,
  assertWorkflowPollResponse,
  isDefinitiveWorkflowStartRejection,
  isTransientWorkflowPollError,
  pollWorkflow,
  readWorkflowPollJson,
  resolveWorkflowFailureMessage,
} from './workflowClientTransport.ts';

const LESSON_VISUAL_RETRY_ERROR = 'La rigenerazione dell’esempio visivo non è riuscita. Riprova.';
const LESSON_VISUAL_RETRY_REQUEST_KEY_PREFIX = 'nous:lesson-visual-retry-request:';
const LESSON_VISUAL_RETRY_WORKFLOW_ID = 'retry-lesson-visual';
const PROJECT_REVISION_EVENT = 'lesson.project-revision';
const PROJECT_REVISION_EVENT_SCHEMA_VERSION = 1;
const ACTIVE_RUN_STATUSES = new Set(['queued', 'running', 'waiting']);
const ACTIVE_CLEANUP_STATUSES = new Set(['pending', 'running']);

class LessonVisualRetryTerminalError extends Error {
  constructor(errorCode?: string) {
    super(resolveWorkflowFailureMessage(errorCode, LESSON_VISUAL_RETRY_ERROR));
    this.name = 'LessonVisualRetryTerminalError';
  }
}

interface RetryTarget {
  readonly projectId: string;
  readonly sectionId: string;
  readonly slotId: string;
}

interface RetryOptions {
  readonly signal?: AbortSignal;
}

interface RetryRunState {
  readonly cleanupStatus: string;
  readonly correlationId?: string;
  readonly errorCode?: string;
  readonly projectId: string;
  readonly publishedEvents: readonly unknown[];
  readonly runId: string;
  readonly status: string;
  readonly workflowId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readStartedRunId = async (response: Response): Promise<string> => {
  const payload = await readWorkflowPollJson(response, LESSON_VISUAL_RETRY_ERROR);
  if (!response.ok || !isRecord(payload) || payload.success !== true || !isRecord(payload.run)) {
    throw new Error(LESSON_VISUAL_RETRY_ERROR);
  }
  const runId = payload.run.id;
  if (typeof runId !== 'string' || !runId) throw new Error(LESSON_VISUAL_RETRY_ERROR);
  return runId;
};

const readRunState = async (
  response: Response,
  expectedRunId: string,
  expectedProjectId: string
): Promise<RetryRunState> => {
  const payload = await readWorkflowPollJson(response, LESSON_VISUAL_RETRY_ERROR);
  if (
    !response.ok ||
    !isRecord(payload) ||
    payload.success !== true ||
    !isRecord(payload.state) ||
    !isRecord(payload.state.run)
  ) {
    throw new Error(LESSON_VISUAL_RETRY_ERROR);
  }
  const run = payload.state.run;
  const correlationId = typeof run.correlationId === 'string' ? run.correlationId : undefined;
  try {
    if (
      !Array.isArray(payload.state.publishedEvents) ||
      run.id !== expectedRunId ||
      run.projectId !== expectedProjectId ||
      run.workflowId !== LESSON_VISUAL_RETRY_WORKFLOW_ID ||
      typeof run.cleanupStatus !== 'string' ||
      typeof run.status !== 'string'
    ) {
      throw new Error(LESSON_VISUAL_RETRY_ERROR);
    }
    const errorCode =
      isRecord(run.error) && typeof run.error.code === 'string' ? run.error.code : undefined;
    return {
      cleanupStatus: run.cleanupStatus,
      ...(correlationId ? { correlationId } : {}),
      ...(errorCode ? { errorCode } : {}),
      projectId: expectedProjectId,
      publishedEvents: payload.state.publishedEvents,
      runId: expectedRunId,
      status: run.status,
      workflowId: LESSON_VISUAL_RETRY_WORKFLOW_ID,
    };
  } catch (error) {
    logBackendFailureCorrelationId(correlationId);
    throw error;
  }
};

const readProjectRevision = (state: RetryRunState): number | null => {
  for (const event of state.publishedEvents) {
    if (
      !isRecord(event) ||
      event.eventType !== PROJECT_REVISION_EVENT ||
      event.schemaVersion !== PROJECT_REVISION_EVENT_SCHEMA_VERSION ||
      !isRecord(event.payload) ||
      event.payload.projectId !== state.projectId
    ) {
      continue;
    }
    const revision = event.payload.revision;
    if (Number.isSafeInteger(revision) && Number(revision) >= 0) return Number(revision);
  }
  return null;
};

const fetchRunState = async (
  runId: string,
  target: RetryTarget,
  signal?: AbortSignal
): Promise<RetryRunState> => {
  const response = await fetchWithSupabaseAuth(
    `${getBackendUrl()}/api/workflows/runs/${encodeURIComponent(runId)}`,
    { cache: 'no-store', signal }
  );
  assertWorkflowPollResponse(response, LESSON_VISUAL_RETRY_ERROR);
  return readRunState(response, runId, target.projectId);
};

const waitForCommittedRevision = async (
  runId: string,
  target: RetryTarget,
  signal?: AbortSignal
): Promise<number> => {
  const initialState = await fetchRunState(runId, target, signal).catch((error): RetryRunState => {
    if (signal?.aborted || !isTransientWorkflowPollError(error)) throw error;
    return {
      cleanupStatus: 'not-required',
      projectId: target.projectId,
      publishedEvents: [],
      runId,
      status: 'running',
      workflowId: LESSON_VISUAL_RETRY_WORKFLOW_ID,
    };
  });
  const terminalState = await pollWorkflow({
    initialState,
    isTerminal: state =>
      state.status === 'completed' ||
      (!ACTIVE_RUN_STATUSES.has(state.status) && !ACTIVE_CLEANUP_STATUSES.has(state.cleanupStatus)),
    readState: (_currentState, pollSignal) => fetchRunState(runId, target, pollSignal),
    signal,
  });
  if (terminalState.status !== 'completed') {
    logBackendFailureCorrelationId(terminalState.correlationId);
    throw new LessonVisualRetryTerminalError(terminalState.errorCode);
  }
  const revision = readProjectRevision(terminalState);
  if (revision === null) {
    logBackendFailureCorrelationId(terminalState.correlationId);
    throw new LessonVisualRetryTerminalError();
  }
  return revision;
};

export const retryDurableLessonVisual = async (
  target: RetryTarget,
  options: RetryOptions = {}
): Promise<{ projectRevision: number }> => {
  const request = acquireWorkflowRequestKey(
    `${LESSON_VISUAL_RETRY_REQUEST_KEY_PREFIX}${target.projectId}:${target.sectionId}:${target.slotId}`
  );
  const response = await fetchWithSupabaseAuth(
    `${getBackendUrl()}/api/projects/${encodeURIComponent(target.projectId)}/sections/${encodeURIComponent(target.sectionId)}/visuals/${encodeURIComponent(target.slotId)}/retry`,
    {
      body: JSON.stringify({ requestKey: request.requestKey }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: options.signal,
    }
  );
  if (isDefinitiveWorkflowStartRejection(response)) request.clear();
  const runId = await readStartedRunId(response);
  try {
    const projectRevision = await waitForCommittedRevision(runId, target, options.signal);
    request.clear();
    return { projectRevision };
  } catch (error) {
    if (error instanceof LessonVisualRetryTerminalError) request.clear();
    throw error;
  }
};
