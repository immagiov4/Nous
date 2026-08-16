import { describe, expect, expectTypeOf, test, vi } from 'vitest';

import type { WorkflowOutboxClaim } from '../../src/workflows/postgresWorkflowOutboxStore.js';
import type { WorkflowRun, WorkflowStepClaim } from '../../src/workflows/types.js';
import {
  ConsoleWorkflowLogger,
  emitWorkflowLog,
  projectWorkflowLogEvent,
  publishWorkflowTransientEvent,
  publishWorkflowTransientEvents,
  subscribeToWorkflowTransientEvents,
  type WorkflowLogEvent,
  type WorkflowLogger,
  type WorkflowTransientEventPublisher,
} from '../../src/workflows/workflowObservability.js';

const run: WorkflowRun = {
  cancellationRequested: false,
  cleanupStatus: 'not-required',
  createdAt: '2026-07-29T10:00:00.000Z',
  definitionHash: 'a'.repeat(64),
  definitionHashVersion: 1,
  id: 'run-1',
  input: { prompt: 'private prompt' },
  requestKey: 'private-request-key',
  resolvedConfig: { apiKey: 'private-key', model: 'provider/model' },
  status: 'queued',
  stepPolicies: {
    generate: {
      config: { maxAttempts: 3, timeoutMs: 60_000 },
      maxAttempts: 3,
      timeoutMs: 60_000,
    },
  },
  stepPoliciesVersion: 1,
  updatedAt: '2026-07-29T10:00:00.000Z',
  userId: 'private-user',
  workflowId: 'lesson-generation',
};

const claim: WorkflowStepClaim = {
  attemptNumber: 2,
  definitionHash: run.definitionHash,
  definitionHashVersion: 1,
  fencingToken: '4',
  input: { source: 'private source' },
  kind: 'step',
  leaseExpiresAt: '2026-07-29T10:01:00.000Z',
  maxAttempts: 3,
  nodeDefinitionId: 'generate',
  nodeInstanceId: 'root/item:private lesson title/generate',
  retryFeedback: 'private model feedback',
  runId: run.id,
  stepPolicies: run.stepPolicies,
  stepPoliciesVersion: run.stepPoliciesVersion,
  timeoutMs: 60_000,
  userId: run.userId,
  workerId: 'private-hostname-worker',
  workflowId: run.workflowId,
};

describe('workflow observability', () => {
  test('keeps transient delivery synchronous and isolates nested payloads between observers', () => {
    expectTypeOf<WorkflowTransientEventPublisher>().returns.toEqualTypeOf<undefined>();
    const received: number[] = [];
    const unsubscribeMutating = subscribeToWorkflowTransientEvents(event => {
      (event.payload as { nested: { value: number } }).nested.value = 99;
      return undefined;
    });
    const unsubscribeReading = subscribeToWorkflowTransientEvents(event => {
      received.push((event.payload as { nested: { value: number } }).nested.value);
      return undefined;
    });

    try {
      publishWorkflowTransientEvents(
        publishWorkflowTransientEvent,
        { runId: 'run-1', workflowId: 'workflow-1' },
        [{ eventType: 'progress', payload: { nested: { value: 1 } }, schemaVersion: 1 }]
      );
    } finally {
      unsubscribeReading();
      unsubscribeMutating();
    }

    expect(received).toEqual([1]);
  });

  test('projects run and attempt sources through a strict content-free allowlist', () => {
    const created = projectWorkflowLogEvent({
      action: 'created',
      entity: 'run',
      run,
    });
    const retry = projectWorkflowLogEvent({
      action: 'retry-scheduled',
      availableAt: '2026-07-29T10:02:00.000Z',
      claim,
      entity: 'attempt',
      failure: {
        code: 'provider_unavailable',
        details: {
          diagnostic: {
            cause: { code: 'provider_rejected', status: 400, type: 'AI_APICallError' },
            type: 'ProviderTransientError',
          },
          model: {
            apiKey: 'private-key',
            model: 'gpt-5.6-terra',
            provider: 'codex',
            serviceTier: 'fast',
            slot: 'lesson',
          },
          response: 'private provider response',
        },
        kind: 'operational',
        message: 'private provider error',
      },
      operation: 'step',
      retryDelayMs: 2_000,
    });

    expect(created).toEqual({
      action: 'created',
      cleanupStatus: 'not-required',
      event: 'workflow.run',
      level: 'info',
      runId: 'run-1',
      runStatus: 'queued',
      workflowId: 'lesson-generation',
    });
    expect(retry).toMatchObject({
      action: 'retry-scheduled',
      attemptNumber: 2,
      event: 'workflow.attempt',
      failureCode: 'provider_unavailable',
      failureKind: 'operational',
      failureDiagnostic: {
        cause: { code: 'provider_rejected', status: 400, type: 'AI_APICallError' },
        type: 'ProviderTransientError',
      },
      fencingToken: '4',
      level: 'warn',
      nodeDefinitionId: 'generate',
      operation: 'step',
      modelContext: {
        model: 'gpt-5.6-terra',
        provider: 'codex',
        serviceTier: 'fast',
        slot: 'lesson',
      },
      retryDelayMs: 2_000,
      runId: 'run-1',
      workflowId: 'lesson-generation',
    });
    expect(retry).toHaveProperty('nodeInstanceIdDigest');
    expect(retry).toHaveProperty('workerIdDigest');
    const serialized = JSON.stringify([created, retry]);
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('prompt');
    expect(serialized).not.toContain('source');
    expect(serialized).not.toContain('response');
    expect(serialized).not.toContain('apiKey');
  });

  test('drops durable notification payloads while preserving delivery correlation', () => {
    const outboxClaim: WorkflowOutboxClaim = {
      attemptNumber: 3,
      correlationId: '123e4567-e89b-42d3-a456-426614174000',
      eventType: 'lesson.ready',
      fencingToken: '5',
      id: 'notification-1',
      leaseExpiresAt: '2026-07-29T10:01:00.000Z',
      payload: { lesson: 'private generated lesson' },
      runId: run.id,
      schemaVersion: 1,
      sequence: '7',
      userId: run.userId,
      workerId: 'private-delivery-host',
    };

    const event = projectWorkflowLogEvent({
      action: 'claimed',
      claim: outboxClaim,
      entity: 'notification',
    });

    expect(event).toEqual({
      action: 'claimed',
      attemptNumber: 3,
      correlationId: '123e4567-e89b-42d3-a456-426614174000',
      event: 'workflow.notification',
      eventType: 'lesson.ready',
      fencingToken: '5',
      level: 'info',
      notificationId: 'notification-1',
      runId: 'run-1',
      schemaVersion: 1,
      sequence: '7',
      workerIdDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(event)).not.toContain('private generated lesson');
  });

  test('records definition compatibility decisions without workflow content', () => {
    const event = projectWorkflowLogEvent({
      action: 'promote',
      boundary: {
        definitionHash: 'a'.repeat(64),
        definitionHashVersion: 1,
        workflowId: 'lesson-generation',
      },
      entity: 'definition',
      supportedDefinitionCount: 2,
    });

    expect(event).toEqual({
      action: 'promote',
      definitionHash: 'a'.repeat(64),
      definitionHashVersion: 1,
      event: 'workflow.definition',
      level: 'info',
      supportedDefinitionCount: 2,
      workflowId: 'lesson-generation',
    });
  });

  test('isolates a failing logger from authoritative workflow work', () => {
    const logger: WorkflowLogger = {
      log: () => {
        throw new Error('logging backend unavailable');
      },
    };

    expect(() =>
      emitWorkflowLog(logger, {
        action: 'created',
        entity: 'run',
        run,
      })
    ).not.toThrow();
  });

  test('writes one JSON object through the console implementation', () => {
    const output = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const logger = new ConsoleWorkflowLogger(output);
    const event: WorkflowLogEvent = {
      action: 'loop-failed',
      event: 'workflow.runtime',
      failureCode: 'workflow_runtime_loop_failed',
      level: 'error',
      loop: 'step',
    };

    logger.log(event);

    expect(output.error).toHaveBeenCalledWith(JSON.stringify(event));
    expect(output.info).not.toHaveBeenCalled();
    expect(output.warn).not.toHaveBeenCalled();
  });

  test('projects correlated lifecycle failures without private payloads', () => {
    const event = projectWorkflowLogEvent({
      action: 'failed',
      correlationId: '123e4567-e89b-12d3-a456-426614174000',
      entity: 'lifecycle',
      failure: {
        code: 'schema_invalid',
        details: {
          diagnostic: { type: 'ZodError' },
        },
        kind: 'permanent',
        message: 'private generated response',
      },
      method: 'POST',
      operation: 'ai_generation',
      path: '/api/openrouter/chat/completions',
      provider: 'openrouter',
      statusCode: 502,
    });

    expect(event).toMatchObject({
      action: 'failed',
      correlationId: '123e4567-e89b-12d3-a456-426614174000',
      event: 'lifecycle',
      failureCode: 'schema_invalid',
      level: 'error',
      operation: 'ai_generation',
      provider: 'openrouter',
    });
    expect(JSON.stringify(event)).not.toContain('private');
  });
});
