import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as z from 'zod';
import { WorkflowExecutionDefaultsSchema } from '../../src/workflows/config.js';
import { createWorkflowRegistry, waitForSignal, workflow } from '../../src/workflows/definition.js';
import { materializeWorkflowStart } from '../../src/workflows/materialization.js';
import { failPermanently } from '../../src/workflows/retryPolicy.js';
import { reconcileUnavailableWorkflowDefinitions } from '../../src/workflows/workflowDefinitionReconciler.js';
import type { WorkflowSignalError } from '../../src/workflows/workflowErrors.js';
import {
  claimNextStep,
  createPostgresWorkflowIntegrationContext,
  createStore,
  definitionBoundary,
  Payload,
  POSTGRES_WORKFLOW_TEST_LOCK,
  registeredStepWorkflow,
  setupPostgresWorkflowIntegrationContext,
  teardownPostgresWorkflowIntegrationContext,
  withPostgresWorkflowTestLock,
} from './postgresWorkflowStore.integration.fixture.js';

const ApprovalSignal = z.object({ approved: z.literal(true) });
const context = createPostgresWorkflowIntegrationContext();
const { projectId, sql, userId } = context;

describe.skipIf(!context.enabled)('PostgresWorkflowStore signal and recovery integration', () => {
  beforeAll(() => setupPostgresWorkflowIntegrationContext(context));
  afterAll(() => teardownPostgresWorkflowIntegrationContext(context));

  test('consumes a typed signal once and replays the same request idempotently', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql);
    const definition = createWorkflowRegistry().register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'signal-test',
        inputSchema: Payload,
        outputSchema: Payload,
        root: waitForSignal({
          id: 'approval',
          inputSchema: Payload,
          outputSchema: Payload,
          payloadSchema: ApprovalSignal,
          resume: (input, signal) => ({
            content: `${input.content}:${signal.approved}`,
          }),
          signal: 'approve',
        }),
        signals: { approve: { schema: ApprovalSignal, schemaVersion: 2 } },
      }),
    }).current;
    const materialization = materializeWorkflowStart(
      definition,
      { content: 'draft' },
      {
        resolvedConfig: definition.executionDefaults,
      }
    );
    const wait = materialization.waits[0];
    if (!wait) throw new Error('Expected an approval wait.');
    const created = await store.createRun({
      config: definition.executionDefaults,
      definitionHash: definition.definitionHash,
      definitionHashVersion: definition.definitionHashVersion,
      id: randomUUID(),
      input: { content: 'draft' },
      materialization,
      projectId,
      requestKey: randomUUID(),
      userId,
      workflowId: definition.id,
    });
    const requestKey = randomUUID();
    const signal = {
      payload: { approved: true, ignored: 'not persisted' },
      requestKey,
      resolveDefinition: () => definition,
      runId: created.run.id,
      signalType: 'approve',
      userId,
      waitId: wait.waitId,
    };

    const reconnected = await store.getRunState({ runId: created.run.id, userId });
    expect(reconnected?.waits).toEqual([
      expect.objectContaining({
        nodeInstanceId: 'approval',
        schemaVersion: 2,
        signalType: 'approve',
        waitId: wait.waitId,
      }),
    ]);

    await expect(store.signals.receive({ ...signal, runId: randomUUID() })).rejects.toMatchObject<
      Partial<WorkflowSignalError>
    >({ code: 'workflow_wait_unknown' });
    await expect(
      store.signals.receive({
        ...signal,
        resolveDefinition: () => {
          throw new Error('A foreign wait must not resolve its workflow definition.');
        },
        userId: randomUUID(),
      })
    ).rejects.toMatchObject<Partial<WorkflowSignalError>>({ code: 'workflow_wait_unknown' });
    await sql`
      update public.workflow_waits
      set signal_schema_version = 1
      where id = ${wait.waitId}
    `;
    await expect(
      store.signals.receive({ ...signal, requestKey: randomUUID() })
    ).rejects.toMatchObject<Partial<WorkflowSignalError>>({ code: 'workflow_wait_obsolete' });
    await sql`
      update public.workflow_waits
      set signal_schema_version = 2
      where id = ${wait.waitId}
    `;
    const concurrentResults = await Promise.all([
      store.signals.receive(signal),
      store.signals.receive(signal),
    ]);
    expect(concurrentResults.map(result => result.status).sort()).toEqual(['consumed', 'replayed']);
    expect(await store.signals.receive({ ...signal, resolveDefinition: () => null })).toEqual({
      runId: created.run.id,
      status: 'replayed',
    });
    await expect(
      store.signals.receive({
        ...signal,
        payload: { approved: true, ignored: 'different request' },
        resolveDefinition: () => null,
      })
    ).rejects.toMatchObject<Partial<WorkflowSignalError>>({
      code: 'workflow_signal_request_conflict',
    });
    await expect(
      store.signals.receive({ ...signal, requestKey: randomUUID() })
    ).rejects.toMatchObject<Partial<WorkflowSignalError>>({ code: 'workflow_wait_obsolete' });

    const state = await sql`
      select
        run.output,
        run.status as run_status,
        signal.payload,
        signal.request_payload,
        signal.signal_schema_version as signal_version,
        wait.signal_schema_version as wait_version,
        wait.status as wait_status
      from public.workflow_runs run
      join public.workflow_waits wait on wait.run_id = run.id
      join public.workflow_signals signal on signal.wait_id = wait.id
      where run.id = ${created.run.id}
    `;
    expect(state).toEqual([
      {
        output: { content: 'draft:true' },
        payload: { approved: true },
        request_payload: { approved: true, ignored: 'not persisted' },
        run_status: 'completed',
        signal_version: 2,
        wait_status: 'consumed',
        wait_version: 2,
      },
    ]);
    await sql`delete from public.workflow_runs where id = ${created.run.id}`;
  });

  test('returns a retryable replica error when an old API receives a signal for a new run', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const workflowId = 'rolling-signal-definition-test';
    const makeDefinition = (compatibilityId: string) =>
      workflow({
        compatibilityId,
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: workflowId,
        inputSchema: Payload,
        outputSchema: Payload,
        root: waitForSignal({
          id: 'approval',
          inputSchema: Payload,
          outputSchema: Payload,
          payloadSchema: ApprovalSignal,
          resume: input => input,
          signal: 'approve',
        }),
        signals: { approve: { schema: ApprovalSignal, schemaVersion: 1 } },
      });
    const previousDefinition = makeDefinition('previous');
    const currentDefinition = makeDefinition('current');
    const oldRegistry = createWorkflowRegistry();
    const old = oldRegistry.register({ current: previousDefinition });
    const deployedRegistry = createWorkflowRegistry();
    const deployed = deployedRegistry.register({
      current: currentDefinition,
      previous: previousDefinition,
    });
    const store = createStore(sql, { enforceCurrentDefinitions: true });
    await sql`
      delete from public.workflow_definition_deployments where workflow_id = ${workflowId}
    `;
    await reconcileUnavailableWorkflowDefinitions({
      registry: oldRegistry,
      store: store.definitionReconciliation,
    });
    await reconcileUnavailableWorkflowDefinitions({
      registry: deployedRegistry,
      store: store.definitionReconciliation,
    });
    const materialization = materializeWorkflowStart(
      deployed.current,
      { content: 'draft' },
      { resolvedConfig: deployed.current.executionDefaults }
    );
    const wait = materialization.waits[0];
    if (!wait) throw new Error('Expected an approval wait.');
    const created = await store.createRun({
      config: deployed.current.executionDefaults,
      definitionHash: deployed.current.definitionHash,
      definitionHashVersion: deployed.current.definitionHashVersion,
      id: randomUUID(),
      input: { content: 'draft' },
      materialization,
      projectId,
      requestKey: randomUUID(),
      userId,
      workflowId,
    });
    const signal = {
      payload: { approved: true },
      requestKey: randomUUID(),
      runId: created.run.id,
      signalType: 'approve',
      userId,
      waitId: wait.waitId,
    };

    await expect(
      store.signals.receive({
        ...signal,
        resolveDefinition: boundary =>
          oldRegistry.resolve(boundary.workflowId, boundary.definitionHash),
      })
    ).rejects.toMatchObject({ name: 'WorkflowReplicaOutdatedError' });
    await expect(
      store.signals.receive({
        ...signal,
        resolveDefinition: boundary =>
          deployedRegistry.resolve(boundary.workflowId, boundary.definitionHash),
      })
    ).resolves.toMatchObject({ status: 'consumed' });
    expect(old.current.definitionHash).not.toBe(deployed.current.definitionHash);
    await sql`delete from public.workflow_runs where id = ${created.run.id}`;
    await sql`
      delete from public.workflow_definition_deployments where workflow_id = ${workflowId}
    `;
  });

  test('consumes a signal declared only by a nested workflow', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql);
    const nested = workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'approval-flow',
      inputSchema: Payload,
      outputSchema: Payload,
      root: waitForSignal({
        id: 'approval',
        inputSchema: Payload,
        outputSchema: Payload,
        payloadSchema: ApprovalSignal,
        resume: (input, signal) => ({
          content: `${input.content}:${signal.approved}`,
        }),
        signal: 'approve',
      }),
      signals: { approve: { schema: ApprovalSignal, schemaVersion: 1 } },
    });
    const definition = createWorkflowRegistry().register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'nested-signal-test',
        inputSchema: Payload,
        outputSchema: Payload,
        root: nested,
      }),
    }).current;
    const materialization = materializeWorkflowStart(
      definition,
      { content: 'draft' },
      { resolvedConfig: definition.executionDefaults }
    );
    const wait = materialization.waits[0];
    if (!wait) throw new Error('Expected a nested approval wait.');
    const created = await store.createRun({
      config: definition.executionDefaults,
      definitionHash: definition.definitionHash,
      definitionHashVersion: definition.definitionHashVersion,
      id: randomUUID(),
      input: { content: 'draft' },
      materialization,
      projectId,
      requestKey: randomUUID(),
      userId,
      workflowId: definition.id,
    });

    await expect(
      store.signals.receive({
        payload: { approved: true, ignored: 'not persisted' },
        requestKey: randomUUID(),
        resolveDefinition: () => definition,
        runId: created.run.id,
        signalType: 'approve',
        userId,
        waitId: wait.waitId,
      })
    ).resolves.toMatchObject({ runId: created.run.id, status: 'consumed' });

    const state = await sql`
      select run.output, run.status as run_status, signal.payload
      from public.workflow_runs run
      join public.workflow_signals signal on signal.run_id = run.id
      where run.id = ${created.run.id}
    `;
    expect(state).toEqual([
      {
        output: { content: 'draft:true' },
        payload: { approved: true },
        run_status: 'completed',
      },
    ]);
    await sql`delete from public.workflow_runs where id = ${created.run.id}`;
  });

  test('fails an unanswered wait at startup when its resumable definition was removed', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql);
    const workflowId = 'removed-wait-definition-test';
    const previousDefinition = workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: workflowId,
      inputSchema: Payload,
      outputSchema: Payload,
      root: waitForSignal({
        id: 'approval',
        inputSchema: Payload,
        outputSchema: Payload,
        payloadSchema: ApprovalSignal,
        resume: input => input,
        signal: 'approve',
      }),
      signals: { approve: { schema: ApprovalSignal, schemaVersion: 1 } },
    });
    const currentDefinition = registeredStepWorkflow(workflowId, 'replacement');
    const previousRegistry = createWorkflowRegistry();
    const previous = previousRegistry.register({ current: previousDefinition });
    const deployedRegistry = createWorkflowRegistry();
    deployedRegistry.register({
      current: currentDefinition,
      previous: previousDefinition,
    });
    const killSwitchRegistry = createWorkflowRegistry();
    killSwitchRegistry.register({ current: currentDefinition });
    await sql`
      delete from public.workflow_definition_deployments where workflow_id = ${workflowId}
    `;
    await reconcileUnavailableWorkflowDefinitions({
      registry: previousRegistry,
      store: store.definitionReconciliation,
    });
    const definition = previous.current;
    const created = await store.createRun({
      config: definition.executionDefaults,
      definitionHash: definition.definitionHash,
      definitionHashVersion: definition.definitionHashVersion,
      id: randomUUID(),
      input: { content: 'draft' },
      materialization: materializeWorkflowStart(
        definition,
        { content: 'draft' },
        {
          resolvedConfig: definition.executionDefaults,
        }
      ),
      projectId,
      requestKey: randomUUID(),
      userId,
      workflowId: definition.id,
    });

    await reconcileUnavailableWorkflowDefinitions({
      registry: deployedRegistry,
      store: store.definitionReconciliation,
    });
    const failedRunIds = await reconcileUnavailableWorkflowDefinitions({
      registry: killSwitchRegistry,
      store: store.definitionReconciliation,
    });

    expect(failedRunIds).toContain(created.run.id);
    const state = await sql`
      select
        run.status as run_status,
        run.cleanup_status,
        run.error ->> 'code' as run_error,
        node.status as node_status,
        wait.status as wait_status
      from public.workflow_runs run
      join public.workflow_node_runs node on node.run_id = run.id
      join public.workflow_waits wait on wait.run_id = run.id
      where run.id = ${created.run.id}
    `;
    expect(state).toEqual([
      {
        cleanup_status: 'not-required',
        node_status: 'cancelled',
        run_error: 'workflow_definition_unavailable',
        run_status: 'failed',
        wait_status: 'cancelled',
      },
    ]);
    await sql`delete from public.workflow_runs where id = ${created.run.id}`;
    await sql`
      delete from public.workflow_definition_deployments where workflow_id = ${workflowId}
    `;
  });

  test('cancels an owned attempt and terminalizes the run only after workers release it', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    await withPostgresWorkflowTestLock(
      sql,
      POSTGRES_WORKFLOW_TEST_LOCK.terminalReconciliation,
      async () => {
        const store = createStore(sql);
        const definition = registeredStepWorkflow('cancellation-test', 'generate');
        const created = await store.createRun({
          config: definition.executionDefaults,
          definitionHash: definition.definitionHash,
          definitionHashVersion: definition.definitionHashVersion,
          id: randomUUID(),
          input: { content: 'draft' },
          materialization: materializeWorkflowStart(
            definition,
            { content: 'draft' },
            {
              resolvedConfig: definition.executionDefaults,
            }
          ),
          projectId,
          requestKey: randomUUID(),
          userId,
          workflowId: definition.id,
        });
        const claim = await claimNextStep(store, definition, 'worker-cancel');
        if (!claim) throw new Error('Expected a workflow claim.');

        expect(await store.cancellation.request({ runId: created.run.id, userId })).toEqual({
          runStatus: 'running',
          status: 'requested',
        });
        expect(await store.steps.heartbeat({ claim, leaseMs: 60_000 })).toEqual({
          status: 'cancelled',
        });
        expect(await store.cancellation.reconcileNext()).toBeNull();
        await store.cancellation.releaseClaim(claim);
        expect(await store.cancellation.reconcileNext()).toEqual({
          cleanupStatus: 'not-required',
          runId: created.run.id,
          runStatus: 'cancelled',
        });

        const state = await sql`
      select run.status as run_status, node.status as node_status, attempt.status as attempt_status
      from public.workflow_runs run
      join public.workflow_node_runs node on node.run_id = run.id
      join public.workflow_node_attempts attempt
        on attempt.run_id = node.run_id and attempt.node_instance_id = node.node_instance_id
      where run.id = ${created.run.id}
    `;
        expect(state).toEqual([
          { attempt_status: 'cancelled', node_status: 'cancelled', run_status: 'cancelled' },
        ]);
        await sql`delete from public.workflow_runs where id = ${created.run.id}`;
      }
    );
  });

  test('expires an unanswered wait instead of leaving the run blocked forever', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql);
    const definition = createWorkflowRegistry().register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'wait-expiry-test',
        inputSchema: Payload,
        outputSchema: Payload,
        root: waitForSignal({
          id: 'approval',
          inputSchema: Payload,
          outputSchema: Payload,
          payloadSchema: z.object({ approved: z.boolean() }),
          resume: input => input,
          signal: 'approve',
        }),
        signals: {
          approve: { schema: z.object({ approved: z.boolean() }), schemaVersion: 1 },
        },
      }),
    }).current;
    const materialization = materializeWorkflowStart(
      definition,
      { content: 'draft' },
      {
        resolvedConfig: definition.executionDefaults,
      }
    );
    const created = await store.createRun({
      config: definition.executionDefaults,
      definitionHash: definition.definitionHash,
      definitionHashVersion: definition.definitionHashVersion,
      id: randomUUID(),
      input: { content: 'draft' },
      materialization,
      projectId,
      requestKey: randomUUID(),
      userId,
      workflowId: definition.id,
    });
    await sql`
      update public.workflow_waits
      set created_at = clock_timestamp() - interval '2 hours',
          expires_at = clock_timestamp() - interval '1 second'
      where run_id = ${created.run.id}
    `;

    expect(await store.waits.expireNext()).toMatchObject({ runId: created.run.id });
    const state = await sql`
      select run.status as run_status, node.status as node_status, wait.status as wait_status
      from public.workflow_runs run
      join public.workflow_node_runs node on node.run_id = run.id
      join public.workflow_waits wait on wait.run_id = run.id
      where run.id = ${created.run.id}
    `;
    expect(state).toEqual([
      { node_status: 'cancelled', run_status: 'expired', wait_status: 'expired' },
    ]);
    await sql`delete from public.workflow_runs where id = ${created.run.id}`;
  });

  test('recovers only an expired lease and invalidates the previous fencing token', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql);
    const definition = registeredStepWorkflow('recovery-test', 'generate');
    const created = await store.createRun({
      config: { maxAttempts: 3, timeoutMs: 60_000 },
      definitionHash: definition.definitionHash,
      definitionHashVersion: definition.definitionHashVersion,
      id: randomUUID(),
      materialization: materializeWorkflowStart(
        definition,
        { content: 'test' },
        {
          resolvedConfig: definition.executionDefaults,
        }
      ),
      input: { content: 'test' },
      projectId,
      requestKey: randomUUID(),
      userId,
      workflowId: 'recovery-test',
    });
    const first = await claimNextStep(store, definition, 'worker-a');
    if (!first) throw new Error('Expected a workflow claim.');
    await sql`
      update public.workflow_node_runs
      set lease_expires_at = clock_timestamp() - interval '1 second'
      where run_id = ${created.run.id} and node_instance_id = 'generate'
    `;

    expect(
      await store.steps.recoverNextExpired({
        random: () => 0,
        resolveDefinition: () => definition,
        supportedDefinitions: [definitionBoundary(definition)],
      })
    ).toEqual({
      nodeInstanceId: 'generate',
      outcome: 'retrying',
      runId: created.run.id,
    });
    expect(await store.steps.heartbeat({ claim: first, leaseMs: 60_000 })).toEqual({
      status: 'lost',
    });
    const recovered = await sql`
      select attempt.status as attempt_status, node.fencing_token, node.status as node_status
      from public.workflow_node_runs node
      join public.workflow_node_attempts attempt
        on attempt.run_id = node.run_id
       and attempt.node_instance_id = node.node_instance_id
       and attempt.attempt_number = 1
      where node.run_id = ${created.run.id} and node.node_instance_id = 'generate'
    `;
    expect(recovered).toEqual([
      { attempt_status: 'lost', fencing_token: '2', node_status: 'retrying' },
    ]);
    await sql`
      update public.workflow_node_runs
      set available_at = clock_timestamp()
      where run_id = ${created.run.id} and node_instance_id = 'generate'
    `;
    const second = await claimNextStep(store, definition, 'worker-b');
    expect(second).toMatchObject({
      attemptNumber: 2,
      fencingToken: '3',
      previousAttemptFailure: { code: 'worker_lease_expired' },
    });
    if (!second) throw new Error('Expected the recovered workflow claim.');
    expect(
      await store.steps.recordFailure({
        claim: second,
        definition,
        failure: failPermanently({
          code: 'invalid_state',
          message: 'The workflow state is invalid.',
        }).failure,
      })
    ).toEqual({ status: 'failed', transientEvents: [] });
    const terminal = await sql`
      select run.status as run_status, node.status as node_status
      from public.workflow_runs run
      join public.workflow_node_runs node on node.run_id = run.id
      where run.id = ${created.run.id}
    `;
    expect(terminal).toEqual([{ node_status: 'failed', run_status: 'failed' }]);
    await sql`delete from public.workflow_runs where id = ${created.run.id}`;
  });
});
