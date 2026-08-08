import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createWorkflowRegistry } from '../../src/workflows/definition.js';
import { mapPreviousSublessonIdempotencyInput } from '../../src/workflows/lessonGenerationStart.js';
import { materializeWorkflowStart } from '../../src/workflows/materialization.js';
import { reconcileUnavailableWorkflowDefinitions } from '../../src/workflows/workflowDefinitionReconciler.js';
import {
  claimNextStep,
  createPostgresWorkflowIntegrationContext,
  createStore,
  definitionBoundary,
  POSTGRES_WORKFLOW_TEST_LOCK,
  registeredStepWorkflow,
  setupPostgresWorkflowIntegrationContext,
  stepMaterialization,
  teardownPostgresWorkflowIntegrationContext,
  withPostgresWorkflowTestLock,
} from './postgresWorkflowStore.integration.fixture.js';

const context = createPostgresWorkflowIntegrationContext();
const { projectId, sql, userId } = context;

describe.skipIf(!context.enabled)('PostgresWorkflowStore run persistence integration', () => {
  beforeAll(() => setupPostgresWorkflowIntegrationContext(context));
  afterAll(() => teardownPostgresWorkflowIntegrationContext(context));

  test('creates a run and its first step atomically and idempotently', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    await withPostgresWorkflowTestLock(sql, POSTGRES_WORKFLOW_TEST_LOCK.outboxClaim, async () => {
      const store = createStore(sql);
      const requestKey = randomUUID();
      const makeInput = () => ({
        config: { maxAttempts: 3, timeoutMs: 60_000 },
        definitionHash: 'a'.repeat(64),
        definitionHashVersion: 1,
        id: randomUUID(),
        materialization: {
          durableEvents: [
            { eventType: 'lesson.started', payload: { sectionId: 'lesson-1' }, schemaVersion: 1 },
          ],
          nodes: [
            {
              definitionId: 'root',
              hasUndo: false,
              input: { projectId, sectionId: 'lesson-1' },
              instanceId: 'root',
              kind: 'sequence' as const,
              maxAttempts: 3,
              parentInstanceId: undefined,
              runtimeState: { activeIndex: 0 },
              status: 'waiting' as const,
              timeoutMs: 60_000,
            },
            {
              definitionId: 'prepare',
              hasUndo: false,
              input: { projectId, sectionId: 'lesson-1' },
              instanceId: 'root/prepare',
              kind: 'step' as const,
              maxAttempts: 3,
              parentInstanceId: 'root',
              runtimeState: undefined,
              status: 'queued' as const,
              timeoutMs: 60_000,
            },
          ],
          stepPolicies: {
            prepare: {
              config: { maxAttempts: 3, timeoutMs: 60_000 },
              maxAttempts: 3,
              timeoutMs: 60_000,
            },
          },
          stepPoliciesVersion: 1,
          transientEvents: [],
          waits: [],
        },
        input: { projectId, sectionId: 'lesson-1' },
        projectId,
        requestKey,
        userId,
        workflowId: 'lesson-generation',
      });

      const [first, duplicate] = await Promise.all([
        store.createRun(makeInput()),
        store.createRun(makeInput()),
      ]);

      expect([first.created, duplicate.created].sort()).toEqual([false, true]);
      expect(first.run.id).toBe(duplicate.run.id);
      await expect(
        store.createRun({
          ...makeInput(),
          definitionHash: 'b'.repeat(64),
          definitionHashVersion: 2,
        })
      ).resolves.toMatchObject({ created: false, run: { id: first.run.id } });
      const nodes = await sql`
      select node_instance_id, status
      from public.workflow_node_runs
      where run_id = ${first.run.id}
      order by node_instance_id
    `;
      expect(nodes).toEqual([
        { node_instance_id: 'root', status: 'waiting' },
        { node_instance_id: 'root/prepare', status: 'queued' },
      ]);
      const startEvents = await sql`
      select event_type, sequence
      from public.workflow_outbox
      where run_id = ${first.run.id}
    `;
      expect(startEvents).toEqual([{ event_type: 'lesson.started', sequence: '1' }]);
      expect((await store.getRunState({ runId: first.run.id, userId }))?.events).toEqual([
        expect.objectContaining({
          eventType: 'lesson.started',
          payload: { sectionId: 'lesson-1' },
          schemaVersion: 1,
          sequence: '1',
        }),
      ]);
      await sql`delete from public.workflow_runs where id = ${first.run.id}`;
    });
  });

  test('rejects request key reuse for different input or project identity', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql);
    const requestKey = randomUUID();
    const create = (content: string, requestProjectId?: string) =>
      store.createRun({
        config: { maxAttempts: 3, timeoutMs: 60_000 },
        definitionHash: 'a'.repeat(64),
        definitionHashVersion: 1,
        id: randomUUID(),
        input: { content },
        materialization: stepMaterialization({ content }, 'generate'),
        ...(requestProjectId ? { projectId: requestProjectId } : {}),
        requestKey,
        userId,
        workflowId: 'request-identity-test',
      });
    const created = await create('original', projectId);

    await expect(create('changed', projectId)).rejects.toMatchObject({
      code: 'workflow_run_request_conflict',
      message: 'The workflow request key was already used for a different request.',
      name: 'WorkflowRunRequestConflictError',
    });
    await expect(create('original')).rejects.toMatchObject({
      code: 'workflow_run_request_conflict',
      name: 'WorkflowRunRequestConflictError',
    });
    await sql`
      update public.workflow_run_requests
      set request_fingerprint = null
      where user_id = ${userId}
        and workflow_id = 'request-identity-test'
        and request_key = ${requestKey}
    `;
    await expect(create('changed', projectId)).rejects.toMatchObject({
      code: 'workflow_run_request_conflict',
    });
    await expect(create('original', projectId)).resolves.toMatchObject({
      created: false,
      run: { id: created.run.id },
    });
    await sql`delete from public.workflow_runs where id = ${created.run.id}`;
  });

  test('upgrades unchanged original course and artifact legacy requests without a mapper', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql);

    for (const workflowId of ['course-generation', 'artifact-draft']) {
      for (const previousFingerprint of ['legacy', 'null'] as const) {
        const requestKey = randomUUID();
        const workflowInput = { content: `${workflowId}-request` };
        const created = await store.createRun({
          config: { maxAttempts: 3, timeoutMs: 60_000 },
          definitionHash: 'a'.repeat(64),
          definitionHashVersion: 1,
          id: randomUUID(),
          input: workflowInput,
          materialization: stepMaterialization(workflowInput, 'generate'),
          projectId,
          requestKey,
          userId,
          workflowId,
        });
        await sql`
          update public.workflow_run_requests
          set request_fingerprint = ${previousFingerprint === 'legacy' ? `legacy:${created.run.id}` : null}
          where user_id = ${userId}
            and workflow_id = ${workflowId}
            and request_key = ${requestKey}
        `;

        await expect(
          store.createRun({
            config: { maxAttempts: 3, timeoutMs: 60_000 },
            definitionHash: 'b'.repeat(64),
            definitionHashVersion: 2,
            id: randomUUID(),
            input: { content: 'different-request' },
            materialization: stepMaterialization({ content: 'different-request' }, 'generate'),
            projectId,
            requestKey,
            userId,
            workflowId,
          })
        ).rejects.toMatchObject({ code: 'workflow_run_request_conflict' });
        await expect(
          store.createRun({
            config: { maxAttempts: 3, timeoutMs: 60_000 },
            definitionHash: 'b'.repeat(64),
            definitionHashVersion: 2,
            id: randomUUID(),
            input: workflowInput,
            materialization: stepMaterialization(workflowInput, 'generate'),
            projectId,
            requestKey,
            userId,
            workflowId,
          })
        ).resolves.toMatchObject({ created: false, run: { id: created.run.id } });
        await sql`delete from public.workflow_runs where id = ${created.run.id}`;
      }
    }
  });

  test('upgrades previous sublesson request fingerprints without weakening conflicts', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql);
    const create = (input: {
      idempotencyInput?: unknown;
      mapPreviousIdempotencyInput?: (workflowInput: unknown) => unknown | undefined;
      requestKey: string;
      sectionId: string;
      selectedText: string;
    }) =>
      store.createRun({
        config: { maxAttempts: 3, timeoutMs: 60_000 },
        definitionHash: 'a'.repeat(64),
        definitionHashVersion: 1,
        id: randomUUID(),
        ...(input.idempotencyInput === undefined
          ? {}
          : { idempotencyInput: input.idempotencyInput }),
        input: {
          focus: { instructions: 'Approfondisci', selectedText: input.selectedText },
          forceRegenerate: false,
          kind: 'sublesson',
          parentSectionId: 'lesson-1',
          projectId,
          sectionId: input.sectionId,
          userId,
        },
        ...(input.mapPreviousIdempotencyInput === undefined
          ? {}
          : { mapPreviousIdempotencyInput: input.mapPreviousIdempotencyInput }),
        materialization: stepMaterialization({ sectionId: input.sectionId }, 'plan-sublesson'),
        projectId,
        requestKey: input.requestKey,
        userId,
        workflowId: 'lesson-generation',
      });
    const stableInput = {
      focus: { instructions: 'Approfondisci', selectedText: 'orologio globale' },
      kind: 'sublesson',
      parentSectionId: 'lesson-1',
      projectId,
      userId,
    };

    for (const previousFingerprint of ['sha', 'legacy', 'null'] as const) {
      const requestKey = randomUUID();
      const created = await create({
        requestKey,
        sectionId: randomUUID(),
        selectedText: 'orologio globale',
      });
      if (previousFingerprint === 'legacy') {
        await sql`
          update public.workflow_run_requests
          set request_fingerprint = ${`legacy:${created.run.id}`}
          where user_id = ${userId}
            and workflow_id = 'lesson-generation'
            and request_key = ${requestKey}
        `;
      }
      if (previousFingerprint === 'null') {
        await sql`
          update public.workflow_run_requests
          set request_fingerprint = null
          where user_id = ${userId}
            and workflow_id = 'lesson-generation'
            and request_key = ${requestKey}
        `;
      }

      await expect(
        create({
          idempotencyInput: {
            ...stableInput,
            focus: { instructions: 'Approfondisci', selectedText: 'consenso distribuito' },
          },
          mapPreviousIdempotencyInput: mapPreviousSublessonIdempotencyInput,
          requestKey,
          sectionId: randomUUID(),
          selectedText: 'consenso distribuito',
        })
      ).rejects.toMatchObject({ code: 'workflow_run_request_conflict' });
      const replay = await create({
        idempotencyInput: stableInput,
        mapPreviousIdempotencyInput: mapPreviousSublessonIdempotencyInput,
        requestKey,
        sectionId: randomUUID(),
        selectedText: 'orologio globale',
      });

      expect(created.created).toBe(true);
      expect(replay).toMatchObject({ created: false, run: { id: created.run.id } });
      await sql`delete from public.workflow_runs where id = ${created.run.id}`;
    }

    const mismatchedMarkerRequestKey = randomUUID();
    const mismatchedMarkerRun = await create({
      requestKey: mismatchedMarkerRequestKey,
      sectionId: randomUUID(),
      selectedText: 'orologio globale',
    });
    await sql`
      update public.workflow_run_requests
      set request_fingerprint = ${`legacy:${randomUUID()}`}
      where user_id = ${userId}
        and workflow_id = 'lesson-generation'
        and request_key = ${mismatchedMarkerRequestKey}
    `;
    await expect(
      create({
        idempotencyInput: stableInput,
        mapPreviousIdempotencyInput: mapPreviousSublessonIdempotencyInput,
        requestKey: mismatchedMarkerRequestKey,
        sectionId: randomUUID(),
        selectedText: 'orologio globale',
      })
    ).rejects.toMatchObject({ code: 'workflow_run_request_conflict' });
    await sql`delete from public.workflow_runs where id = ${mismatchedMarkerRun.run.id}`;
  });

  test('deduplicates mutually exclusive project work across workflow definitions', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql);
    const dedupeKey = `project-content-generation:${projectId}`;
    const create = (workflowId: string, definitionId: string, definitionHash: string) =>
      store.createRun({
        config: { maxAttempts: 3, timeoutMs: 60_000 },
        dedupeKey,
        definitionHash,
        definitionHashVersion: 1,
        id: randomUUID(),
        input: { content: definitionId },
        materialization: stepMaterialization({ content: definitionId }, definitionId),
        projectId,
        requestKey: randomUUID(),
        userId,
        workflowId,
      });

    const [lesson, sublesson] = await Promise.all([
      create('lesson-generation', 'lesson', 'a'.repeat(64)),
      create('sublesson-generation', 'sublesson', 'b'.repeat(64)),
    ]);

    expect([lesson.created, sublesson.created].sort()).toEqual([false, true]);
    expect(sublesson.run.id).toBe(lesson.run.id);
    await sql`delete from public.workflow_runs where id = ${lesson.run.id}`;
  });

  test('keeps every deduplicated request key bound after the shared run becomes terminal', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql);
    const dedupeKey = `project-content-generation:${projectId}`;
    const firstRequestKey = randomUUID();
    const aliasRequestKey = randomUUID();
    const first = await store.createRun({
      config: { maxAttempts: 3, timeoutMs: 60_000 },
      dedupeKey,
      definitionHash: 'a'.repeat(64),
      definitionHashVersion: 1,
      id: randomUUID(),
      input: { content: 'lesson' },
      materialization: stepMaterialization({ content: 'lesson' }, 'lesson'),
      projectId,
      requestKey: firstRequestKey,
      userId,
      workflowId: 'lesson-generation',
    });
    const alias = await store.createRun({
      config: { maxAttempts: 3, timeoutMs: 60_000 },
      dedupeKey,
      definitionHash: 'b'.repeat(64),
      definitionHashVersion: 1,
      id: randomUUID(),
      input: { content: 'sublesson' },
      materialization: stepMaterialization({ content: 'sublesson' }, 'sublesson'),
      projectId,
      requestKey: aliasRequestKey,
      userId,
      workflowId: 'sublesson-generation',
    });

    expect(first.created).toBe(true);
    expect(alias).toMatchObject({ created: false, run: { id: first.run.id } });
    const insertedAlias = await sql<Array<{ request_fingerprint: string }>>`
      select request_fingerprint
      from public.workflow_run_requests
      where user_id = ${userId}
        and workflow_id = 'sublesson-generation'
        and request_key = ${aliasRequestKey}
    `;
    expect(insertedAlias[0]?.request_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const legacyAliasFingerprint = `legacy:${first.run.id}`;
    await sql`
      update public.workflow_run_requests
      set request_fingerprint = ${legacyAliasFingerprint}
      where user_id = ${userId}
        and workflow_id = 'sublesson-generation'
        and request_key = ${aliasRequestKey}
    `;
    await expect(
      store.createRun({
        config: { maxAttempts: 7, timeoutMs: 90_000 },
        dedupeKey,
        definitionHash: 'c'.repeat(64),
        definitionHashVersion: 2,
        id: randomUUID(),
        input: { content: 'sublesson' },
        materialization: stepMaterialization({ content: 'sublesson' }, 'sublesson'),
        projectId,
        requestKey: aliasRequestKey,
        userId,
        workflowId: 'sublesson-generation',
      })
    ).rejects.toMatchObject({ code: 'workflow_run_request_conflict' });
    const upgradedAlias = await sql<Array<{ request_fingerprint: string }>>`
      select request_fingerprint
      from public.workflow_run_requests
      where user_id = ${userId}
        and workflow_id = 'sublesson-generation'
        and request_key = ${aliasRequestKey}
    `;
    expect(upgradedAlias[0]?.request_fingerprint).toBe(legacyAliasFingerprint);
    await expect(
      store.createRun({
        config: { maxAttempts: 3, timeoutMs: 60_000 },
        dedupeKey,
        definitionHash: 'b'.repeat(64),
        definitionHashVersion: 1,
        id: randomUUID(),
        input: { content: 'different-sublesson' },
        materialization: stepMaterialization({ content: 'different-sublesson' }, 'sublesson'),
        projectId,
        requestKey: aliasRequestKey,
        userId,
        workflowId: 'sublesson-generation',
      })
    ).rejects.toMatchObject({ code: 'workflow_run_request_conflict' });
    await sql`
      update public.workflow_runs
      set status = 'completed', output = '{}'::jsonb, completed_at = now()
      where id = ${first.run.id}
    `;

    expect(
      await store.getRunByRequestKey({
        requestKey: aliasRequestKey,
        userId,
        workflowId: 'sublesson-generation',
      })
    ).toMatchObject({ id: first.run.id, status: 'completed' });
    await sql`delete from public.workflow_runs where id = ${first.run.id}`;
  });

  test('keeps a restarted old replica from failing or starting work for the new definition', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql, { enforceCurrentDefinitions: true });
    const workflowId = 'rolling-definition-admission-test';
    const previousDefinition = registeredStepWorkflow(workflowId, 'generate-v1');
    const currentDefinition = registeredStepWorkflow(workflowId, 'generate-v2');
    const previousRegistry = createWorkflowRegistry();
    previousRegistry.register({ current: previousDefinition });
    const deployedRegistry = createWorkflowRegistry();
    const deployed = deployedRegistry.register({
      current: currentDefinition,
      resumableDefinitions: [previousDefinition],
    });
    await sql`
      delete from public.workflow_definition_deployments where workflow_id = ${workflowId}
    `;
    await reconcileUnavailableWorkflowDefinitions({
      registry: previousRegistry,
      store: store.definitionReconciliation,
    });
    await reconcileUnavailableWorkflowDefinitions({
      registry: deployedRegistry,
      store: store.definitionReconciliation,
    });
    const created = await store.createRun({
      config: deployed.current.executionDefaults,
      definitionHash: deployed.current.definitionHash,
      definitionHashVersion: deployed.current.definitionHashVersion,
      id: randomUUID(),
      input: { content: 'new release' },
      materialization: materializeWorkflowStart(
        deployed.current,
        { content: 'new release' },
        { resolvedConfig: deployed.current.executionDefaults }
      ),
      projectId,
      requestKey: randomUUID(),
      userId,
      workflowId,
    });

    await expect(
      reconcileUnavailableWorkflowDefinitions({
        registry: previousRegistry,
        store: store.definitionReconciliation,
      })
    ).resolves.toEqual([]);
    await expect(store.getRun({ runId: created.run.id, userId })).resolves.toMatchObject({
      status: 'queued',
    });
    await expect(
      store.createRun({
        config: previousDefinition.executionDefaults,
        definitionHash: previousDefinition.definitionHash,
        definitionHashVersion: previousDefinition.definitionHashVersion,
        id: randomUUID(),
        input: { content: 'stale start' },
        materialization: materializeWorkflowStart(
          previousDefinition,
          { content: 'stale start' },
          { resolvedConfig: previousDefinition.executionDefaults }
        ),
        projectId,
        requestKey: randomUUID(),
        userId,
        workflowId,
      })
    ).rejects.toMatchObject({ name: 'WorkflowReplicaOutdatedError' });
    await sql`delete from public.workflow_runs where id = ${created.run.id}`;
    await sql`
      delete from public.workflow_definition_deployments where workflow_id = ${workflowId}
    `;
  });

  test('blocks stale-replica claim and recovery after its definition is removed', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql, { enforceCurrentDefinitions: true });
    const workflowId = 'rolling-definition-step-authority-test';
    const versionOne = registeredStepWorkflow(workflowId, 'generate-v1');
    const versionTwo = registeredStepWorkflow(workflowId, 'generate-v2');
    const versionOneRegistry = createWorkflowRegistry();
    versionOneRegistry.register({ current: versionOne });
    const rollingRegistry = createWorkflowRegistry();
    rollingRegistry.register({
      current: versionTwo,
      resumableDefinitions: [versionOne],
    });
    const killSwitchRegistry = createWorkflowRegistry();
    killSwitchRegistry.register({ current: versionTwo });
    await sql`
      delete from public.workflow_definition_deployments where workflow_id = ${workflowId}
    `;

    try {
      await store.definitionReconciliation.activateDeployments(
        versionOneRegistry.listDefinitionDeployments()
      );
      const createVersionOneRun = () =>
        store.createRun({
          config: versionOne.executionDefaults,
          definitionHash: versionOne.definitionHash,
          definitionHashVersion: versionOne.definitionHashVersion,
          id: randomUUID(),
          input: { content: 'retire me' },
          materialization: materializeWorkflowStart(
            versionOne,
            { content: 'retire me' },
            { resolvedConfig: versionOne.executionDefaults }
          ),
          projectId,
          requestKey: randomUUID(),
          userId,
          workflowId,
        });
      const running = await createVersionOneRun();
      const runningClaim = await claimNextStep(store, versionOne, 'stale-worker-before-removal');
      if (!runningClaim) throw new Error('Expected the v1 worker to claim its run.');
      const queued = await createVersionOneRun();
      await sql`
        update public.workflow_node_runs
        set lease_expires_at = clock_timestamp() - interval '1 second'
        where run_id = ${running.run.id}
      `;

      await store.definitionReconciliation.activateDeployments(
        rollingRegistry.listDefinitionDeployments()
      );
      await store.definitionReconciliation.activateDeployments(
        killSwitchRegistry.listDefinitionDeployments()
      );

      const recovery = await store.steps.recoverNextExpired({
        random: () => 0,
        resolveDefinition: () => versionOne,
        supportedDefinitions: [definitionBoundary(versionOne)],
      });
      const claim = await claimNextStep(store, versionOne, 'stale-worker-after-removal');

      expect(recovery).toBeNull();
      expect(claim).toBeNull();
      expect(
        await sql`
          select run_id, status, attempt_count
          from public.workflow_node_runs
          where run_id in (${running.run.id}, ${queued.run.id})
        `
      ).toEqual(
        expect.arrayContaining([
          { attempt_count: 1, run_id: running.run.id, status: 'running' },
          { attempt_count: 0, run_id: queued.run.id, status: 'queued' },
        ])
      );
    } finally {
      await sql`delete from public.workflow_runs where workflow_id = ${workflowId}`;
      await sql`
        delete from public.workflow_definition_deployments where workflow_id = ${workflowId}
      `;
    }
  });

  test('fences an in-flight step as soon as its definition is removed', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql, { enforceCurrentDefinitions: true });
    const workflowId = 'rolling-definition-checkpoint-fence-test';
    const versionOne = registeredStepWorkflow(workflowId, 'generate-v1');
    const versionTwo = registeredStepWorkflow(workflowId, 'generate-v2');
    const versionOneRegistry = createWorkflowRegistry();
    versionOneRegistry.register({ current: versionOne });
    const rollingRegistry = createWorkflowRegistry();
    rollingRegistry.register({
      current: versionTwo,
      resumableDefinitions: [versionOne],
    });
    const killSwitchRegistry = createWorkflowRegistry();
    killSwitchRegistry.register({ current: versionTwo });
    await sql`
      delete from public.workflow_definition_deployments where workflow_id = ${workflowId}
    `;

    try {
      await store.definitionReconciliation.activateDeployments(
        versionOneRegistry.listDefinitionDeployments()
      );
      const created = await store.createRun({
        config: versionOne.executionDefaults,
        definitionHash: versionOne.definitionHash,
        definitionHashVersion: versionOne.definitionHashVersion,
        id: randomUUID(),
        input: { content: 'fence me' },
        materialization: materializeWorkflowStart(
          versionOne,
          { content: 'fence me' },
          { resolvedConfig: versionOne.executionDefaults }
        ),
        projectId,
        requestKey: randomUUID(),
        userId,
        workflowId,
      });
      const claim = await claimNextStep(store, versionOne, 'stale-checkpoint-worker');
      if (!claim) throw new Error('Expected the v1 step claim.');

      await store.definitionReconciliation.activateDeployments(
        rollingRegistry.listDefinitionDeployments()
      );
      await store.definitionReconciliation.activateDeployments(
        killSwitchRegistry.listDefinitionDeployments()
      );

      await expect(store.steps.heartbeat({ claim, leaseMs: 60_000 })).resolves.toEqual({
        status: 'lost',
      });
      await expect(
        store.checkpointStep({ claim, definition: versionOne, output: { content: 'too late' } })
      ).rejects.toMatchObject({ name: 'WorkflowLeaseLostError' });
      await expect(
        store.steps.recordFailure({
          claim,
          definition: versionOne,
          failure: {
            code: 'provider_failed',
            kind: 'permanent',
            message: 'The provider failed.',
          },
        })
      ).rejects.toMatchObject({ name: 'WorkflowLeaseLostError' });
      await expect(store.getRun({ runId: created.run.id, userId })).resolves.toMatchObject({
        status: 'running',
      });

      await expect(
        reconcileUnavailableWorkflowDefinitions({
          registry: killSwitchRegistry,
          store: store.definitionReconciliation,
        })
      ).resolves.toContain(created.run.id);
    } finally {
      await sql`delete from public.workflow_runs where workflow_id = ${workflowId}`;
      await sql`
        delete from public.workflow_definition_deployments where workflow_id = ${workflowId}
      `;
    }
  });

  test('revokes reconciliation authority before an old replica can fail a newer run', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql, { enforceCurrentDefinitions: true });
    const workflowId = 'rolling-definition-authority-test';
    const versionOne = registeredStepWorkflow(workflowId, 'generate-v1');
    const versionTwo = registeredStepWorkflow(workflowId, 'generate-v2');
    const versionThree = registeredStepWorkflow(workflowId, 'generate-v3');
    const versionOneRegistry = createWorkflowRegistry();
    versionOneRegistry.register({ current: versionOne });
    const versionTwoRegistry = createWorkflowRegistry();
    const registeredVersionTwo = versionTwoRegistry.register({
      current: versionTwo,
      resumableDefinitions: [versionOne],
    });
    const versionThreeRegistry = createWorkflowRegistry();
    const registeredVersionThree = versionThreeRegistry.register({
      current: versionThree,
      resumableDefinitions: [versionTwo],
    });
    await sql`
      delete from public.workflow_definition_deployments where workflow_id = ${workflowId}
    `;

    try {
      await store.definitionReconciliation.activateDeployments(
        versionOneRegistry.listDefinitionDeployments()
      );
      const oldAuthority = await store.definitionReconciliation.activateDeployments(
        versionTwoRegistry.listDefinitionDeployments()
      );
      await store.definitionReconciliation.activateDeployments(
        versionThreeRegistry.listDefinitionDeployments()
      );
      const created = await store.createRun({
        config: registeredVersionThree.current.executionDefaults,
        definitionHash: registeredVersionThree.current.definitionHash,
        definitionHashVersion: registeredVersionThree.current.definitionHashVersion,
        id: randomUUID(),
        input: { content: 'newest release' },
        materialization: materializeWorkflowStart(
          registeredVersionThree.current,
          { content: 'newest release' },
          { resolvedConfig: registeredVersionThree.current.executionDefaults }
        ),
        projectId,
        requestKey: randomUUID(),
        userId,
        workflowId,
      });
      const activeBoundary = (await store.definitionReconciliation.listActiveBoundaries()).find(
        boundary =>
          boundary.workflowId === workflowId &&
          boundary.definitionHash === registeredVersionThree.current.definitionHash
      );
      if (!activeBoundary || !oldAuthority[0]) {
        throw new Error('Expected the old authority and newest active boundary.');
      }

      await expect(
        store.definitionReconciliation.failNextRun(activeBoundary, oldAuthority[0])
      ).resolves.toEqual({ status: 'stale' });
      await expect(store.getRun({ runId: created.run.id, userId })).resolves.toMatchObject({
        status: 'queued',
      });

      expect(registeredVersionTwo.current.definitionHash).not.toBe(
        registeredVersionThree.current.definitionHash
      );
    } finally {
      await sql`delete from public.workflow_runs where workflow_id = ${workflowId}`;
      await sql`
        delete from public.workflow_definition_deployments where workflow_id = ${workflowId}
      `;
    }
  });

  test('makes removal of a resumable definition a one-way kill switch', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql, { enforceCurrentDefinitions: true });
    const workflowId = 'rolling-definition-kill-switch-test';
    const previousDefinition = registeredStepWorkflow(workflowId, 'generate-v1');
    const currentDefinition = registeredStepWorkflow(workflowId, 'generate-v2');
    const previousRegistry = createWorkflowRegistry();
    const previous = previousRegistry.register({ current: previousDefinition });
    const deployedRegistry = createWorkflowRegistry();
    deployedRegistry.register({
      current: currentDefinition,
      resumableDefinitions: [previousDefinition],
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
    const created = await store.createRun({
      config: previous.current.executionDefaults,
      definitionHash: previous.current.definitionHash,
      definitionHashVersion: previous.current.definitionHashVersion,
      id: randomUUID(),
      input: { content: 'retire me' },
      materialization: materializeWorkflowStart(
        previous.current,
        { content: 'retire me' },
        { resolvedConfig: previous.current.executionDefaults }
      ),
      projectId,
      requestKey: randomUUID(),
      userId,
      workflowId,
    });
    await reconcileUnavailableWorkflowDefinitions({
      registry: deployedRegistry,
      store: store.definitionReconciliation,
    });

    await expect(
      reconcileUnavailableWorkflowDefinitions({
        registry: killSwitchRegistry,
        store: store.definitionReconciliation,
      })
    ).resolves.toContain(created.run.id);
    await expect(
      reconcileUnavailableWorkflowDefinitions({
        registry: deployedRegistry,
        store: store.definitionReconciliation,
      })
    ).resolves.toEqual([]);
    const state = await sql`
      select
        jsonb_array_length(current_deployment -> 'supportedDefinitions') as supported_count,
        (select status from public.workflow_runs where id = ${created.run.id}) as run_status
      from public.workflow_definition_deployments
      where workflow_id = ${workflowId}
    `;
    expect(state).toEqual([{ run_status: 'failed', supported_count: 1 }]);
    await sql`delete from public.workflow_runs where id = ${created.run.id}`;
    await sql`
      delete from public.workflow_definition_deployments where workflow_id = ${workflowId}
    `;
  });

  test('tombstones a removed workflow id before a stale replica can resume it', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const definitionDeploymentScope = `removed-workflow-id-${randomUUID()}`;
    const deployedStore = createStore(sql, {
      definitionDeploymentScope,
      enforceCurrentDefinitions: true,
      workflowSetVersion: 1,
    });
    const removedStore = createStore(sql, {
      definitionDeploymentScope,
      enforceCurrentDefinitions: true,
      workflowSetVersion: 2,
    });
    const workflowId = 'removed-workflow-id-kill-switch-test';
    const definition = registeredStepWorkflow(workflowId, 'generate');
    const deployedRegistry = createWorkflowRegistry();
    deployedRegistry.register({ current: definition });
    const removedRegistry = createWorkflowRegistry();
    await sql`
      delete from public.workflow_definition_deployments where workflow_id = ${workflowId}
    `;

    const createRun = () =>
      deployedStore.createRun({
        config: definition.executionDefaults,
        definitionHash: definition.definitionHash,
        definitionHashVersion: definition.definitionHashVersion,
        id: randomUUID(),
        input: { content: 'retire the workflow' },
        materialization: materializeWorkflowStart(
          definition,
          { content: 'retire the workflow' },
          { resolvedConfig: definition.executionDefaults }
        ),
        projectId,
        requestKey: randomUUID(),
        userId,
        workflowId,
      });

    try {
      await reconcileUnavailableWorkflowDefinitions({
        registry: deployedRegistry,
        store: deployedStore.definitionReconciliation,
      });
      const running = await createRun();
      const runningClaim = await claimNextStep(
        deployedStore,
        definition,
        'removed-workflow-running'
      );
      if (!runningClaim) throw new Error('Expected the removed workflow claim.');
      const queued = await createRun();

      await expect(
        reconcileUnavailableWorkflowDefinitions({
          registry: removedRegistry,
          store: removedStore.definitionReconciliation,
        })
      ).resolves.toEqual(expect.arrayContaining([running.run.id, queued.run.id]));
      await expect(
        reconcileUnavailableWorkflowDefinitions({
          registry: deployedRegistry,
          store: deployedStore.definitionReconciliation,
        })
      ).resolves.toEqual([]);
      await expect(createRun()).rejects.toMatchObject({ name: 'WorkflowReplicaOutdatedError' });
      await expect(
        claimNextStep(deployedStore, definition, 'removed-workflow-stale-worker')
      ).resolves.toBeNull();

      expect(
        await sql`
          select
            current_deployment ->> 'removed' as removed,
            previous_deployment -> 'current' ->> 'workflowId' as previous_workflow_id
          from public.workflow_definition_deployments
          where workflow_id = ${workflowId}
        `
      ).toEqual([{ previous_workflow_id: workflowId, removed: 'true' }]);
      expect(
        await sql`
          select id::text, status
          from public.workflow_runs
          where id in (${running.run.id}, ${queued.run.id})
          order by id
        `
      ).toEqual([running.run.id, queued.run.id].sort().map(id => ({ id, status: 'failed' })));
      await expect(
        deployedStore.steps.heartbeat({ claim: runningClaim, leaseMs: 60_000 })
      ).resolves.toEqual({
        status: 'lost',
      });
    } finally {
      await sql`delete from public.workflow_runs where workflow_id = ${workflowId}`;
      await sql`
        delete from public.workflow_definition_deployments where workflow_id = ${workflowId}
      `;
      await sql`
        delete from public.workflow_definition_registry_deployments
        where registry_scope = ${definitionDeploymentScope}
      `;
    }
  });

  test('activates the complete workflow manifest atomically', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql);
    const firstWorkflowId = 'atomic-manifest-a';
    const secondWorkflowId = 'atomic-manifest-b';
    const firstPrevious = registeredStepWorkflow(firstWorkflowId, 'generate-v1');
    const firstCurrent = registeredStepWorkflow(firstWorkflowId, 'generate-v2');
    const secondPrevious = registeredStepWorkflow(secondWorkflowId, 'generate-v1');
    const incompatibleSecond = registeredStepWorkflow(secondWorkflowId, 'generate-v2');
    const initialRegistry = createWorkflowRegistry();
    initialRegistry.register({ current: firstPrevious });
    initialRegistry.register({ current: secondPrevious });
    const conflictingRegistry = createWorkflowRegistry();
    conflictingRegistry.register({
      current: firstCurrent,
      resumableDefinitions: [firstPrevious],
    });
    conflictingRegistry.register({ current: incompatibleSecond });

    await sql`
      delete from public.workflow_definition_deployments
      where workflow_id in (${firstWorkflowId}, ${secondWorkflowId})
    `;
    try {
      await reconcileUnavailableWorkflowDefinitions({
        registry: initialRegistry,
        store: store.definitionReconciliation,
      });

      await expect(
        reconcileUnavailableWorkflowDefinitions({
          registry: conflictingRegistry,
          store: store.definitionReconciliation,
        })
      ).rejects.toMatchObject({
        name: 'WorkflowDefinitionDeploymentConflictError',
        workflowId: secondWorkflowId,
      });
      expect(
        await sql`
          select workflow_id,
                 current_deployment -> 'current' ->> 'definitionHash' as definition_hash
          from public.workflow_definition_deployments
          where workflow_id in (${firstWorkflowId}, ${secondWorkflowId})
          order by workflow_id
        `
      ).toEqual([
        { definition_hash: firstPrevious.definitionHash, workflow_id: firstWorkflowId },
        { definition_hash: secondPrevious.definitionHash, workflow_id: secondWorkflowId },
      ]);
    } finally {
      await sql`
        delete from public.workflow_definition_deployments
        where workflow_id in (${firstWorkflowId}, ${secondWorkflowId})
      `;
    }
  });

  test('orders workflow-set changes before accepting a complete manifest', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const definitionDeploymentScope = `workflow-set-version-${randomUUID()}`;
    const firstWorkflowId = 'versioned-manifest-a';
    const secondWorkflowId = 'versioned-manifest-b';
    const firstDefinition = registeredStepWorkflow(firstWorkflowId, 'generate');
    const secondDefinition = registeredStepWorkflow(secondWorkflowId, 'generate');
    const oldRegistry = createWorkflowRegistry();
    oldRegistry.register({ current: firstDefinition });
    const newRegistry = createWorkflowRegistry();
    newRegistry.register({ current: firstDefinition });
    newRegistry.register({ current: secondDefinition });
    const oldStore = createStore(sql, { definitionDeploymentScope, workflowSetVersion: 1 });
    const newStore = createStore(sql, { definitionDeploymentScope, workflowSetVersion: 2 });
    const conflictingStore = createStore(sql, {
      definitionDeploymentScope,
      workflowSetVersion: 2,
    });

    await sql`
      delete from public.workflow_definition_deployments
      where workflow_id in (${firstWorkflowId}, ${secondWorkflowId})
    `;
    try {
      await newStore.definitionReconciliation.activateDeployments(
        newRegistry.listDefinitionDeployments()
      );
      await expect(
        oldStore.definitionReconciliation.activateDeployments(
          oldRegistry.listDefinitionDeployments()
        )
      ).resolves.toEqual([]);
      await expect(
        conflictingStore.definitionReconciliation.activateDeployments(
          oldRegistry.listDefinitionDeployments()
        )
      ).rejects.toMatchObject({
        name: 'WorkflowDefinitionRegistryDeploymentConflictError',
        registryScope: definitionDeploymentScope,
      });

      expect(
        await sql`
          select workflow_id, current_deployment ->> 'removed' as removed
          from public.workflow_definition_deployments
          where workflow_id in (${firstWorkflowId}, ${secondWorkflowId})
          order by workflow_id
        `
      ).toEqual([
        { removed: null, workflow_id: firstWorkflowId },
        { removed: null, workflow_id: secondWorkflowId },
      ]);
    } finally {
      await sql`
        delete from public.workflow_definition_deployments
        where workflow_id in (${firstWorkflowId}, ${secondWorkflowId})
      `;
      await sql`
        delete from public.workflow_definition_registry_deployments
        where registry_scope = ${definitionDeploymentScope}
      `;
    }
  });

  test('returns durable structured progress after the observer reconnects', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    const store = createStore(sql);
    const definition = registeredStepWorkflow('progress-reconnect-test', 'generate');
    const created = await store.createRun({
      config: definition.executionDefaults,
      definitionHash: definition.definitionHash,
      definitionHashVersion: definition.definitionHashVersion,
      id: randomUUID(),
      input: { content: 'draft' },
      materialization: materializeWorkflowStart(
        definition,
        { content: 'draft' },
        { resolvedConfig: definition.executionDefaults }
      ),
      projectId,
      requestKey: randomUUID(),
      userId,
      workflowId: definition.id,
    });
    const claim = await claimNextStep(store, definition, 'worker-progress');
    if (!claim) throw new Error('Expected the progress workflow step to be claimed.');

    const state = await store.getRunState({ runId: created.run.id, userId });

    expect(state?.run).toMatchObject({
      id: created.run.id,
      startedAt: expect.any(String),
      status: 'running',
    });
    expect(state?.nodes).toEqual([
      expect.objectContaining({
        attemptCount: 1,
        definitionId: 'generate',
        instanceId: 'generate',
        maxAttempts: 3,
        status: 'running',
      }),
    ]);
    expect(state?.nodes[0]).not.toHaveProperty('input');
    expect(state?.nodes[0]).not.toHaveProperty('output');
    expect(state?.run).not.toHaveProperty('input');
    expect(state?.run).not.toHaveProperty('output');
    expect(state?.run).not.toHaveProperty('resolvedConfig');
    expect(state?.run).not.toHaveProperty('stepPolicies');
    expect(state?.run).not.toHaveProperty('userId');
    await sql`delete from public.workflow_runs where id = ${created.run.id}`;
  });
});
