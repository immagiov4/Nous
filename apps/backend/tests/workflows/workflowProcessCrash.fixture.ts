import postgres, { type Sql } from 'postgres';
import * as z from 'zod';

import type { ProjectAssetObjectStorage } from '../../src/projects/projectAsset.js';
import { WorkflowExecutionDefaultsSchema } from '../../src/workflows/config.js';
import {
  createWorkflowRegistry,
  fanOut,
  sequence,
  step,
  waitForSignal,
  workflow,
} from '../../src/workflows/definition.js';
import { PostgresWorkflowStore } from '../../src/workflows/postgresWorkflowStore.js';
import type { WorkflowDefinition, WorkflowExecutionDefaults } from '../../src/workflows/types.js';
import { runWorkflowStepClaim } from '../../src/workflows/workflowStepRunner.js';
import { runWorkflowUndoClaim } from '../../src/workflows/workflowUndoRunner.js';

const TEST_LEASE_MS = 60_000;
const Payload = z.object({ content: z.string() });
const FanPayload = z.object({ values: z.array(z.string()) });
const ApprovalPayload = z.object({ approved: z.literal(true) });

export const crashTestAssetStorage: ProjectAssetObjectStorage = {
  delete: async () => {
    throw new Error('Crash recovery must not delete project asset objects.');
  },
  download: async () => {
    throw new Error('Crash recovery must not download project asset objects.');
  },
  upload: async () => {
    throw new Error('Crash recovery must not upload project asset objects.');
  },
};

interface CrashEffectIdentity {
  readonly idempotencyKey: string;
  readonly operation: string;
  readonly runId: string;
}

export interface CrashEffectServices {
  recordEffect(input: CrashEffectIdentity): Promise<void>;
}

export const recordCrashEffect = async (
  sql: Sql,
  input: CrashEffectIdentity & { readonly completed: boolean }
): Promise<void> => {
  await sql`
    insert into public.workflow_crash_effects (
      idempotency_key, run_id, operation, completed
    ) values (
      ${input.idempotencyKey}, ${input.runId}, ${input.operation}, ${input.completed}
    )
    on conflict (idempotency_key) do update
    set invocation_count = public.workflow_crash_effects.invocation_count + 1,
        completed = public.workflow_crash_effects.completed or excluded.completed
  `;
};

export const createCrashEffectWorkflowDefinition = () => {
  const effect = step<
    typeof Payload,
    typeof Payload,
    WorkflowExecutionDefaults,
    CrashEffectServices
  >({
    id: 'effect',
    inputSchema: Payload,
    outputSchema: Payload,
    run: async ({ execution, idempotencyKey, input, services }) => {
      await services.recordEffect({
        idempotencyKey,
        operation: 'step',
        runId: execution.runId,
      });
      return input;
    },
  });
  return workflow({
    compatibilityId: 'test-v1',
    configSchema: WorkflowExecutionDefaultsSchema,
    executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
    id: 'process-crash-effect-test',
    inputSchema: Payload,
    outputSchema: Payload,
    root: effect,
  });
};

export const createCrashFanOutWorkflowDefinition = () => {
  const worker = step<z.ZodString, z.ZodString, WorkflowExecutionDefaults, CrashEffectServices>({
    id: 'worker',
    inputSchema: z.string(),
    outputSchema: z.string(),
    run: async ({ execution, idempotencyKey, input, services }) => {
      await services.recordEffect({
        idempotencyKey,
        operation: 'fanout',
        runId: execution.runId,
      });
      return input.toUpperCase();
    },
  });
  return workflow({
    compatibilityId: 'test-v1',
    configSchema: WorkflowExecutionDefaultsSchema,
    executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
    id: 'process-crash-fanout-test',
    inputSchema: FanPayload,
    outputSchema: FanPayload,
    root: fanOut({
      failureMode: 'collect',
      fanIn: results => ({
        values: results.flatMap(result => (result.status === 'completed' ? [result.output] : [])),
      }),
      id: 'fan',
      inputSchema: FanPayload,
      inputs: input => input.values,
      itemSchema: z.string(),
      keyBy: input => input,
      outputSchema: FanPayload,
      worker,
    }),
  });
};

export const createCrashSignalWorkflowDefinition = () =>
  workflow({
    compatibilityId: 'test-v1',
    configSchema: WorkflowExecutionDefaultsSchema,
    executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
    id: 'process-crash-signal-test',
    inputSchema: Payload,
    outputSchema: Payload,
    root: waitForSignal({
      id: 'approval',
      inputSchema: Payload,
      outputSchema: Payload,
      payloadSchema: ApprovalPayload,
      resume: (input, signal) => ({
        content: `${input.content}:${signal.approved}`,
      }),
      signal: 'approve',
    }),
    signals: {
      approve: { schema: ApprovalPayload, schemaVersion: 1 },
    },
  });

export const createCrashUndoWorkflowDefinition = () => {
  const reversible = step<
    typeof Payload,
    typeof Payload,
    WorkflowExecutionDefaults,
    CrashEffectServices
  >({
    id: 'reversible',
    inputSchema: Payload,
    outputSchema: Payload,
    run: async ({ input }) => ({ content: `${input.content}:prepared` }),
    undo: async ({ execution, idempotencyKey, services }) => {
      await services.recordEffect({
        idempotencyKey,
        operation: 'undo',
        runId: execution.runId,
      });
    },
  });
  const finish = step<
    typeof Payload,
    typeof Payload,
    WorkflowExecutionDefaults,
    CrashEffectServices
  >({
    id: 'finish',
    inputSchema: Payload,
    outputSchema: Payload,
    run: async ({ input }) => input,
  });
  return workflow({
    compatibilityId: 'test-v1',
    configSchema: WorkflowExecutionDefaultsSchema,
    executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
    id: 'process-crash-undo-test',
    inputSchema: Payload,
    outputSchema: Payload,
    root: sequence({ id: 'root', nodes: [reversible, finish] }),
  });
};

export const createPreviousDeployWorkflowDefinition = () =>
  workflow({
    compatibilityId: 'test-v1',
    configSchema: WorkflowExecutionDefaultsSchema,
    executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
    id: 'process-crash-deploy-test',
    inputSchema: Payload,
    outputSchema: Payload,
    root: step({
      id: 'generate-v1',
      inputSchema: Payload,
      outputSchema: Payload,
      run: async ({ input }) => ({ content: `${input.content}:v1` }),
    }),
  });

export const createCurrentDeployWorkflowDefinition = () =>
  workflow({
    compatibilityId: 'test-v1',
    configSchema: WorkflowExecutionDefaultsSchema,
    executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
    id: 'process-crash-deploy-test',
    inputSchema: Payload,
    outputSchema: Payload,
    root: step({
      id: 'generate-v2',
      inputSchema: Payload,
      outputSchema: Payload,
      run: async ({ input }) => ({ content: `${input.content}:v2` }),
    }),
  });

const holdProcess = async (): Promise<never> => new Promise<never>(() => undefined);

const announceAndHold = async (): Promise<never> => {
  process.stdout.write('READY\n');
  return holdProcess();
};

const requireEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Workflow crash fixture is missing ${name}.`);
  return value;
};

const register = (definition: WorkflowDefinition) => {
  const registry = createWorkflowRegistry();
  registry.register({ current: definition });
  return registry;
};

const runStepUntilKilled = async (
  store: PostgresWorkflowStore,
  registry: ReturnType<typeof createWorkflowRegistry>,
  services: CrashEffectServices,
  expectedRunId: string
): Promise<never> => {
  const claim = await store.steps.claimNext({
    leaseMs: TEST_LEASE_MS,
    supportedDefinitions: registry.listRegisteredBoundaries(),
    workerId: `crash-step:${process.pid}`,
  });
  if (claim?.runId !== expectedRunId) throw new Error('Crash fixture claimed the wrong step.');
  await runWorkflowStepClaim({ claim, registry, services, store });
  throw new Error('Crash fixture step unexpectedly completed.');
};

const runUndoUntilKilled = async (
  store: PostgresWorkflowStore,
  registry: ReturnType<typeof createWorkflowRegistry>,
  services: CrashEffectServices,
  expectedRunId: string
): Promise<never> => {
  const claim = await store.undo.claimNext({
    leaseMs: TEST_LEASE_MS,
    supportedDefinitions: registry.listRegisteredBoundaries(),
    workerId: `crash-undo:${process.pid}`,
  });
  if (claim?.runId !== expectedRunId) throw new Error('Crash fixture claimed the wrong undo.');
  await runWorkflowUndoClaim({ claim, registry, services, store: store.undo });
  throw new Error('Crash fixture undo unexpectedly completed.');
};

const runFixture = async (): Promise<never> => {
  const databaseUrl = requireEnvironment('WORKFLOW_INTEGRATION_DATABASE_URL');
  const expectedRunId = requireEnvironment('WORKFLOW_CRASH_RUN_ID');
  const mode = requireEnvironment('WORKFLOW_CRASH_MODE');
  const sql = postgres(databaseUrl, { max: 1 });
  const store = new PostgresWorkflowStore({
    enforceCurrentDefinitions: false,
    logger: { log: () => undefined },
    projectAssetStorage: crashTestAssetStorage,
    sqlClient: sql,
  });
  const blockingEffects = (completed: boolean): CrashEffectServices => ({
    recordEffect: async input => {
      await recordCrashEffect(sql, { ...input, completed });
      await announceAndHold();
    },
  });

  if (mode === 'before-claim' || mode === 'signal-before-consume') {
    return announceAndHold();
  }

  if (mode === 'step-claimed') {
    const boundaries = await sql<
      Array<{
        definition_hash: string;
        definition_hash_version: number;
        workflow_id: string;
      }>
    >`
      select workflow_id, definition_hash, definition_hash_version
      from public.workflow_runs
      where id = ${expectedRunId}
    `;
    const claim = await store.steps.claimNext({
      leaseMs: TEST_LEASE_MS,
      supportedDefinitions: boundaries.map(boundary => ({
        definitionHash: boundary.definition_hash,
        definitionHashVersion: boundary.definition_hash_version,
        workflowId: boundary.workflow_id,
      })),
      workerId: `crash-step:${process.pid}`,
    });
    if (claim?.runId !== expectedRunId) throw new Error('Crash fixture claimed the wrong step.');
    return announceAndHold();
  }

  if (mode === 'notification-claimed') {
    const claim = await store.outbox.claimNext({
      leaseMs: TEST_LEASE_MS,
      workerId: `crash-notification:${process.pid}`,
    });
    if (claim?.runId !== expectedRunId) {
      throw new Error('Crash fixture claimed the wrong notification.');
    }
    return announceAndHold();
  }

  if (mode === 'step-effect-running') {
    return runStepUntilKilled(
      store,
      register(createCrashEffectWorkflowDefinition()),
      blockingEffects(false),
      expectedRunId
    );
  }

  if (mode === 'fanout-after-effect') {
    return runStepUntilKilled(
      store,
      register(createCrashFanOutWorkflowDefinition()),
      blockingEffects(true),
      expectedRunId
    );
  }

  if (mode === 'signal-after-consume') {
    const registry = register(createCrashSignalWorkflowDefinition());
    const result = await store.signals.receive({
      payload: { approved: true },
      requestKey: requireEnvironment('WORKFLOW_CRASH_SIGNAL_REQUEST_KEY'),
      resolveDefinition: boundary => {
        const definition = registry.resolve(boundary.workflowId, boundary.definitionHash);
        return definition?.definitionHashVersion === boundary.definitionHashVersion
          ? definition
          : null;
      },
      runId: expectedRunId,
      signalType: 'approve',
      userId: requireEnvironment('WORKFLOW_CRASH_USER_ID'),
      waitId: requireEnvironment('WORKFLOW_CRASH_WAIT_ID'),
    });
    if (result.status !== 'consumed') throw new Error('Crash fixture did not consume the signal.');
    return announceAndHold();
  }

  if (mode === 'undo-after-effect') {
    return runUndoUntilKilled(
      store,
      register(createCrashUndoWorkflowDefinition()),
      blockingEffects(true),
      expectedRunId
    );
  }

  throw new Error(`Unsupported workflow crash fixture mode: ${mode}`);
};

if (import.meta.main) await runFixture();
