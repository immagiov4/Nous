import { afterEach, describe, expect, test, vi } from 'vitest';
import * as z from 'zod';

import { WorkflowExecutionDefaultsSchema } from '../../src/workflows/config.js';
import { createWorkflowRegistry, step, workflow } from '../../src/workflows/definition.js';
import type { WorkflowOutboxClaim } from '../../src/workflows/postgresWorkflowOutboxStore.js';
import { failPermanently } from '../../src/workflows/retryPolicy.js';
import {
  createWorkflowRuntimeWorker as createRuntimeWorker,
  type WorkflowRuntimeAssetCleanup,
  type WorkflowRuntimeLoopError,
  type WorkflowRuntimeStore,
  type WorkflowRuntimeWake,
  type WorkflowRuntimeWakeSource,
  type WorkflowRuntimeWakeSubscription,
  type WorkflowRuntimeWorkerInput,
} from '../../src/workflows/runtime/workflowRuntimeWorker.js';
import type { RegisteredWorkflow, WorkflowStepClaim } from '../../src/workflows/types.js';
import type { WorkflowLogEvent } from '../../src/workflows/workflowObservability.js';
import {
  DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MS,
  DEFAULT_WORKFLOW_LEASE_MS,
} from '../../src/workflows/workflowStepRunner.js';

const POLL_INTERVAL_MS = 100;
const Text = z.object({ text: z.string() });
const reconcileAvailableDefinitions = async (): Promise<void> => undefined;

const makeAssetCleanup = (): WorkflowRuntimeAssetCleanup => ({
  claimNextCleanup: vi.fn(async () => null),
  claimNextQueuedObject: vi.fn(async () => null),
  cleanup: vi.fn(async () => ({ status: 'deleted' as const })),
  cleanupQueuedObject: vi.fn(async () => 'deleted' as const),
  queueNextTerminalRunAssets: vi.fn(async () => 0),
});

const createWorkflowRuntimeWorker = <Services>(
  input: Omit<
    WorkflowRuntimeWorkerInput<Services>,
    'assetCleanup' | 'deliverNotification' | 'stepConcurrency'
  > & {
    assetCleanup?: WorkflowRuntimeAssetCleanup;
    deliverNotification?: WorkflowRuntimeWorkerInput<Services>['deliverNotification'];
    stepConcurrency?: number;
  }
) =>
  createRuntimeWorker({
    assetCleanup: input.assetCleanup ?? makeAssetCleanup(),
    deliverNotification: input.deliverNotification ?? vi.fn(async () => undefined),
    stepConcurrency: input.stepConcurrency ?? 1,
    ...input,
  });

class FakeWakeSource implements WorkflowRuntimeWakeSource {
  private listener: ((wake: WorkflowRuntimeWake) => void) | null = null;
  readonly subscribe = vi.fn(
    async (
      listener: (wake: WorkflowRuntimeWake) => void
    ): Promise<WorkflowRuntimeWakeSubscription> => {
      this.listener = listener;
      return {
        unsubscribe: vi.fn(async () => {
          this.listener = null;
        }),
      };
    }
  );

  emit(wake: WorkflowRuntimeWake): void {
    this.listener?.(wake);
  }
}

const registerStepWorkflow = (run: (text: string) => Promise<string>) => {
  const registry = createWorkflowRegistry();
  const definition = registry.register({
    current: workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'runtime-worker',
      inputSchema: Text,
      outputSchema: Text,
      root: step({
        id: 'work',
        inputSchema: Text,
        outputSchema: Text,
        run: async context => ({ text: await run(context.input.text) }),
      }),
    }),
  }).current;
  return { definition, registry };
};

const makeClaim = (
  definition: RegisteredWorkflow,
  workerId: string,
  overrides: Partial<WorkflowStepClaim> = {}
): WorkflowStepClaim => ({
  attemptNumber: 1,
  definitionHash: definition.definitionHash,
  definitionHashVersion: definition.definitionHashVersion,
  fencingToken: '1',
  input: { text: 'input' },
  kind: 'step',
  leaseExpiresAt: '2026-07-29T12:00:00.000Z',
  maxAttempts: 3,
  nodeDefinitionId: 'work',
  nodeInstanceId: 'work',
  retryFeedback: '',
  runId: '11111111-1111-4111-8111-111111111111',
  stepPolicies: {
    work: {
      config: { maxAttempts: 3, timeoutMs: 60_000 },
      maxAttempts: 3,
      timeoutMs: 60_000,
    },
  },
  stepPoliciesVersion: 1,
  timeoutMs: 60_000,
  userId: '22222222-2222-4222-8222-222222222222',
  workerId,
  workflowId: definition.id,
  ...overrides,
});

const makeStore = (): WorkflowRuntimeStore => ({
  cancellation: {
    reconcileNext: vi.fn(async () => null),
    releaseClaim: vi.fn(async () => undefined),
  },
  checkpointStep: vi.fn(async () => ({ status: 'checkpointed', transientEvents: [] })),
  recordAiUsage: vi.fn(async () => undefined),
  outbox: {
    claimNext: vi.fn(async () => null),
    heartbeat: vi.fn(async () => ({
      leaseExpiresAt: '2026-07-29T12:01:00.000Z',
      status: 'renewed' as const,
    })),
    markDelivered: vi.fn(async () => undefined),
    recordFailure: vi.fn(async () => undefined),
  },
  steps: {
    claimNext: vi.fn(async () => null),
    heartbeat: vi.fn(async () => ({
      leaseExpiresAt: '2026-07-29T12:01:00.000Z',
      status: 'renewed',
    })),
    recordDefinitionUnavailable: vi.fn(async () => undefined),
    recordFailure: vi.fn(async () => ({ status: 'failed', transientEvents: [] })),
    recoverNextExpired: vi.fn(async () => null),
  },
  undo: {
    claimNext: vi.fn(async () => null),
    complete: vi.fn(async () => ({ cleanupStatus: 'completed' })),
    heartbeat: vi.fn(async () => ({
      leaseExpiresAt: '2026-07-29T12:01:00.000Z',
      status: 'renewed',
    })),
    recordFailure: vi.fn(async () => ({ status: 'failed' })),
    recoverNextExpired: vi.fn(async () => null),
    requeueFailed: vi.fn(async () => 0),
  },
  waits: {
    expireNext: vi.fn(async () => null),
  },
});

const outboxClaim: WorkflowOutboxClaim = {
  attemptNumber: 1,
  eventType: 'lesson.project-revision',
  fencingToken: '1',
  id: 'notification-1',
  leaseExpiresAt: '2026-07-29T12:01:00.000Z',
  payload: { projectId: 'project-1', revision: 4 },
  runId: '11111111-1111-4111-8111-111111111111',
  schemaVersion: 1,
  sequence: '1',
  userId: '22222222-2222-4222-8222-222222222222',
  workerId: 'worker-1',
};

const settleDrains = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('workflow runtime worker', () => {
  test('scans every independent work class at startup', async () => {
    const { definition, registry } = registerStepWorkflow(async text => text);
    const store = makeStore();
    const reconcileUnavailableDefinitions = vi.fn(reconcileAvailableDefinitions);
    const wakeSource = new FakeWakeSource();
    const assetCleanup = makeAssetCleanup();
    const supportedDefinitions = [
      {
        definitionHash: definition.definitionHash,
        definitionHashVersion: definition.definitionHashVersion,
        workflowId: definition.id,
      },
    ];
    const worker = createWorkflowRuntimeWorker({
      assetCleanup,
      deliverNotification: vi.fn(async () => undefined),
      onLoopError: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      reconcileUnavailableDefinitions,
      registry,
      services: {},
      store,
      wakeSource,
      workerId: 'worker-1',
    });

    await worker.start();
    await settleDrains();

    expect(store.steps.claimNext).toHaveBeenCalledOnce();
    expect(store.steps.claimNext).toHaveBeenCalledWith({
      leaseMs: DEFAULT_WORKFLOW_LEASE_MS,
      supportedDefinitions,
      workerId: 'worker-1',
    });
    expect(store.outbox.claimNext).toHaveBeenCalledOnce();
    expect(store.undo.claimNext).toHaveBeenCalledOnce();
    expect(store.undo.claimNext).toHaveBeenCalledWith({
      leaseMs: DEFAULT_WORKFLOW_LEASE_MS,
      supportedDefinitions,
      workerId: 'worker-1',
    });
    expect(store.steps.recoverNextExpired).toHaveBeenCalledOnce();
    expect(store.steps.recoverNextExpired).toHaveBeenCalledWith({
      resolveDefinition: expect.any(Function),
      supportedDefinitions,
    });
    expect(store.undo.recoverNextExpired).toHaveBeenCalledOnce();
    expect(store.undo.recoverNextExpired).toHaveBeenCalledWith({ supportedDefinitions });
    expect(store.undo.requeueFailed).toHaveBeenCalledOnce();
    expect(store.undo.requeueFailed).toHaveBeenCalledWith({ supportedDefinitions });
    expect(store.waits.expireNext).toHaveBeenCalledOnce();
    expect(store.cancellation.reconcileNext).toHaveBeenCalledOnce();
    expect(assetCleanup.queueNextTerminalRunAssets).toHaveBeenCalledOnce();
    expect(reconcileUnavailableDefinitions).toHaveBeenCalledOnce();
    expect(reconcileUnavailableDefinitions.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(store.undo.requeueFailed).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(vi.mocked(store.undo.requeueFailed).mock.invocationCallOrder[0]).toBeLessThan(
      wakeSource.subscribe.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    await worker.stop();
  });

  test('delivers a durable notification and acknowledges it only afterwards', async () => {
    const { registry } = registerStepWorkflow(async text => text);
    const store = makeStore();
    vi.mocked(store.outbox.claimNext).mockResolvedValueOnce(outboxClaim).mockResolvedValue(null);
    const deliverNotification = vi.fn(async () => undefined);
    const worker = createWorkflowRuntimeWorker({
      deliverNotification,
      onLoopError: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      reconcileUnavailableDefinitions: reconcileAvailableDefinitions,
      registry,
      services: {},
      store,
      wakeSource: new FakeWakeSource(),
      workerId: 'worker-1',
    });

    await worker.start();
    await vi.waitFor(() => expect(store.outbox.markDelivered).toHaveBeenCalledWith(outboxClaim));

    expect(deliverNotification).toHaveBeenCalledWith(outboxClaim);
    expect(deliverNotification.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(store.outbox.markDelivered).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    await worker.stop();
  });

  test('renews a durable notification lease while delivery is still running', async () => {
    vi.useFakeTimers();
    const { registry } = registerStepWorkflow(async text => text);
    const store = makeStore();
    vi.mocked(store.outbox.claimNext).mockResolvedValueOnce(outboxClaim).mockResolvedValue(null);
    let finishDelivery = (): void => undefined;
    const delivery = new Promise<void>(resolve => {
      finishDelivery = resolve;
    });
    const worker = createWorkflowRuntimeWorker({
      deliverNotification: vi.fn(() => delivery),
      onLoopError: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      reconcileUnavailableDefinitions: reconcileAvailableDefinitions,
      registry,
      services: {},
      store,
      wakeSource: new FakeWakeSource(),
      workerId: 'worker-1',
    });

    await worker.start();
    await settleDrains();
    await vi.advanceTimersByTimeAsync(DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MS);

    expect(store.outbox.heartbeat).toHaveBeenCalledWith({
      claim: outboxClaim,
      leaseMs: DEFAULT_WORKFLOW_LEASE_MS,
    });
    expect(store.outbox.markDelivered).not.toHaveBeenCalled();

    finishDelivery();
    await vi.waitFor(() => expect(store.outbox.markDelivered).toHaveBeenCalledWith(outboxClaim));
    await worker.stop();
  });

  test('does not acknowledge or reschedule after notification lease ownership is lost', async () => {
    vi.useFakeTimers();
    const { registry } = registerStepWorkflow(async text => text);
    const store = makeStore();
    vi.mocked(store.outbox.claimNext).mockResolvedValueOnce(outboxClaim).mockResolvedValue(null);
    vi.mocked(store.outbox.heartbeat).mockResolvedValueOnce({ status: 'lost' });
    let finishDelivery = (): void => undefined;
    const delivery = new Promise<void>(resolve => {
      finishDelivery = resolve;
    });
    const worker = createWorkflowRuntimeWorker({
      deliverNotification: vi.fn(() => delivery),
      onLoopError: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      reconcileUnavailableDefinitions: reconcileAvailableDefinitions,
      registry,
      services: {},
      store,
      wakeSource: new FakeWakeSource(),
      workerId: 'worker-1',
    });

    await worker.start();
    await settleDrains();
    await vi.advanceTimersByTimeAsync(DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MS);
    finishDelivery();
    await settleDrains();

    expect(store.outbox.markDelivered).not.toHaveBeenCalled();
    expect(store.outbox.recordFailure).not.toHaveBeenCalled();
    await worker.stop();
  });

  test('reschedules a failed durable notification without persisting private error text', async () => {
    const { registry } = registerStepWorkflow(async text => text);
    const store = makeStore();
    vi.mocked(store.outbox.claimNext).mockResolvedValueOnce(outboxClaim).mockResolvedValue(null);
    const worker = createWorkflowRuntimeWorker({
      deliverNotification: vi.fn(async () => {
        throw new Error('private listener detail');
      }),
      onLoopError: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      reconcileUnavailableDefinitions: reconcileAvailableDefinitions,
      registry,
      services: {},
      store,
      wakeSource: new FakeWakeSource(),
      workerId: 'worker-1',
    });

    await worker.start();
    await vi.waitFor(() => expect(store.outbox.recordFailure).toHaveBeenCalledOnce());

    expect(store.outbox.markDelivered).not.toHaveBeenCalled();
    expect(store.outbox.recordFailure).toHaveBeenCalledWith({
      claim: outboxClaim,
      failure: {
        code: 'notification_delivery_failed',
        kind: 'operational',
        message: 'The durable notification could not be delivered.',
      },
      retryDelayMs: POLL_INTERVAL_MS,
    });
    expect(JSON.stringify(vi.mocked(store.outbox.recordFailure).mock.calls)).not.toContain(
      'private listener detail'
    );
    await worker.stop();
  });

  test('retries a permanently invalid notification without acknowledging delivery', async () => {
    const { registry } = registerStepWorkflow(async text => text);
    const store = makeStore();
    vi.mocked(store.outbox.claimNext).mockResolvedValueOnce(outboxClaim).mockResolvedValue(null);
    const failure = failPermanently({
      code: 'notification_unsupported',
      message: 'The durable workflow notification is not supported.',
    });
    const worker = createWorkflowRuntimeWorker({
      deliverNotification: vi.fn(async () => {
        throw failure;
      }),
      onLoopError: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      reconcileUnavailableDefinitions: reconcileAvailableDefinitions,
      registry,
      services: {},
      store,
      wakeSource: new FakeWakeSource(),
      workerId: 'worker-1',
    });

    await worker.start();
    await vi.waitFor(() => expect(store.outbox.recordFailure).toHaveBeenCalledOnce());

    expect(store.outbox.recordFailure).toHaveBeenCalledWith({
      claim: outboxClaim,
      failure: failure.failure,
      retryDelayMs: POLL_INTERVAL_MS,
    });
    expect(store.outbox.markDelivered).not.toHaveBeenCalled();
    await worker.stop();
  });

  test('drains one work class until PostgreSQL reports no more eligible rows', async () => {
    const { registry } = registerStepWorkflow(async text => text);
    const store = makeStore();
    vi.mocked(store.waits.expireNext)
      .mockResolvedValueOnce({ nodeInstanceId: 'first', runId: 'run', waitId: 'wait-1' })
      .mockResolvedValueOnce({ nodeInstanceId: 'second', runId: 'run', waitId: 'wait-2' })
      .mockResolvedValue(null);
    const wakeSource = new FakeWakeSource();
    const worker = createWorkflowRuntimeWorker({
      onLoopError: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      reconcileUnavailableDefinitions: reconcileAvailableDefinitions,
      registry,
      services: {},
      store,
      wakeSource,
      workerId: 'worker-1',
    });

    await worker.start();
    await settleDrains();

    expect(store.waits.expireNext).toHaveBeenCalledTimes(3);
    await worker.stop();
  });

  test('runs claimed steps concurrently up to the configured technical capacity', async () => {
    let releaseSteps!: () => void;
    const released = new Promise<void>(resolve => {
      releaseSteps = resolve;
    });
    const startedInputs: string[] = [];
    const { definition, registry } = registerStepWorkflow(async text => {
      startedInputs.push(text);
      await released;
      return text;
    });
    const store = makeStore();
    vi.mocked(store.steps.claimNext)
      .mockResolvedValueOnce(
        makeClaim(definition, 'worker-1', {
          input: { text: 'first' },
          runId: '11111111-1111-4111-8111-111111111111',
        })
      )
      .mockResolvedValueOnce(
        makeClaim(definition, 'worker-1', {
          input: { text: 'second' },
          runId: '33333333-3333-4333-8333-333333333333',
        })
      )
      .mockResolvedValue(null);
    const worker = createWorkflowRuntimeWorker({
      onLoopError: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      reconcileUnavailableDefinitions: reconcileAvailableDefinitions,
      registry,
      services: {},
      stepConcurrency: 2,
      store,
      wakeSource: new FakeWakeSource(),
      workerId: 'worker-1',
    });

    await worker.start();
    try {
      await vi.waitFor(() => expect(startedInputs).toEqual(['first', 'second']), { timeout: 200 });
    } finally {
      releaseSteps();
      await worker.stop();
    }

    expect(store.checkpointStep).toHaveBeenCalledTimes(2);
  });

  test('claims new work as soon as one concurrency slot becomes free', async () => {
    let releaseSlowStep!: () => void;
    const slowStep = new Promise<void>(resolve => {
      releaseSlowStep = resolve;
    });
    const startedInputs: string[] = [];
    let runningCount = 0;
    let maximumRunningCount = 0;
    const { definition, registry } = registerStepWorkflow(async text => {
      startedInputs.push(text);
      runningCount += 1;
      maximumRunningCount = Math.max(maximumRunningCount, runningCount);
      if (text === 'slow') await slowStep;
      runningCount -= 1;
      return text;
    });
    const store = makeStore();
    const inputs = ['slow', 'short-1', 'short-2', 'short-3', 'next'];
    for (const [index, text] of inputs.entries()) {
      vi.mocked(store.steps.claimNext).mockResolvedValueOnce(
        makeClaim(definition, 'worker-1', {
          input: { text },
          runId: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
        })
      );
    }
    vi.mocked(store.steps.claimNext).mockResolvedValue(null);
    const worker = createWorkflowRuntimeWorker({
      onLoopError: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      reconcileUnavailableDefinitions: reconcileAvailableDefinitions,
      registry,
      services: {},
      stepConcurrency: 4,
      store,
      wakeSource: new FakeWakeSource(),
      workerId: 'worker-1',
    });

    await worker.start();
    try {
      await vi.waitFor(() => expect(startedInputs).toContain('next'), { timeout: 200 });
      expect(startedInputs[0]).toBe('slow');
      expect(maximumRunningCount).toBeLessThanOrEqual(4);
    } finally {
      releaseSlowStep();
      await worker.stop();
    }
  });

  test('does not refill capacity after stop while a claim is in flight', async () => {
    let resolveClaim!: (claim: WorkflowStepClaim) => void;
    const pendingClaim = new Promise<WorkflowStepClaim>(resolve => {
      resolveClaim = resolve;
    });
    const { definition, registry } = registerStepWorkflow(async text => text);
    const store = makeStore();
    vi.mocked(store.steps.claimNext)
      .mockImplementationOnce(() => pendingClaim)
      .mockResolvedValue(null);
    const worker = createWorkflowRuntimeWorker({
      onLoopError: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      reconcileUnavailableDefinitions: reconcileAvailableDefinitions,
      registry,
      services: {},
      stepConcurrency: 4,
      store,
      wakeSource: new FakeWakeSource(),
      workerId: 'worker-1',
    });

    await worker.start();
    await vi.waitFor(() => expect(store.steps.claimNext).toHaveBeenCalledOnce());
    const stopped = worker.stop();
    resolveClaim(makeClaim(definition, 'worker-1'));
    await stopped;

    expect(store.steps.claimNext).toHaveBeenCalledOnce();
    expect(store.checkpointStep).toHaveBeenCalledOnce();
  });

  test('drains terminal staged assets, object cleanup, and project-deletion tombstones', async () => {
    const { registry } = registerStepWorkflow(async text => text);
    const assetCleanup = makeAssetCleanup();
    vi.mocked(assetCleanup.queueNextTerminalRunAssets)
      .mockResolvedValueOnce(2)
      .mockResolvedValue(0);
    vi.mocked(assetCleanup.claimNextCleanup)
      .mockResolvedValueOnce({
        byteSize: 12,
        fencingToken: 1,
        hash: 'a'.repeat(64),
        id: 'b'.repeat(64),
        mediaType: 'image/png',
        objectPath: 'asset/object',
        workerId: 'worker-1',
      })
      .mockResolvedValue(null);
    vi.mocked(assetCleanup.claimNextQueuedObject)
      .mockResolvedValueOnce({
        fencingToken: 2,
        objectPath: 'deleted-project/object',
        workerId: 'worker-1',
      })
      .mockResolvedValue(null);
    const worker = createWorkflowRuntimeWorker({
      assetCleanup,
      onLoopError: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      reconcileUnavailableDefinitions: reconcileAvailableDefinitions,
      registry,
      services: {},
      store: makeStore(),
      wakeSource: new FakeWakeSource(),
      workerId: 'worker-1',
    });

    await worker.start();
    await settleDrains();

    await vi.waitFor(() =>
      expect(assetCleanup.queueNextTerminalRunAssets).toHaveBeenCalledTimes(4)
    );
    expect(assetCleanup.cleanup).toHaveBeenCalledOnce();
    expect(assetCleanup.cleanupQueuedObject).toHaveBeenCalledWith({
      fencingToken: 2,
      objectPath: 'deleted-project/object',
      workerId: 'worker-1',
    });
    await worker.stop();
  });

  test('stops the asset drain after a retryable Storage failure', async () => {
    const { registry } = registerStepWorkflow(async text => text);
    const assetCleanup = makeAssetCleanup();
    vi.mocked(assetCleanup.claimNextCleanup).mockResolvedValue({
      byteSize: 12,
      fencingToken: 1,
      hash: 'a'.repeat(64),
      id: 'b'.repeat(64),
      mediaType: 'image/png',
      objectPath: 'asset/object',
      workerId: 'worker-1',
    });
    vi.mocked(assetCleanup.cleanup).mockResolvedValue({ status: 'retrying' });
    const worker = createWorkflowRuntimeWorker({
      assetCleanup,
      onLoopError: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      reconcileUnavailableDefinitions: reconcileAvailableDefinitions,
      registry,
      services: {},
      store: makeStore(),
      wakeSource: new FakeWakeSource(),
      workerId: 'worker-1',
    });

    await worker.start();
    await settleDrains();

    expect(assetCleanup.claimNextCleanup).toHaveBeenCalledOnce();
    expect(assetCleanup.claimNextQueuedObject).not.toHaveBeenCalled();
    await worker.stop();
  });

  test('recovers a lost notification through mandatory polling', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async (text: string) => text.toUpperCase());
    const { definition, registry } = registerStepWorkflow(run);
    const store = makeStore();
    let eligible = false;
    vi.mocked(store.steps.claimNext).mockImplementation(async ({ workerId }) => {
      if (!eligible) return null;
      eligible = false;
      return makeClaim(definition, workerId);
    });
    const worker = createWorkflowRuntimeWorker({
      onLoopError: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      reconcileUnavailableDefinitions: reconcileAvailableDefinitions,
      registry,
      services: {},
      store,
      wakeSource: new FakeWakeSource(),
      workerId: 'worker-1',
    });

    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();

    eligible = true;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(run).toHaveBeenCalledOnce();
    expect(store.checkpointStep).toHaveBeenCalledOnce();
    await worker.stop();
  });

  test('publishes transient events only after their authoritative step checkpoint', async () => {
    const { definition, registry } = registerStepWorkflow(async text => text.toUpperCase());
    const store = makeStore();
    const claim = makeClaim(definition, 'worker-1');
    vi.mocked(store.steps.claimNext).mockResolvedValueOnce(claim).mockResolvedValue(null);
    vi.mocked(store.checkpointStep).mockResolvedValue({
      status: 'checkpointed',
      transientEvents: [
        { eventType: 'lesson.progress', payload: { stage: 'ready' }, schemaVersion: 1 },
      ],
    });
    const publishTransientEvent = vi.fn();
    const worker = createWorkflowRuntimeWorker({
      onLoopError: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      publishTransientEvent,
      reconcileUnavailableDefinitions: reconcileAvailableDefinitions,
      registry,
      services: {},
      store,
      wakeSource: new FakeWakeSource(),
      workerId: 'worker-1',
    });

    await worker.start();
    await vi.waitFor(() => expect(publishTransientEvent).toHaveBeenCalledOnce());

    expect(store.checkpointStep.mock.invocationCallOrder[0]).toBeLessThan(
      publishTransientEvent.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(publishTransientEvent).toHaveBeenCalledWith({
      eventType: 'lesson.progress',
      payload: { stage: 'ready' },
      runId: claim.runId,
      schemaVersion: 1,
      workflowId: definition.id,
    });
    await worker.stop();
  });

  test('publishes transient events produced by a terminal step failure', async () => {
    const { definition, registry } = registerStepWorkflow(async () => {
      throw failPermanently({ code: 'rejected', message: 'Rejected.' });
    });
    const store = makeStore();
    const claim = makeClaim(definition, 'worker-1');
    vi.mocked(store.steps.claimNext).mockResolvedValueOnce(claim).mockResolvedValue(null);
    vi.mocked(store.steps.recordFailure).mockResolvedValue({
      status: 'failed',
      transientEvents: [
        { eventType: 'lesson.failed', payload: { code: 'rejected' }, schemaVersion: 1 },
      ],
    });
    const publishTransientEvent = vi.fn();
    const worker = createWorkflowRuntimeWorker({
      onLoopError: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      publishTransientEvent,
      reconcileUnavailableDefinitions: reconcileAvailableDefinitions,
      registry,
      services: {},
      store,
      wakeSource: new FakeWakeSource(),
      workerId: 'worker-1',
    });

    await worker.start();
    await vi.waitFor(() => expect(publishTransientEvent).toHaveBeenCalledOnce());

    expect(publishTransientEvent).toHaveBeenCalledWith({
      eventType: 'lesson.failed',
      payload: { code: 'rejected' },
      runId: claim.runId,
      schemaVersion: 1,
      workflowId: definition.id,
    });
    await worker.stop();
  });

  test('publishes transient events produced while recovering an expired step', async () => {
    const { registry } = registerStepWorkflow(async text => text);
    const store = makeStore();
    vi.mocked(store.steps.recoverNextExpired)
      .mockResolvedValueOnce({
        nodeInstanceId: 'work',
        outcome: 'completed',
        runId: 'run-1',
        transientEvents: [
          { eventType: 'lesson.recovered', payload: { recovered: true }, schemaVersion: 1 },
        ],
        workflowId: 'runtime-worker',
      })
      .mockResolvedValue(null);
    const publishTransientEvent = vi.fn();
    const worker = createWorkflowRuntimeWorker({
      onLoopError: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      publishTransientEvent,
      reconcileUnavailableDefinitions: reconcileAvailableDefinitions,
      registry,
      services: {},
      store,
      wakeSource: new FakeWakeSource(),
      workerId: 'worker-1',
    });

    await worker.start();
    await vi.waitFor(() => expect(publishTransientEvent).toHaveBeenCalledOnce());

    expect(publishTransientEvent).toHaveBeenCalledWith({
      eventType: 'lesson.recovered',
      payload: { recovered: true },
      runId: 'run-1',
      schemaVersion: 1,
      workflowId: 'runtime-worker',
    });
    await worker.stop();
  });

  test('isolates loop errors, sanitizes the callback and waits for a future wake before retrying', async () => {
    const { registry } = registerStepWorkflow(async text => text);
    const store = makeStore();
    vi.mocked(store.steps.claimNext).mockRejectedValue(new Error('secret database detail'));
    vi.mocked(store.waits.expireNext)
      .mockResolvedValueOnce({ nodeInstanceId: 'work', runId: 'run', waitId: 'wait' })
      .mockResolvedValue(null);
    const errors: WorkflowRuntimeLoopError[] = [];
    const logEvents: WorkflowLogEvent[] = [];
    const wakeSource = new FakeWakeSource();
    const worker = createWorkflowRuntimeWorker({
      logger: { log: event => logEvents.push(event) },
      onLoopError: error => errors.push(error),
      pollIntervalMs: POLL_INTERVAL_MS,
      reconcileUnavailableDefinitions: reconcileAvailableDefinitions,
      registry,
      services: {},
      store,
      wakeSource,
      workerId: 'worker-1',
    });

    await worker.start();
    await settleDrains();

    expect(store.steps.claimNext).toHaveBeenCalledOnce();
    expect(store.waits.expireNext).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([
      {
        code: 'workflow_runtime_loop_failed',
        loop: 'step',
        message: 'A workflow runtime loop failed.',
      },
    ]);
    expect(JSON.stringify(errors)).not.toContain('secret database detail');
    expect(logEvents).toEqual([
      {
        action: 'loop-failed',
        event: 'workflow.runtime',
        failureCode: 'workflow_runtime_loop_failed',
        level: 'error',
        loop: 'step',
      },
    ]);
    expect(JSON.stringify(logEvents)).not.toContain('secret database detail');

    wakeSource.emit('step');
    await settleDrains();
    expect(store.steps.claimNext).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  test('starts and stops idempotently and ignores wakes after stop', async () => {
    const { registry } = registerStepWorkflow(async text => text);
    const store = makeStore();
    const wakeSource = new FakeWakeSource();
    const worker = createWorkflowRuntimeWorker({
      onLoopError: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      reconcileUnavailableDefinitions: reconcileAvailableDefinitions,
      registry,
      services: {},
      store,
      wakeSource,
      workerId: 'worker-1',
    });

    await Promise.all([worker.start(), worker.start()]);
    await settleDrains();
    await Promise.all([worker.stop(), worker.stop()]);
    const claimsAfterStop = vi.mocked(store.steps.claimNext).mock.calls.length;
    wakeSource.emit('all');
    await settleDrains();

    expect(wakeSource.subscribe).toHaveBeenCalledOnce();
    expect(store.steps.claimNext).toHaveBeenCalledTimes(claimsAfterStop);
  });

  test('does not subscribe or claim work when definition reconciliation fails at startup', async () => {
    const { registry } = registerStepWorkflow(async text => text);
    const store = makeStore();
    const wakeSource = new FakeWakeSource();
    const worker = createWorkflowRuntimeWorker({
      onLoopError: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      reconcileUnavailableDefinitions: async () => {
        throw new Error('reconciliation failed');
      },
      registry,
      services: {},
      store,
      wakeSource,
      workerId: 'worker-1',
    });

    await expect(worker.start()).rejects.toThrow('reconciliation failed');

    expect(wakeSource.subscribe).not.toHaveBeenCalled();
    expect(store.steps.claimNext).not.toHaveBeenCalled();
  });

  test('retains a failed wake subscription teardown so stop can retry it', async () => {
    const { registry } = registerStepWorkflow(async text => text);
    const store = makeStore();
    const unsubscribe = vi
      .fn()
      .mockRejectedValueOnce(new Error('unsubscribe failed'))
      .mockResolvedValueOnce(undefined);
    const wakeSource: WorkflowRuntimeWakeSource = {
      subscribe: vi.fn(async () => ({ unsubscribe })),
    };
    const worker = createWorkflowRuntimeWorker({
      onLoopError: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      reconcileUnavailableDefinitions: reconcileAvailableDefinitions,
      registry,
      services: {},
      store,
      wakeSource,
      workerId: 'worker-1',
    });

    await worker.start();
    await settleDrains();
    await expect(worker.stop()).rejects.toThrow('unsubscribe failed');
    await expect(worker.stop()).resolves.toBeUndefined();

    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});
