import { describe, expect, test, vi } from 'vitest';

import type { ProjectAssetReader } from '../../src/projects/projectAssetReader.js';
import type { CourseGenerationApi } from '../../src/workflows/courseGenerationApi.js';
import type { CourseInterviewApi } from '../../src/workflows/courseInterviewApi.js';
import { createWorkflowRegistry } from '../../src/workflows/definition.js';
import type { LessonVisualRetryStarter } from '../../src/workflows/lessonVisualRetryStart.js';
import type { WorkflowOutboxClaim } from '../../src/workflows/postgresWorkflowOutboxStore.js';
import { COURSE_PROJECT_REVISION_EVENT } from '../../src/workflows/projectRevisionNotifications.js';
import { WorkflowSignalError } from '../../src/workflows/workflowErrors.js';
import { subscribeToWorkflowTransientEvents } from '../../src/workflows/workflowObservability.js';
import type { WorkflowRunState } from '../../src/workflows/workflowReadModel.js';
import {
  createRuntimeProjectRevisionNotificationDelivery,
  createWorkflowRuntimeComposition,
  type WorkflowRuntimeCompositionStore,
} from '../../src/workflows/workflowRuntimeComposition.js';

const RUN_ID = '9de19290-0dab-470d-a554-9a214073283e';

const createStore = (): WorkflowRuntimeCompositionStore => ({
  cancellation: {
    request: vi.fn().mockResolvedValue({ runStatus: 'running', status: 'requested' }),
  },
  close: vi.fn().mockResolvedValue(undefined),
  getRunState: vi.fn().mockResolvedValue(null),
  outbox: {
    listDeadLetters: vi.fn().mockResolvedValue([]),
    retryDeadLetter: vi.fn().mockResolvedValue('retried'),
  },
  signals: {
    receive: vi.fn().mockImplementation(input => {
      const definition = input.resolveDefinition({
        definitionHash: 'removed-hash',
        definitionHashVersion: 1,
        workflowId: 'not-yet-registered',
      });
      if (!definition) {
        return Promise.reject(
          new WorkflowSignalError(
            'workflow_wait_obsolete',
            'The workflow definition is unavailable.'
          )
        );
      }
      return Promise.resolve({ runId: RUN_ID, status: 'replayed' as const });
    }),
  },
});

describe('workflow runtime production composition', () => {
  test('accepts supported revision events through the durable recipient boundary', async () => {
    const receiveNotification = vi.fn(async () => undefined);
    const deliver = createRuntimeProjectRevisionNotificationDelivery(receiveNotification);
    const baseClaim: WorkflowOutboxClaim = {
      attemptNumber: 1,
      eventType: COURSE_PROJECT_REVISION_EVENT,
      fencingToken: '1',
      id: 'notification-1',
      leaseExpiresAt: '2026-07-30T12:00:00.000Z',
      payload: { projectId: 'project-1', revision: 7 },
      runId: RUN_ID,
      schemaVersion: 1,
      sequence: '1',
      userId: 'user-1',
      workerId: 'worker-1',
    };

    await deliver(baseClaim);
    await deliver({ ...baseClaim, eventType: 'lesson.project-revision', id: 'notification-2' });

    expect(receiveNotification).toHaveBeenNthCalledWith(1, baseClaim);
    expect(receiveNotification).toHaveBeenNthCalledWith(2, {
      ...baseClaim,
      eventType: 'lesson.project-revision',
      id: 'notification-2',
    });
  });

  test.each([
    ['unsupported event', { eventType: 'unknown' }, 'notification_unsupported'],
    [
      'invalid payload',
      { payload: { projectId: 'project-1', revision: -1 } },
      'notification_payload_invalid',
    ],
  ])('rejects %s permanently', async (_case, override, code) => {
    const receiveNotification = vi.fn(async () => undefined);
    const deliver = createRuntimeProjectRevisionNotificationDelivery(receiveNotification);
    const claim: WorkflowOutboxClaim = {
      attemptNumber: 1,
      eventType: COURSE_PROJECT_REVISION_EVENT,
      fencingToken: '1',
      id: 'notification-invalid',
      leaseExpiresAt: '2026-07-30T12:00:00.000Z',
      payload: { projectId: 'project-1', revision: 7 },
      runId: RUN_ID,
      schemaVersion: 1,
      sequence: '1',
      userId: 'user-1',
      workerId: 'worker-1',
      ...override,
    };

    await expect(deliver(claim)).rejects.toThrowError(
      expect.objectContaining({ failure: expect.objectContaining({ code, kind: 'permanent' }) })
    );
    expect(receiveNotification).not.toHaveBeenCalled();
  });

  test('composes public boundaries and owns worker then store shutdown', async () => {
    const store = createStore();
    const projectAssetReader: ProjectAssetReader = {
      readActive: vi.fn().mockResolvedValue(null),
    };
    const courseGenerationApi: CourseGenerationApi = {
      get: vi.fn(),
      getActive: vi.fn(),
      start: vi.fn(),
    };
    const courseInterviewApi: CourseInterviewApi = {
      getActive: vi.fn(),
      start: vi.fn(),
    };
    const lessonVisualRetryStarter: LessonVisualRetryStarter = {
      start: vi.fn(),
    };
    const worker = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = createWorkflowRuntimeComposition({
      courseGenerationApi,
      courseInterviewApi,
      lessonVisualRetryStarter,
      projectAssetReader,
      registry: createWorkflowRegistry(),
      store,
      worker,
    });

    expect(runtime.projectAssetReader).toBe(projectAssetReader);
    expect(runtime.courseGenerationApi).toBe(courseGenerationApi);
    expect(runtime.courseInterviewApi).toBe(courseInterviewApi);
    expect(runtime.lessonVisualRetryStarter).toBe(lessonVisualRetryStarter);
    expect(runtime.workflowOutboxAdmin).toBe(store.outbox);

    await runtime.start();
    expect(worker.start).toHaveBeenCalledOnce();

    await expect(
      runtime.api.receiveSignal({
        payload: null,
        requestKey: 'approval-1',
        runId: RUN_ID,
        signalType: 'approve',
        userId: 'user-1',
        waitId: 'f58eeb9b-7abd-4d0f-a589-e54192284062',
      })
    ).rejects.toMatchObject({ code: 'workflow_wait_obsolete' });
    expect(store.signals.receive).toHaveBeenCalledOnce();

    await runtime.close();
    expect(worker.stop).toHaveBeenCalledOnce();
    expect(store.close).toHaveBeenCalledOnce();
    expect(worker.stop.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(store.close).mock.invocationCallOrder[0] as number
    );
  });

  test('installs an ordered in-process sink for transient events by default', async () => {
    const store = createStore();
    vi.mocked(store.signals.receive).mockResolvedValue({
      runId: RUN_ID,
      status: 'consumed',
      transientEvents: [
        { eventType: 'progress', payload: { order: 1 }, schemaVersion: 1 },
        { eventType: 'progress', payload: { order: 2 }, schemaVersion: 1 },
      ],
      workflowId: 'course-generation',
    });
    const received: number[] = [];
    const unsubscribeBroken = subscribeToWorkflowTransientEvents(() => {
      throw new Error('observer failure');
    });
    const unsubscribe = subscribeToWorkflowTransientEvents(event => {
      received.push((event.payload as { order: number }).order);
      return undefined;
    });
    const runtime = createWorkflowRuntimeComposition({ store });

    try {
      await runtime.api.receiveSignal({
        payload: null,
        requestKey: 'approval-1',
        runId: RUN_ID,
        signalType: 'approve',
        userId: 'user-1',
        waitId: 'f58eeb9b-7abd-4d0f-a589-e54192284062',
      });
    } finally {
      unsubscribe();
      unsubscribeBroken();
      await runtime.close();
    }

    expect(received).toEqual([1, 2]);
  });

  test('closes the store even when worker shutdown fails', async () => {
    const store = createStore();
    const workerFailure = new Error('worker unsubscribe failed');
    const worker = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockRejectedValue(workerFailure),
    };
    const runtime = createWorkflowRuntimeComposition({ store, worker });

    await expect(runtime.close()).rejects.toBe(workerFailure);
    expect(worker.stop).toHaveBeenCalledOnce();
    expect(store.close).toHaveBeenCalledOnce();
    expect(worker.stop.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(store.close).mock.invocationCallOrder[0] as number
    );
  });

  test('publishes only the committed project revision for visual retry clients', async () => {
    const state: WorkflowRunState = {
      events: [
        {
          createdAt: '2026-07-29T10:00:00.000Z',
          eventType: 'provider.request.completed',
          payload: { privateTrace: 'hidden' },
          schemaVersion: 1,
          sequence: '1',
        },
        {
          createdAt: '2026-07-29T10:00:01.000Z',
          eventType: 'lesson.project-revision',
          payload: { projectId: 'project-1', revision: 12 },
          schemaVersion: 1,
          sequence: '2',
        },
      ],
      nodes: [],
      run: {
        cancellationRequested: false,
        cleanupStatus: 'not-required',
        completedAt: '2026-07-29T10:00:01.000Z',
        createdAt: '2026-07-29T10:00:00.000Z',
        definitionHash: 'definition-hash',
        definitionHashVersion: 1,
        id: RUN_ID,
        projectId: 'project-1',
        requestKey: 'request-1',
        status: 'completed',
        updatedAt: '2026-07-29T10:00:01.000Z',
        workflowId: 'retry-lesson-visual',
      },
      waits: [],
    };
    const store = createStore();
    vi.mocked(store.getRunState).mockResolvedValue(state);
    const runtime = createWorkflowRuntimeComposition({ store });

    const publicState = await runtime.api.getRunState({ runId: RUN_ID, userId: 'user-1' });

    expect(publicState?.publishedEvents).toEqual([
      expect.objectContaining({
        eventType: 'lesson.project-revision',
        payload: { projectId: 'project-1', revision: 12 },
      }),
    ]);
    expect(JSON.stringify(publicState)).not.toContain('hidden');
  });

  test('projects the committed revision from course workflow state', async () => {
    const store = createStore();
    vi.mocked(store.getRunState).mockResolvedValue({
      events: [
        {
          createdAt: '2026-07-30T12:00:01.000Z',
          eventType: COURSE_PROJECT_REVISION_EVENT,
          payload: { projectId: 'project-1', revision: 8 },
          schemaVersion: 1,
          sequence: '1',
        },
      ],
      nodes: [],
      run: {
        cancellationRequested: false,
        cleanupStatus: 'not-required',
        completedAt: '2026-07-30T12:00:01.000Z',
        createdAt: '2026-07-30T12:00:00.000Z',
        definitionHash: 'definition-hash',
        definitionHashVersion: 1,
        id: RUN_ID,
        projectId: 'project-1',
        requestKey: 'request-1',
        status: 'completed',
        updatedAt: '2026-07-30T12:00:01.000Z',
        workflowId: 'course-generation',
      },
      waits: [],
    });
    const runtime = createWorkflowRuntimeComposition({ store });

    const publicState = await runtime.api.getRunState({ runId: RUN_ID, userId: 'user-1' });

    expect(publicState?.publishedEvents).toEqual([
      expect.objectContaining({
        eventType: COURSE_PROJECT_REVISION_EVENT,
        payload: { projectId: 'project-1', revision: 8 },
      }),
    ]);
  });

  test('projects only durable public events from a course interview', async () => {
    const store = createStore();
    vi.mocked(store.getRunState).mockResolvedValue({
      events: [
        {
          createdAt: '2026-08-08T12:00:00.000Z',
          eventType: 'course-interview-message',
          payload: { message: { role: 'model', text: 'Qual è il tuo obiettivo?' } },
          schemaVersion: 1,
          sequence: '1',
        },
        {
          createdAt: '2026-08-08T12:00:01.000Z',
          eventType: 'provider.request.completed',
          payload: { privateTrace: 'hidden' },
          schemaVersion: 1,
          sequence: '2',
        },
        {
          createdAt: '2026-08-08T12:00:02.000Z',
          eventType: 'course-interview-ended',
          payload: { kind: 'cancelled', projectId: 'project-1' },
          schemaVersion: 1,
          sequence: '3',
        },
      ],
      nodes: [],
      run: {
        cancellationRequested: false,
        cleanupStatus: 'completed',
        completedAt: '2026-08-08T12:00:02.000Z',
        createdAt: '2026-08-08T12:00:00.000Z',
        definitionHash: 'definition-hash',
        definitionHashVersion: 1,
        id: RUN_ID,
        projectId: 'project-1',
        requestKey: 'request-1',
        status: 'completed',
        updatedAt: '2026-08-08T12:00:02.000Z',
        workflowId: 'course-interview',
      },
      waits: [],
    });
    const runtime = createWorkflowRuntimeComposition({ store });

    const publicState = await runtime.api.getRunState({ runId: RUN_ID, userId: 'user-1' });

    expect(publicState?.publishedEvents.map(event => event.eventType)).toEqual([
      'course-interview-message',
      'course-interview-ended',
    ]);
    expect(JSON.stringify(publicState)).not.toContain('hidden');
  });
});
