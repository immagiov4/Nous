import type { TransactionSql } from 'postgres';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as z from 'zod';

import { WorkflowExecutionDefaultsSchema } from '../../src/workflows/config.js';
import {
  createWorkflowRegistry,
  sequence,
  step,
  workflow,
} from '../../src/workflows/definition.js';
import { retryOperational } from '../../src/workflows/retryPolicy.js';
import type {
  JsonValue,
  RegisteredWorkflow,
  WorkflowStepClaim,
} from '../../src/workflows/types.js';
import { recordWorkflowAiUsage } from '../../src/workflows/workflowAiMetering.js';
import { WorkflowCancellationRequestedError } from '../../src/workflows/workflowErrors.js';
import {
  DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MS,
  DEFAULT_WORKFLOW_LEASE_MS,
  runWorkflowStepClaim,
  type WorkflowStepRunnerStore,
} from '../../src/workflows/workflowStepRunner.js';

const Text = z.object({ text: z.string() });

const makeClaim = (
  definition: RegisteredWorkflow,
  overrides: Partial<WorkflowStepClaim> = {}
): WorkflowStepClaim => ({
  attemptNumber: 1,
  definitionHash: definition.definitionHash,
  definitionHashVersion: definition.definitionHashVersion,
  fencingToken: '1',
  input: { text: 'input' },
  kind: 'step',
  leaseExpiresAt: '2026-07-29T12:00:00.000Z',
  maxAttempts: 3,
  nodeDefinitionId: 'work',
  nodeInstanceId: 'root/work',
  retryFeedback: '',
  runId: '11111111-1111-4111-8111-111111111111',
  stepPolicies: {
    work: {
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

type WorkflowStepRunnerStoreOverrides = Partial<{
  checkpointStep: WorkflowStepRunnerStore['checkpointStep'];
  getProviderResult: WorkflowStepRunnerStore['providerEffects']['getResult'];
  heartbeat: WorkflowStepRunnerStore['steps']['heartbeat'];
  recordProviderResult: WorkflowStepRunnerStore['providerEffects']['recordResult'];
  recordAiUsage: WorkflowStepRunnerStore['recordAiUsage'];
  recordDefinitionUnavailable: WorkflowStepRunnerStore['steps']['recordDefinitionUnavailable'];
  recordFailure: WorkflowStepRunnerStore['steps']['recordFailure'];
  releaseClaim: WorkflowStepRunnerStore['cancellation']['releaseClaim'];
}>;

const makeStore = (overrides: WorkflowStepRunnerStoreOverrides = {}): WorkflowStepRunnerStore => ({
  cancellation: {
    releaseClaim:
      overrides.releaseClaim ??
      vi.fn(
        async (_claim: Parameters<WorkflowStepRunnerStore['cancellation']['releaseClaim']>[0]) =>
          undefined
      ),
  },
  checkpointStep:
    overrides.checkpointStep ??
    vi.fn(async (_input: Parameters<WorkflowStepRunnerStore['checkpointStep']>[0]) => ({
      status: 'checkpointed' as const,
      transientEvents: [],
    })),
  providerEffects: {
    getResult:
      overrides.getProviderResult ??
      vi.fn(
        async (_input: Parameters<WorkflowStepRunnerStore['providerEffects']['getResult']>[0]) =>
          undefined
      ),
    recordResult:
      overrides.recordProviderResult ??
      vi.fn(
        async (input: Parameters<WorkflowStepRunnerStore['providerEffects']['recordResult']>[0]) =>
          input.output
      ),
  },
  recordAiUsage: overrides.recordAiUsage ?? vi.fn(async () => undefined),
  steps: {
    heartbeat:
      overrides.heartbeat ??
      vi.fn(async (_input: Parameters<WorkflowStepRunnerStore['steps']['heartbeat']>[0]) => ({
        leaseExpiresAt: '2026-07-29T12:01:00.000Z',
        status: 'renewed' as const,
      })),
    recordDefinitionUnavailable:
      overrides.recordDefinitionUnavailable ??
      vi.fn(
        async (
          _input: Parameters<WorkflowStepRunnerStore['steps']['recordDefinitionUnavailable']>[0]
        ) => undefined
      ),
    recordFailure:
      overrides.recordFailure ??
      vi.fn(async (_input: Parameters<WorkflowStepRunnerStore['steps']['recordFailure']>[0]) => ({
        status: 'failed' as const,
        transientEvents: [],
      })),
  },
});

const postgresError = (code: string): Error & { code: string } =>
  Object.assign(new Error(`PostgreSQL ${code}`), { code });

afterEach(() => {
  vi.useRealTimers();
});

describe('single workflow step runner', () => {
  test('resolves a nested step, validates boundaries and keeps idempotency stable across retries', async () => {
    const executionIdentities: unknown[] = [];
    const keys: string[] = [];
    const retryFeedbackSourceAttemptNumbers: Array<number | undefined> = [];
    let checkpointing = false;
    const commit = vi.fn(async (_output: unknown) => undefined);
    const work = step({
      commit: async context => {
        expect(checkpointing).toBe(true);
        executionIdentities.push(context.execution);
        expect(Object.isFrozen(context.execution)).toBe(true);
        await commit(context.output);
      },
      id: 'work',
      inputSchema: Text,
      outputSchema: Text,
      run: async context => {
        expect(checkpointing).toBe(false);
        executionIdentities.push(context.execution);
        expect(Object.isFrozen(context.execution)).toBe(true);
        keys.push(context.idempotencyKey);
        retryFeedbackSourceAttemptNumbers.push(context.retryFeedbackSourceAttemptNumber);
        expect(context.config).toEqual({ maxAttempts: 3, timeoutMs: 60_000 });
        return { text: context.input.text.toUpperCase() };
      },
    });
    const nested = workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'child',
      inputSchema: Text,
      outputSchema: Text,
      root: work,
    });
    const definition = workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'nested-runner',
      inputSchema: Text,
      outputSchema: Text,
      root: sequence({ id: 'root', nodes: [nested] }),
    });
    const registry = createWorkflowRegistry();
    const registered = registry.register({ current: definition }).current;
    const checkpointStep = vi.fn(
      async (input: Parameters<WorkflowStepRunnerStore['checkpointStep']>[0]) => {
        checkpointing = true;
        await input.commit?.({} as TransactionSql);
        checkpointing = false;
        return { status: 'checkpointed' as const, transientEvents: [] };
      }
    );
    const store = makeStore({ checkpointStep });
    const nestedClaim = {
      nodeDefinitionId: 'child/work',
      nodeInstanceId: 'root/child/work',
      stepPolicies: {
        'child/work': {
          config: { maxAttempts: 3, timeoutMs: 60_000 },
          maxAttempts: 3,
          timeoutMs: 60_000,
        },
      },
    };

    await runWorkflowStepClaim({
      claim: makeClaim(registered, nestedClaim),
      registry,
      services: {},
      store,
    });
    await runWorkflowStepClaim({
      claim: makeClaim(registered, {
        ...nestedClaim,
        attemptNumber: 2,
        fencingToken: '2',
        retryFeedback: 'Correct the prior candidate.',
        retryFeedbackSourceAttemptNumber: 1,
      }),
      registry,
      services: {},
      store,
    });

    expect(keys).toEqual([
      'workflow:forward:run:36:11111111-1111-4111-8111-111111111111:node:15:root/child/work',
      'workflow:forward:run:36:11111111-1111-4111-8111-111111111111:node:15:root/child/work',
    ]);
    expect(retryFeedbackSourceAttemptNumbers).toEqual([undefined, 1]);
    expect(executionIdentities).toEqual([
      {
        nodeInstanceId: 'root/child/work',
        runId: '11111111-1111-4111-8111-111111111111',
      },
      {
        nodeInstanceId: 'root/child/work',
        runId: '11111111-1111-4111-8111-111111111111',
      },
      {
        nodeInstanceId: 'root/child/work',
        runId: '11111111-1111-4111-8111-111111111111',
      },
      {
        nodeInstanceId: 'root/child/work',
        runId: '11111111-1111-4111-8111-111111111111',
      },
    ]);
    expect(checkpointStep).toHaveBeenCalledTimes(2);
    expect(checkpointStep.mock.calls[0]?.[0].output).toEqual({ text: 'INPUT' });
    expect(commit).toHaveBeenCalledTimes(2);
  });

  test('uses the frozen step configuration instead of the global run configuration', async () => {
    const Config = WorkflowExecutionDefaultsSchema.extend({ mode: z.enum(['normal', 'fast']) });
    type Config = z.infer<typeof Config>;
    const observedConfigs: unknown[] = [];
    const work = step<typeof Text, typeof Text, Config>({
      config: { mode: 'fast' },
      id: 'work',
      inputSchema: Text,
      outputSchema: Text,
      run: async ({ config, input }) => {
        observedConfigs.push(config);
        return input;
      },
    });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: Config,
        executionDefaults: { maxAttempts: 3, mode: 'normal', timeoutMs: 60_000 },
        id: 'step-config-runner',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;

    await runWorkflowStepClaim({
      claim: makeClaim(registered, {
        stepPolicies: {
          work: {
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

  test('uses the unavailable-definition boundary instead of passing null to recordFailure', async () => {
    const run = vi.fn(async () => ({ text: 'unused' }));
    const work = step({ id: 'work', inputSchema: Text, outputSchema: Text, run });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'compatibility',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const recordFailure = vi.fn(async () => {
      throw new Error('recordFailure must not handle an unavailable definition');
    });
    const recordDefinitionUnavailable = vi.fn(async () => undefined);
    const store = makeStore({ recordDefinitionUnavailable, recordFailure });

    await runWorkflowStepClaim({
      claim: makeClaim(registered, { workflowId: 'missing' }),
      registry,
      services: {},
      store,
    });

    expect(recordDefinitionUnavailable).toHaveBeenCalledOnce();
    expect(recordFailure).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  test('releases an unavailable-definition claim when cancellation wins its ownership lock', async () => {
    const work = step({
      id: 'work',
      inputSchema: Text,
      outputSchema: Text,
      run: async () => ({ text: 'unused' }),
    });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'cancelled-unavailable-definition',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const releaseClaim = vi.fn(async () => undefined);
    const store = makeStore({
      recordDefinitionUnavailable: vi.fn(async () => {
        throw new WorkflowCancellationRequestedError();
      }),
      releaseClaim,
    });

    await expect(
      runWorkflowStepClaim({
        claim: makeClaim(registered, { workflowId: 'missing' }),
        registry,
        services: {},
        store,
      })
    ).resolves.toEqual({ status: 'cancelled' });
    expect(releaseClaim).toHaveBeenCalledOnce();
  });

  test('uses the unresumable boundary for version-mismatched and unknown step definitions', async () => {
    const run = vi.fn(async () => ({ text: 'unused' }));
    const work = step({ id: 'work', inputSchema: Text, outputSchema: Text, run });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'compatibility',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const recordFailure = vi.fn(async () => ({ status: 'failed' as const, transientEvents: [] }));
    const recordDefinitionUnavailable = vi.fn(
      async (
        _input: Parameters<WorkflowStepRunnerStore['steps']['recordDefinitionUnavailable']>[0]
      ) => undefined
    );
    const store = makeStore({ recordDefinitionUnavailable, recordFailure });

    await runWorkflowStepClaim({
      claim: makeClaim(registered, {
        definitionHashVersion: registered.definitionHashVersion + 1,
      }),
      registry,
      services: {},
      store,
    });
    await runWorkflowStepClaim({
      claim: makeClaim(registered, { nodeDefinitionId: 'missing-step' }),
      registry,
      services: {},
      store,
    });

    expect(recordDefinitionUnavailable.mock.calls.map(call => call[0].failure)).toMatchObject([
      { code: 'workflow_definition_incompatible', kind: 'permanent' },
      { code: 'workflow_step_definition_incompatible', kind: 'permanent' },
    ]);
    expect(recordFailure).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(store.checkpointStep).not.toHaveBeenCalled();
  });

  test('records invalid durable input with the exact trusted definition', async () => {
    const run = vi.fn(async () => ({ text: 'unused' }));
    const work = step({ id: 'work', inputSchema: Text, outputSchema: Text, run });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'invalid-durable-input',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const recordFailure = vi.fn(async () => ({ status: 'failed' as const, transientEvents: [] }));
    const store = makeStore({ recordFailure });

    await runWorkflowStepClaim({
      claim: makeClaim(registered, { input: { text: 123 }, nodeInstanceId: 'work' }),
      registry,
      services: {},
      store,
    });

    expect(recordFailure).toHaveBeenCalledWith({
      claim: expect.any(Object),
      definition: registered,
      failure: expect.objectContaining({
        code: 'workflow_step_input_incompatible',
        kind: 'permanent',
      }),
    });
    expect(store.steps.recordDefinitionUnavailable).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  test('distinguishes an incompatible durable configuration from invalid input', async () => {
    const run = vi.fn(async () => ({ text: 'unused' }));
    const work = step({ id: 'work', inputSchema: Text, outputSchema: Text, run });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'invalid-durable-config',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const recordFailure = vi.fn(async () => ({ status: 'failed' as const, transientEvents: [] }));

    await runWorkflowStepClaim({
      claim: makeClaim(registered, {
        nodeInstanceId: 'work',
        stepPolicies: {
          work: {
            config: { maxAttempts: 'three', timeoutMs: 60_000 },
            maxAttempts: 3,
            timeoutMs: 60_000,
          },
        },
      }),
      registry,
      services: {},
      store: makeStore({ recordFailure }),
    });

    expect(recordFailure.mock.calls[0]?.[0].failure).toMatchObject({
      code: 'workflow_step_config_incompatible',
      kind: 'permanent',
    });
    expect(run).not.toHaveBeenCalled();
  });

  test('rejects an unsupported durable step policy version before running', async () => {
    const run = vi.fn(async () => ({ text: 'unused' }));
    const work = step({ id: 'work', inputSchema: Text, outputSchema: Text, run });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'unsupported-step-policy-version',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const recordFailure = vi.fn(async () => ({ status: 'failed' as const, transientEvents: [] }));

    await runWorkflowStepClaim({
      claim: makeClaim(registered, { nodeInstanceId: 'work', stepPoliciesVersion: 2 }),
      registry,
      services: {},
      store: makeStore({ recordFailure }),
    });

    expect(recordFailure.mock.calls[0]?.[0].failure).toMatchObject({
      code: 'workflow_step_policy_incompatible',
      kind: 'permanent',
    });
    expect(run).not.toHaveBeenCalled();
  });

  test('finishes a timeout even when run ignores its abort signal', async () => {
    vi.useFakeTimers();
    const work = step({
      id: 'work',
      inputSchema: Text,
      outputSchema: Text,
      run: async () => new Promise<never>(() => {}),
    });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'timeout',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const recordFailure = vi.fn(async () => ({ status: 'failed' as const, transientEvents: [] }));
    const execution = runWorkflowStepClaim({
      claim: makeClaim(registered, {
        nodeInstanceId: 'work',
        stepPolicies: {
          work: {
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
    const result = await Promise.race([
      execution,
      Promise.resolve({ status: 'execution-did-not-settle' as const }),
    ]);
    expect(result).toMatchObject({ status: 'failure-recorded' });
    expect(recordFailure.mock.calls[0]?.[0].failure).toMatchObject({
      code: 'workflow_step_timeout',
      kind: 'operational',
    });
  });

  test('deduplicates a provider result that completes after timeout alongside its retry', async () => {
    vi.useFakeTimers();
    const finishProvider: Array<(output: { text: string }) => void> = [];
    const provider = vi.fn(
      async () =>
        new Promise<{ text: string }>(resolve => {
          finishProvider.push(resolve);
        })
    );
    const work = step({
      externalEffect: 'provider',
      id: 'work',
      inputSchema: Text,
      outputSchema: Text,
      run: provider,
    });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'provider-result-deduplication',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const canonicalResults = new Map<string, JsonValue>();
    let confirmFirstResult: (() => void) | undefined;
    const firstResultRecorded = new Promise<void>(resolve => {
      confirmFirstResult = resolve;
    });
    const recordProviderResult = vi.fn(
      async (input: Parameters<WorkflowStepRunnerStore['providerEffects']['recordResult']>[0]) => {
        const canonical = canonicalResults.get(input.idempotencyKey);
        if (canonical !== undefined) return canonical;
        canonicalResults.set(input.idempotencyKey, input.output);
        confirmFirstResult?.();
        return input.output;
      }
    );
    const checkpointStep = vi.fn(
      async (_input: Parameters<WorkflowStepRunnerStore['checkpointStep']>[0]) => ({
        status: 'checkpointed' as const,
        transientEvents: [],
      })
    );
    const store = makeStore({ checkpointStep, recordProviderResult });
    const timedClaim = makeClaim(registered, {
      nodeInstanceId: 'work',
      stepPolicies: {
        work: {
          config: { maxAttempts: 3, timeoutMs: 1_000 },
          maxAttempts: 3,
          timeoutMs: 1_000,
        },
      },
      timeoutMs: 1_000,
    });

    const firstExecution = runWorkflowStepClaim({
      claim: timedClaim,
      registry,
      services: {},
      store,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(firstExecution).resolves.toMatchObject({ status: 'failure-recorded' });

    const retryExecution = runWorkflowStepClaim({
      claim: { ...timedClaim, attemptNumber: 2, fencingToken: '2' },
      registry,
      services: {},
      store,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(finishProvider).toHaveLength(2);
    finishProvider[0]?.({ text: 'late-first-result' });
    await firstResultRecorded;
    finishProvider[1]?.({ text: 'retry-result' });
    await expect(retryExecution).resolves.toMatchObject({ status: 'checkpointed' });

    expect(provider).toHaveBeenCalledTimes(2);
    expect(recordProviderResult).toHaveBeenCalledTimes(2);
    expect(checkpointStep).toHaveBeenCalledOnce();
    expect(checkpointStep.mock.calls[0]?.[0].output).toEqual({ text: 'late-first-result' });
  });

  test('checkpoints an authoritative provider result without repeating the provider call', async () => {
    const provider = vi.fn(async () => ({ text: 'duplicate' }));
    const work = step({
      externalEffect: 'provider',
      id: 'work',
      inputSchema: Text,
      outputSchema: Text,
      run: provider,
    });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'provider-result-reuse',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const getProviderResult = vi.fn(async () => ({ text: 'authoritative' }));
    const store = makeStore({ getProviderResult });

    await expect(
      runWorkflowStepClaim({
        claim: makeClaim(registered, { nodeInstanceId: 'work' }),
        registry,
        services: {},
        store,
      })
    ).resolves.toMatchObject({ status: 'checkpointed' });

    expect(getProviderResult).toHaveBeenCalledOnce();
    expect(provider).not.toHaveBeenCalled();
    expect(store.providerEffects.recordResult).not.toHaveBeenCalled();
    expect(store.checkpointStep).toHaveBeenCalledWith(
      expect.objectContaining({ output: { text: 'authoritative' } })
    );
  });

  test('reuses a provider result when downstream post-processing fails', async () => {
    const provider = vi.fn(async () => ({ text: 'paid-result' }));
    const postprocess = vi
      .fn()
      .mockRejectedValueOnce(new Error('asset staging unavailable'))
      .mockResolvedValueOnce(undefined);
    const work = step({
      externalEffect: 'provider-with-postprocessing',
      id: 'work',
      inputSchema: Text,
      outputSchema: Text,
      run: async ({ providerEffect }) => {
        if (!providerEffect) throw new Error('Expected provider effect persistence.');
        const output = await providerEffect.run({
          key: 'generate',
          operation: provider,
          outputSchema: Text,
        });
        await postprocess();
        return output;
      },
    });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'provider-result-before-postprocessing',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    let persistedResult: JsonValue | undefined;
    const getProviderResult = vi.fn(async () => persistedResult);
    const recordProviderResult = vi.fn(
      async (input: Parameters<WorkflowStepRunnerStore['providerEffects']['recordResult']>[0]) => {
        persistedResult ??= input.output;
        return persistedResult;
      }
    );
    const store = makeStore({ getProviderResult, recordProviderResult });
    const claim = makeClaim(registered, { nodeInstanceId: 'work' });

    await expect(
      runWorkflowStepClaim({ claim, registry, services: {}, store })
    ).resolves.toMatchObject({ status: 'failure-recorded' });
    await expect(
      runWorkflowStepClaim({
        claim: { ...claim, attemptNumber: 2, fencingToken: '2' },
        registry,
        services: {},
        store,
      })
    ).resolves.toMatchObject({ status: 'checkpointed' });

    expect(provider).toHaveBeenCalledOnce();
    expect(recordProviderResult).toHaveBeenCalledOnce();
    expect(postprocess).toHaveBeenCalledTimes(2);
    expect(store.checkpointStep).toHaveBeenCalledWith(
      expect.objectContaining({ output: { text: 'paid-result' } })
    );
  });

  test('reuses each provider result independently when a later provider fails', async () => {
    const generate = vi.fn(async () => ({ text: 'generated' }));
    const verify = vi
      .fn()
      .mockRejectedValueOnce(new Error('verification provider unavailable'))
      .mockResolvedValueOnce({ text: 'verified' });
    const work = step({
      externalEffect: 'provider-with-postprocessing',
      id: 'work',
      inputSchema: Text,
      outputSchema: Text,
      run: async ({ providerEffect }) => {
        if (!providerEffect) throw new Error('Expected provider effect persistence.');
        await providerEffect.run({ key: 'generate', operation: generate, outputSchema: Text });
        return providerEffect.run({ key: 'verify', operation: verify, outputSchema: Text });
      },
    });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'multiple-provider-results',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const persisted = new Map<string, JsonValue>();
    const getProviderResult = vi.fn(async ({ idempotencyKey }) => persisted.get(idempotencyKey));
    const recordProviderResult = vi.fn(
      async (input: Parameters<WorkflowStepRunnerStore['providerEffects']['recordResult']>[0]) => {
        persisted.set(input.idempotencyKey, input.output);
        return input.output;
      }
    );
    const store = makeStore({ getProviderResult, recordProviderResult });
    const claim = makeClaim(registered, { nodeInstanceId: 'work' });

    await expect(
      runWorkflowStepClaim({ claim, registry, services: {}, store })
    ).resolves.toMatchObject({ status: 'failure-recorded' });
    await expect(
      runWorkflowStepClaim({
        claim: { ...claim, attemptNumber: 2, fencingToken: '2' },
        registry,
        services: {},
        store,
      })
    ).resolves.toMatchObject({ status: 'checkpointed' });

    expect(generate).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledTimes(2);
    expect([...persisted.keys()]).toEqual([
      expect.stringContaining(':provider:generate'),
      expect.stringContaining(':provider:verify'),
    ]);
  });

  test('does not repeat a provider after usage persistence fails', async () => {
    const provider = vi.fn(async () => {
      await recordWorkflowAiUsage({
        inputTokens: 5,
        model: 'paid-model',
        outputTokens: 3,
        provider: 'paid-provider',
      });
      return { text: 'paid-result' };
    });
    const work = step({
      externalEffect: 'provider',
      id: 'work',
      inputSchema: Text,
      outputSchema: Text,
      run: provider,
    });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'provider-result-before-usage',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    let persistedResult: JsonValue | undefined;
    const getProviderResult = vi.fn(async () => persistedResult);
    const recordProviderResult = vi.fn(
      async (input: Parameters<WorkflowStepRunnerStore['providerEffects']['recordResult']>[0]) => {
        persistedResult ??= input.output;
        throw postgresError('23505');
      }
    );
    const store = makeStore({ getProviderResult, recordProviderResult });
    const claim = makeClaim(registered, { nodeInstanceId: 'work' });

    await expect(
      runWorkflowStepClaim({ claim, registry, services: {}, store })
    ).resolves.toMatchObject({ status: 'failure-recorded' });
    await expect(
      runWorkflowStepClaim({
        claim: { ...claim, attemptNumber: 2, fencingToken: '2' },
        registry,
        services: {},
        store,
      })
    ).resolves.toMatchObject({ status: 'checkpointed' });

    expect(provider).toHaveBeenCalledOnce();
    expect(recordProviderResult).toHaveBeenCalledWith(
      expect.objectContaining({
        aiUsage: [
          expect.objectContaining({
            attemptNumber: 1,
            model: 'paid-model',
            provider: 'paid-provider',
          }),
        ],
        output: { text: 'paid-result' },
      })
    );
    expect(store.recordAiUsage).toHaveBeenCalledOnce();
  });

  test('observes a late run rejection after timeout without recording a second failure', async () => {
    vi.useFakeTimers();
    let rejectRun: ((reason: unknown) => void) | undefined;
    const work = step({
      id: 'work',
      inputSchema: Text,
      outputSchema: Text,
      run: async () =>
        new Promise<never>((_, reject) => {
          rejectRun = reject;
        }),
    });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'late-rejection',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const recordFailure = vi.fn(async () => ({ status: 'failed' as const, transientEvents: [] }));
    const execution = runWorkflowStepClaim({
      claim: makeClaim(registered, {
        nodeInstanceId: 'work',
        stepPolicies: {
          work: {
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
    rejectRun?.(new Error('late provider rejection'));
    await Promise.resolve();

    expect(recordFailure).toHaveBeenCalledOnce();
  });

  test('persists usage returned after timeout with the original attempt identity', async () => {
    vi.useFakeTimers();
    let finishProvider: (() => void) | undefined;
    const work = step({
      id: 'work',
      inputSchema: Text,
      outputSchema: Text,
      run: async () => {
        await new Promise<void>(resolve => {
          finishProvider = resolve;
        });
        await recordWorkflowAiUsage({
          inputTokens: 11,
          model: 'late-model',
          outputTokens: 7,
          provider: 'late-provider',
        });
        return { text: 'late result' };
      },
    });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'late-usage',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const recordAiUsage = vi
      .fn()
      .mockRejectedValueOnce(postgresError('40001'))
      .mockResolvedValueOnce(undefined);
    const execution = runWorkflowStepClaim({
      claim: makeClaim(registered, {
        nodeInstanceId: 'work',
        stepPolicies: {
          work: {
            config: { maxAttempts: 3, timeoutMs: 1_000 },
            maxAttempts: 3,
            timeoutMs: 1_000,
          },
        },
        timeoutMs: 1_000,
      }),
      registry,
      services: {},
      store: makeStore({ recordAiUsage }),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(execution).resolves.toMatchObject({ status: 'failure-recorded' });
    finishProvider?.();
    await vi.advanceTimersByTimeAsync(2_500);

    expect(recordAiUsage).toHaveBeenCalledTimes(2);
    expect(recordAiUsage.mock.calls[0]?.[0]).toBe(recordAiUsage.mock.calls[1]?.[0]);
    expect(recordAiUsage.mock.calls[0]?.[0]).toMatchObject({
      attemptNumber: 1,
      nodeInstanceId: 'work',
      reportedAfterInterruption: true,
      runId: '11111111-1111-4111-8111-111111111111',
    });
  });

  test.each([
    ['lost', 'lease-lost', false],
    ['cancelled', 'cancelled', true],
  ] as const)('finishes on a %s heartbeat even when run ignores abort', async (heartbeatStatus, expectedStatus, releasesClaim) => {
    vi.useFakeTimers();
    const work = step({
      id: 'work',
      inputSchema: Text,
      outputSchema: Text,
      run: async () => new Promise<never>(() => {}),
    });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: `heartbeat-${heartbeatStatus}`,
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const store = makeStore({
      heartbeat: vi
        .fn()
        .mockResolvedValueOnce({
          leaseExpiresAt: '2026-07-29T12:01:00.000Z',
          status: 'renewed' as const,
        })
        .mockResolvedValue({ status: heartbeatStatus }),
    });
    const execution = runWorkflowStepClaim({
      claim: makeClaim(registered, { nodeInstanceId: 'work' }),
      registry,
      services: {},
      store,
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MS);
    const result = await Promise.race([
      execution,
      Promise.resolve({ status: 'execution-did-not-settle' as const }),
    ]);
    expect(result).toMatchObject({ status: expectedStatus });
    expect(store.checkpointStep).not.toHaveBeenCalled();
    expect(store.steps.recordFailure).not.toHaveBeenCalled();
    expect(store.cancellation.releaseClaim).toHaveBeenCalledTimes(releasesClaim ? 1 : 0);
  });

  test.each([
    ['lost', 'lease-lost', false],
    ['cancelled', 'cancelled', true],
  ] as const)('does not invoke a step whose initial heartbeat reports %s', async (heartbeatStatus, expectedStatus, releasesClaim) => {
    const run = vi.fn(async () => ({ text: 'unused' }));
    const work = step({ id: 'work', inputSchema: Text, outputSchema: Text, run });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: `initial-heartbeat-${heartbeatStatus}`,
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const store = makeStore({ heartbeat: vi.fn(async () => ({ status: heartbeatStatus })) });

    await expect(
      runWorkflowStepClaim({
        claim: makeClaim(registered, { nodeInstanceId: 'work' }),
        registry,
        services: {},
        store,
      })
    ).resolves.toMatchObject({ status: expectedStatus });

    expect(run).not.toHaveBeenCalled();
    expect(store.checkpointStep).not.toHaveBeenCalled();
    expect(store.cancellation.releaseClaim).toHaveBeenCalledTimes(releasesClaim ? 1 : 0);
  });

  test('stops waiting for an in-flight checkpoint when its lease is lost', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {
      await recordWorkflowAiUsage({
        inputTokens: 9,
        model: 'fake-model',
        outputTokens: 4,
        provider: 'fake-provider',
      });
      return { text: 'generated' };
    });
    const work = step({ id: 'work', inputSchema: Text, outputSchema: Text, run });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'checkpoint-lease-loss',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const checkpointStep = vi.fn(async () => new Promise<never>(() => {}));
    const recordAiUsage = vi.fn(async () => undefined);
    const heartbeat = vi
      .fn()
      .mockResolvedValueOnce({
        leaseExpiresAt: '2026-07-29T12:01:00.000Z',
        status: 'renewed' as const,
      })
      .mockResolvedValueOnce({ status: 'lost' as const });
    const store = makeStore({ checkpointStep, heartbeat, recordAiUsage });
    const execution = runWorkflowStepClaim({
      claim: makeClaim(registered, { nodeInstanceId: 'work' }),
      heartbeatIntervalMs: 20,
      leaseMs: 60,
      registry,
      services: {},
      store,
    });

    await vi.advanceTimersByTimeAsync(20);

    await expect(execution).resolves.toEqual({ status: 'lease-lost' });
    expect(run).toHaveBeenCalledOnce();
    expect(recordAiUsage).toHaveBeenCalledOnce();
    expect(checkpointStep).toHaveBeenCalledOnce();
    expect(store.steps.recordFailure).not.toHaveBeenCalled();
  });

  test('normalizes invalid output as a corrective failure', async () => {
    const work = step({
      id: 'work',
      inputSchema: Text,
      outputSchema: Text,
      run: async () => ({ text: 123 }) as never,
    });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'invalid-output',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const recordFailure = vi.fn(async () => ({ status: 'failed' as const, transientEvents: [] }));

    await runWorkflowStepClaim({
      claim: makeClaim(registered, { nodeInstanceId: 'work' }),
      registry,
      services: {},
      store: makeStore({ recordFailure }),
    });

    expect(recordFailure.mock.calls[0]?.[0].failure).toMatchObject({
      code: 'workflow_step_output_invalid',
      kind: 'corrective',
    });
  });

  test('retries a transient PostgreSQL checkpoint with the same output without rerunning the step', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {
      await recordWorkflowAiUsage({
        inputTokens: 9,
        model: 'fake-model',
        outputTokens: 4,
        provider: 'fake-provider',
      });
      return { text: 'generated' };
    });
    const work = step({ id: 'work', inputSchema: Text, outputSchema: Text, run });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'checkpoint-retry',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const outputs: unknown[] = [];
    const recordAiUsage = vi.fn(async () => undefined);
    const checkpointStep = vi.fn(
      async (input: Parameters<WorkflowStepRunnerStore['checkpointStep']>[0]) => {
        outputs.push(input.output);
        if (outputs.length === 1) throw postgresError('40001');
        return { status: 'checkpointed' as const, transientEvents: [] };
      }
    );

    const execution = runWorkflowStepClaim({
      claim: makeClaim(registered, { nodeInstanceId: 'work' }),
      registry,
      services: {},
      store: makeStore({ checkpointStep, recordAiUsage }),
    });
    await vi.advanceTimersByTimeAsync(2_500);
    await execution;

    expect(run).toHaveBeenCalledTimes(1);
    expect(checkpointStep).toHaveBeenCalledTimes(2);
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toBe(outputs[1]);
    expect(recordAiUsage).toHaveBeenCalledOnce();
    expect(recordAiUsage).toHaveBeenCalledWith({
      attemptNumber: 1,
      id: expect.any(String),
      inputTokens: 9,
      model: 'fake-model',
      nodeInstanceId: 'work',
      outputTokens: 4,
      provider: 'fake-provider',
      runId: '11111111-1111-4111-8111-111111111111',
    });
    expect(checkpointStep.mock.calls[0]?.[0]).not.toHaveProperty('aiUsage');
  });

  test('retries transient usage persistence with the same identity without rerunning the step', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {
      await recordWorkflowAiUsage({
        inputTokens: 9,
        model: 'fake-model',
        outputTokens: 4,
        provider: 'fake-provider',
      });
      return { text: 'generated' };
    });
    const work = step({ id: 'work', inputSchema: Text, outputSchema: Text, run });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'usage-persistence-retry',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const recordAiUsage = vi
      .fn()
      .mockRejectedValueOnce(postgresError('40001'))
      .mockResolvedValueOnce(undefined);
    const store = makeStore({ recordAiUsage });

    const execution = runWorkflowStepClaim({
      claim: makeClaim(registered, { nodeInstanceId: 'work' }),
      registry,
      services: {},
      store,
    });
    await vi.advanceTimersByTimeAsync(2_500);
    await execution;

    expect(run).toHaveBeenCalledOnce();
    expect(recordAiUsage).toHaveBeenCalledTimes(2);
    expect(recordAiUsage.mock.calls[0]?.[0]).toBe(recordAiUsage.mock.calls[1]?.[0]);
    expect(store.checkpointStep).toHaveBeenCalledOnce();
  });

  test('persists only the unflushed usage suffix with the failure checkpoint', async () => {
    const run = vi.fn(async () => {
      await recordWorkflowAiUsage({
        inputTokens: 9,
        model: 'first-model',
        outputTokens: 4,
        provider: 'fake-provider',
      });
      await recordWorkflowAiUsage({
        inputTokens: 11,
        model: 'second-model',
        outputTokens: 6,
        provider: 'fake-provider',
      });
      return { text: 'generated' };
    });
    const work = step({ id: 'work', inputSchema: Text, outputSchema: Text, run });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'usage-persistence-suffix',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const recordAiUsage = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(postgresError('23505'));
    const recordFailure = vi.fn(async () => ({
      status: 'failed' as const,
      transientEvents: [],
    }));
    const store = makeStore({ recordAiUsage, recordFailure });

    await expect(
      runWorkflowStepClaim({
        claim: makeClaim(registered, { nodeInstanceId: 'work' }),
        registry,
        services: {},
        store,
      })
    ).resolves.toMatchObject({ status: 'failure-recorded' });

    expect(run).toHaveBeenCalledOnce();
    expect(recordAiUsage).toHaveBeenCalledTimes(2);
    const persistedUsage = recordAiUsage.mock.calls[0]?.[0];
    const unflushedUsage = recordAiUsage.mock.calls[1]?.[0];
    expect(recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ aiUsage: [unflushedUsage] })
    );
    expect(recordFailure.mock.calls[0]?.[0].aiUsage).not.toContain(persistedUsage);
    expect(store.checkpointStep).not.toHaveBeenCalled();
  });

  test('keeps recorded usage when cancellation wins during checkpoint', async () => {
    const run = vi.fn(async () => {
      await recordWorkflowAiUsage({
        inputTokens: 9,
        model: 'fake-model',
        outputTokens: 4,
        provider: 'fake-provider',
      });
      return { text: 'generated' };
    });
    const work = step({ id: 'work', inputSchema: Text, outputSchema: Text, run });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'checkpoint-cancelled',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const recordAiUsage = vi.fn(async () => undefined);
    const releaseClaim = vi.fn(async () => undefined);

    await expect(
      runWorkflowStepClaim({
        claim: makeClaim(registered, { nodeInstanceId: 'work' }),
        registry,
        services: {},
        store: makeStore({
          checkpointStep: vi.fn(async () => {
            throw new WorkflowCancellationRequestedError();
          }),
          recordAiUsage,
          releaseClaim,
        }),
      })
    ).resolves.toEqual({ status: 'cancelled' });

    expect(recordAiUsage).toHaveBeenCalledOnce();
    expect(releaseClaim).toHaveBeenCalledWith(expect.any(Object));
  });

  test.each([
    '23505',
    '42P01',
  ])('records PostgreSQL %s checkpoint errors as permanent without rerunning', async code => {
    const run = vi.fn(async () => ({ text: 'generated' }));
    const work = step({ id: 'work', inputSchema: Text, outputSchema: Text, run });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: `checkpoint-${code}`,
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const recordFailure = vi.fn(async () => ({ status: 'failed' as const, transientEvents: [] }));
    const checkpointStep = vi.fn(async () => {
      throw postgresError(code);
    });

    const result = await runWorkflowStepClaim({
      claim: makeClaim(registered, { nodeInstanceId: 'work' }),
      registry,
      services: {},
      store: makeStore({ checkpointStep, recordFailure }),
    });

    expect(result).toMatchObject({
      failure: { code: 'workflow_step_checkpoint_failed', kind: 'permanent' },
      status: 'failure-recorded',
    });
    expect(run).toHaveBeenCalledOnce();
    expect(checkpointStep).toHaveBeenCalledOnce();
    expect(recordFailure).toHaveBeenCalledOnce();
  });

  test('normalizes declared step failures before recording them', async () => {
    const work = step({
      id: 'work',
      inputSchema: Text,
      outputSchema: Text,
      run: async () => {
        throw retryOperational({ code: 'provider_busy', message: 'Provider busy.' });
      },
    });
    const registry = createWorkflowRegistry();
    const registered = registry.register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'normalized-failure',
        inputSchema: Text,
        outputSchema: Text,
        root: work,
      }),
    }).current;
    const recordFailure = vi.fn(async () => ({ status: 'failed' as const, transientEvents: [] }));

    await runWorkflowStepClaim({
      claim: makeClaim(registered, { nodeInstanceId: 'work' }),
      registry,
      services: {},
      store: makeStore({ recordFailure }),
    });

    expect(recordFailure.mock.calls[0]?.[0].failure).toMatchObject({
      code: 'provider_busy',
      kind: 'operational',
    });
  });

  test('exports the approved lease and heartbeat defaults', () => {
    expect(DEFAULT_WORKFLOW_LEASE_MS).toBe(60_000);
    expect(DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MS).toBe(20_000);
  });
});
