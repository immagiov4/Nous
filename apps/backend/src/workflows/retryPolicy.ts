import { isRecord } from '../utils/validation.js';
import { snapshotImmutableJson } from './jsonSnapshot.js';
import type { JsonValue, StepFailure } from './types.js';
import { toWorkflowErrorDiagnostic } from './workflowErrorDiagnostics.js';

const BASE_OPERATIONAL_BACKOFF_MS = 2_000;
const MAX_OPERATIONAL_BACKOFF_MS = 60_000;
const MAX_POSITIVE_JITTER_RATIO = 0.25;

interface FailureOptions {
  code: string;
  details?: Readonly<Record<string, JsonValue>>;
  message: string;
}

interface CorrectiveFailureOptions extends FailureOptions {
  feedback: string;
}

interface OperationalFailureOptions extends FailureOptions {
  retryAfterMs?: number;
}

interface WorkflowStageFailure extends FailureOptions {
  details?: Readonly<Record<string, JsonValue>>;
}

const readHeader = (headers: Record<string, unknown>, name: string): string | undefined => {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === 'string' && entry[1].trim() ? entry[1].trim() : undefined;
};

const toRetryDelay = (milliseconds: number): number | undefined => {
  const rounded = Math.ceil(milliseconds);
  return Number.isSafeInteger(rounded) && rounded >= 0 ? rounded : undefined;
};

const readRetryAfterHeader = (
  headers: Record<string, unknown>,
  now: () => number
): number | undefined => {
  const milliseconds = readHeader(headers, 'retry-after-ms');
  if (milliseconds) {
    const parsed = Number(milliseconds);
    if (Number.isFinite(parsed)) {
      const delay = toRetryDelay(parsed);
      if (delay !== undefined) return delay;
    }
  }
  const retryAfter = readHeader(headers, 'retry-after');
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return toRetryDelay(seconds * 1_000);
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? toRetryDelay(Math.max(0, date - now())) : undefined;
};

/** Reads standard provider retry headers without retaining the surrounding error details. */
export const readRetryAfterMs = (
  error: unknown,
  now: () => number = Date.now
): number | undefined => {
  const seen = new Set<object>();
  let current = error;
  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);
    if (isRecord(current.responseHeaders)) {
      const retryAfterMs = readRetryAfterHeader(current.responseHeaders, now);
      if (retryAfterMs !== undefined) return retryAfterMs;
    }
    current = current.cause;
  }
  return undefined;
};

const assertJsonValue = (value: unknown, path: string, ancestors: Set<object>): void => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new Error(`Step failure ${path} must contain finite JSON numbers.`);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Step failure ${path} must contain only JSON values.`);
  }
  if (ancestors.has(value)) throw new Error(`Step failure ${path} cannot be circular.`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        assertJsonValue(entry, `${path}[${index}]`, ancestors);
      });
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Step failure ${path} must contain only plain JSON objects.`);
    }
    Object.entries(value).forEach(([key, entry]) => {
      assertJsonValue(entry, `${path}.${key}`, ancestors);
    });
  } finally {
    ancestors.delete(value);
  }
};

const assertRequiredText = (value: unknown, message: string): void => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message);
};

const assertRetryAfterMs = (value: unknown): void => {
  if (
    value !== undefined &&
    (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new Error('retryAfterMs must be a non-negative integer.');
  }
};

const assertStepFailure: (failure: unknown) => asserts failure is StepFailure = failure => {
  if (!isRecord(failure)) throw new Error('Step failure must be an object.');
  assertRequiredText(failure.code, 'Step failure code is required.');
  assertRequiredText(failure.message, 'Step failure message is required.');
  if (failure.details !== undefined && !isRecord(failure.details)) {
    throw new Error('Step failure details must be an object.');
  }
  if (failure.details !== undefined) assertJsonValue(failure.details, 'details', new Set());

  switch (failure.kind) {
    case 'corrective':
      assertRequiredText(failure.feedback, 'Corrective retry feedback is required.');
      if (failure.retryAfterMs !== undefined) {
        throw new Error('Corrective step failures cannot include retryAfterMs.');
      }
      break;
    case 'operational':
      if (failure.feedback !== undefined) {
        throw new Error('Operational step failures cannot include corrective feedback.');
      }
      assertRetryAfterMs(failure.retryAfterMs);
      break;
    case 'permanent':
      if (failure.feedback !== undefined || failure.retryAfterMs !== undefined) {
        throw new Error('Permanent step failures cannot include retry metadata.');
      }
      break;
    default:
      throw new Error('Unknown step failure kind.');
  }
};

export const parseStepFailure = (failure: unknown): StepFailure => {
  assertStepFailure(failure);
  return snapshotImmutableJson(failure);
};

export class WorkflowStepError extends Error {
  readonly failure: StepFailure;

  constructor(failure: StepFailure) {
    const snapshot = parseStepFailure(failure);
    super(snapshot.message);
    this.name = 'WorkflowStepError';
    this.failure = snapshot;
  }
}

export const failPermanently = (options: FailureOptions): WorkflowStepError =>
  new WorkflowStepError({ ...options, kind: 'permanent' });

export const retryCorrective = (options: CorrectiveFailureOptions): WorkflowStepError =>
  new WorkflowStepError({ ...options, kind: 'corrective' });

export const retryOperational = (options: OperationalFailureOptions): WorkflowStepError =>
  new WorkflowStepError({ ...options, kind: 'operational' });

export const runWorkflowStage = async <Output>(input: {
  failure: WorkflowStageFailure;
  operation: () => Promise<Output>;
  signal: AbortSignal;
}): Promise<Output> => {
  try {
    return await input.operation();
  } catch (error) {
    input.signal.throwIfAborted();
    if (error instanceof WorkflowStepError) throw error;
    const retryAfterMs = readRetryAfterMs(error);
    throw retryOperational({
      code: input.failure.code,
      details: {
        diagnostic: toWorkflowErrorDiagnostic(error, { trustedMessage: input.failure.message }),
        ...input.failure.details,
      },
      message: input.failure.message,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
};

export const toStepFailure = (error: unknown): StepFailure => {
  if (error instanceof WorkflowStepError) return error.failure;
  const retryAfterMs = readRetryAfterMs(error);
  return parseStepFailure({
    code: 'step_failed',
    kind: 'operational',
    message: 'The workflow step failed.',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
};

const nominalBackoffMs = (attemptNumber: number): number =>
  Math.min(BASE_OPERATIONAL_BACKOFF_MS * 2 ** (attemptNumber - 1), MAX_OPERATIONAL_BACKOFF_MS);

export const getOperationalRetryDelayMs = (input: {
  attemptNumber: number;
  random?: () => number;
  retryAfterMs?: number;
}): number => {
  if (!Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1) {
    throw new Error('attemptNumber must be a positive integer.');
  }
  assertRetryAfterMs(input.retryAfterMs);
  const random = (input.random ?? Math.random)();
  if (!Number.isFinite(random) || random < 0 || random > 1) {
    throw new Error('Retry jitter source must return a number between 0 and 1.');
  }
  const nominalMs = nominalBackoffMs(input.attemptNumber);
  const jitterMs = Math.round(nominalMs * MAX_POSITIVE_JITTER_RATIO * random);
  const baseDelayMs = Math.max(input.retryAfterMs ?? 0, nominalMs);
  return baseDelayMs > Number.MAX_SAFE_INTEGER - jitterMs
    ? Number.MAX_SAFE_INTEGER
    : baseDelayMs + jitterMs;
};

export const getRetryDecision = (input: {
  attemptNumber: number;
  failure: StepFailure;
  maxAttempts: number;
  random?: () => number;
}): { delayMs: number; retry: true } | { retry: false } => {
  if (!Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1) {
    throw new Error('attemptNumber must be a positive integer.');
  }
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer.');
  }
  const failure = parseStepFailure(input.failure);
  if (failure.kind === 'permanent' || input.attemptNumber >= input.maxAttempts) {
    return { retry: false };
  }
  if (failure.kind === 'corrective') return { delayMs: 0, retry: true };

  return {
    delayMs: getOperationalRetryDelayMs({
      attemptNumber: input.attemptNumber,
      ...(input.random ? { random: input.random } : {}),
      ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
    }),
    retry: true,
  };
};
