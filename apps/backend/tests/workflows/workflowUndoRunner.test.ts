import { afterEach, describe, expect, test, vi } from 'vitest';
import * as z from 'zod';

import { WorkflowExecutionDefaultsSchema } from '../../src/workflows/config.js';
import { createWorkflowRegistry, step, workflow } from '../../src/workflows/definition.js';
import type { WorkflowUndoClaim } from '../../src/workflows/postgresWorkflowUndoStore.js';
import { WorkflowUndoLeaseLostError } from '../../src/workflows/postgresWorkflowUndoStore.js';
import { retryOperational } from '../../src/workflows/retryPolicy.js';
import type { RegisteredWorkflow } from '../../src/workflows/types.js';
import { workflowStepIdempotencyKey } from '../../src/workflows/workflowStepResolution.js';
import {
  runWorkflowUndoClaim,
  type WorkflowUndoRunnerStore,
  workflowUndoIdempotencyKey,
} from '../../src/workflows/workflowUndoRunner.js';

const Text = z.object({ text: z.string() });

const makeClaim = (
  definition: RegisteredWorkflow,
  overrides: Partial<WorkflowUndoClaim> = {}
): WorkflowUndoClaim => ({
  attemptNumber: 1,
  definitionHash: definition.definitionHash,
  definitionHashVersion: definition.definitionHashVersion,
  fencingToken: '1',
  input: { text: 'input' },
  leaseExpiresAt: '2026-07-29T12:00:00.000Z',
  maxAttempts: 3,
  nodeDefinitionId: 'child/work',
  nodeInstanceId: 'child/work',
  output: { text: 'output' },
  runId: '11111111-1111-4111-8111-111111111111',
  stepPolicies: {
    'child/work': {
      config: { maxAttempts: 3, timeoutMs: 60_000 },
      maxAttempts: 3,
      timeoutMs: 60_000,
    },
  },
  stepPoliciesVersion: 1,
  timeoutMs: 60_000,
  userId: '22222222-2222-4222-8222-222222222222',
  workerId: 'worker-1',
  workflowId: definition.id,
  ...overrides,
});

const makeStore = (overrides: Partial<WorkflowUndoRunnerStore> = {}): WorkflowUndoRunnerStore => ({
  complete: vi.fn(async () => ({ cleanupStatus: 'completed' as const })),
  heartbeat: vi.fn(async () => ({
    leaseExpiresAt: '2026-07-29T12:01:00.000Z',
    status: 'renewed' as const,
  })),
  recordFailure: vi.fn(async () => ({ status: 'failed' as const })),
  ...overrides,
});

const registerUndoWorkflow = (undo?: Parameters<typeof step>[0]['undo']) => {
  const work = step({
    id: 'work',
    inputSchema: Text,
    outputSchema: Text,
    run: async input => input.input,
    ...(undo ? { undo } : {}),
  });
  const registry = createWorkflowRegistry();
  const child = workflow({
    configSchema: WorkflowExecutionDefaultsSchema,
    executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
    id: 'child',
    inputSchema: Text,
    outputSchema: Text,
    root: work,
  });
  const registered = registry.register({
    current: workflow({
      configSchema: WorkflowExecutionDefaultsSchema,
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'undo-runner',
      inputSchema: Text,
      outputSchema: Text,
      root: child,
    }),
  }).current;
  return { registered, registry };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('single workflow undo runner', () => {
  test('validates durable boundaries and supplies a stable undo-specific idempotency key', async () => {
    const keys: string[] = [];
    const undo = vi.fn(async context => {
      keys.push(context.idempotencyKey);
      expect(context.execution).toEqual({
        nodeInstanceId: 'child/work',
        runId: '11111111-1111-4111-8111-111111111111',
      });
      expect(Object.isFrozen(context.execution)).toBe(true);
      expect(context.config).toEqual({ maxAttempts: 3, timeoutMs: 60_000 });
      expect(context.input).toEqual({ text: 'input' });
      expect(context.output).toEqual({ text: 'output' });
      expect(context.services).toEqual({ storage: 'test' });
      expect(context.signal).toBeInstanceOf(AbortSignal);
    });
    const { registered, registry } = registerUndoWorkflow(undo);
    const first = makeClaim(registered);
    const second = makeClaim(registered, { attemptNumber: 2, fencingToken: '2' });
    const firstStore = makeStore();
    const secondStore = makeStore();

    await runWorkflowUndoClaim({
      claim: first,
      registry,
      services: { storage: 'test' },
      store: firstStore,
    });
    await runWorkflowUndoClaim({
      claim: second,
      registry,
      services: { storage: 'test' },
      store: secondStore,
    });

    expect(keys).toEqual([workflowUndoIdempotencyKey(first), workflowUndoIdempotencyKey(first)]);
    expect(keys[0]).toBe(
      'workflow:undo:run:36:11111111-1111-4111-8111-111111111111:node:10:child/work'
    );
    expect(firstStore.complete).toHaveBeenCalledOnce();
    expect(secondStore.complete).toHaveBeenCalledOnce();
  });

  test('uses the same frozen step configuration for undo', async () => {
    const Config = WorkflowExecutionDefaultsSchema.extend({ mode: z.enum(['normal', 'fast']) });
    type Config = z.infer<typeof Config>;
    const observedConfigs: unknown[] = [];
    const work = step<typeof Text, typeof Text, Config>({
      config: { mode: 'fast' },
      id: 'work',
      inputSchema: Text,
      outputSchema: Text,
      run: async ({ input }) => input,
      undo: async ({ config }) => {
        observedConfigs.push(config);
      },
    });
    const child = workflow({
      configSchema: Config,
      executionDefaults: { maxAttempts: 3, mode: 'normal', timeoutMs: 60_000 },
      id: 'child',
      inputSchema: Text,
      outputSchema: Text,
      root: work,
    });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        configSchema: Config,
        executionDefaults: { maxAttempts: 3, mode: 'normal', timeoutMs: 60_000 },
        id: 'undo-step-config',
        inputSchema: Text,
        outputSchema: Text,
        root: child,
      }),
    }).current;

    await runWorkflowUndoClaim({
      claim: makeClaim(registered, {
        stepPolicies: {
          'child/work': {
            config: { maxAttempts: 3, mode: 'fast', timeoutMs: 60_000 },
            maxAttempts: 3,
            timeoutMs: 60_000,
          },
        },
      }),
      registry,
      services: {},
      store: makeStore(),
    });

    expect(observedConfigs).toEqual([{ maxAttempts: 3, mode: 'fast', timeoutMs: 60_000 }]);
  });

  test('keeps forward and undo idempotency keys disjoint for adversarial node ids', () => {
    const { registered } = registerUndoWorkflow(async () => undefined);
    const forwardClaim = {
      ...makeClaim(registered, { nodeInstanceId: 'child/work:undo' }),
      kind: 'step' as const,
      retryFeedback: '',
      stepPolicies: {
        'child/work': {
          config: { maxAttempts: 3, timeoutMs: 60_000 },
          maxAttempts: 3,
          timeoutMs: 60_000,
        },
      },
    };
    const undoClaim = makeClaim(registered, { nodeInstanceId: 'child/work' });

    expect(workflowStepIdempotencyKey(forwardClaim)).not.toBe(
      workflowUndoIdempotencyKey(undoClaim)
    );
  });

  test.each([
    ['missing definition', { workflowId: 'missing' }, 'workflow_definition_unavailable'],
    ['wrong definition version', { definitionHashVersion: 99 }, 'workflow_definition_incompatible'],
    ['unsupported policy version', { stepPoliciesVersion: 2 }, 'workflow_undo_policy_incompatible'],
    [
      'invalid configuration',
      {
        stepPolicies: {
          'child/work': {
            config: { maxAttempts: 'three', timeoutMs: 60_000 },
            maxAttempts: 3,
            timeoutMs: 60_000,
          },
        },
      },
      'workflow_undo_config_incompatible',
    ],
    ['invalid input', { input: { text: 42 } }, 'workflow_undo_input_incompatible'],
    ['invalid output', { output: { text: 42 } }, 'workflow_undo_output_incompatible'],
  ] as const)('records %s as a permanent failure', async (_name, overrides, code) => {
    const undo = vi.fn(async () => undefined);
    const { registered, registry } = registerUndoWorkflow(undo);
    const recordFailure = vi.fn(async () => ({ status: 'failed' as const }));

    await runWorkflowUndoClaim({
      claim: makeClaim(registered, overrides),
      registry,
      services: {},
      store: makeStore({ recordFailure }),
    });

    expect(recordFailure.mock.calls[0]?.[0].failure).toMatchObject({ code, kind: 'permanent' });
    expect(undo).not.toHaveBeenCalled();
  });

  test('requires the resolved step to declare undo', async () => {
    const { registered, registry } = registerUndoWorkflow();
    const recordFailure = vi.fn(async () => ({ status: 'failed' as const }));

    await runWorkflowUndoClaim({
      claim: makeClaim(registered),
      registry,
      services: {},
      store: makeStore({ recordFailure }),
    });

    expect(recordFailure.mock.calls[0]?.[0].failure).toMatchObject({
      code: 'workflow_undo_definition_incompatible',
      kind: 'permanent',
    });
  });

  test('normalizes callback failures before recording them', async () => {
    const { registered, registry } = registerUndoWorkflow(async () => {
      throw retryOperational({ code: 'storage_busy', message: 'Storage busy.' });
    });
    const recordFailure = vi.fn(async () => ({ status: 'retrying' as const }));

    await runWorkflowUndoClaim({
      claim: makeClaim(registered),
      registry,
      services: {},
      store: makeStore({ recordFailure }),
    });

    expect(recordFailure.mock.calls[0]?.[0].failure).toMatchObject({
      code: 'storage_busy',
      kind: 'operational',
    });
  });

  test('finishes on timeout when undo ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const { registered, registry } = registerUndoWorkflow(async () => new Promise<never>(() => {}));
    const recordFailure = vi.fn(async () => ({ status: 'retrying' as const }));
    const execution = runWorkflowUndoClaim({
      claim: makeClaim(registered, {
        stepPolicies: {
          'child/work': {
            config: { maxAttempts: 3, timeoutMs: 1_000 },
            maxAttempts: 3,
            timeoutMs: 1_000,
          },
        },
        timeoutMs: 1_000,
      }),
      registry,
      services: {},
      store: makeStore({ recordFailure }),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(execution).resolves.toMatchObject({ status: 'failure-recorded' });
    expect(recordFailure.mock.calls[0]?.[0].failure).toMatchObject({
      code: 'workflow_undo_timeout',
      kind: 'operational',
    });
  });

  test('finishes on heartbeat lease loss when undo ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const { registered, registry } = registerUndoWorkflow(async () => new Promise<never>(() => {}));
    const store = makeStore({
      heartbeat: vi
        .fn()
        .mockResolvedValueOnce({
          leaseExpiresAt: '2026-07-29T12:01:00.000Z',
          status: 'renewed' as const,
        })
        .mockResolvedValueOnce({ status: 'lost' as const }),
    });
    const execution = runWorkflowUndoClaim({
      claim: makeClaim(registered),
      heartbeatIntervalMs: 20,
      leaseMs: 60,
      registry,
      services: {},
      store,
    });

    await vi.advanceTimersByTimeAsync(20);
    await expect(execution).resolves.toEqual({ status: 'lease-lost' });
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.recordFailure).not.toHaveBeenCalled();
  });

  test('does not invoke undo when its initial heartbeat reports a lost lease', async () => {
    const undo = vi.fn(async () => undefined);
    const { registered, registry } = registerUndoWorkflow(undo);
    const store = makeStore({ heartbeat: vi.fn(async () => ({ status: 'lost' as const })) });

    await expect(
      runWorkflowUndoClaim({
        claim: makeClaim(registered),
        registry,
        services: {},
        store,
      })
    ).resolves.toEqual({ status: 'lease-lost' });

    expect(undo).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });

  test('stops waiting for an in-flight completion when its lease is lost', async () => {
    vi.useFakeTimers();
    const undo = vi.fn(async () => undefined);
    const { registered, registry } = registerUndoWorkflow(undo);
    const store = makeStore({
      complete: vi.fn(async () => new Promise<never>(() => {})),
      heartbeat: vi
        .fn()
        .mockResolvedValueOnce({
          leaseExpiresAt: '2026-07-29T12:01:00.000Z',
          status: 'renewed' as const,
        })
        .mockResolvedValueOnce({ status: 'lost' as const }),
    });
    const execution = runWorkflowUndoClaim({
      claim: makeClaim(registered),
      heartbeatIntervalMs: 20,
      leaseMs: 60,
      registry,
      services: {},
      store,
    });

    await vi.advanceTimersByTimeAsync(20);

    await expect(execution).resolves.toEqual({ status: 'lease-lost' });
    expect(undo).toHaveBeenCalledOnce();
    expect(store.complete).toHaveBeenCalledOnce();
    expect(store.recordFailure).not.toHaveBeenCalled();
  });

  test('retries transient completion without rerunning undo', async () => {
    vi.useFakeTimers();
    const undo = vi.fn(async () => undefined);
    const { registered, registry } = registerUndoWorkflow(undo);
    const complete = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('serialization'), { code: '40001' }))
      .mockResolvedValueOnce({ cleanupStatus: 'completed' as const });

    const execution = runWorkflowUndoClaim({
      claim: makeClaim(registered),
      registry,
      services: {},
      store: makeStore({ complete }),
    });
    await vi.advanceTimersByTimeAsync(2_500);
    await execution;

    expect(undo).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledTimes(2);
  });

  test('treats a fenced completion as lease loss', async () => {
    const undo = vi.fn(async () => undefined);
    const { registered, registry } = registerUndoWorkflow(undo);
    const recordFailure = vi.fn(async () => ({ status: 'failed' as const }));

    await expect(
      runWorkflowUndoClaim({
        claim: makeClaim(registered),
        registry,
        services: {},
        store: makeStore({
          complete: vi.fn(async () => {
            throw new WorkflowUndoLeaseLostError();
          }),
          recordFailure,
        }),
      })
    ).resolves.toEqual({ status: 'lease-lost' });
    expect(recordFailure).not.toHaveBeenCalled();
  });
});
