import type { ProjectAssetCleanupClaim } from '../../projects/projectAsset.js';
import type { ProjectAssetDeletionClaim } from '../../projects/projectAssetDeletionQueue.js';
import type {
  PostgresWorkflowOutboxStore,
  WorkflowOutboxClaim,
} from '../postgresWorkflowOutboxStore.js';
import type { ExpiredStepRecoveryResult } from '../postgresWorkflowStepStore.js';
import type { WorkflowUndoClaim } from '../postgresWorkflowUndoStore.js';
import { WorkflowStepError } from '../retryPolicy.js';
import type {
  RegisteredWorkflow,
  WorkflowDefinitionBoundary,
  WorkflowStepClaim,
} from '../types.js';
import { WorkflowOutboxLeaseLostError } from '../workflowErrors.js';
import {
  consoleWorkflowLogger,
  emitWorkflowLog,
  publishWorkflowTransientEvents,
  WORKFLOW_RUNTIME_LOOP_FAILURE_CODE,
  type WorkflowLogger,
  type WorkflowRuntimeLoop as WorkflowRuntimeLoopType,
  type WorkflowTransientEventPublisher,
} from '../workflowObservability.js';
import { startWorkflowAttemptMonitor } from '../workflowStepAttempt.js';
import type { WorkflowDefinitionResolver } from '../workflowStepResolution.js';
import {
  DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MS,
  DEFAULT_WORKFLOW_LEASE_MS,
  runWorkflowStepClaim,
  type WorkflowStepRunnerStore,
} from '../workflowStepRunner.js';
import { runWorkflowUndoClaim, type WorkflowUndoRunnerStore } from '../workflowUndoRunner.js';

export type WorkflowRuntimeLoop = WorkflowRuntimeLoopType;

export type WorkflowRuntimeWake = 'all' | WorkflowRuntimeLoop;

export interface WorkflowRuntimeWakeSubscription {
  unsubscribe(): Promise<void>;
}

export interface WorkflowRuntimeWakeSource {
  subscribe(
    listener: (wake: WorkflowRuntimeWake) => void
  ): Promise<WorkflowRuntimeWakeSubscription>;
}

export interface WorkflowRuntimeLoopError {
  code: typeof WORKFLOW_RUNTIME_LOOP_FAILURE_CODE;
  loop: WorkflowRuntimeLoop;
  message: 'A workflow runtime loop failed.';
}

export interface WorkflowRuntimeAssetCleanup {
  claimNextCleanup(input: {
    leaseMs: number;
    workerId: string;
  }): Promise<ProjectAssetCleanupClaim | null>;
  claimNextQueuedObject(input: {
    leaseMs: number;
    workerId: string;
  }): Promise<ProjectAssetDeletionClaim | null>;
  cleanup(claim: ProjectAssetCleanupClaim): Promise<{ status: 'deleted' | 'retrying' }>;
  cleanupQueuedObject(claim: ProjectAssetDeletionClaim): Promise<'deleted' | 'retrying'>;
  queueNextTerminalRunAssets(): Promise<number>;
}

const WORKFLOW_RUNTIME_LOOP_FAILURE_MESSAGE = 'A workflow runtime loop failed.' as const;

export interface WorkflowRuntimeStore extends WorkflowStepRunnerStore {
  cancellation: WorkflowStepRunnerStore['cancellation'] & {
    reconcileNext(): Promise<object | null>;
  };
  outbox: Pick<
    PostgresWorkflowOutboxStore,
    'claimNext' | 'heartbeat' | 'markDelivered' | 'recordFailure'
  >;
  steps: WorkflowStepRunnerStore['steps'] & {
    claimNext(input: {
      leaseMs: number;
      supportedDefinitions: readonly WorkflowDefinitionBoundary[];
      workerId: string;
    }): Promise<WorkflowStepClaim | null>;
    recoverNextExpired(input: {
      resolveDefinition: (
        workflowId: string,
        definitionHash: string,
        definitionHashVersion: number
      ) => RegisteredWorkflow | null;
      supportedDefinitions: readonly WorkflowDefinitionBoundary[];
    }): Promise<ExpiredStepRecoveryResult | null>;
  };
  undo: WorkflowUndoRunnerStore & {
    claimNext(input: {
      leaseMs: number;
      supportedDefinitions: readonly WorkflowDefinitionBoundary[];
      workerId: string;
    }): Promise<WorkflowUndoClaim | null>;
    recoverNextExpired(input: {
      supportedDefinitions: readonly WorkflowDefinitionBoundary[];
    }): Promise<object | null>;
    requeueFailed(input: {
      supportedDefinitions: readonly WorkflowDefinitionBoundary[];
    }): Promise<number>;
  };
  waits: {
    expireNext(): Promise<object | null>;
  };
}

export interface WorkflowRuntimeRegistry extends WorkflowDefinitionResolver {
  listRegisteredBoundaries(): readonly WorkflowDefinitionBoundary[];
}

export interface WorkflowRuntimeWorkerInput<Services> {
  assetCleanup: WorkflowRuntimeAssetCleanup;
  deliverNotification(claim: WorkflowOutboxClaim): Promise<void>;
  logger?: WorkflowLogger;
  onLoopError(error: WorkflowRuntimeLoopError): void;
  pollIntervalMs: number;
  publishTransientEvent?: WorkflowTransientEventPublisher;
  reconcileUnavailableDefinitions(): Promise<void>;
  registry: WorkflowRuntimeRegistry;
  services: Services;
  stepConcurrency: number;
  store: WorkflowRuntimeStore;
  wakeSource: WorkflowRuntimeWakeSource;
  workerId: string;
}

interface RuntimeLoopState {
  pending: boolean;
  running: Promise<void> | null;
}

const RUNTIME_LOOPS: readonly WorkflowRuntimeLoop[] = [
  'asset-cleanup',
  'notification',
  'step',
  'undo',
  'step-recovery',
  'undo-recovery',
  'wait-expiry',
  'cancellation-reconciliation',
];

const createLoopStates = (): Record<WorkflowRuntimeLoop, RuntimeLoopState> => ({
  'asset-cleanup': { pending: false, running: null },
  'cancellation-reconciliation': { pending: false, running: null },
  notification: { pending: false, running: null },
  step: { pending: false, running: null },
  'step-recovery': { pending: false, running: null },
  undo: { pending: false, running: null },
  'undo-recovery': { pending: false, running: null },
  'wait-expiry': { pending: false, running: null },
});

const assertPositiveInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
};

const throwFirstRejection = (results: readonly PromiseSettledResult<unknown>[]): void => {
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
};

const assertWorkerInput = (
  workerId: string,
  pollIntervalMs: number,
  stepConcurrency: number
): void => {
  if (!workerId.trim()) throw new Error('workerId is required.');
  assertPositiveInteger(pollIntervalMs, 'pollIntervalMs');
  assertPositiveInteger(stepConcurrency, 'stepConcurrency');
};

export class WorkflowRuntimeWorker<Services> {
  private active = false;
  private readonly loopStates = createLoopStates();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private subscription: WorkflowRuntimeWakeSubscription | null = null;

  constructor(private readonly input: WorkflowRuntimeWorkerInput<Services>) {
    assertWorkerInput(input.workerId, input.pollIntervalMs, input.stepConcurrency);
  }

  async start(): Promise<void> {
    if (this.stopPromise) await this.stopPromise;
    if (this.subscription && !this.active) await this.stop();
    if (this.active) return;
    if (this.startPromise) return this.startPromise;

    const startPromise = this.startInternal();
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    const stopPromise = this.stopInternal();
    this.stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) this.stopPromise = null;
    }
  }

  private async startInternal(): Promise<void> {
    await this.input.reconcileUnavailableDefinitions();
    await this.input.store.undo.requeueFailed({
      supportedDefinitions: this.input.registry.listRegisteredBoundaries(),
    });
    const subscription = await this.input.wakeSource.subscribe(wake => this.wake(wake));
    this.subscription = subscription;
    this.active = true;
    this.pollTimer = setInterval(() => this.wake('all'), this.input.pollIntervalMs);
    this.wake('all');
  }

  private async stopInternal(): Promise<void> {
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        return;
      }
    }
    if (!this.active && !this.subscription) return;

    this.active = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    const subscription = this.subscription;
    const drains = RUNTIME_LOOPS.flatMap(loop => {
      const running = this.loopStates[loop].running;
      return running ? [running] : [];
    });
    let unsubscribeFailure: unknown;
    if (subscription) {
      try {
        await subscription.unsubscribe();
        if (this.subscription === subscription) this.subscription = null;
      } catch (error) {
        unsubscribeFailure = error;
      }
    }
    const results = await Promise.allSettled(drains);
    if (unsubscribeFailure) throw unsubscribeFailure;
    throwFirstRejection(results);
  }

  private wake(wake: WorkflowRuntimeWake): void {
    if (!this.active) return;
    if (wake === 'all') {
      for (const loop of RUNTIME_LOOPS) this.requestDrain(loop);
      return;
    }
    this.requestDrain(wake);
  }

  private requestDrain(loop: WorkflowRuntimeLoop): void {
    const state = this.loopStates[loop];
    state.pending = true;
    if (state.running) return;

    const running = this.drain(loop, state).finally(() => {
      if (state.running === running) state.running = null;
      if (this.active && state.pending) this.requestDrain(loop);
    });
    state.running = running;
  }

  private async drain(loop: WorkflowRuntimeLoop, state: RuntimeLoopState): Promise<void> {
    do {
      state.pending = false;
      try {
        while (this.active && (await this.runOnce(loop))) {
          // PostgreSQL owns eligibility; drain until its atomic claim returns null.
        }
      } catch {
        state.pending = false;
        this.reportLoopError(loop);
        return;
      }
    } while (this.active && state.pending);
  }

  private async runOnce(loop: WorkflowRuntimeLoop): Promise<boolean> {
    switch (loop) {
      case 'asset-cleanup':
        return this.runAssetCleanup();
      case 'notification':
        return this.runNotification();
      case 'step':
        return this.runStepBatch();
      case 'undo':
        return this.runUndo();
      case 'step-recovery':
        return this.runStepRecovery();
      case 'undo-recovery':
        return (
          (await this.input.store.undo.recoverNextExpired({
            supportedDefinitions: this.input.registry.listRegisteredBoundaries(),
          })) !== null
        );
      case 'wait-expiry':
        return (await this.input.store.waits.expireNext()) !== null;
      case 'cancellation-reconciliation':
        return (await this.input.store.cancellation.reconcileNext()) !== null;
    }
  }

  private async runAssetCleanup(): Promise<boolean> {
    if ((await this.input.assetCleanup.queueNextTerminalRunAssets()) > 0) return true;
    const claim = await this.input.assetCleanup.claimNextCleanup({
      leaseMs: DEFAULT_WORKFLOW_LEASE_MS,
      workerId: this.input.workerId,
    });
    if (claim) return (await this.input.assetCleanup.cleanup(claim)).status === 'deleted';

    const deletionClaim = await this.input.assetCleanup.claimNextQueuedObject({
      leaseMs: DEFAULT_WORKFLOW_LEASE_MS,
      workerId: this.input.workerId,
    });
    if (!deletionClaim) return false;
    return (await this.input.assetCleanup.cleanupQueuedObject(deletionClaim)) === 'deleted';
  }

  private async runNotification(): Promise<boolean> {
    const claim = await this.input.store.outbox.claimNext({
      leaseMs: DEFAULT_WORKFLOW_LEASE_MS,
      workerId: this.input.workerId,
    });
    if (!claim) return false;

    const controller = new AbortController();
    const monitor = startWorkflowAttemptMonitor({
      controller,
      heartbeat: () =>
        this.input.store.outbox.heartbeat({
          claim,
          leaseMs: DEFAULT_WORKFLOW_LEASE_MS,
        }),
      heartbeatIntervalMs: DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MS,
      interruptionError: () => new WorkflowOutboxLeaseLostError(),
      leaseMs: DEFAULT_WORKFLOW_LEASE_MS,
    });
    let deliveryError: unknown;
    let deliveryFailed = false;
    try {
      await this.input.deliverNotification(claim);
    } catch (error) {
      deliveryError = error;
      deliveryFailed = true;
    }
    if (await monitor.stop()) return false;

    if (deliveryFailed) {
      await this.input.store.outbox.recordFailure({
        claim,
        failure:
          deliveryError instanceof WorkflowStepError
            ? deliveryError.failure
            : {
                code: 'notification_delivery_failed',
                kind: 'operational',
                message: 'The durable notification could not be delivered.',
              },
        retryDelayMs: this.input.pollIntervalMs,
      });
      return false;
    }
    await this.input.store.outbox.markDelivered(claim);
    return true;
  }

  private async runStep(claim: WorkflowStepClaim): Promise<void> {
    const result = await runWorkflowStepClaim({
      claim,
      registry: this.input.registry,
      services: this.input.services,
      store: this.input.store,
    });
    if ('transientEvents' in result) {
      publishWorkflowTransientEvents(
        this.input.publishTransientEvent,
        { runId: claim.runId, workflowId: claim.workflowId },
        result.transientEvents
      );
    }
  }

  private async runStepBatch(): Promise<boolean> {
    const failures: unknown[] = [];
    const runningSteps = new Set<Promise<void>>();
    const supportedDefinitions = this.input.registry.listRegisteredBoundaries();
    let claimedAny = false;

    while (this.active) {
      while (
        this.active &&
        runningSteps.size < this.input.stepConcurrency &&
        failures.length === 0
      ) {
        let claim: WorkflowStepClaim | null = null;
        try {
          claim = await this.input.store.steps.claimNext({
            leaseMs: DEFAULT_WORKFLOW_LEASE_MS,
            supportedDefinitions,
            workerId: this.input.workerId,
          });
        } catch (error) {
          failures.push(error);
        }
        if (!claim) break;

        claimedAny = true;
        let execution: Promise<void>;
        execution = this.runStep(claim)
          .catch(error => {
            failures.push(error);
          })
          .finally(() => runningSteps.delete(execution));
        runningSteps.add(execution);
      }

      if (failures.length > 0) {
        await Promise.all(runningSteps);
        throw failures[0];
      }
      if (runningSteps.size === 0) return claimedAny;
      await Promise.race(runningSteps);
    }

    await Promise.all(runningSteps);
    if (failures.length > 0) throw failures[0];
    return claimedAny;
  }

  private async runStepRecovery(): Promise<boolean> {
    const result = await this.input.store.steps.recoverNextExpired({
      resolveDefinition: (workflowId, definitionHash, definitionHashVersion) =>
        this.resolveRegisteredDefinition(workflowId, definitionHash, definitionHashVersion),
      supportedDefinitions: this.input.registry.listRegisteredBoundaries(),
    });
    if (!result) return false;
    if (!result.transientEvents || !result.workflowId) return true;
    publishWorkflowTransientEvents(
      this.input.publishTransientEvent,
      { runId: result.runId, workflowId: result.workflowId },
      result.transientEvents
    );
    return true;
  }

  private async runUndo(): Promise<boolean> {
    const claim = await this.input.store.undo.claimNext({
      leaseMs: DEFAULT_WORKFLOW_LEASE_MS,
      supportedDefinitions: this.input.registry.listRegisteredBoundaries(),
      workerId: this.input.workerId,
    });
    if (!claim) return false;
    await runWorkflowUndoClaim({
      claim,
      registry: this.input.registry,
      services: this.input.services,
      store: this.input.store.undo,
    });
    return true;
  }

  private resolveRegisteredDefinition(
    workflowId: string,
    definitionHash: string,
    definitionHashVersion: number
  ): RegisteredWorkflow | null {
    const definition = this.input.registry.resolve(workflowId, definitionHash);
    return definition?.definitionHashVersion === definitionHashVersion
      ? (definition as RegisteredWorkflow)
      : null;
  }

  private reportLoopError(loop: WorkflowRuntimeLoop): void {
    emitWorkflowLog(this.input.logger ?? consoleWorkflowLogger, {
      action: 'loop-failed',
      entity: 'runtime',
      loop,
    });
    try {
      this.input.onLoopError({
        code: WORKFLOW_RUNTIME_LOOP_FAILURE_CODE,
        loop,
        message: WORKFLOW_RUNTIME_LOOP_FAILURE_MESSAGE,
      });
    } catch {
      // Observability must not take down the authoritative worker loop.
    }
  }
}

export const createWorkflowRuntimeWorker = <Services>(
  input: WorkflowRuntimeWorkerInput<Services>
): WorkflowRuntimeWorker<Services> => new WorkflowRuntimeWorker(input);
