import { randomUUID } from 'node:crypto';

import type { Sql, TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WorkflowExecutionDefaultsSchema } from '../../src/workflows/config.js';
import {
  createWorkflowRegistry,
  sequence,
  step,
  workflow,
} from '../../src/workflows/definition.js';
import { materializeWorkflowStart } from '../../src/workflows/materialization.js';
import { failPermanently, retryOperational } from '../../src/workflows/retryPolicy.js';
import { reconcileUnavailableWorkflowDefinitions } from '../../src/workflows/workflowDefinitionReconciler.js';
import {
  claimNextStep,
  claimNextUndo,
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

const createDeferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>(release => {
    resolve = release;
  });
  return { promise, resolve };
};

const pauseAfterTerminalCandidateSelection = (
  client: Sql,
  onSelected: () => void,
  resume: Promise<void>
): Sql => {
  let paused = false;
  return new Proxy(client, {
    get(target, property) {
      if (property === 'begin') {
        return (callback: (transaction: TransactionSql) => Promise<unknown>) =>
          target.begin(async transaction => {
            const intercepted = new Proxy(transaction, {
              apply(sqlTag, _thisArgument, argumentsList) {
                const pending = Reflect.apply(sqlTag, transaction, argumentsList);
                const strings = argumentsList[0];
                if (paused || !Array.isArray(strings)) return pending;
                const query = strings.join(' ').replaceAll(/\s+/g, ' ');
                if (
                  !query.includes('select run.id') ||
                  !query.includes('from public.workflow_runs run') ||
                  !query.includes('order by run.updated_at, run.id')
                ) {
                  return pending;
                }
                return Promise.resolve(pending).then(async rows => {
                  if (Array.isArray(rows) && rows.length > 0) {
                    paused = true;
                    onSelected();
                    await resume;
                  }
                  return rows;
                });
              },
              get(sqlTag, property) {
                const value = Reflect.get(sqlTag, property, sqlTag);
                return typeof value === 'function' ? value.bind(sqlTag) : value;
              },
            }) as TransactionSql;
            return callback(intercepted);
          });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Sql;
};

const context = createPostgresWorkflowIntegrationContext();
const { projectId, sql, userId } = context;

describe.skipIf(!context.enabled)('PostgresWorkflowStore undo integration', () => {
  beforeAll(() => setupPostgresWorkflowIntegrationContext(context));
  afterAll(() => teardownPostgresWorkflowIntegrationContext(context));

  test('materializes and completes undo in reverse checkpoint order without replacing the run error', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    await withPostgresWorkflowTestLock(
      sql,
      POSTGRES_WORKFLOW_TEST_LOCK.terminalReconciliation,
      async () => {
        const store = createStore(sql);
        const first = step({
          id: 'first',
          inputSchema: Payload,
          outputSchema: Payload,
          run: async ({ input }) => input,
          undo: async () => {},
        });
        const second = step({
          id: 'second',
          inputSchema: Payload,
          outputSchema: Payload,
          run: async ({ input }) => input,
          undo: async () => {},
        });
        const finish = step({
          id: 'finish',
          inputSchema: Payload,
          outputSchema: Payload,
          run: async ({ input }) => input,
        });
        const definition = createWorkflowRegistry().register({
          current: workflow({
            compatibilityId: 'test-v1',
            configSchema: WorkflowExecutionDefaultsSchema,
            executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
            id: 'undo-order-test',
            inputSchema: Payload,
            outputSchema: Payload,
            root: sequence({ id: 'root', nodes: [first, second, finish] }),
          }),
        }).current;
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

        for (const nodeDefinitionId of ['first', 'second']) {
          const claim = await claimNextStep(store, definition, 'worker-run');
          expect(claim?.nodeDefinitionId).toBe(nodeDefinitionId);
          if (!claim) throw new Error(`Expected ${nodeDefinitionId} workflow claim.`);
          await store.checkpointStep({
            claim,
            definition,
            output: { content: `${nodeDefinitionId}-output` },
          });
        }
        const failingClaim = await claimNextStep(store, definition, 'worker-run');
        expect(failingClaim?.nodeDefinitionId).toBe('finish');
        if (!failingClaim) throw new Error('Expected the failing workflow claim.');
        await store.steps.recordFailure({
          claim: failingClaim,
          definition,
          failure: failPermanently({
            code: 'finalization_failed',
            message: 'Finalization failed.',
          }).failure,
        });
        expect(await store.cancellation.reconcileNext()).toMatchObject({
          cleanupStatus: 'pending',
          runId: created.run.id,
          runStatus: 'failed',
        });

        const secondUndo = await claimNextUndo(store, definition, 'worker-undo');
        expect(secondUndo).toMatchObject({
          input: { content: 'first-output' },
          nodeDefinitionId: 'second',
          output: { content: 'second-output' },
        });
        if (!secondUndo) throw new Error('Expected the second step undo claim.');
        expect(await store.undo.complete(secondUndo)).toEqual({ cleanupStatus: 'running' });

        const firstUndo = await claimNextUndo(store, definition, 'worker-undo');
        expect(firstUndo).toMatchObject({
          input: { content: 'draft' },
          nodeDefinitionId: 'first',
          output: { content: 'first-output' },
        });
        if (!firstUndo) throw new Error('Expected the first step undo claim.');
        expect(await store.undo.complete(firstUndo)).toEqual({ cleanupStatus: 'completed' });

        expect(await store.getRun({ runId: created.run.id, userId })).toMatchObject({
          cleanupStatus: 'completed',
          error: { code: 'finalization_failed' },
          status: 'failed',
        });
        await sql`delete from public.workflow_runs where id = ${created.run.id}`;
      }
    );
  });

  test('requeues only retryable exhausted undo on restart while retaining its failed attempt', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    await withPostgresWorkflowTestLock(
      sql,
      POSTGRES_WORKFLOW_TEST_LOCK.terminalReconciliation,
      async () => {
        const store = createStore(sql);
        const reversible = step({
          id: 'reversible',
          inputSchema: Payload,
          outputSchema: Payload,
          run: async ({ input }) => input,
          undo: async () => {},
        });
        const finish = step({
          id: 'finish',
          inputSchema: Payload,
          outputSchema: Payload,
          run: async ({ input }) => input,
        });
        const definition = createWorkflowRegistry().register({
          current: workflow({
            compatibilityId: 'test-v1',
            configSchema: WorkflowExecutionDefaultsSchema,
            executionDefaults: { maxAttempts: 1, timeoutMs: 60_000 },
            id: 'undo-restart-recovery-test',
            inputSchema: Payload,
            outputSchema: Payload,
            root: sequence({ id: 'root', nodes: [reversible, finish] }),
          }),
        }).current;
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

        const reversibleClaim = await claimNextStep(store, definition, 'worker-reversible');
        if (!reversibleClaim) throw new Error('Expected the reversible workflow claim.');
        await store.checkpointStep({
          claim: reversibleClaim,
          definition,
          output: { content: 'reversible-output' },
        });
        const failingClaim = await claimNextStep(store, definition, 'worker-failing');
        if (!failingClaim) throw new Error('Expected the failing workflow claim.');
        await store.steps.recordFailure({
          claim: failingClaim,
          definition,
          failure: failPermanently({ code: 'forced_failure', message: 'Forced failure.' }).failure,
        });
        await store.cancellation.reconcileNext();

        const failedUndo = await claimNextUndo(store, definition, 'worker-undo');
        if (!failedUndo) throw new Error('Expected the workflow undo claim.');
        const retryableFailure = retryOperational({
          code: 'undo_temporarily_unavailable',
          message: 'Undo is temporarily unavailable.',
        }).failure;
        expect(
          await store.undo.recordFailure({
            claim: failedUndo,
            failure: retryableFailure,
            random: () => 0,
          })
        ).toEqual({ status: 'failed' });

        await sql`
      update public.workflow_undo_runs
      set error = ${sql.json(
        failPermanently({
          code: 'workflow_undo_definition_incompatible',
          message: 'The workflow undo definition is unavailable.',
        }).failure
      )}
      where run_id = ${created.run.id} and node_instance_id = 'root/reversible'
    `;
        expect(
          await store.undo.requeueFailed({ supportedDefinitions: [definitionBoundary(definition)] })
        ).toBe(0);
        expect(await store.getRun({ runId: created.run.id, userId })).toMatchObject({
          cleanupStatus: 'failed',
        });

        await sql`
      update public.workflow_undo_runs
      set error = ${sql.json(retryableFailure)}
      where run_id = ${created.run.id} and node_instance_id = 'root/reversible'
    `;

        expect(
          await store.undo.requeueFailed({
            supportedDefinitions: [
              {
                definitionHash: '0'.repeat(64),
                definitionHashVersion: definition.definitionHashVersion,
                workflowId: definition.id,
              },
            ],
          })
        ).toBe(0);
        expect(await store.getRun({ runId: created.run.id, userId })).toMatchObject({
          cleanupStatus: 'failed',
        });
        expect(
          await store.undo.requeueFailed({ supportedDefinitions: [definitionBoundary(definition)] })
        ).toBe(1);
        const requeued = await sql`
      select attempt_count, error, max_attempts, status
      from public.workflow_undo_runs
      where run_id = ${created.run.id} and node_instance_id = 'root/reversible'
    `;
        expect(requeued).toEqual([
          {
            attempt_count: 1,
            error: expect.objectContaining({ code: 'undo_temporarily_unavailable' }),
            max_attempts: 2,
            status: 'retrying',
          },
        ]);

        const recoveredUndo = await claimNextUndo(store, definition, 'worker-undo-after-restart');
        expect(recoveredUndo).toMatchObject({ attemptNumber: 2, maxAttempts: 2 });
        if (!recoveredUndo) throw new Error('Expected the requeued workflow undo claim.');
        expect(await store.undo.complete(recoveredUndo)).toEqual({ cleanupStatus: 'completed' });
        expect(
          await sql`
        select attempt_number, status
        from public.workflow_undo_attempts
        where run_id = ${created.run.id}
        order by attempt_number
      `
        ).toEqual([
          { attempt_number: 1, status: 'failed' },
          { attempt_number: 2, status: 'completed' },
        ]);
        expect(await store.getRun({ runId: created.run.id, userId })).toMatchObject({
          cleanupStatus: 'completed',
          error: { code: 'forced_failure' },
          status: 'failed',
        });
        await sql`delete from public.workflow_runs where id = ${created.run.id}`;
      }
    );
  });

  test('does not reopen completed cleanup from a concurrently selected stale candidate', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    await withPostgresWorkflowTestLock(
      sql,
      POSTGRES_WORKFLOW_TEST_LOCK.terminalReconciliation,
      async () => {
        const store = createStore(sql);
        const reversible = step({
          id: 'reversible',
          inputSchema: Payload,
          outputSchema: Payload,
          run: async ({ input }) => input,
          undo: async () => {},
        });
        const finish = step({
          id: 'finish',
          inputSchema: Payload,
          outputSchema: Payload,
          run: async ({ input }) => input,
        });
        const definition = createWorkflowRegistry().register({
          current: workflow({
            compatibilityId: 'test-v1',
            configSchema: WorkflowExecutionDefaultsSchema,
            executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
            id: 'concurrent-cleanup-reconciliation-test',
            inputSchema: Payload,
            outputSchema: Payload,
            root: sequence({ id: 'root', nodes: [reversible, finish] }),
          }),
        }).current;
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

        const reversibleClaim = await claimNextStep(store, definition, 'worker-reversible');
        if (!reversibleClaim) throw new Error('Expected the reversible workflow claim.');
        await store.checkpointStep({
          claim: reversibleClaim,
          definition,
          output: { content: 'reversible-output' },
        });
        const failingClaim = await claimNextStep(store, definition, 'worker-failing');
        if (!failingClaim) throw new Error('Expected the failing workflow claim.');
        await store.steps.recordFailure({
          claim: failingClaim,
          definition,
          failure: failPermanently({
            code: 'forced_failure',
            message: 'Forced failure.',
          }).failure,
        });

        const candidateSelected = createDeferred();
        const resumeStaleReconciler = createDeferred();
        const staleStore = createStore(
          pauseAfterTerminalCandidateSelection(
            sql,
            candidateSelected.resolve,
            resumeStaleReconciler.promise
          )
        );
        const staleReconciliation = staleStore.cancellation.reconcileNext();
        await candidateSelected.promise;

        let concurrentWorkError: unknown;
        try {
          expect(await store.cancellation.reconcileNext()).toEqual({
            cleanupStatus: 'pending',
            runId: created.run.id,
            runStatus: 'failed',
          });
          const undoClaim = await claimNextUndo(store, definition, 'worker-undo-concurrent');
          if (!undoClaim) throw new Error('Expected the workflow undo claim.');
          expect(await store.undo.complete(undoClaim)).toEqual({ cleanupStatus: 'completed' });
        } catch (error) {
          concurrentWorkError = error;
        } finally {
          resumeStaleReconciler.resolve();
        }

        expect(await staleReconciliation).toBeNull();
        if (concurrentWorkError) throw concurrentWorkError;
        expect(await store.getRun({ runId: created.run.id, userId })).toMatchObject({
          cleanupStatus: 'completed',
          status: 'failed',
        });
        await sql`delete from public.workflow_runs where id = ${created.run.id}`;
      }
    );
  });

  test('fences queued and running undo when their definition is removed', async () => {
    if (!sql) throw new Error('Workflow integration database is required.');
    await withPostgresWorkflowTestLock(
      sql,
      POSTGRES_WORKFLOW_TEST_LOCK.terminalReconciliation,
      async () => {
        const store = createStore(sql, { enforceCurrentDefinitions: true });
        const workflowId = 'removed-undo-definition-test';
        const reversible = step({
          id: 'reversible',
          inputSchema: Payload,
          outputSchema: Payload,
          run: async ({ input }) => input,
          undo: async () => {},
        });
        const finish = step({
          id: 'finish',
          inputSchema: Payload,
          outputSchema: Payload,
          run: async ({ input }) => input,
        });
        const versionOneRegistry = createWorkflowRegistry();
        const versionOne = versionOneRegistry.register({
          current: workflow({
            compatibilityId: 'test-v1',
            configSchema: WorkflowExecutionDefaultsSchema,
            executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
            id: workflowId,
            inputSchema: Payload,
            outputSchema: Payload,
            root: sequence({ id: 'root', nodes: [reversible, finish] }),
          }),
        }).current;
        const versionTwo = registeredStepWorkflow(workflowId, 'replacement');
        const rollingRegistry = createWorkflowRegistry();
        rollingRegistry.register({
          current: versionTwo,
          previous: versionOne,
        });
        const killSwitchRegistry = createWorkflowRegistry();
        killSwitchRegistry.register({ current: versionTwo });
        await sql`
          delete from public.workflow_definition_deployments where workflow_id = ${workflowId}
        `;

        const createFailedRun = async (content: string): Promise<string> => {
          const created = await store.createRun({
            config: versionOne.executionDefaults,
            definitionHash: versionOne.definitionHash,
            definitionHashVersion: versionOne.definitionHashVersion,
            id: randomUUID(),
            input: { content },
            materialization: materializeWorkflowStart(
              versionOne,
              { content },
              { resolvedConfig: versionOne.executionDefaults }
            ),
            projectId,
            requestKey: randomUUID(),
            userId,
            workflowId,
          });
          const reversibleClaim = await claimNextStep(store, versionOne, `${content}-reversible`);
          if (!reversibleClaim) throw new Error('Expected the reversible workflow claim.');
          await store.checkpointStep({
            claim: reversibleClaim,
            definition: versionOne,
            output: { content: `${content}-output` },
          });
          const failingClaim = await claimNextStep(store, versionOne, `${content}-failing`);
          if (!failingClaim) throw new Error('Expected the failing workflow claim.');
          await store.steps.recordFailure({
            claim: failingClaim,
            definition: versionOne,
            failure: failPermanently({ code: 'forced_failure', message: 'Forced failure.' })
              .failure,
          });
          await expect(store.cancellation.reconcileNext()).resolves.toMatchObject({
            cleanupStatus: 'pending',
            runId: created.run.id,
          });
          return created.run.id;
        };

        try {
          await reconcileUnavailableWorkflowDefinitions({
            registry: versionOneRegistry,
            store: store.definitionReconciliation,
          });
          const runningUndoRunId = await createFailedRun('running-undo');
          const queuedUndoRunId = await createFailedRun('queued-undo');
          const runningUndo = await claimNextUndo(store, versionOne, 'removed-undo-worker');
          if (!runningUndo) throw new Error('Expected the running workflow undo claim.');
          expect(runningUndo.runId).toBe(runningUndoRunId);

          await reconcileUnavailableWorkflowDefinitions({
            registry: rollingRegistry,
            store: store.definitionReconciliation,
          });
          await store.definitionReconciliation.activateDeployments(
            killSwitchRegistry.listDefinitionDeployments()
          );
          await expect(
            store.undo.heartbeat({ claim: runningUndo, leaseMs: 60_000 })
          ).resolves.toEqual({ status: 'lost' });
          await expect(store.undo.complete(runningUndo)).rejects.toMatchObject({
            name: 'WorkflowUndoLeaseLostError',
          });
          await expect(
            store.undo.recordFailure({
              claim: runningUndo,
              failure: failPermanently({
                code: 'too_late',
                message: 'The undo result arrived after its definition was removed.',
              }).failure,
            })
          ).rejects.toMatchObject({ name: 'WorkflowUndoLeaseLostError' });
          await expect(
            reconcileUnavailableWorkflowDefinitions({
              registry: killSwitchRegistry,
              store: store.definitionReconciliation,
            })
          ).resolves.toEqual(expect.arrayContaining([runningUndoRunId, queuedUndoRunId]));

          await expect(
            claimNextUndo(store, versionOne, 'removed-undo-stale-worker')
          ).resolves.toBeNull();
          await expect(
            store.undo.recoverNextExpired({
              random: () => 0,
              supportedDefinitions: [definitionBoundary(versionOne)],
            })
          ).resolves.toBeNull();
          await expect(
            store.undo.requeueFailed({
              supportedDefinitions: [definitionBoundary(versionOne)],
            })
          ).resolves.toBe(0);
          await expect(
            store.undo.heartbeat({ claim: runningUndo, leaseMs: 60_000 })
          ).resolves.toEqual({ status: 'lost' });
          await expect(store.undo.complete(runningUndo)).rejects.toMatchObject({
            name: 'WorkflowUndoLeaseLostError',
          });

          expect(
            await sql`
              select id::text, cleanup_status
              from public.workflow_runs
              where id in (${runningUndoRunId}, ${queuedUndoRunId})
              order by id
            `
          ).toEqual(
            [runningUndoRunId, queuedUndoRunId].sort().map(id => ({ cleanup_status: 'failed', id }))
          );
          expect(
            await sql`
              select run_id::text, status, error ->> 'code' as error_code
              from public.workflow_undo_runs
              where run_id in (${runningUndoRunId}, ${queuedUndoRunId})
              order by run_id
            `
          ).toEqual(
            [runningUndoRunId, queuedUndoRunId].sort().map(runId => ({
              error_code: 'workflow_definition_unavailable',
              run_id: runId,
              status: 'failed',
            }))
          );
          expect(
            await sql`
              select status, error ->> 'code' as error_code
              from public.workflow_undo_attempts
              where run_id = ${runningUndoRunId}
            `
          ).toEqual([{ error_code: 'workflow_definition_unavailable', status: 'lost' }]);
        } finally {
          await sql`delete from public.workflow_runs where workflow_id = ${workflowId}`;
          await sql`
            delete from public.workflow_definition_deployments where workflow_id = ${workflowId}
          `;
        }
      }
    );
  });
});
