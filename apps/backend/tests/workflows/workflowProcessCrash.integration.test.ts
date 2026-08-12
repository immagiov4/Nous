import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import * as z from 'zod';

import { WorkflowExecutionDefaultsSchema } from '../../src/workflows/config.js';
import {
  createWorkflowRegistry,
  emit,
  sequence,
  step,
  workflow,
} from '../../src/workflows/definition.js';
import { materializeWorkflowStart } from '../../src/workflows/materialization.js';
import { PostgresWorkflowStore } from '../../src/workflows/postgresWorkflowStore.js';
import { failPermanently } from '../../src/workflows/retryPolicy.js';
import type { RegisteredWorkflow, WorkflowStepClaim } from '../../src/workflows/types.js';
import { reconcileUnavailableWorkflowDefinitions } from '../../src/workflows/workflowDefinitionReconciler.js';
import {
  createWorkflowRuntimeWorker,
  type WorkflowRuntimeAssetCleanup,
  type WorkflowRuntimeLoopError,
  type WorkflowRuntimeWorkerInput,
} from '../../src/workflows/workflowRuntimeWorker.js';
import { runWorkflowStepClaim } from '../../src/workflows/workflowStepRunner.js';
import { runWorkflowUndoClaim } from '../../src/workflows/workflowUndoRunner.js';
import {
  type CrashEffectServices,
  crashTestAssetStorage,
  createCrashEffectWorkflowDefinition,
  createCrashFanOutWorkflowDefinition,
  createCrashSignalWorkflowDefinition,
  createCrashUndoWorkflowDefinition,
  createCurrentDeployWorkflowDefinition,
  createPreviousDeployWorkflowDefinition,
  recordCrashEffect,
} from './workflowProcessCrash.fixture.js';

const shouldRun = process.env.RUN_WORKFLOW_INTEGRATION_TESTS === '1';
const databaseUrl = process.env.WORKFLOW_INTEGRATION_DATABASE_URL;
if (shouldRun && !databaseUrl) {
  throw new Error('WORKFLOW_INTEGRATION_DATABASE_URL is required for workflow integration tests.');
}

const PROCESS_READY_TIMEOUT_MS = 5_000;
const MULTI_PROCESS_RECOVERY_TIMEOUT_MS = PROCESS_READY_TIMEOUT_MS * 4;
const PROCESS_CRASH_SUITE_LOCK_TIMEOUT_MS = MULTI_PROCESS_RECOVERY_TIMEOUT_MS * 2;
const TEST_LEASE_MS = 60_000;
const crashFixturePath = fileURLToPath(
  new URL('./workflowProcessCrash.fixture.ts', import.meta.url)
);
const userId = randomUUID();
const projectId = `workflow-crash-${randomUUID()}`;
const sql = shouldRun && databaseUrl ? postgres(databaseUrl, { max: 3 }) : null;
let suiteLock: Awaited<ReturnType<Sql['reserve']>> | null = null;

const waitForReady = async (
  subprocess: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
): Promise<void> => {
  const reader = subprocess.stdout.getReader();
  const decoder = new TextDecoder();
  let output = '';
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        while (!output.includes('READY\n')) {
          const chunk = await reader.read();
          if (chunk.done) {
            const errorOutput = await new Response(subprocess.stderr).text();
            throw new Error(`Workflow crash fixture exited before READY. ${errorOutput}`);
          }
          output += decoder.decode(chunk.value, { stream: true });
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Workflow crash fixture did not become ready.')),
          PROCESS_READY_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    reader.releaseLock();
  }
};

const spawnCrashFixture = (
  mode: string,
  runId: string,
  environment: Readonly<Record<string, string>> = {}
) => {
  if (!databaseUrl) throw new Error('Workflow integration database is required.');
  return Bun.spawn([process.execPath, crashFixturePath], {
    env: {
      ...process.env,
      ...environment,
      WORKFLOW_CRASH_MODE: mode,
      WORKFLOW_CRASH_RUN_ID: runId,
      WORKFLOW_INTEGRATION_DATABASE_URL: databaseUrl,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
};

const killFixture = async (subprocess: Bun.Subprocess): Promise<void> => {
  subprocess.kill();
  await subprocess.exited;
};

const crashAtReady = async (
  mode: string,
  runId: string,
  environment?: Readonly<Record<string, string>>
): Promise<void> => {
  const subprocess = spawnCrashFixture(mode, runId, environment);
  try {
    await waitForReady(subprocess);
  } finally {
    await killFixture(subprocess);
  }
};

const Payload = z.object({ content: z.string() });

const createStore = (): PostgresWorkflowStore => {
  if (!sql) throw new Error('Workflow integration database is required.');
  if (!databaseUrl) throw new Error('Workflow integration database is required.');
  return new PostgresWorkflowStore({
    definitionDeploymentScope: randomUUID(),
    enforceCurrentDefinitions: false,
    listenClientFactory: () => postgres(databaseUrl, { max: 1 }),
    projectAssetStorage: crashTestAssetStorage,
    sqlClient: sql,
  });
};

type WorkflowRegistry = ReturnType<typeof createWorkflowRegistry>;

const claimNextStep = (
  store: PostgresWorkflowStore,
  registry: WorkflowRegistry,
  workerId: string
): Promise<WorkflowStepClaim | null> =>
  store.steps.claimNext({
    leaseMs: TEST_LEASE_MS,
    supportedDefinitions: registry.listRegisteredBoundaries(),
    workerId,
  });

const claimNextUndo = (
  store: PostgresWorkflowStore,
  registry: WorkflowRegistry,
  workerId: string
) =>
  store.undo.claimNext({
    leaseMs: TEST_LEASE_MS,
    supportedDefinitions: registry.listRegisteredBoundaries(),
    workerId,
  });

const crashWorkerAssetCleanup: WorkflowRuntimeAssetCleanup = {
  claimNextCleanup: async () => null,
  claimNextQueuedObject: async () => null,
  cleanup: async () => ({ status: 'deleted' }),
  cleanupQueuedObject: async () => 'deleted',
  queueNextTerminalRunAssets: async () => 0,
};

const createCrashRuntimeWorker = <Services>(input: {
  deliverNotification?: WorkflowRuntimeWorkerInput<Services>['deliverNotification'];
  registry: WorkflowRegistry;
  services: Services;
  store: PostgresWorkflowStore;
  workerId: string;
}) => {
  const loopErrors: WorkflowRuntimeLoopError[] = [];
  const worker = createWorkflowRuntimeWorker({
    assetCleanup: crashWorkerAssetCleanup,
    deliverNotification: input.deliverNotification ?? (async () => undefined),
    onLoopError: error => loopErrors.push(error),
    pollIntervalMs: TEST_LEASE_MS,
    reconcileUnavailableDefinitions: () =>
      reconcileUnavailableWorkflowDefinitions({
        registry: input.registry,
        store: input.store.definitionReconciliation,
      }).then(() => undefined),
    registry: input.registry,
    services: input.services,
    stepConcurrency: 1,
    store: input.store,
    wakeSource: input.store.wake,
    workerId: input.workerId,
  });
  return { loopErrors, worker };
};

const persistRun = async (
  store: PostgresWorkflowStore,
  definition: RegisteredWorkflow,
  input: unknown
) =>
  store.createRun({
    config: definition.executionDefaults,
    definitionHash: definition.definitionHash,
    definitionHashVersion: definition.definitionHashVersion,
    id: randomUUID(),
    input,
    materialization: materializeWorkflowStart(definition, input, {
      resolvedConfig: definition.executionDefaults,
    }),
    projectId,
    requestKey: randomUUID(),
    userId,
    workflowId: definition.id,
  });

const resolveRegisteredDefinition =
  (registry: ReturnType<typeof createWorkflowRegistry>) =>
  (workflowId: string, definitionHash: string, definitionHashVersion: number) => {
    const definition = registry.resolve(workflowId, definitionHash);
    return definition?.definitionHashVersion === definitionHashVersion
      ? (definition as RegisteredWorkflow)
      : null;
  };

const reclaimExpiredStep = async (
  store: PostgresWorkflowStore,
  registry: ReturnType<typeof createWorkflowRegistry>,
  runId: string
): Promise<WorkflowStepClaim> => {
  if (!sql) throw new Error('Workflow integration database is required.');
  await sql`
    update public.workflow_node_runs
    set lease_expires_at = clock_timestamp() - interval '1 second'
    where run_id = ${runId} and status = 'running'
  `;
  await expect(
    store.steps.recoverNextExpired({
      random: () => 0,
      resolveDefinition: resolveRegisteredDefinition(registry),
      supportedDefinitions: registry.listRegisteredBoundaries(),
    })
  ).resolves.toMatchObject({ outcome: 'retrying', runId });
  await sql`
    update public.workflow_node_runs
    set available_at = clock_timestamp()
    where run_id = ${runId} and status = 'retrying'
  `;
  const claim = await claimNextStep(store, registry, 'replacement-step-worker');
  if (!claim) throw new Error('Expected the replacement worker to reclaim the step.');
  if (claim.runId !== runId) {
    throw new Error(`Expected to reclaim workflow run ${runId}, received ${claim.runId}.`);
  }
  return claim;
};

const completedEffectServices = (): CrashEffectServices => {
  if (!sql) throw new Error('Workflow integration database is required.');
  return {
    recordEffect: input => recordCrashEffect(sql, { ...input, completed: true }),
  };
};

describe.skipIf(!shouldRun || !databaseUrl)('workflow process crash recovery', () => {
  beforeAll(async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    suiteLock = await sql.reserve();
    await suiteLock`select pg_advisory_lock(hashtext('nous-workflow-it:process-crash-suite')::bigint)`;
    await sql`
      delete from auth.users
      where id in (
        select user_id from public.projects where id like 'workflow-crash-%'
      )
    `;
    await sql`
      delete from public.workflow_definition_registry_deployments registry
      where exists (
        select 1
        from jsonb_array_elements(registry.current_manifest) deployment
        where deployment -> 'current' ->> 'workflowId' like 'process-crash-%'
      )
    `;
    await sql`
      delete from public.workflow_definition_deployments
      where workflow_id like 'process-crash-%'
    `;
    await sql`
      insert into auth.users (id, aud, role, created_at, updated_at)
      values (${userId}, 'authenticated', 'authenticated', now(), now())
    `;
    await sql`
      insert into public.projects (user_id, id, meta, updated_at, last_opened_at)
      values (${userId}, ${projectId}, '{}'::jsonb, now(), now())
    `;
    await sql`
      create table if not exists public.workflow_crash_effects (
        idempotency_key text primary key,
        run_id uuid not null references public.workflow_runs(id) on delete cascade,
        operation text not null,
        invocation_count integer not null default 1,
        completed boolean not null
      )
    `;
  }, PROCESS_CRASH_SUITE_LOCK_TIMEOUT_MS);

  afterAll(async () => {
    if (!sql) return;
    await sql`drop table if exists public.workflow_crash_effects`;
    await sql`delete from auth.users where id = ${userId}`;
    if (suiteLock) {
      await suiteLock.unsafe('select pg_advisory_unlock_all()');
      suiteLock.release();
      suiteLock = null;
    }
    await sql.end();
  });

  afterEach(async () => {
    if (!sql) return;
    await sql`delete from public.workflow_runs where user_id = ${userId}`;
  });

  test('retries a step killed during its effect with the same idempotency key', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore();
    const registry = createWorkflowRegistry();
    const definition = registry.register({
      current: createCrashEffectWorkflowDefinition(),
    }).current;
    const created = await persistRun(store, definition, { content: 'during-effect' });

    await crashAtReady('step-effect-running', created.run.id);
    expect(
      await sql`
        select completed, invocation_count
        from public.workflow_crash_effects
        where run_id = ${created.run.id}
      `
    ).toEqual([{ completed: false, invocation_count: 1 }]);

    const replacement = await reclaimExpiredStep(store, registry, created.run.id);
    expect(replacement.attemptNumber).toBe(2);
    await expect(
      runWorkflowStepClaim({
        claim: replacement,
        registry,
        services: completedEffectServices(),
        store,
      })
    ).resolves.toMatchObject({ status: 'checkpointed' });

    expect(
      await sql`
        select effect.completed, effect.invocation_count, run.status
        from public.workflow_crash_effects effect
        join public.workflow_runs run on run.id = effect.run_id
        where effect.run_id = ${created.run.id}
      `
    ).toEqual([{ completed: true, invocation_count: 2, status: 'completed' }]);
    await sql`delete from public.workflow_runs where id = ${created.run.id}`;
  });

  test('recovers a fan-out child killed after its effect and completes fan-in deterministically', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore();
    const registry = createWorkflowRegistry();
    const definition = registry.register({
      current: createCrashFanOutWorkflowDefinition(),
    }).current;
    const created = await persistRun(store, definition, { values: ['first', 'second'] });

    await crashAtReady('fanout-after-effect', created.run.id);
    expect(
      await sql`
        select completed, invocation_count
        from public.workflow_crash_effects
        where run_id = ${created.run.id}
      `
    ).toEqual([{ completed: true, invocation_count: 1 }]);

    let claim: WorkflowStepClaim | null = await reclaimExpiredStep(store, registry, created.run.id);
    while (claim) {
      await runWorkflowStepClaim({
        claim,
        registry,
        services: completedEffectServices(),
        store,
      });
      claim = await claimNextStep(store, registry, 'replacement-fanout-worker');
    }

    expect(await store.getRun({ runId: created.run.id, userId })).toMatchObject({
      output: { values: ['FIRST', 'SECOND'] },
      status: 'completed',
    });
    expect(
      await sql`
        select completed, invocation_count
        from public.workflow_crash_effects
        where run_id = ${created.run.id}
        order by invocation_count
      `
    ).toEqual([
      { completed: true, invocation_count: 1 },
      { completed: true, invocation_count: 2 },
    ]);
    await sql`delete from public.workflow_runs where id = ${created.run.id}`;
  });

  test('keeps a signal absent before receipt and replayable after committed consumption', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore();
    const registry = createWorkflowRegistry();
    const definition = registry.register({
      current: createCrashSignalWorkflowDefinition(),
    }).current;
    const created = await persistRun(store, definition, { content: 'draft' });
    const wait = (await store.getRunState({ runId: created.run.id, userId }))?.waits[0];
    if (!wait) throw new Error('Expected a durable signal wait.');
    const requestKey = randomUUID();
    const signalEnvironment = {
      WORKFLOW_CRASH_SIGNAL_REQUEST_KEY: requestKey,
      WORKFLOW_CRASH_USER_ID: userId,
      WORKFLOW_CRASH_WAIT_ID: wait.waitId,
    };

    await crashAtReady('signal-before-consume', created.run.id, signalEnvironment);
    expect(
      await sql`
        select
          (select count(*)::integer from public.workflow_signals where run_id = ${created.run.id})
            as signal_count,
          status
        from public.workflow_waits
        where id = ${wait.waitId}
      `
    ).toEqual([{ signal_count: 0, status: 'waiting' }]);

    await crashAtReady('signal-after-consume', created.run.id, signalEnvironment);
    await expect(
      store.signals.receive({
        payload: { approved: true },
        requestKey,
        resolveDefinition: () => {
          throw new Error('A committed signal replay must not need the workflow definition.');
        },
        runId: created.run.id,
        signalType: 'approve',
        userId,
        waitId: wait.waitId,
      })
    ).resolves.toEqual({ runId: created.run.id, status: 'replayed' });
    expect(await store.getRun({ runId: created.run.id, userId })).toMatchObject({
      output: { content: 'draft:true' },
      status: 'completed',
    });
    expect(
      await sql`
        select count(*)::integer as signal_count
        from public.workflow_signals
        where run_id = ${created.run.id}
      `
    ).toEqual([{ signal_count: 1 }]);
    await sql`delete from public.workflow_runs where id = ${created.run.id}`;
  });

  test('retries undo killed after its external effect without duplicating the effect', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore();
    const registry = createWorkflowRegistry();
    const definition = registry.register({
      current: createCrashUndoWorkflowDefinition(),
    }).current;
    const created = await persistRun(store, definition, { content: 'draft' });
    const reversible = await claimNextStep(store, registry, 'setup-step-worker');
    if (!reversible) throw new Error('Expected the reversible step claim.');
    await store.checkpointStep({
      claim: reversible,
      definition,
      output: { content: 'prepared' },
    });
    const failing = await claimNextStep(store, registry, 'setup-step-worker');
    if (!failing) throw new Error('Expected the terminal step claim.');
    await store.steps.recordFailure({
      claim: failing,
      definition,
      failure: failPermanently({ code: 'forced_failure', message: 'Forced failure.' }).failure,
    });
    await store.cancellation.reconcileNext();

    await crashAtReady('undo-after-effect', created.run.id);
    await sql`
      update public.workflow_undo_runs
      set lease_expires_at = clock_timestamp() - interval '1 second'
      where run_id = ${created.run.id} and status = 'running'
    `;
    await expect(
      store.undo.recoverNextExpired({
        random: () => 0,
        supportedDefinitions: [
          {
            definitionHash: '0'.repeat(64),
            definitionHashVersion: definition.definitionHashVersion,
            workflowId: definition.id,
          },
        ],
      })
    ).resolves.toBeNull();
    expect(
      await sql`
        select status, worker_id
        from public.workflow_undo_runs
        where run_id = ${created.run.id}
      `
    ).toEqual([{ status: 'running', worker_id: expect.stringMatching(/^crash-undo:/) }]);
    await expect(
      store.undo.recoverNextExpired({
        random: () => 0,
        supportedDefinitions: registry.listRegisteredBoundaries(),
      })
    ).resolves.toMatchObject({
      outcome: 'retrying',
      runId: created.run.id,
    });
    await sql`
      update public.workflow_undo_runs
      set available_at = clock_timestamp()
      where run_id = ${created.run.id} and status = 'retrying'
    `;
    const replacement = await claimNextUndo(store, registry, 'replacement-undo-worker');
    if (!replacement) throw new Error('Expected the replacement undo claim.');
    expect(replacement.attemptNumber).toBe(2);
    await expect(
      runWorkflowUndoClaim({
        claim: replacement,
        registry,
        services: completedEffectServices(),
        store: store.undo,
      })
    ).resolves.toEqual({ cleanupStatus: 'completed' });

    expect(
      await sql`
        select effect.completed, effect.invocation_count, run.cleanup_status
        from public.workflow_crash_effects effect
        join public.workflow_runs run on run.id = effect.run_id
        where effect.run_id = ${created.run.id}
      `
    ).toEqual([{ cleanup_status: 'completed', completed: true, invocation_count: 2 }]);
    await sql`delete from public.workflow_runs where id = ${created.run.id}`;
  });

  test('resumes a crashed run with its previous definition after deploy', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore();
    const previousRegistry = createWorkflowRegistry();
    const previousDefinition = previousRegistry.register({
      current: createPreviousDeployWorkflowDefinition(),
    }).current;
    const created = await persistRun(store, previousDefinition, { content: 'draft' });

    await crashAtReady('step-claimed', created.run.id);
    const deployedRegistry = createWorkflowRegistry();
    const deployed = deployedRegistry.register({
      current: createCurrentDeployWorkflowDefinition(),
      previous: createPreviousDeployWorkflowDefinition(),
    });
    expect(deployed.current.definitionHash).not.toBe(previousDefinition.definitionHash);

    const replacement = await reclaimExpiredStep(store, deployedRegistry, created.run.id);
    await expect(
      runWorkflowStepClaim({
        claim: replacement,
        registry: deployedRegistry,
        services: {},
        store,
      })
    ).resolves.toMatchObject({ status: 'checkpointed' });
    expect(await store.getRun({ runId: created.run.id, userId })).toMatchObject({
      definitionHash: previousDefinition.definitionHash,
      output: { content: 'draft:v1' },
      status: 'completed',
    });
    await sql`delete from public.workflow_runs where id = ${created.run.id}`;
  });

  test('lets only the new worker claim a new definition during a rolling deploy', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore();
    const previousRegistry = createWorkflowRegistry();
    previousRegistry.register({ current: createPreviousDeployWorkflowDefinition() });
    const deployedRegistry = createWorkflowRegistry();
    const deployed = deployedRegistry.register({
      current: createCurrentDeployWorkflowDefinition(),
      previous: createPreviousDeployWorkflowDefinition(),
    });
    const oldRuntime = createCrashRuntimeWorker({
      registry: previousRegistry,
      services: {},
      store,
      workerId: 'rolling-old-worker',
    });
    const newRuntime = createCrashRuntimeWorker({
      registry: deployedRegistry,
      services: {},
      store,
      workerId: 'rolling-new-worker',
    });
    const claimNext = vi.spyOn(store.steps, 'claimNext');
    const workflowId = deployed.current.id;

    await sql`
      delete from public.workflow_definition_deployments where workflow_id = ${workflowId}
    `;
    await reconcileUnavailableWorkflowDefinitions({
      registry: deployedRegistry,
      store: store.definitionReconciliation,
    });
    const created = await persistRun(store, deployed.current, { content: 'draft' });
    try {
      await oldRuntime.worker.start();
      await vi.waitFor(() => expect(claimNext).toHaveBeenCalled(), {
        timeout: PROCESS_READY_TIMEOUT_MS,
      });
      await expect(store.getRun({ runId: created.run.id, userId })).resolves.toMatchObject({
        status: 'queued',
      });
      expect(
        await sql`
          select worker_id
          from public.workflow_node_attempts
          where run_id = ${created.run.id}
        `
      ).toEqual([]);

      await newRuntime.worker.start();
      await vi.waitFor(
        async () => {
          expect(await store.getRun({ runId: created.run.id, userId })).toMatchObject({
            output: { content: 'draft:v2' },
            status: 'completed',
          });
        },
        { timeout: PROCESS_READY_TIMEOUT_MS }
      );
      expect(
        await sql`
          select worker_id
          from public.workflow_node_attempts
          where run_id = ${created.run.id}
        `
      ).toEqual([{ worker_id: 'rolling-new-worker' }]);
      expect(oldRuntime.loopErrors).toEqual([]);
      expect(newRuntime.loopErrors).toEqual([]);
    } finally {
      claimNext.mockRestore();
      await Promise.allSettled([oldRuntime.worker.stop(), newRuntime.worker.stop()]);
      await sql`delete from public.workflow_runs where id = ${created.run.id}`;
      await sql`
        delete from public.workflow_definition_deployments where workflow_id = ${workflowId}
      `;
    }
  });

  test('starts a replacement worker that recovers an expired process claim to completion', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore();
    const registry = createWorkflowRegistry();
    const definition = registry.register({
      current: createCurrentDeployWorkflowDefinition(),
    }).current;
    const created = await persistRun(store, definition, { content: 'crashed' });

    await crashAtReady('step-claimed', created.run.id);
    await sql`
      update public.workflow_node_runs
      set lease_expires_at = clock_timestamp() - interval '1 second'
      where run_id = ${created.run.id} and status = 'running'
    `;
    const replacement = createCrashRuntimeWorker({
      registry,
      services: {},
      store,
      workerId: 'replacement-runtime-worker',
    });

    await replacement.worker.start();
    try {
      await vi.waitFor(
        async () => {
          const nodes = await sql`
            select status
            from public.workflow_node_runs
            where run_id = ${created.run.id}
          `;
          expect(nodes).toEqual([{ status: 'retrying' }]);
        },
        { timeout: PROCESS_READY_TIMEOUT_MS }
      );
      await sql`
        update public.workflow_node_runs
        set available_at = clock_timestamp()
        where run_id = ${created.run.id} and status = 'retrying'
      `;
      await sql`select pg_notify('workflow_ready', ${created.run.id})`;

      await vi.waitFor(
        async () => {
          expect(await store.getRun({ runId: created.run.id, userId })).toMatchObject({
            output: { content: 'crashed:v2' },
            status: 'completed',
          });
        },
        { timeout: PROCESS_READY_TIMEOUT_MS }
      );
      expect(
        await sql`
          select attempt_number, status, worker_id
          from public.workflow_node_attempts
          where run_id = ${created.run.id}
          order by attempt_number
        `
      ).toEqual([
        {
          attempt_number: 1,
          status: 'lost',
          worker_id: expect.stringMatching(/^crash-step:/),
        },
        { attempt_number: 2, status: 'completed', worker_id: 'replacement-runtime-worker' },
      ]);
      expect(replacement.loopErrors).toEqual([]);
    } finally {
      await replacement.worker.stop();
    }
  });

  test(
    'recovers real process death without losing queued work or replaying a checkpointed step',
    async () => {
      if (!sql) throw new Error('Workflow integration database is required.');
      const store = createStore();
      const generate = step({
        id: 'generate',
        inputSchema: Payload,
        outputSchema: Payload,
        run: async ({ input }) => input,
      });
      const registry = createWorkflowRegistry();
      const definition = registry.register({
        current: workflow({
          compatibilityId: 'test-v1',
          configSchema: WorkflowExecutionDefaultsSchema,
          events: {
            'lesson.ready': { durability: 'durable', schema: Payload, schemaVersion: 1 },
          },
          executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
          id: 'process-crash-recovery-test',
          inputSchema: Payload,
          outputSchema: Payload,
          root: sequence({
            id: 'root',
            nodes: [
              generate,
              emit({
                event: 'lesson.ready',
                id: 'announce',
                inputSchema: Payload,
                payload: input => input,
              }),
            ],
          }),
        }),
      }).current;
      const input = { content: 'durable result' };
      const created = await store.createRun({
        config: definition.executionDefaults,
        definitionHash: definition.definitionHash,
        definitionHashVersion: definition.definitionHashVersion,
        id: randomUUID(),
        input,
        materialization: materializeWorkflowStart(definition, input, {
          resolvedConfig: definition.executionDefaults,
        }),
        projectId,
        requestKey: randomUUID(),
        userId,
        workflowId: definition.id,
      });

      await crashAtReady('before-claim', created.run.id);
      expect(
        await sql`
        select attempt_count, status
        from public.workflow_node_runs
        where run_id = ${created.run.id} and node_instance_id = 'root/generate'
      `
      ).toEqual([{ attempt_count: 0, status: 'queued' }]);

      await crashAtReady('step-claimed', created.run.id);
      await sql`
      update public.workflow_node_runs
      set lease_expires_at = clock_timestamp() - interval '1 second'
      where run_id = ${created.run.id} and node_instance_id = 'root/generate'
    `;
      expect(
        await store.steps.recoverNextExpired({
          random: () => 0,
          resolveDefinition: () => definition,
          supportedDefinitions: registry.listRegisteredBoundaries(),
        })
      ).toMatchObject({ outcome: 'retrying', runId: created.run.id });
      await sql`
      update public.workflow_node_runs
      set available_at = clock_timestamp()
      where run_id = ${created.run.id} and node_instance_id = 'root/generate'
    `;
      const recoveredClaim = await claimNextStep(store, registry, 'replacement-step-worker');
      if (!recoveredClaim) throw new Error('Expected the replacement worker to reclaim the step.');
      expect(recoveredClaim).toMatchObject({ attemptNumber: 2, runId: created.run.id });
      await store.checkpointStep({ claim: recoveredClaim, definition, output: input });

      await crashAtReady('notification-claimed', created.run.id);
      await sql`
      update public.workflow_outbox
      set lease_expires_at = clock_timestamp() - interval '1 second'
      where run_id = ${created.run.id}
    `;
      const recoveredNotification = await store.outbox.claimNext({
        leaseMs: TEST_LEASE_MS,
        workerId: 'replacement-notification-worker',
      });
      if (!recoveredNotification) {
        throw new Error('Expected the replacement worker to reclaim the notification.');
      }
      expect(recoveredNotification).toMatchObject({ attemptNumber: 2, runId: created.run.id });
      await store.outbox.markDelivered(recoveredNotification);

      const state = await sql`
      select
        run.status as run_status,
        node.attempt_count,
        node.status as node_status,
        event.attempt_count as notification_attempts,
        event.status as notification_status
      from public.workflow_runs run
      join public.workflow_node_runs node
        on node.run_id = run.id and node.node_instance_id = 'root/generate'
      join public.workflow_outbox event on event.run_id = run.id
      where run.id = ${created.run.id}
    `;
      expect(state).toEqual([
        {
          attempt_count: 2,
          node_status: 'completed',
          notification_attempts: 2,
          notification_status: 'delivered',
          run_status: 'completed',
        },
      ]);
      expect(await claimNextStep(store, registry, 'probe-worker')).toBeNull();
      await sql`delete from public.workflow_runs where id = ${created.run.id}`;
    },
    MULTI_PROCESS_RECOVERY_TIMEOUT_MS
  );
});
