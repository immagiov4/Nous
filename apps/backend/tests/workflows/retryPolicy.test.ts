import { describe, expect, test } from 'vitest';

import {
  failPermanently,
  getRetryDecision,
  readRetryAfterMs,
  retryCorrective,
  retryOperational,
  runWorkflowStage,
  toStepFailure,
  WorkflowStepError,
} from '../../src/workflows/retryPolicy.js';
import type { StepFailure } from '../../src/workflows/types.js';

describe('workflow retry policy', () => {
  test('makes corrective retries immediately eligible with explicit feedback', () => {
    const failure = toStepFailure(
      retryCorrective({
        code: 'invalid_lesson_shape',
        feedback: 'Restituisci tutte le sezioni richieste.',
        message: 'The generated lesson did not match its schema.',
      })
    );

    expect(
      getRetryDecision({ attemptNumber: 1, failure, maxAttempts: 3, random: () => 0.8 })
    ).toEqual({
      delayMs: 0,
      retry: true,
    });
    expect(failure).toMatchObject({
      code: 'invalid_lesson_shape',
      feedback: 'Restituisci tutte le sezioni richieste.',
      kind: 'corrective',
    });
  });

  test('uses persisted exponential backoff with positive jitter for operational retries', () => {
    const failure = toStepFailure(
      retryOperational({ code: 'provider_unavailable', message: 'Provider unavailable.' })
    );

    expect(
      getRetryDecision({ attemptNumber: 1, failure, maxAttempts: 3, random: () => 0.5 })
    ).toEqual({ delayMs: 2_250, retry: true });
    expect(
      getRetryDecision({ attemptNumber: 2, failure, maxAttempts: 3, random: () => 1 })
    ).toEqual({ delayMs: 5_000, retry: true });
  });

  test('uses the greater of Retry-After and nominal backoff before adding local jitter', () => {
    const longerRetryAfter = toStepFailure(
      retryOperational({
        code: 'rate_limited',
        message: 'Rate limited.',
        retryAfterMs: 90_000,
      })
    );

    expect(
      getRetryDecision({
        attemptNumber: 1,
        failure: longerRetryAfter,
        maxAttempts: 3,
        random: () => 1,
      })
    ).toEqual({ delayMs: 90_500, retry: true });

    const shorterRetryAfter = toStepFailure(
      retryOperational({ code: 'rate_limited', message: 'Rate limited.', retryAfterMs: 1 })
    );
    expect(
      getRetryDecision({
        attemptNumber: 2,
        failure: shorterRetryAfter,
        maxAttempts: 3,
        random: () => 0,
      })
    ).toEqual({ delayMs: 4_000, retry: true });
  });

  test('falls back to the standard Retry-After header when retry-after-ms is invalid', () => {
    expect(
      readRetryAfterMs({
        responseHeaders: { 'retry-after': '23', 'retry-after-ms': '-1' },
      })
    ).toBe(23_000);
  });

  test('stops immediately for permanent failures and after the configured attempt limit', () => {
    const permanent = toStepFailure(
      failPermanently({ code: 'project_missing', message: 'Project missing.' })
    );
    const transient = toStepFailure(
      retryOperational({ code: 'network_error', message: 'Network error.' })
    );

    expect(getRetryDecision({ attemptNumber: 1, failure: permanent, maxAttempts: 3 })).toEqual({
      retry: false,
    });
    expect(getRetryDecision({ attemptNumber: 3, failure: transient, maxAttempts: 3 })).toEqual({
      retry: false,
    });
  });

  test('sanitizes unknown exceptions instead of persisting raw messages', () => {
    expect(toStepFailure(new Error('password=do-not-persist'))).toEqual({
      code: 'step_failed',
      kind: 'operational',
      message: 'The workflow step failed.',
    });
  });

  test('records the trusted stage message without persisting the thrown provider prose', async () => {
    const providerError = Object.assign(new Error('private provider response secret=hidden'), {
      code: 'invalid_request',
      status: 400,
    });

    await expect(
      runWorkflowStage({
        failure: {
          code: 'lesson_research_failed',
          message: 'Lesson research failed.',
        },
        operation: async () => {
          throw providerError;
        },
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({
      failure: {
        code: 'lesson_research_failed',
        details: {
          diagnostic: {
            code: 'invalid_request',
            message: 'Lesson research failed.',
            status: 400,
            type: 'Error',
          },
        },
      },
    });
  });

  test('does not let direct WorkflowStepError construction bypass failure invariants', () => {
    expect(
      () =>
        new WorkflowStepError({
          code: 'rate_limited',
          kind: 'operational',
          message: 'Rate limited.',
          retryAfterMs: -1,
        })
    ).toThrow('retryAfterMs must be a non-negative integer.');

    expect(
      () =>
        new WorkflowStepError({
          code: 'invalid_lesson_shape',
          feedback: ' ',
          kind: 'corrective',
          message: 'Invalid lesson.',
        })
    ).toThrow('Corrective retry feedback is required.');
  });

  test('validates the discriminant again at the retry decision boundary', () => {
    const invalidFailure = {
      code: 'invalid_kind',
      kind: 'unexpected',
      message: 'Invalid failure kind.',
    } as unknown as StepFailure;

    expect(() =>
      getRetryDecision({ attemptNumber: 1, failure: invalidFailure, maxAttempts: 3 })
    ).toThrow('Unknown step failure kind.');
  });

  test('rejects details that PostgreSQL JSON cannot preserve', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    for (const details of [{ value: 1n }, circular, { value: Number.NaN }]) {
      expect(
        () =>
          new WorkflowStepError({
            code: 'invalid_details',
            details: details as StepFailure['details'],
            kind: 'operational',
            message: 'Invalid details.',
          })
      ).toThrow(/Step failure details/);
    }
  });

  test('stores a deeply immutable JSON snapshot of failure details', () => {
    const details = { nested: { values: ['original'] } };

    const error = retryOperational({
      code: 'provider_unavailable',
      details,
      message: 'Provider unavailable.',
    });
    details.nested.values.push('mutated');

    const failureDetails = error.failure.details as
      | { readonly nested: { readonly values: readonly string[] } }
      | undefined;
    expect(failureDetails).toEqual({ nested: { values: ['original'] } });
    expect(Object.isFrozen(error.failure)).toBe(true);
    expect(Object.isFrozen(failureDetails)).toBe(true);
    expect(Object.isFrozen(failureDetails?.nested)).toBe(true);
    expect(Object.isFrozen(failureDetails?.nested.values)).toBe(true);
  });

  test('keeps the persisted delay within JavaScript safe integer bounds', () => {
    const failure = toStepFailure(
      retryOperational({
        code: 'rate_limited',
        message: 'Rate limited.',
        retryAfterMs: Number.MAX_SAFE_INTEGER,
      })
    );

    expect(
      getRetryDecision({ attemptNumber: 1, failure, maxAttempts: 2, random: () => 1 })
    ).toEqual({ delayMs: Number.MAX_SAFE_INTEGER, retry: true });
  });
});
