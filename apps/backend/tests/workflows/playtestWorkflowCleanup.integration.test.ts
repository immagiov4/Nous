import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settleAccountWorkflows } from '../../../../e2e/nous/workflowCleanup';
import {
  createPostgresWorkflowIntegrationContext,
  createStore,
  registeredStepWorkflow,
  setupPostgresWorkflowIntegrationContext,
  stepMaterialization,
  teardownPostgresWorkflowIntegrationContext,
} from './postgresWorkflowStore.integration.fixture';

const own = createPostgresWorkflowIntegrationContext();
const other = createPostgresWorkflowIntegrationContext();
describe.skipIf(!own.enabled)('account workflow cleanup isolation', () => {
  beforeAll(async () => {
    await setupPostgresWorkflowIntegrationContext(own);
    await setupPostgresWorkflowIntegrationContext(other);
  });
  afterAll(async () => {
    await teardownPostgresWorkflowIntegrationContext(own);
    await teardownPostgresWorkflowIntegrationContext(other);
  });
  it('leaves another account active while the target account is settled', async () => {
    assert(own.sql && other.sql);
    const definition = registeredStepWorkflow(`cleanup-${randomUUID()}`, 'step');
    const input = { content: 'Synthetic workflow input' };
    const foreignId = randomUUID();
    for (const context of [own, other]) {
      assert(context.sql);
      await createStore(context.sql).createRun({
        id: context === own ? randomUUID() : foreignId,
        userId: context.userId,
        projectId: context.projectId,
        workflowId: definition.id,
        definitionHash: definition.definitionHash,
        definitionHashVersion: definition.definitionHashVersion,
        requestKey: randomUUID(),
        config: definition.executionDefaults,
        input,
        materialization:
          context === own
            ? { ...stepMaterialization(input, 'step'), nodes: [], completedOutput: input }
            : stepMaterialization(input, 'step'),
      });
    }
    await settleAccountWorkflows(own.sql, own.userId);
    const [foreign] =
      await other.sql`select status, cancellation_requested from public.workflow_runs where id = ${foreignId}`;
    expect(foreign).toMatchObject({ status: 'queued', cancellation_requested: false });
  });
});
