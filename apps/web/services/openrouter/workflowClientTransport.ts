import { TransientRequestError } from '../core/errorMessage.ts';

const WORKFLOW_STATUS_POLL_MS = 1_000;
const TRANSIENT_WORKFLOW_HTTP_STATUSES = new Set([408, 429]);

export const WORKFLOW_DEFINITION_UNAVAILABLE_MESSAGE =
  'L’app è stata aggiornata mentre questa generazione era in corso. Avvia una nuova generazione.';

export const resolveWorkflowFailureMessage = (
  errorCode: string | undefined,
  fallbackMessage: string
): string =>
  errorCode === 'workflow_definition_unavailable'
    ? WORKFLOW_DEFINITION_UNAVAILABLE_MESSAGE
    : fallbackMessage;

interface WorkflowRequestKey {
  clear(): void;
  readonly requestKey: string;
}

export const clearWorkflowRequestKey = (storageKey: string, expectedRequestKey?: string): void => {
  try {
    if (
      expectedRequestKey !== undefined &&
      globalThis.sessionStorage.getItem(storageKey) !== expectedRequestKey
    ) {
      return;
    }
    globalThis.sessionStorage.removeItem(storageKey);
  } catch {
    // Session storage is optional; backend request-key deduplication still protects this call.
  }
};

export const readWorkflowRequestKey = (storageKey: string): string | null => {
  try {
    return globalThis.sessionStorage.getItem(storageKey);
  } catch {
    return null;
  }
};

export const acquireWorkflowRequestKey = (storageKey: string): WorkflowRequestKey => {
  const existing = readWorkflowRequestKey(storageKey);
  const requestKey = existing || globalThis.crypto.randomUUID();
  if (!existing) {
    try {
      globalThis.sessionStorage.setItem(storageKey, requestKey);
    } catch {
      // Session storage is optional; the request key still protects this attempt.
    }
  }

  return {
    clear() {
      clearWorkflowRequestKey(storageKey, requestKey);
    },
    requestKey,
  };
};

export const isTransientWorkflowPollError = (error: unknown): boolean =>
  error instanceof TypeError || error instanceof TransientRequestError;

export const isTransientWorkflowResponse = (response: Response): boolean =>
  response.status >= 500 || TRANSIENT_WORKFLOW_HTTP_STATUSES.has(response.status);

export const isDefinitiveWorkflowStartRejection = (response: Response): boolean =>
  response.status >= 400 && response.status < 500 && !isTransientWorkflowResponse(response);

export const assertWorkflowPollResponse = (response: Response, errorMessage: string): void => {
  if (response.ok) return;
  if (isTransientWorkflowResponse(response)) {
    throw new TransientRequestError(errorMessage);
  }
  throw new Error(errorMessage);
};

export const readWorkflowJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
};

export const readWorkflowPollJson = async (
  response: Response,
  errorMessage: string
): Promise<unknown> => {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new TransientRequestError(errorMessage);
    throw error;
  }
};

export interface WorkflowSnapshotEnvelope {
  readonly attempt?: number;
  readonly correlationId?: string;
  readonly createdAt: string;
  readonly errorCode?: string;
  readonly id: string;
  readonly projectId: string;
  readonly stage: string;
  readonly startedAt?: string;
  readonly status: string;
  readonly updatedAt: string;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && Boolean(value.trim());

export const isWorkflowSnapshotEnvelope = (
  value: unknown
): value is WorkflowSnapshotEnvelope & Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return (
    isNonEmptyString(snapshot.createdAt) &&
    isNonEmptyString(snapshot.id) &&
    isNonEmptyString(snapshot.projectId) &&
    isNonEmptyString(snapshot.stage) &&
    isNonEmptyString(snapshot.status) &&
    isNonEmptyString(snapshot.updatedAt) &&
    (snapshot.attempt === undefined ||
      (Number.isSafeInteger(snapshot.attempt) && Number(snapshot.attempt) > 0)) &&
    (snapshot.correlationId === undefined || isNonEmptyString(snapshot.correlationId)) &&
    (snapshot.errorCode === undefined || isNonEmptyString(snapshot.errorCode)) &&
    (snapshot.startedAt === undefined || isNonEmptyString(snapshot.startedAt))
  );
};

interface PollWorkflowOptions<State extends object> {
  readonly initialState: State;
  readonly isTerminal: (state: State) => boolean;
  readonly onState?: (state: State) => void;
  readonly readState: (currentState: State, signal?: AbortSignal) => Promise<State>;
  readonly signal?: AbortSignal;
}

const abortReason = (signal: AbortSignal): unknown => {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
};

const waitForNextPoll = (signal?: AbortSignal): Promise<void> => {
  if (!signal) {
    return new Promise(resolve => globalThis.setTimeout(resolve, WORKFLOW_STATUS_POLL_MS));
  }
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = globalThis.setTimeout(finish, WORKFLOW_STATUS_POLL_MS);
    const abort = () => {
      globalThis.clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
};

export const retryTransientWorkflowRequest = async <Result>(
  request: () => Promise<Result>
): Promise<Result> => {
  while (true) {
    try {
      return await request();
    } catch (error) {
      if (!isTransientWorkflowPollError(error)) throw error;
      await waitForNextPoll();
    }
  }
};

export const pollWorkflow = async <State extends object>({
  initialState,
  isTerminal,
  onState,
  readState,
  signal,
}: PollWorkflowOptions<State>): Promise<State> => {
  let currentState = initialState;
  onState?.(currentState);

  while (!isTerminal(currentState)) {
    await waitForNextPoll(signal);
    let nextState: State;
    try {
      nextState = await readState(currentState, signal);
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (!isTransientWorkflowPollError(error)) throw error;
      continue;
    }
    currentState = nextState;
    onState?.(currentState);
  }
  return currentState;
};
