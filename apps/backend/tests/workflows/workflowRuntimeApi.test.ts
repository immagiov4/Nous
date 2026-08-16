import { describe, expect, test, vi } from 'vitest';

import type { WorkflowRegistry } from '../../src/workflows/definition.js';
import {
  createWorkflowRuntimeApi,
  type WorkflowRuntimeApiStore,
} from '../../src/workflows/runtime/workflowRuntimeApi.js';
import type { ErasedRegisteredWorkflow } from '../../src/workflows/types.js';
import { WorkflowSignalError } from '../../src/workflows/workflowErrors.js';
import type { WorkflowRunState } from '../../src/workflows/workflowReadModel.js';

const RUN_ID = '9de19290-0dab-470d-a554-9a214073283e';
const WAIT_ID = 'f58eeb9b-7abd-4d0f-a589-e54192284062';

const createState = (): WorkflowRunState => ({
  events: [
    {
      createdAt: '2026-07-29T10:00:00.000Z',
      eventType: 'provider.request.completed',
      payload: { privateTrace: 'do-not-publish' },
      schemaVersion: 1,
      sequence: '1',
    },
  ],
  nodes: [],
  run: {
    cancellationRequested: false,
    cleanupStatus: 'not-required',
    createdAt: '2026-07-29T10:00:00.000Z',
    definitionHash: 'definition-hash',
    definitionHashVersion: 1,
    id: RUN_ID,
    requestKey: 'request-1',
    status: 'waiting',
    updatedAt: '2026-07-29T10:00:00.000Z',
    workflowId: 'lesson-generation',
  },
  waits: [
    {
      createdAt: '2026-07-29T10:00:00.000Z',
      expiresAt: '2026-07-30T10:00:00.000Z',
      nodeInstanceId: 'root/approval',
      schemaVersion: 1,
      signalType: 'lesson.approved',
      waitId: WAIT_ID,
    },
  ],
});

const createDependencies = () => {
  const definition = { definitionHashVersion: 1 } as ErasedRegisteredWorkflow;
  const registry = {
    resolve: vi.fn().mockReturnValue(definition),
  } as unknown as WorkflowRegistry;
  const store: WorkflowRuntimeApiStore = {
    cancellation: {
      request: vi.fn().mockResolvedValue({ runStatus: 'running', status: 'requested' }),
    },
    getRunState: vi.fn().mockResolvedValue(createState()),
    signals: {
      receive: vi.fn().mockResolvedValue({
        runId: RUN_ID,
        status: 'consumed',
        transientEvents: [{ eventType: 'private', payload: { secret: true }, schemaVersion: 1 }],
        workflowId: 'lesson-generation',
      }),
    },
  };
  return { definition, registry, store };
};

describe('workflow runtime API facade', () => {
  test('delegates owner-scoped reads and cancellation without publishing internal events', async () => {
    const { registry, store } = createDependencies();
    const api = createWorkflowRuntimeApi({ registry, store });

    const state = await api.getRunState({ runId: RUN_ID, userId: 'user-1' });
    expect(state).toEqual({
      nodes: [],
      publishedEvents: [],
      run: createState().run,
      waits: createState().waits,
    });
    expect(state).not.toHaveProperty('events');
    expect(JSON.stringify(state)).not.toContain('do-not-publish');
    await expect(api.requestCancellation({ runId: RUN_ID, userId: 'user-1' })).resolves.toEqual({
      runStatus: 'running',
      status: 'requested',
    });

    expect(store.getRunState).toHaveBeenCalledWith({ runId: RUN_ID, userId: 'user-1' });
    expect(store.cancellation.request).toHaveBeenCalledWith({
      runId: RUN_ID,
      userId: 'user-1',
    });
  });

  test('publishes only events returned by an explicit workflow projector', async () => {
    const { registry, store } = createDependencies();
    const projector = vi.fn(() => [
      {
        createdAt: '2026-07-29T10:00:00.000Z',
        eventType: 'lesson.ready',
        payload: { sectionId: 'section-1' },
        schemaVersion: 1,
        sequence: '1',
      },
    ]);
    const api = createWorkflowRuntimeApi({
      publishedEventProjectors: new Map([['lesson-generation', projector]]),
      registry,
      store,
    });

    const state = await api.getRunState({ runId: RUN_ID, userId: 'user-1' });

    expect(projector).toHaveBeenCalledWith(createState());
    expect(state?.publishedEvents).toEqual([
      expect.objectContaining({
        eventType: 'lesson.ready',
        payload: { sectionId: 'section-1' },
      }),
    ]);
    expect(JSON.stringify(state)).not.toContain('do-not-publish');
  });

  test('delegates strict signal lookup without loading the full run state', async () => {
    const { definition, registry, store } = createDependencies();
    vi.mocked(store.signals.receive).mockImplementation(async input => {
      expect(
        input.resolveDefinition({
          definitionHash: 'definition-hash',
          definitionHashVersion: 1,
          workflowId: 'lesson-generation',
        })
      ).toBe(definition);
      return {
        runId: RUN_ID,
        status: 'consumed',
        transientEvents: [],
        workflowId: 'lesson-generation',
      };
    });
    const api = createWorkflowRuntimeApi({ registry, store });
    const payload = { approved: true };

    await expect(
      api.receiveSignal({
        payload,
        requestKey: 'approval-1',
        runId: RUN_ID,
        signalType: 'lesson.approved',
        userId: 'user-1',
        waitId: WAIT_ID,
      })
    ).resolves.toEqual({ runId: RUN_ID, status: 'consumed' });

    expect(store.getRunState).not.toHaveBeenCalled();
    expect(registry.resolve).toHaveBeenCalledWith('lesson-generation', 'definition-hash');
    expect(store.signals.receive).toHaveBeenCalledWith({
      payload,
      requestKey: 'approval-1',
      resolveDefinition: expect.any(Function),
      runId: RUN_ID,
      signalType: 'lesson.approved',
      userId: 'user-1',
      waitId: WAIT_ID,
    });
  });

  test('publishes transient events produced by a consumed signal, but not by a replay', async () => {
    const { registry, store } = createDependencies();
    const publishTransientEvent = vi.fn();
    const api = createWorkflowRuntimeApi({ publishTransientEvent, registry, store });

    await api.receiveSignal({
      payload: { approved: true },
      requestKey: 'approval-1',
      runId: RUN_ID,
      signalType: 'lesson.approved',
      userId: 'user-1',
      waitId: WAIT_ID,
    });

    expect(publishTransientEvent).toHaveBeenCalledWith({
      eventType: 'private',
      payload: { secret: true },
      runId: RUN_ID,
      schemaVersion: 1,
      workflowId: 'lesson-generation',
    });

    publishTransientEvent.mockClear();
    vi.mocked(store.signals.receive).mockResolvedValue({ runId: RUN_ID, status: 'replayed' });
    await api.receiveSignal({
      payload: { approved: true },
      requestKey: 'approval-1',
      runId: RUN_ID,
      signalType: 'lesson.approved',
      userId: 'user-1',
      waitId: WAIT_ID,
    });
    expect(publishTransientEvent).not.toHaveBeenCalled();
  });

  test('leaves owner and wait authorization to the narrow signal lookup', async () => {
    const { registry, store } = createDependencies();
    vi.mocked(store.signals.receive).mockRejectedValue(
      new WorkflowSignalError('workflow_wait_unknown', 'The workflow wait is unavailable.')
    );
    const api = createWorkflowRuntimeApi({ registry, store });

    await expect(
      api.receiveSignal({
        payload: null,
        requestKey: 'approval-1',
        runId: RUN_ID,
        signalType: 'lesson.approved',
        userId: 'other-user',
        waitId: WAIT_ID,
      })
    ).rejects.toMatchObject({ code: 'workflow_wait_unknown' });
    expect(registry.resolve).not.toHaveBeenCalled();
    expect(store.getRunState).not.toHaveBeenCalled();
  });

  test('allows the signal store to replay a consumed wait omitted from the active read model', async () => {
    const { registry, store } = createDependencies();
    vi.mocked(store.signals.receive).mockResolvedValue({ runId: RUN_ID, status: 'replayed' });
    const api = createWorkflowRuntimeApi({ registry, store });

    await expect(
      api.receiveSignal({
        payload: null,
        requestKey: 'approval-1',
        runId: RUN_ID,
        signalType: 'lesson.approved',
        userId: 'user-1',
        waitId: WAIT_ID,
      })
    ).resolves.toEqual({ runId: RUN_ID, status: 'replayed' });
    expect(store.getRunState).not.toHaveBeenCalled();
    expect(registry.resolve).not.toHaveBeenCalled();
  });

  test.each([
    ['missing definition', null],
    ['different definition version', { definitionHashVersion: 2 }],
  ])('returns no resumable definition for a %s', async (_title, resolvedDefinition) => {
    const { registry, store } = createDependencies();
    vi.mocked(registry.resolve).mockReturnValue(
      resolvedDefinition as ErasedRegisteredWorkflow | null
    );
    const api = createWorkflowRuntimeApi({ registry, store });
    await api.receiveSignal({
      payload: null,
      requestKey: 'approval-1',
      runId: RUN_ID,
      signalType: 'lesson.approved',
      userId: 'user-1',
      waitId: WAIT_ID,
    });
    const [{ resolveDefinition }] = vi.mocked(store.signals.receive).mock.calls[0] ?? [];

    expect(
      resolveDefinition?.({
        definitionHash: 'definition-hash',
        definitionHashVersion: 1,
        workflowId: 'lesson-generation',
      })
    ).toBeNull();
  });
});
