import { describe, expect, test, vi } from 'vitest';

import {
  degradeOnFinalAttempt,
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

  test('persists a redacted original cause for unknown exceptions', () => {
    expect(toStepFailure(new Error('password=do-not-persist'))).toEqual({
      code: 'step_failed',
      details: { diagnostic: { originalMessage: 'password=[REDACTED]', type: 'Error' } },
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
            originalMessage: 'private provider response secret=[REDACTED]',
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

test.each([
  -1,
  0.5,
  Number.POSITIVE_INFINITY,
])('rejects invalid persisted retry caps: %s', maxRetryDelayMs => {
  expect(() =>
    retryOperational({
      code: 'tts_request_failed',
      message: 'Speech unavailable.',
      maxRetryDelayMs,
    })
  ).toThrow('maxRetryDelayMs must be a non-negative integer.');
});

describe('final-attempt degradation', () => {
  test.each([
    { attemptNumber: 1, eligible: true, degrades: false },
    { attemptNumber: 3, eligible: false, degrades: false },
    { attemptNumber: 3, eligible: true, degrades: true },
    { attemptNumber: 4, eligible: true, degrades: true },
  ])('preserves retry and eligibility: $attemptNumber / $eligible', scenario => {
    const error = retryCorrective({
      code: 'mapping_invalid',
      feedback: 'private',
      message: 'private',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fallback = vi.fn(failure => ({ value: null, failure }));
    const operation = () =>
      degradeOnFinalAttempt({
        ...scenario,
        error,
        fallback,
        maxAttempts: 3,
        signal: new AbortController().signal,
        stage: 'map',
      });
    try {
      if (scenario.degrades) {
        expect(operation()).toEqual({
          value: null,
          failure: {
            attemptNumber: scenario.attemptNumber,
            kind: 'corrective',
            stage: 'map',
            diagnostic: { type: 'WorkflowStepError', code: 'mapping_invalid' },
          },
        });
        expect(warn).toHaveBeenCalledWith(
          'Workflow step degraded.',
          expect.objectContaining({ stage: 'map' })
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
      } else {
        expect(operation).toThrow(error);
        expect(fallback).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      }
    } finally {
      warn.mockRestore();
    }
  });
  test('cancellation wins even on the final eligible attempt', () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const fallback = vi.fn();
    expect(() =>
      degradeOnFinalAttempt({
        attemptNumber: 3,
        maxAttempts: 3,
        eligible: true,
        error: new Error('private'),
        fallback,
        signal: controller.signal,
        stage: 'map',
      })
    ).toThrow('cancelled');
    expect(fallback).not.toHaveBeenCalled();
  });
});

test('degradation retains a wrapped validation cause through a content-free projection', () => {
  const error = retryOperational({
    code: 'provider_failed',
    message: 'private',
    details: {
      diagnostic: {
        type: 'ProviderError',
        code: 'invalid_output',
        originalMessage: 'private',
        validation: { reason: 'schema-invalid', path: ['verificationReport', 0, 'status'] },
      },
    },
  });
  const failure = degradeOnFinalAttempt({
    attemptNumber: 3,
    maxAttempts: 3,
    eligible: true,
    error,
    signal: new AbortController().signal,
    stage: 'research',
    fallback: failure => failure,
  });
  expect(failure.diagnostic).toEqual({
    type: 'WorkflowStepError',
    code: 'provider_failed',
    cause: { type: 'ProviderError', code: 'invalid_output' },
    validation: { reason: 'schema-invalid', path: ['verificationReport', 0, 'status'] },
  });
  expect(JSON.stringify(failure)).not.toContain('private');
});
