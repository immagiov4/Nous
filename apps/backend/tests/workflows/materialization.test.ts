import { describe, expect, test, vi } from 'vitest';
import * as z from 'zod';
import { unset, WorkflowExecutionDefaultsSchema } from '../../src/workflows/config.js';
import {
  createWorkflowRegistry,
  emit,
  fanOut,
  repeat,
  repeatDecisionSchema,
  routeBy,
  sequence,
  step,
  waitForSignal,
  workflow,
} from '../../src/workflows/definition.js';
import { materializeWorkflowStart } from '../../src/workflows/materialization.js';
import type { WorkflowDefinition } from '../../src/workflows/types.js';
import {
  hashWorkflowManifest,
  validateWorkflowDefinition,
} from '../../src/workflows/validation.js';

const Input = z.object({ kind: z.enum(['short', 'long']), text: z.string() });
const Output = z.object({ value: z.string() });
const ApprovalSignal = z.object({ approved: z.literal(true) });

const materializeDefinition = (
  definition: WorkflowDefinition,
  rawInput: unknown,
  options: { createId?: (nodeInstanceId: string) => string } = {}
) => {
  const registered = createWorkflowRegistry().register({ current: definition }).current;
  return materializeWorkflowStart(registered, rawInput, {
    ...options,
    resolvedConfig: registered.executionDefaults,
  });
};

describe('workflow start materialization', () => {
  test('materializes a nested workflow in the same run with scoped definitions', () => {
    const nested = workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      events: {
        prepared: { durability: 'durable', schema: Output, schemaVersion: 1 },
      },
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'nested',
      inputSchema: Input,
      outputSchema: Output,
      root: sequence({
        id: 'inner',
        nodes: [
          step({
            id: 'prepare',
            inputSchema: Input,
            outputSchema: Output,
            run: async ({ input }) => ({ value: input.text }),
          }),
          emit({
            event: 'prepared',
            id: 'announce',
            inputSchema: Output,
            payload: output => output,
          }),
        ],
      }),
    });
    const definition = workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'nested-start',
      inputSchema: Input,
      outputSchema: Output,
      root: nested,
    });

    const materialized = materializeDefinition(definition, {
      kind: 'short',
      text: 'hello',
    });

    expect(materialized.nodes).toEqual([
      expect.objectContaining({
        definitionId: 'nested',
        instanceId: 'nested',
        kind: 'workflow',
        parentInstanceId: undefined,
        status: 'waiting',
      }),
      expect.objectContaining({
        definitionId: 'nested/inner',
        instanceId: 'nested/inner',
        kind: 'sequence',
        parentInstanceId: 'nested',
        status: 'waiting',
      }),
      expect.objectContaining({
        definitionId: 'nested/prepare',
        instanceId: 'nested/inner/prepare',
        kind: 'step',
        parentInstanceId: 'nested/inner',
        status: 'queued',
      }),
    ]);
    expect(materialized.stepPolicies).toEqual({
      'nested/prepare': {
        config: { maxAttempts: 3, timeoutMs: 60_000 },
        maxAttempts: 3,
        timeoutMs: 60_000,
      },
    });
  });

  test('uses the resolved run configuration instead of definition defaults', () => {
    const generate = step({
      id: 'generate',
      inputSchema: Input,
      outputSchema: Output,
      run: async ({ input }) => ({ value: input.text }),
    });
    const registered = createWorkflowRegistry().register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'resolved-config',
        inputSchema: Input,
        outputSchema: Output,
        root: generate,
      }),
    }).current;

    const result = materializeWorkflowStart(
      registered,
      { kind: 'short', text: 'hello' },
      { resolvedConfig: { maxAttempts: 7, timeoutMs: 90_000 } }
    );

    expect(result.nodes[0]).toMatchObject({ maxAttempts: 7, timeoutMs: 90_000 });
    expect(Object.isFrozen(result.stepPolicies)).toBe(true);
    expect(Object.isFrozen(result.stepPolicies.generate)).toBe(true);
  });

  test('freezes each step configuration after applying typed recursive overrides', () => {
    const Config = WorkflowExecutionDefaultsSchema.extend({
      model: z.string(),
      provider: z.object({ apiKey: z.string().optional(), speed: z.enum(['normal', 'fast']) }),
      tags: z.array(z.string()),
    });
    type Config = z.infer<typeof Config>;
    const generate = step<typeof Input, typeof Output, Config>({
      config: {
        provider: { apiKey: unset(), speed: 'fast' },
        tags: ['lesson'],
      },
      id: 'generate',
      inputSchema: Input,
      maxAttempts: 5,
      outputSchema: Output,
      run: async ({ input }) => ({ value: input.text }),
    });
    const registered = createWorkflowRegistry().register({
      current: workflow({
        compatibilityId: 'test-v1',
        configSchema: Config,
        executionDefaults: {
          maxAttempts: 3,
          model: 'luna',
          provider: { apiKey: 'injected', speed: 'normal' },
          tags: ['default'],
          timeoutMs: 60_000,
        },
        id: 'step-config',
        inputSchema: Input,
        outputSchema: Output,
        root: generate,
      }),
    }).current;

    const result = materializeWorkflowStart(
      registered,
      { kind: 'short', text: 'hello' },
      {
        resolvedConfig: {
          maxAttempts: 4,
          model: 'luna',
          provider: { apiKey: 'runtime', speed: 'normal' },
          tags: ['runtime'],
          timeoutMs: 90_000,
        },
      }
    );

    expect(result.stepPolicies.generate).toEqual({
      config: {
        maxAttempts: 5,
        model: 'luna',
        provider: { speed: 'fast' },
        tags: ['lesson'],
        timeoutMs: 90_000,
      },
      maxAttempts: 5,
      timeoutMs: 90_000,
    });
    expect(Object.isFrozen(result.stepPolicies.generate?.config)).toBe(true);
  });

  test('validates execution defaults independently of the workflow config schema', () => {
    const PermissiveConfigSchema = z.object({
      maxAttempts: z.number(),
      timeoutMs: z.number(),
    });
    const definition = workflow({
      compatibilityId: 'test-v1',
      configSchema: PermissiveConfigSchema,
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'invalid-resolved-defaults',
      inputSchema: Input,
      outputSchema: Output,
      root: step({
        id: 'generate',
        inputSchema: Input,
        outputSchema: Output,
        run: async ({ input }) => ({ value: input.text }),
      }),
    });
    const registered = createWorkflowRegistry().register({ current: definition }).current;

    expect(() =>
      materializeWorkflowStart(
        registered,
        { kind: 'short', text: 'hello' },
        {
          resolvedConfig: { maxAttempts: 0, timeoutMs: 60_000 },
        }
      )
    ).toThrow('resolvedConfig.maxAttempts must be a positive PostgreSQL integer.');
  });

  test('rejects an unregistered or mutated definition before materialization', () => {
    const MutableInput = z.object({ text: z.string() });
    const definition = workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'definition-integrity',
      inputSchema: MutableInput,
      outputSchema: MutableInput,
      root: step({
        id: 'generate',
        inputSchema: MutableInput,
        outputSchema: MutableInput,
        run: async ({ input }) => input,
      }),
    });
    const registered = createWorkflowRegistry().register({ current: definition }).current;
    const options = { resolvedConfig: registered.executionDefaults };

    expect(() =>
      materializeWorkflowStart(definition as typeof registered, { text: 'ok' }, options)
    ).toThrow('Workflow definition must be registered before materialization.');

    const forgedManifest = validateWorkflowDefinition(definition);
    const forged = Object.freeze({
      ...definition,
      definitionHash: hashWorkflowManifest(forgedManifest),
      definitionHashVersion: forgedManifest.definitionHashVersion,
      manifest: forgedManifest,
    });
    expect(() => materializeWorkflowStart(forged, { text: 'ok' }, options)).toThrow(
      'Workflow definition must be registered before materialization.'
    );

    MutableInput.shape.text = z.string().min(10);
    expect(() => materializeWorkflowStart(registered, { text: 'too short' }, options)).toThrow(
      'Registered workflow definition definition-integrity changed after registration.'
    );
  });

  test('materializes only the first executable leaf and persists its container path', () => {
    const prepare = step({
      id: 'prepare',
      inputSchema: Input,
      maxAttempts: 5,
      outputSchema: Output,
      run: async ({ input }) => ({ value: input.text }),
      timeoutMs: 30_000,
    });
    const finish = step({
      id: 'finish',
      inputSchema: Output,
      outputSchema: Output,
      run: async ({ input }) => input,
    });
    const definition = workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'linear',
      inputSchema: Input,
      outputSchema: Output,
      root: sequence({ id: 'root', nodes: [prepare, finish] }),
    });

    expect(materializeDefinition(definition, { kind: 'short', text: 'hello' })).toEqual({
      durableEvents: [],
      nodes: [
        {
          definitionId: 'root',
          hasUndo: false,
          input: { kind: 'short', text: 'hello' },
          instanceId: 'root',
          kind: 'sequence',
          maxAttempts: 3,
          parentInstanceId: undefined,
          runtimeState: { activeIndex: 0 },
          status: 'waiting',
          timeoutMs: 60_000,
        },
        {
          definitionId: 'prepare',
          hasUndo: false,
          input: { kind: 'short', text: 'hello' },
          instanceId: 'root/prepare',
          kind: 'step',
          maxAttempts: 5,
          parentInstanceId: 'root',
          runtimeState: undefined,
          status: 'queued',
          timeoutMs: 30_000,
        },
      ],
      stepPolicies: {
        finish: {
          config: { maxAttempts: 3, timeoutMs: 60_000 },
          maxAttempts: 3,
          timeoutMs: 60_000,
        },
        prepare: {
          config: { maxAttempts: 5, timeoutMs: 30_000 },
          maxAttempts: 5,
          timeoutMs: 30_000,
        },
      },
      stepPoliciesVersion: 1,
      transientEvents: [],
      waits: [],
    });
  });

  test('selects one typed route and rejects a selector result not declared by the workflow', () => {
    const render = step({
      id: 'render',
      inputSchema: Input,
      outputSchema: Output,
      run: async ({ input }) => ({ value: input.text }),
    });
    const makeDefinition = (select: (input: z.output<typeof Input>) => string) =>
      workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'routed',
        inputSchema: Input,
        outputSchema: Output,
        root: routeBy({
          cases: { short: render },
          id: 'length-route',
          inputSchema: Input,
          outputSchema: Output,
          select,
        }),
      });

    const materialized = materializeDefinition(
      makeDefinition(input => input.kind),
      {
        kind: 'short',
        text: 'hello',
      }
    );
    expect(materialized.nodes.map(node => [node.instanceId, node.status])).toEqual([
      ['length-route', 'waiting'],
      ['length-route/render', 'queued'],
    ]);
    expect(() =>
      materializeDefinition(
        makeDefinition(() => 'missing'),
        { kind: 'short', text: 'hello' }
      )
    ).toThrow('Route length-route selected unknown case "missing".');
  });

  test('snapshots step policy even when operational overrides do not change the definition hash', () => {
    const makeDefinition = (maxAttempts: number, timeoutMs: number) =>
      workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'policy-snapshot',
        inputSchema: Input,
        outputSchema: Output,
        root: step({
          id: 'generate',
          inputSchema: Input,
          maxAttempts,
          outputSchema: Output,
          run: async ({ input }) => ({ value: input.text }),
          timeoutMs,
        }),
      });
    const first = createWorkflowRegistry().register({ current: makeDefinition(2, 30_000) }).current;
    const second = createWorkflowRegistry().register({
      current: makeDefinition(7, 90_000),
    }).current;

    expect(first.definitionHash).toBe(second.definitionHash);
    expect(
      materializeWorkflowStart(
        first,
        { kind: 'short', text: 'hello' },
        {
          resolvedConfig: first.executionDefaults,
        }
      ).stepPolicies
    ).toEqual({
      generate: {
        config: { maxAttempts: 2, timeoutMs: 30_000 },
        maxAttempts: 2,
        timeoutMs: 30_000,
      },
    });
    expect(
      materializeWorkflowStart(
        second,
        { kind: 'short', text: 'hello' },
        {
          resolvedConfig: second.executionDefaults,
        }
      ).stepPolicies
    ).toEqual({
      generate: {
        config: { maxAttempts: 7, timeoutMs: 90_000 },
        maxAttempts: 7,
        timeoutMs: 90_000,
      },
    });
  });

  test('snapshots whether a durable step has an undo operation', () => {
    const reversible = step({
      id: 'reversible',
      inputSchema: Input,
      outputSchema: Output,
      run: async ({ input }) => ({ value: input.text }),
      undo: async () => undefined,
    });
    const definition = workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'undo-snapshot',
      inputSchema: Input,
      outputSchema: Output,
      root: reversible,
    });

    expect(materializeDefinition(definition, { kind: 'short', text: 'hello' }).nodes).toEqual([
      expect.objectContaining({ definitionId: 'reversible', hasUndo: true }),
    ]);
  });

  test('materializes deterministic fan-out instances in input order', () => {
    const FanInput = z.object({ values: z.array(z.string()) });
    const FanOutput = z.object({ values: z.array(z.string()) });
    const worker = step({
      id: 'render',
      inputSchema: z.string(),
      outputSchema: z.string(),
      run: async ({ input }) => input,
    });
    const definition = workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'fan-out',
      inputSchema: FanInput,
      outputSchema: FanOutput,
      root: fanOut({
        failureMode: 'collect',
        fanIn: results => ({
          values: results.flatMap(result => (result.status === 'completed' ? [result.output] : [])),
        }),
        id: 'visuals',
        inputSchema: FanInput,
        inputs: input => input.values,
        itemSchema: z.string(),
        keyBy: input => input,
        outputSchema: FanOutput,
        worker,
      }),
    });

    const materialized = materializeDefinition(definition, { values: ['front/a', 'back'] });
    expect(materialized.nodes.map(node => node.instanceId)).toEqual([
      'visuals',
      'visuals/item:front~1a/render',
      'visuals/item:back/render',
    ]);
    expect(materialized.nodes[0]?.runtimeState).toEqual({ keys: ['front/a', 'back'] });
    expect(materialized.nodes.slice(1).map(node => node.parentInstanceId)).toEqual([
      'visuals',
      'visuals',
    ]);
    expect(() => materializeDefinition(definition, { values: ['same', 'same'] })).toThrow(
      'Fan-out visuals produced duplicate key "same".'
    );
  });

  test('passes the parent input to fan-in when no item needs materialization', () => {
    const FanInput = z.object({ lessonId: z.string(), values: z.array(z.string()) });
    const FanOutput = z.object({ lessonId: z.string(), values: z.array(z.string()) });
    const aggregate = vi.fn(
      (_results: readonly FanOutResult<string, string>[], parentInput: z.infer<typeof FanInput>) =>
        parentInput
    );
    const definition = workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'empty-fan-out',
      inputSchema: FanInput,
      outputSchema: FanOutput,
      root: fanOut({
        failureMode: 'collect',
        fanIn: aggregate,
        id: 'visuals',
        inputSchema: FanInput,
        inputs: input => input.values,
        itemSchema: z.string(),
        keyBy: input => input,
        outputSchema: FanOutput,
        worker: step({
          id: 'render',
          inputSchema: z.string(),
          outputSchema: z.string(),
          run: async ({ input }) => input,
        }),
      }),
    });
    const input = { lessonId: 'lesson-1', values: [] };

    expect(materializeDefinition(definition, input).completedOutput).toEqual(input);
    expect(aggregate).toHaveBeenCalledWith([], input);
  });

  test('materializes repeat iterations and durable signal waits with stable public ids', () => {
    const State = z.object({ revision: z.number() });
    const review = step({
      id: 'review',
      inputSchema: State,
      outputSchema: repeatDecisionSchema(State),
      run: async () => ({ kind: 'finish' as const, state: { revision: 1 } }),
    });
    const repeating = workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'repeat',
      inputSchema: State,
      outputSchema: State,
      root: repeat({
        body: review,
        id: 'refine',
        maxIterations: 2,
        onExhausted: state => state,
        stateSchema: State,
      }),
    });
    const waiting = workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'wait',
      inputSchema: State,
      outputSchema: State,
      root: waitForSignal({
        id: 'approval',
        inputSchema: State,
        outputSchema: State,
        payloadSchema: ApprovalSignal,
        resume: input => input,
        signal: 'approve',
      }),
      signals: { approve: { schema: ApprovalSignal, schemaVersion: 1 } },
    });

    const repeatNodes = materializeDefinition(repeating, { revision: 0 }).nodes;
    expect(repeatNodes.map(node => node.instanceId)).toEqual([
      'refine',
      'refine/iteration:1/review',
    ]);
    expect(repeatNodes[1]?.parentInstanceId).toBe('refine');
    expect(
      materializeDefinition(waiting, { revision: 0 }, { createId: () => 'wait-1' })
    ).toMatchObject({
      nodes: [{ instanceId: 'approval', status: 'waiting' }],
      waits: [
        {
          nodeInstanceId: 'approval',
          schemaVersion: 1,
          signalType: 'approve',
          waitId: 'wait-1',
        },
      ],
    });
  });

  test('rejects duplicate wait ids produced by a fan-out', () => {
    const FanInput = z.object({ values: z.array(z.string()) });
    const definition = workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'wait-id-uniqueness',
      inputSchema: FanInput,
      outputSchema: z.array(z.string()),
      root: fanOut({
        failureMode: 'collect',
        fanIn: results =>
          results.flatMap(result => (result.status === 'completed' ? [result.output] : [])),
        id: 'approvals',
        inputSchema: FanInput,
        inputs: input => input.values,
        itemSchema: z.string(),
        keyBy: input => input,
        outputSchema: z.array(z.string()),
        worker: waitForSignal({
          id: 'approval',
          inputSchema: z.string(),
          outputSchema: z.string(),
          payloadSchema: ApprovalSignal,
          resume: input => input,
          signal: 'approve',
        }),
      }),
      signals: { approve: { schema: ApprovalSignal, schemaVersion: 1 } },
    });

    expect(() =>
      materializeDefinition(
        definition,
        { values: ['first', 'second'] },
        { createId: () => 'same-wait-id' }
      )
    ).toThrow('Workflow materialization produced duplicate wait ids.');
  });

  test('completes pure emit nodes while separating durable and transient events', () => {
    const makeEmitWorkflow = (durability: 'durable' | 'transient') =>
      workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        events: {
          ready: { durability, schema: Output, schemaVersion: 2 },
        },
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: `emit-${durability}`,
        inputSchema: Output,
        outputSchema: Output,
        root: emit({
          event: 'ready',
          id: 'announce',
          inputSchema: Output,
          payload: input => input,
        }),
      });

    const durable = materializeDefinition(makeEmitWorkflow('durable'), { value: 'ready' });
    const transient = materializeDefinition(makeEmitWorkflow('transient'), { value: 'ready' });
    expect(durable).toMatchObject({
      completedOutput: { value: 'ready' },
      durableEvents: [{ eventType: 'ready', payload: { value: 'ready' }, schemaVersion: 2 }],
      nodes: [{ instanceId: 'announce', status: 'completed' }],
      transientEvents: [],
    });
    expect(transient.transientEvents).toEqual([
      { eventType: 'ready', payload: { value: 'ready' }, schemaVersion: 2 },
    ]);
  });

  test('normalizes durable values to detached JSON snapshots', () => {
    const Snapshot = z.object({
      nested: z.object({ value: z.string() }),
      optional: z.string().optional(),
    });
    const eventPayload = { nested: { value: 'ready' }, optional: undefined };
    const definition = workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      events: {
        ready: { durability: 'durable', schema: Snapshot, schemaVersion: 1 },
      },
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'json-snapshot',
      inputSchema: Snapshot,
      outputSchema: Snapshot,
      root: emit({
        event: 'ready',
        id: 'announce',
        inputSchema: Snapshot,
        payload: () => eventPayload,
      }),
    });

    const materialized = materializeDefinition(definition, {
      nested: { value: 'input' },
      optional: undefined,
    });
    eventPayload.nested.value = 'changed';

    const durablePayload = materialized.durableEvents[0]?.payload as z.output<typeof Snapshot>;
    expect(durablePayload).toEqual({ nested: { value: 'ready' } });
    expect(Object.hasOwn(durablePayload, 'optional')).toBe(false);
    expect(materialized.completedOutput).toEqual({ nested: { value: 'input' } });
    expect(Object.hasOwn(materialized.completedOutput as object, 'optional')).toBe(false);
  });

  test('marks a pure workflow as completed independently of its output payload', () => {
    const definition = workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      events: {
        ready: { durability: 'durable', schema: z.object({}), schemaVersion: 1 },
      },
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'null-output',
      inputSchema: z.null(),
      outputSchema: z.null(),
      root: emit({
        event: 'ready',
        id: 'announce',
        inputSchema: z.null(),
        payload: () => ({}),
      }),
    });

    expect(materializeDefinition(definition, null)).toMatchObject({
      completedOutput: null,
    });
  });
});
