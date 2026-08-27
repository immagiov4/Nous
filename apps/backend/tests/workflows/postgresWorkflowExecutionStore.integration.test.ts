import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import * as z from 'zod';
import { WorkflowExecutionDefaultsSchema } from '../../src/workflows/config.js';
import { createWorkflowRegistry, fanOut, step, workflow } from '../../src/workflows/definition.js';
import { materializeWorkflowStart } from '../../src/workflows/materialization.js';
import { PostgresProjectRevisionInbox } from '../../src/workflows/postgresProjectRevisionInbox.js';
import { COURSE_PROJECT_REVISION_EVENT } from '../../src/workflows/projectRevisionNotifications.js';
import {
  failPermanently,
  retryCorrective,
  retryOperational,
} from '../../src/workflows/retryPolicy.js';
import {
  WorkflowLeaseLostError,
  WorkflowOutboxLeaseLostError,
} from '../../src/workflows/workflowErrors.js';
import {
  claimNextStep,
  createPostgresWorkflowIntegrationContext,
  createStore,
  POSTGRES_WORKFLOW_TEST_LOCK,
  registeredStepWorkflow,
  setupPostgresWorkflowIntegrationContext,
  stepMaterialization,
  teardownPostgresWorkflowIntegrationContext,
  withPostgresWorkflowTestLock,
} from './postgresWorkflowStore.integration.fixture.js';

const context = createPostgresWorkflowIntegrationContext();
const { projectId, sql, userId } = context;

const createRevisionNotificationRun = (store: ReturnType<typeof createStore>, revision: number) =>
  store.createRun({
    config: { maxAttempts: 3, timeoutMs: 60_000 },
    definitionHash: 'e'.repeat(64),
    definitionHashVersion: 1,
    id: randomUUID(),
    input: { projectId },
    materialization: {
      completedOutput: { projectId, revision },
      durableEvents: [
        {
          eventType: COURSE_PROJECT_REVISION_EVENT,
          payload: { projectId, revision },
          schemaVersion: 1,
        },
      ],
      nodes: [],
      stepPolicies: {},
      stepPoliciesVersion: 1,
      transientEvents: [],
      waits: [],
    },
    projectId,
    requestKey: randomUUID(),
    userId,
    workflowId: 'project-revision-inbox-test',
  });

const createListenClient = () => {
  const databaseUrl = process.env.WORKFLOW_INTEGRATION_DATABASE_URL;
  if (!databaseUrl) throw new Error('Workflow integration database is required.');
  return postgres(databaseUrl, { max: 1 });
};

describe.skipIf(!context.enabled)('PostgresWorkflowStore execution integration', () => {
  beforeAll(() => setupPostgresWorkflowIntegrationContext(context));
  afterAll(() => teardownPostgresWorkflowIntegrationContext(context));

  test('lets only one worker claim a step and records its fencing token', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql);
    const definition = {
      definitionHash: 'b'.repeat(64),
      definitionHashVersion: 1,
      id: 'claim-test',
    };
    const created = await store.createRun({
      config: { maxAttempts: 3, timeoutMs: 60_000 },
      definitionHash: 'b'.repeat(64),
      definitionHashVersion: 1,
      id: randomUUID(),
      materialization: stepMaterialization({ prompt: 'test' }, 'generate'),
      input: { content: 'test' },
      projectId,
      requestKey: randomUUID(),
      userId,
      workflowId: 'claim-test',
    });

    const [first, second] = await Promise.all([
      claimNextStep(store, definition, 'worker-a'),
      claimNextStep(store, definition, 'worker-b'),
    ]);
    const claim = first ?? second;

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(claim).toMatchObject({
      attemptNumber: 1,
      fencingToken: '1',
      nodeInstanceId: 'generate',
      runId: created.run.id,
    });
    const attempts = await sql`
      select attempt_number, fencing_token, worker_id
      from public.workflow_node_attempts
      where run_id = ${created.run.id}
    `;
    expect(attempts).toEqual([
      {
        attempt_number: 1,
        fencing_token: '1',
        worker_id: claim?.workerId,
      },
    ]);
    await sql`delete from public.workflow_runs where id = ${created.run.id}`;
  });

  test('keeps one authoritative provider result across overlapping attempts', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql);
    const runId = randomUUID();
    const definition = registeredStepWorkflow('provider-result-test', 'generate');
    await store.createRun({
      config: definition.executionDefaults,
      definitionHash: definition.definitionHash,
      definitionHashVersion: definition.definitionHashVersion,
      id: runId,
      input: { prompt: 'test' },
      materialization: materializeWorkflowStart(
        definition,
        { content: 'test' },
        {
          resolvedConfig: definition.executionDefaults,
        }
      ),
      projectId,
      requestKey: randomUUID(),
      userId,
      workflowId: 'provider-result-test',
    });
    const claim = await claimNextStep(store, definition, 'provider-worker');
    if (!claim) throw new Error('Expected a provider workflow claim.');
    const identity = {
      idempotencyKey: `workflow:forward:run:36:${runId}:node:8:generate`,
      nodeInstanceId: claim.nodeInstanceId,
      runId,
    };
    const usage = (model: string) => ({
      attemptNumber: claim.attemptNumber,
      id: randomUUID(),
      inputTokens: 5,
      model,
      nodeInstanceId: claim.nodeInstanceId,
      outputTokens: 3,
      provider: 'test-provider',
      runId,
    });

    const results = await Promise.all([
      store.providerEffects.recordResult({
        ...identity,
        aiUsage: [usage('first-model')],
        output: { content: 'first' },
      }),
      store.providerEffects.recordResult({
        ...identity,
        aiUsage: [usage('second-model')],
        output: { content: 'second' },
      }),
    ]);

    expect(results[0]).toEqual(results[1]);
    expect([{ content: 'first' }, { content: 'second' }]).toContainEqual(results[0]);
    await expect(store.providerEffects.getResult(identity)).resolves.toEqual(results[0]);
    const verificationIdentity = {
      ...identity,
      idempotencyKey: `${identity.idempotencyKey}:provider:verify`,
    };
    await expect(
      store.providerEffects.recordResult({
        ...verificationIdentity,
        output: { content: 'verified' },
      })
    ).resolves.toEqual({ content: 'verified' });
    const rows = await sql`
      select finalized, output
      from public.workflow_provider_effect_results
      where run_id = ${runId} and node_instance_id = ${claim.nodeInstanceId}
      order by idempotency_key
    `;
    expect(rows).toEqual([
      { finalized: false, output: results[0] },
      { finalized: false, output: { content: 'verified' } },
    ]);
    expect(
      await sql`
        select model
        from public.workflow_ai_usage
        where run_id = ${runId} and node_instance_id = ${claim.nodeInstanceId}
        order by model
      `
    ).toEqual([{ model: 'first-model' }, { model: 'second-model' }]);
    await expect(
      store.checkpointStep({ claim, definition, output: results[0] })
    ).resolves.toMatchObject({ status: 'checkpointed' });
    expect(
      await sql`
        select ai_usage, finalized, output
        from public.workflow_provider_effect_results
        where run_id = ${runId} and node_instance_id = ${claim.nodeInstanceId}
        order by idempotency_key
      `
    ).toEqual([
      { ai_usage: [], finalized: true, output: null },
      { ai_usage: [], finalized: true, output: null },
    ]);
    await expect(store.providerEffects.getResult(identity)).rejects.toBeInstanceOf(
      WorkflowLeaseLostError
    );
    await expect(
      store.providerEffects.recordResult({ ...identity, output: { content: 'late' } })
    ).rejects.toBeInstanceOf(WorkflowLeaseLostError);
    await sql`delete from public.workflow_runs where id = ${runId}`;
  });

  test('preserves corrective feedback identity across an operational retry', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql);
    const definition = registeredStepWorkflow('corrective-feedback-test', 'generate');
    const runId = randomUUID();
    const input = { content: 'test' };
    await store.createRun({
      config: definition.executionDefaults,
      definitionHash: definition.definitionHash,
      definitionHashVersion: definition.definitionHashVersion,
      id: runId,
      input,
      materialization: materializeWorkflowStart(definition, input, {
        resolvedConfig: definition.executionDefaults,
      }),
      projectId,
      requestKey: randomUUID(),
      userId,
      workflowId: definition.id,
    });

    const first = await claimNextStep(store, definition, 'corrective-worker');
    if (!first) throw new Error('Expected the first workflow claim.');
    const correctiveFailure = retryCorrective({
      code: 'workflow_step_output_invalid',
      details: {
        validationIssue: {
          code: 'too_small',
          path: ['research', 'summary', 'sources', 0, 'title'],
        },
      },
      feedback:
        'Return an output that matches the declared schema. Correct research.summary.sources[0].title (too_small).',
      message: 'The workflow step returned an invalid output.',
    }).failure;
    await store.steps.recordFailure({ claim: first, definition, failure: correctiveFailure });

    const second = await claimNextStep(store, definition, 'operational-worker');
    if (!second) throw new Error('Expected the corrective retry claim.');
    expect(second).toMatchObject({
      attemptNumber: 2,
      previousAttemptFailure: correctiveFailure,
      retryFeedback: correctiveFailure.feedback,
      retryFeedbackSourceAttemptNumber: 1,
    });
    const operationalFailure = retryOperational({
      code: 'provider_timeout',
      message: 'The provider timed out.',
      retryAfterMs: 0,
    }).failure;
    await store.steps.recordFailure({ claim: second, definition, failure: operationalFailure });
    await sql`
      update public.workflow_node_runs
      set available_at = clock_timestamp()
      where run_id = ${runId} and node_instance_id = ${second.nodeInstanceId}
    `;

    const third = await claimNextStep(store, definition, 'recovery-worker');
    if (!third) throw new Error('Expected the operational retry claim.');
    expect(third).toMatchObject({
      attemptNumber: 3,
      previousAttemptFailure: operationalFailure,
      retryFeedback: correctiveFailure.feedback,
      retryFeedbackSourceAttemptNumber: 1,
    });

    await sql`delete from public.workflow_runs where id = ${runId}`;
  });

  test('renews leases, retries without losing diagnostics, and rejects stale or rolled-back commits', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    await withPostgresWorkflowTestLock(sql, POSTGRES_WORKFLOW_TEST_LOCK.outboxClaim, async () => {
      const store = createStore(sql);
      const definition = registeredStepWorkflow('lifecycle-test', 'generate', 'lesson.completed');
      const input = { content: 'test' };
      const requestKey = randomUUID();
      const created = await store.createRun({
        config: { maxAttempts: 3, timeoutMs: 60_000 },
        definitionHash: definition.definitionHash,
        definitionHashVersion: definition.definitionHashVersion,
        id: randomUUID(),
        materialization: materializeWorkflowStart(definition, input, {
          resolvedConfig: definition.executionDefaults,
        }),
        input,
        projectId,
        requestKey,
        userId,
        workflowId: 'lifecycle-test',
      });
      const first = await claimNextStep(store, definition, 'worker-a');
      if (!first) throw new Error('Expected the first workflow claim.');

      expect(await store.steps.heartbeat({ claim: first, leaseMs: 60_000 })).toMatchObject({
        status: 'renewed',
      });
      await store.steps.recordFailure({
        aiUsage: [
          {
            attemptNumber: first.attemptNumber,
            id: randomUUID(),
            inputTokens: 10,
            model: 'first-model',
            nodeInstanceId: first.nodeInstanceId,
            outputTokens: 2,
            provider: 'codex',
            runId: first.runId,
          },
        ],
        claim: first,
        definition,
        failure: retryCorrective({
          code: 'invalid_lesson_shape',
          feedback: 'Return the required lesson fields.',
          message: 'Invalid lesson shape.',
        }).failure,
      });
      expect(await store.steps.heartbeat({ claim: first, leaseMs: 60_000 })).toEqual({
        status: 'lost',
      });

      const second = await claimNextStep(store, definition, 'worker-b');
      if (!second) throw new Error('Expected the retried workflow claim.');
      expect(second).toMatchObject({
        attemptNumber: 2,
        fencingToken: '2',
        retryFeedback: 'Return the required lesson fields.',
      });
      const secondAttemptUsage = [
        {
          attemptNumber: second.attemptNumber,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          inputTokens: 12,
          id: randomUUID(),
          model: 'openai/test-model',
          nodeInstanceId: second.nodeInstanceId,
          outputTokens: 5,
          provider: 'openrouter',
          providerCost: 0.0042,
          reasoningTokens: 2,
          runId: second.runId,
        },
      ] as const;
      await expect(
        store.checkpointStep({ claim: first, definition, output: { content: 'stale' } })
      ).rejects.toBeInstanceOf(WorkflowLeaseLostError);

      await expect(
        store.checkpointStep({
          aiUsage: secondAttemptUsage,
          claim: second,
          commit: async transaction => {
            await transaction`
            update public.projects
            set meta = jsonb_set(meta, '{workflowTest}', 'true'::jsonb)
            where user_id = ${userId} and id = ${projectId}
          `;
            throw new Error('forced commit failure');
          },
          definition,
          output: { content: 'draft' },
        })
      ).rejects.toThrow('forced commit failure');

      const afterRollback = await sql`
      select meta -> 'workflowTest' as marker
      from public.projects
      where user_id = ${userId} and id = ${projectId}
    `;
      expect(afterRollback[0]?.marker).toBeNull();

      await store.checkpointStep({
        aiUsage: secondAttemptUsage,
        claim: second,
        commit: async transaction => {
          await transaction`
          update public.projects
          set meta = jsonb_set(meta, '{workflowTest}', 'true'::jsonb)
          where user_id = ${userId} and id = ${projectId}
        `;
        },
        definition,
        output: { content: 'draft' },
      });
      expect(
        await store.checkpointStep({
          claim: second,
          definition,
          output: { content: 'draft' },
        })
      ).toEqual({ status: 'already-checkpointed' });

      const usage = await sql`
      select
        attempt_number, cache_read_tokens, cache_write_tokens, input_tokens, model,
        output_tokens, provider, provider_cost, reasoning_tokens, reported_after_interruption
      from public.workflow_ai_usage
      where run_id = ${created.run.id}
      order by attempt_number
    `;
      expect(usage).toEqual([
        {
          attempt_number: 1,
          cache_read_tokens: null,
          cache_write_tokens: null,
          input_tokens: 10,
          model: 'first-model',
          output_tokens: 2,
          provider: 'codex',
          provider_cost: null,
          reasoning_tokens: null,
          reported_after_interruption: false,
        },
        {
          attempt_number: 2,
          cache_read_tokens: 3,
          cache_write_tokens: 2,
          input_tokens: 12,
          model: 'openai/test-model',
          output_tokens: 5,
          provider: 'openrouter',
          provider_cost: '0.004200000000',
          reasoning_tokens: 2,
          reported_after_interruption: false,
        },
      ]);

      const state = await sql`
      select
        run.status as run_status,
        node.status as node_status,
        node.completion_sequence,
        attempt.status as attempt_status
      from public.workflow_runs run
      join public.workflow_node_runs node on node.run_id = run.id
      join public.workflow_node_attempts attempt
        on attempt.run_id = node.run_id
       and attempt.node_instance_id = node.node_instance_id
       and attempt.attempt_number = 2
      where run.id = ${created.run.id}
    `;
      expect(state).toEqual([
        {
          attempt_status: 'completed',
          completion_sequence: '1',
          node_status: 'completed',
          run_status: 'completed',
        },
      ]);
      const outbox = await sql`
      select event_type, sequence
      from public.workflow_outbox
      where run_id = ${created.run.id}
      order by sequence
    `;
      expect(outbox).toEqual([{ event_type: 'lesson.completed', sequence: '1' }]);

      expect(await store.getRun({ runId: created.run.id, userId })).toMatchObject({
        cancellationRequested: false,
        cleanupStatus: 'not-required',
        id: created.run.id,
        input,
        output: { content: 'draft' },
        projectId,
        startedAt: expect.any(String),
        status: 'completed',
      });
      expect(await store.getRun({ runId: created.run.id, userId: randomUUID() })).toBeNull();
      expect(
        await store.getRunByRequestKey({
          requestKey,
          userId,
          workflowId: 'lifecycle-test',
        })
      ).toMatchObject({ id: created.run.id, status: 'completed' });
      expect(
        await store.getRunByRequestKey({
          requestKey,
          userId: randomUUID(),
          workflowId: 'lifecycle-test',
        })
      ).toBeNull();
      await sql`delete from public.workflow_runs where id = ${created.run.id}`;
    });
  });

  test('persists provider usage once even when the step later loses its lease', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql);
    const definition = registeredStepWorkflow('metering-lease-loss', 'generate');
    const input = { content: 'test' };
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
    const claim = await claimNextStep(store, definition, 'metering-worker');
    if (!claim) throw new Error('Expected the metering workflow claim.');
    const usage = {
      attemptNumber: claim.attemptNumber,
      id: randomUUID(),
      inputTokens: 10,
      model: 'test-model',
      nodeInstanceId: claim.nodeInstanceId,
      outputTokens: 2,
      provider: 'codex',
      reportedAfterInterruption: true,
      runId: claim.runId,
    } as const;

    await store.recordAiUsage(usage);
    await store.recordAiUsage(usage);
    await sql`
      update public.workflow_node_runs
      set lease_expires_at = clock_timestamp() - interval '1 second'
      where run_id = ${claim.runId} and node_instance_id = ${claim.nodeInstanceId}
    `;

    expect(await store.steps.heartbeat({ claim, leaseMs: 60_000 })).toEqual({ status: 'lost' });
    const rows = await sql`
      select id, input_tokens, output_tokens, reported_after_interruption
      from public.workflow_ai_usage
      where id = ${usage.id}
    `;
    expect(rows).toEqual([
      {
        id: usage.id,
        input_tokens: 10,
        output_tokens: 2,
        reported_after_interruption: true,
      },
    ]);
    await sql`delete from public.workflow_runs where id = ${created.run.id}`;
  });

  test('terminalizes an owned claim whose durable definition is unavailable', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql);
    const unavailableDefinition = {
      definitionHash: 'd'.repeat(64),
      definitionHashVersion: 1,
      id: 'unavailable-definition-test',
    };
    const created = await store.createRun({
      config: { maxAttempts: 3, timeoutMs: 60_000 },
      definitionHash: unavailableDefinition.definitionHash,
      definitionHashVersion: unavailableDefinition.definitionHashVersion,
      id: randomUUID(),
      input: { content: 'orphaned' },
      materialization: stepMaterialization({ content: 'orphaned' }, 'generate'),
      projectId,
      requestKey: randomUUID(),
      userId,
      workflowId: unavailableDefinition.id,
    });
    const claim = await claimNextStep(
      store,
      unavailableDefinition,
      'worker-unavailable-definition'
    );
    if (!claim) throw new Error('Expected the unavailable-definition workflow claim.');
    const failure = failPermanently({
      code: 'workflow_definition_unavailable',
      message: 'The workflow definition required by this run is unavailable.',
    }).failure;

    await store.steps.recordDefinitionUnavailable({ claim, failure });

    const state = await sql`
      select
        run.cleanup_status,
        run.error ->> 'code' as run_error,
        run.status as run_status,
        node.error ->> 'code' as node_error,
        node.fencing_token::text,
        node.status as node_status,
        attempt.status as attempt_status,
        (
          select count(*)::integer
          from public.workflow_undo_runs undo
          where undo.run_id = run.id
        ) as undo_count
      from public.workflow_runs run
      join public.workflow_node_runs node on node.run_id = run.id
      join public.workflow_node_attempts attempt
        on attempt.run_id = node.run_id and attempt.node_instance_id = node.node_instance_id
      where run.id = ${created.run.id}
    `;
    expect(state).toEqual([
      {
        attempt_status: 'lost',
        cleanup_status: 'not-required',
        fencing_token: '2',
        node_error: 'workflow_definition_unavailable',
        node_status: 'cancelled',
        run_error: 'workflow_definition_unavailable',
        run_status: 'failed',
        undo_count: 0,
      },
    ]);
    await expect(
      store.steps.recordDefinitionUnavailable({ claim, failure })
    ).rejects.toBeInstanceOf(WorkflowLeaseLostError);
    await sql`delete from public.workflow_runs where id = ${created.run.id}`;
  });

  test('serializes concurrent fan-out checkpoints and fans in from the fresh snapshot', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql);
    const FanInput = z.object({ values: z.array(z.string()) });
    const worker = step({
      id: 'worker',
      inputSchema: z.string(),
      outputSchema: z.string(),
      run: async ({ input }) => input,
    });
    const definition = createWorkflowRegistry().register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'fanout-race-test',
        inputSchema: FanInput,
        outputSchema: FanInput,
        root: fanOut({
          failureMode: 'collect',
          fanIn: results => ({
            values: results.flatMap(result =>
              result.status === 'completed' ? [result.output] : []
            ),
          }),
          id: 'fan',
          inputSchema: FanInput,
          inputs: input => input.values,
          itemSchema: z.string(),
          keyBy: input => input,
          outputSchema: FanInput,
          worker,
        }),
      }),
    }).current;
    const input = { values: ['first', 'second'] };
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
    const first = await claimNextStep(store, definition, 'worker-a');
    const second = await claimNextStep(store, definition, 'worker-b');
    if (!first || !second) throw new Error('Expected both fan-out items to be claimed.');

    await Promise.all(
      [first, second].map(claim =>
        store.checkpointStep({
          claim,
          definition,
          output: String(claim.input).toUpperCase(),
        })
      )
    );

    const runs = await sql`
      select output, status
      from public.workflow_runs
      where id = ${created.run.id}
    `;
    expect(runs).toEqual([{ output: { values: ['FIRST', 'SECOND'] }, status: 'completed' }]);
    await sql`delete from public.workflow_runs where id = ${created.run.id}`;
  });

  test('redelivers a durable notification after failure and fences the stale delivery', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    await withPostgresWorkflowTestLock(sql, POSTGRES_WORKFLOW_TEST_LOCK.outboxClaim, async () => {
      const store = createStore(sql);
      const created = await store.createRun({
        config: { maxAttempts: 3, timeoutMs: 60_000 },
        definitionHash: 'c'.repeat(64),
        definitionHashVersion: 1,
        id: randomUUID(),
        input: { content: 'done' },
        materialization: {
          completedOutput: { content: 'done' },
          durableEvents: [
            { eventType: 'lesson.ready', payload: { content: 'done' }, schemaVersion: 1 },
          ],
          nodes: [],
          stepPolicies: {},
          stepPoliciesVersion: 1,
          transientEvents: [],
          waits: [],
        },
        projectId,
        requestKey: randomUUID(),
        userId,
        workflowId: 'outbox-test',
      });
      const first = await store.outbox.claimNext({ leaseMs: 60_000, workerId: 'delivery-a' });
      if (!first) throw new Error('Expected a durable notification claim.');
      expect(first).toMatchObject({
        attemptNumber: 1,
        fencingToken: '1',
        runId: created.run.id,
        userId,
      });
      expect(await store.outbox.heartbeat({ claim: first, leaseMs: 60_000 })).toMatchObject({
        status: 'renewed',
      });
      await store.outbox.recordFailure({
        claim: first,
        failure: {
          code: 'receiver_unavailable',
          kind: 'operational',
          message: 'The notification receiver is unavailable.',
        },
        retryDelayMs: 0,
      });

      const second = await store.outbox.claimNext({ leaseMs: 60_000, workerId: 'delivery-b' });
      if (!second) throw new Error('Expected the notification to be redelivered.');
      expect(second).toMatchObject({ attemptNumber: 2, fencingToken: '2', id: first.id });
      await expect(store.outbox.markDelivered(first)).rejects.toBeInstanceOf(
        WorkflowOutboxLeaseLostError
      );
      await store.outbox.markDelivered(second);

      const events = await sql`
      select attempt_count, delivered_at is not null as delivered, status
      from public.workflow_outbox
      where run_id = ${created.run.id}
    `;
      expect(events).toEqual([{ attempt_count: 2, delivered: true, status: 'delivered' }]);
      await sql`delete from public.workflow_runs where id = ${created.run.id}`;
    });
  });

  test('dead-letters a permanently invalid notification without blocking later events', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    await withPostgresWorkflowTestLock(sql, POSTGRES_WORKFLOW_TEST_LOCK.outboxClaim, async () => {
      const store = createStore(sql);
      const created = await store.createRun({
        config: { maxAttempts: 3, timeoutMs: 60_000 },
        definitionHash: 'e'.repeat(64),
        definitionHashVersion: 1,
        id: randomUUID(),
        input: { projectId },
        materialization: {
          completedOutput: { projectId, revision: 8 },
          durableEvents: [
            {
              eventType: COURSE_PROJECT_REVISION_EVENT,
              payload: { projectId, revision: 7 },
              schemaVersion: 1,
            },
            {
              eventType: COURSE_PROJECT_REVISION_EVENT,
              payload: { projectId, revision: 8 },
              schemaVersion: 1,
            },
          ],
          nodes: [],
          stepPolicies: {},
          stepPoliciesVersion: 1,
          transientEvents: [],
          waits: [],
        },
        projectId,
        requestKey: randomUUID(),
        userId,
        workflowId: 'project-revision-inbox-test',
      });
      await sql`
        update public.workflow_outbox
        set available_at = case sequence
          when 1 then '-infinity'::timestamptz
          else 'epoch'::timestamptz
        end
        where run_id = ${created.run.id}
      `;
      const claim = await store.outbox.claimNext({ leaseMs: 60_000, workerId: 'delivery-invalid' });
      if (!claim) throw new Error('Expected the invalid notification claim.');
      expect(claim).toMatchObject({ runId: created.run.id, sequence: '1' });

      await store.outbox.recordFailure({
        claim,
        failure: {
          code: 'notification_unsupported',
          kind: 'permanent',
          message: 'The durable workflow notification is not supported.',
        },
        retryDelayMs: 0,
      });

      expect(
        await store.outbox.claimNext({ leaseMs: 60_000, workerId: 'delivery-next' })
      ).toMatchObject({ runId: created.run.id, sequence: '2' });
      expect(
        await sql`
          select
            status,
            delivered_at is not null as delivered,
            dead_lettered_at is not null as dead_lettered,
            last_error ->> 'code' as error_code
          from public.workflow_outbox
          where id = ${claim.id}
        `
      ).toEqual([
        {
          delivered: false,
          dead_lettered: true,
          error_code: 'notification_unsupported',
          status: 'dead-letter',
        },
      ]);

      await expect(
        store.outbox.retryDeadLetter({ id: claim.id, requestedBy: userId })
      ).resolves.toBe(true);
      expect(
        await sql`
          select
            status,
            dead_lettered_at is null as dead_letter_timestamp_cleared,
            last_error ->> 'code' as error_code
          from public.workflow_outbox
          where id = ${claim.id}
        `
      ).toEqual([
        {
          dead_letter_timestamp_cleared: true,
          error_code: 'notification_unsupported',
          status: 'pending',
        },
      ]);
      await sql`delete from public.workflow_runs where id = ${created.run.id}`;
    });
  });

  test('persists a receiver acknowledgement once before the outbox is marked delivered', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    await withPostgresWorkflowTestLock(sql, POSTGRES_WORKFLOW_TEST_LOCK.outboxClaim, async () => {
      const store = createStore(sql);
      const created = await createRevisionNotificationRun(store, 7);
      const inbox = new PostgresProjectRevisionInbox({ createListenClient, sql });
      const first = await store.outbox.claimNext({ leaseMs: 60_000, workerId: 'delivery-a' });
      if (!first) throw new Error('Expected a durable project revision claim.');

      await inbox.deliver(first);

      expect(
        await sql`
        select status
        from public.workflow_outbox
        where id = ${first.id}
      `
      ).toEqual([{ status: 'delivering' }]);
      expect(
        await sql`
        select
          notification_id, run_id, user_id, event_type, schema_version,
          sequence::text, payload
        from public.project_revision_notification_inbox
        where notification_id = ${first.id}
      `
      ).toEqual([
        {
          event_type: COURSE_PROJECT_REVISION_EVENT,
          notification_id: first.id,
          payload: { projectId, revision: 7 },
          run_id: created.run.id,
          schema_version: 1,
          sequence: '1',
          user_id: userId,
        },
      ]);

      await sql`
      update public.workflow_outbox
      set lease_expires_at = clock_timestamp() - interval '1 second'
      where id = ${first.id}
    `;
      const retry = await store.outbox.claimNext({ leaseMs: 60_000, workerId: 'delivery-b' });
      if (!retry) throw new Error('Expected the project revision notification to be redelivered.');
      await inbox.deliver(retry);

      expect(
        await sql`
        select count(*)::integer as count
        from public.project_revision_notification_inbox
        where notification_id = ${first.id}
      `
      ).toEqual([{ count: 1 }]);
      await store.outbox.markDelivered(retry);
      await sql`delete from public.workflow_runs where id = ${created.run.id}`;
    });
  });

  test('wakes every replica and fans out the stored revision through the local SSE boundary', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    await withPostgresWorkflowTestLock(sql, POSTGRES_WORKFLOW_TEST_LOCK.outboxClaim, async () => {
      const store = createStore(sql);
      const created = await createRevisionNotificationRun(store, 8);
      const publishOnFirstReplica = vi.fn();
      const publishOnSecondReplica = vi.fn();
      const firstReplica = new PostgresProjectRevisionInbox({
        createListenClient,
        publishRevision: publishOnFirstReplica,
        sql,
      });
      const secondReplica = new PostgresProjectRevisionInbox({
        createListenClient,
        publishRevision: publishOnSecondReplica,
        sql,
      });

      await Promise.all([firstReplica.start(), secondReplica.start()]);
      try {
        const claim = await store.outbox.claimNext({ leaseMs: 60_000, workerId: 'delivery-a' });
        if (!claim) throw new Error('Expected a durable project revision claim.');
        await firstReplica.deliver(claim);

        await vi.waitFor(() => {
          expect(publishOnFirstReplica).toHaveBeenCalledWith(userId, {
            projectId,
            revision: 8,
          });
          expect(publishOnSecondReplica).toHaveBeenCalledWith(userId, {
            projectId,
            revision: 8,
          });
        });
        await store.outbox.markDelivered(claim);
      } finally {
        await Promise.all([firstReplica.stop(), secondReplica.stop()]);
        await sql`delete from public.workflow_runs where id = ${created.run.id}`;
      }
    });
  });
});
