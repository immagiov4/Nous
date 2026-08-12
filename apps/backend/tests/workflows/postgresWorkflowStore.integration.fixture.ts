import { randomUUID } from 'node:crypto';

import postgres, { type Sql } from 'postgres';
import * as z from 'zod';
import type { ProjectAssetObjectStorage } from '../../src/projects/projectAsset.js';
import { WorkflowExecutionDefaultsSchema } from '../../src/workflows/config.js';
import {
  createWorkflowRegistry,
  emit,
  sequence,
  step,
  workflow,
} from '../../src/workflows/definition.js';
import type { WorkflowStartMaterialization } from '../../src/workflows/materialization.js';
import { PostgresWorkflowStore } from '../../src/workflows/postgresWorkflowStore.js';
import type { RegisteredWorkflow } from '../../src/workflows/types.js';

export interface PostgresWorkflowIntegrationContext {
  enabled: boolean;
  projectId: string;
  sql: Sql | null;
  userId: string;
}

export const POSTGRES_WORKFLOW_TEST_LOCK = {
  outboxClaim: 'nous-workflow-it:outbox-claim',
  terminalReconciliation: 'nous-workflow-it:terminal-reconciliation',
} as const;

type PostgresWorkflowTestLock =
  (typeof POSTGRES_WORKFLOW_TEST_LOCK)[keyof typeof POSTGRES_WORKFLOW_TEST_LOCK];

const unusedAssetStorage: ProjectAssetObjectStorage = {
  delete: async () => {
    throw new Error('Workflow persistence integration must not delete project asset objects.');
  },
  download: async () => {
    throw new Error('Workflow persistence integration must not download project asset objects.');
  },
  upload: async () => {
    throw new Error('Workflow persistence integration must not upload project asset objects.');
  },
};

export const createPostgresWorkflowIntegrationContext = (): PostgresWorkflowIntegrationContext => {
  const shouldRun = process.env.RUN_WORKFLOW_INTEGRATION_TESTS === '1';
  const databaseUrl = process.env.WORKFLOW_INTEGRATION_DATABASE_URL;
  if (shouldRun && !databaseUrl) {
    throw new Error(
      'WORKFLOW_INTEGRATION_DATABASE_URL is required for workflow integration tests.'
    );
  }

  return {
    enabled: Boolean(shouldRun && databaseUrl),
    projectId: `workflow-runtime-${randomUUID()}`,
    sql: shouldRun && databaseUrl ? postgres(databaseUrl, { max: 4 }) : null,
    userId: randomUUID(),
  };
};

export const setupPostgresWorkflowIntegrationContext = async (
  context: PostgresWorkflowIntegrationContext
): Promise<void> => {
  const { projectId, sql, userId } = context;
  if (!sql) throw new Error('Workflow integration database is required.');
  await sql`
    insert into auth.users (id, aud, role, created_at, updated_at)
    values (${userId}, 'authenticated', 'authenticated', now(), now())
  `;
  await sql`
    insert into public.projects (user_id, id, meta, updated_at, last_opened_at)
    values (${userId}, ${projectId}, '{}'::jsonb, now(), now())
  `;
};

export const teardownPostgresWorkflowIntegrationContext = async (
  context: PostgresWorkflowIntegrationContext
): Promise<void> => {
  const { sql, userId } = context;
  if (!sql) return;
  await sql`delete from auth.users where id = ${userId}`;
  await sql.end();
};

export const withPostgresWorkflowTestLock = <Result>(
  sql: Sql,
  lock: PostgresWorkflowTestLock,
  run: () => Promise<Result>
): Promise<Result> =>
  sql.begin(async transaction => {
    await transaction`select pg_advisory_xact_lock(hashtext(${lock})::bigint)`;
    return run();
  });

export const createStore = (
  sqlClient: Sql,
  options: {
    definitionDeploymentScope?: string;
    enforceCurrentDefinitions?: boolean;
    workflowSetVersion?: number;
  } = {}
): PostgresWorkflowStore =>
  new PostgresWorkflowStore({
    definitionDeploymentScope: options.definitionDeploymentScope ?? randomUUID(),
    enforceCurrentDefinitions: options.enforceCurrentDefinitions ?? false,
    projectAssetStorage: unusedAssetStorage,
    sqlClient,
    workflowSetVersion: options.workflowSetVersion,
  });

type ClaimableWorkflowDefinition = Pick<
  RegisteredWorkflow,
  'definitionHash' | 'definitionHashVersion' | 'id'
>;

export const definitionBoundary = (definition: ClaimableWorkflowDefinition) => ({
  definitionHash: definition.definitionHash,
  definitionHashVersion: definition.definitionHashVersion,
  workflowId: definition.id,
});

export const claimNextStep = (
  store: PostgresWorkflowStore,
  definition: ClaimableWorkflowDefinition,
  workerId: string
) =>
  store.steps.claimNext({
    leaseMs: 60_000,
    supportedDefinitions: [definitionBoundary(definition)],
    workerId,
  });

export const claimNextUndo = (
  store: PostgresWorkflowStore,
  definition: ClaimableWorkflowDefinition,
  workerId: string
) =>
  store.undo.claimNext({
    leaseMs: 60_000,
    supportedDefinitions: [definitionBoundary(definition)],
    workerId,
  });

export const Payload = z.object({ content: z.string() });

export const registeredStepWorkflow = (workflowId: string, stepId: string, eventType?: string) => {
  const generate = step({
    id: stepId,
    inputSchema: Payload,
    outputSchema: Payload,
    run: async ({ input }) => input,
  });
  const root = eventType
    ? sequence({
        id: 'root',
        nodes: [
          generate,
          emit({
            event: eventType,
            id: 'announce',
            inputSchema: Payload,
            payload: input => input,
          }),
        ],
      })
    : generate;
  return createWorkflowRegistry().register({
    current: workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      events: eventType
        ? { [eventType]: { durability: 'durable', schema: Payload, schemaVersion: 1 } }
        : {},
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: workflowId,
      inputSchema: Payload,
      outputSchema: Payload,
      root,
    }),
  }).current;
};

export const stepMaterialization = (
  input: unknown,
  definitionId: string
): WorkflowStartMaterialization => ({
  durableEvents: [],
  nodes: [
    {
      definitionId,
      hasUndo: false,
      input,
      instanceId: definitionId,
      kind: 'step',
      maxAttempts: 3,
      parentInstanceId: undefined,
      runtimeState: undefined,
      status: 'queued',
      timeoutMs: 60_000,
    },
  ],
  stepPolicies: {
    [definitionId]: {
      config: { maxAttempts: 3, timeoutMs: 60_000 },
      maxAttempts: 3,
      timeoutMs: 60_000,
    },
  },
  stepPoliciesVersion: 1,
  transientEvents: [],
  waits: [],
});
