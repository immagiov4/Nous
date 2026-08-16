import { describe, expect, test } from 'vitest';
import type { WorkflowRun } from '../../src/workflows/types.js';
import {
  createWorkflowPublicRunState,
  createWorkflowRunState,
  type WorkflowDurableEventState,
  type WorkflowNodeRunState,
  type WorkflowSignalWaitState,
} from '../../src/workflows/workflowReadModel.js';

const run: WorkflowRun = {
  cancellationRequested: false,
  cleanupStatus: 'not-required',
  correlationId: '48eb116c-a283-440b-b875-a528e5e4f5f1',
  createdAt: '2026-07-29T10:00:00.000Z',
  definitionHash: 'a'.repeat(64),
  definitionHashVersion: 1,
  id: 'run-1',
  input: { content: 'private input' },
  requestKey: 'request-1',
  resolvedConfig: { maxAttempts: 3, timeoutMs: 60_000 },
  status: 'running',
  stepPolicies: {
    generate: {
      config: { maxAttempts: 3, timeoutMs: 60_000 },
      maxAttempts: 3,
      timeoutMs: 60_000,
    },
  },
  stepPoliciesVersion: 1,
  updatedAt: '2026-07-29T10:00:02.000Z',
  userId: 'user-1',
  workflowId: 'lesson-generation',
};

const node = (input: {
  createdAt: string;
  definitionId: string;
  instanceId: string;
}): WorkflowNodeRunState => ({
  attemptCount: 0,
  availableAt: input.createdAt,
  createdAt: input.createdAt,
  definitionId: input.definitionId,
  instanceId: input.instanceId,
  kind: 'step',
  maxAttempts: 3,
  status: 'queued',
  updatedAt: input.createdAt,
});

describe('workflow read model', () => {
  test('returns an immutable, deterministic lifecycle snapshot after reconnect', () => {
    const events: WorkflowDurableEventState[] = [
      {
        createdAt: '2026-07-29T10:00:02.000Z',
        eventType: 'lesson.completed',
        payload: { sectionId: 'section-1' },
        schemaVersion: 1,
        sequence: '2',
      },
      {
        createdAt: '2026-07-29T10:00:01.000Z',
        eventType: 'lesson.started',
        payload: { sectionId: 'section-1' },
        schemaVersion: 1,
        sequence: '1',
      },
    ];
    const waits: WorkflowSignalWaitState[] = [
      {
        createdAt: '2026-07-29T10:00:02.000Z',
        expiresAt: '2026-07-30T10:00:02.000Z',
        nodeInstanceId: 'root/approve',
        schemaVersion: 2,
        signalType: 'course.approved',
        waitId: 'wait-2',
      },
      {
        createdAt: '2026-07-29T10:00:01.000Z',
        expiresAt: '2026-07-30T10:00:01.000Z',
        nodeInstanceId: 'root/confirm',
        schemaVersion: 1,
        signalType: 'course.confirmed',
        waitId: 'wait-1',
      },
    ];
    const state = createWorkflowRunState({
      events,
      nodes: [
        node({
          createdAt: '2026-07-29T10:00:01.000Z',
          definitionId: 'second',
          instanceId: 'root/second',
        }),
        node({
          createdAt: '2026-07-29T10:00:00.000Z',
          definitionId: 'first',
          instanceId: 'root/first',
        }),
        node({
          createdAt: '2026-07-29T10:00:01.000Z',
          definitionId: 'alpha',
          instanceId: 'root/alpha',
        }),
      ],
      run,
      waits,
    });

    expect(state.nodes.map(current => current.instanceId)).toEqual([
      'root/first',
      'root/alpha',
      'root/second',
    ]);
    expect(state.events.map(event => event.sequence)).toEqual(['1', '2']);
    expect(state.waits.map(wait => wait.waitId)).toEqual(['wait-1', 'wait-2']);
    expect(state.run.correlationId).toBe(run.correlationId);
    expect(state.run).not.toHaveProperty('input');
    expect(state.run).not.toHaveProperty('output');
    expect(state.run).not.toHaveProperty('resolvedConfig');
    expect(state.run).not.toHaveProperty('stepPolicies');
    expect(state.run).not.toHaveProperty('userId');
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.events[0]?.payload)).toBe(true);
    expect(Object.isFrozen(state.nodes)).toBe(true);
    expect(Object.isFrozen(state.waits)).toBe(true);
  });

  test('keeps internal durable events out of the public state unless explicitly projected', () => {
    const internalState = createWorkflowRunState({
      events: [
        {
          createdAt: '2026-07-29T10:00:01.000Z',
          eventType: 'provider.request.completed',
          payload: { privateTrace: 'do-not-publish' },
          schemaVersion: 1,
          sequence: '1',
        },
      ],
      nodes: [],
      run,
      waits: [],
    });

    const publicState = createWorkflowPublicRunState({
      publishedEvents: [],
      state: internalState,
    });

    expect(publicState).toEqual({
      nodes: [],
      publishedEvents: [],
      run: internalState.run,
      waits: [],
    });
    expect(publicState).not.toHaveProperty('events');
    expect(JSON.stringify(publicState)).not.toContain('do-not-publish');
    expect(Object.isFrozen(publicState)).toBe(true);
  });
});
