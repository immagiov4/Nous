import { describe, expect, test, vi } from 'vitest';
import * as z from 'zod';

import { WorkflowExecutionDefaultsSchema } from '../../src/workflows/config.js';
import {
  planWorkflowContinuation,
  planWorkflowFailure,
  planWorkflowSignal,
  type WorkflowContinuationPlan,
  type WorkflowNodeSnapshot,
} from '../../src/workflows/continuation.js';
import {
  continueRepeatWith,
  createWorkflowRegistry,
  emit,
  fanOut,
  finishRepeat,
  repeat,
  repeatDecisionSchema,
  routeBy,
  sequence,
  step,
  waitForSignal,
  workflow,
} from '../../src/workflows/definition.js';
import { materializeWorkflowStart } from '../../src/workflows/materialization.js';
import type {
  FanOutResult,
  RegisteredWorkflow,
  WorkflowDefinition,
  WorkflowExecutionDefaults,
  WorkflowStepPolicies,
} from '../../src/workflows/types.js';

const Text = z.object({ text: z.string() });
const ApprovalSignal = z.object({ approved: z.literal(true) });

const register = <Input, Output, Config extends WorkflowExecutionDefaults, Services>(
  definition: WorkflowDefinition<Input, Output, Config, Services>
): RegisteredWorkflow<Input, Output, Config, Services> =>
  createWorkflowRegistry().register({ current: definition }).current;

const start = (definition: RegisteredWorkflow, input: unknown) =>
  materializeWorkflowStart(definition, input, {
    createId: () => 'initial-wait',
    resolvedConfig: definition.executionDefaults,
  });

const applyPlan = (
  snapshot: readonly WorkflowNodeSnapshot[],
  plan: WorkflowContinuationPlan
): WorkflowNodeSnapshot[] => {
  const updates = new Map(plan.nodeUpdates.map(update => [update.instanceId, update]));
  return [
    ...snapshot.map(node => ({ ...node, ...updates.get(node.instanceId) })),
    ...plan.newNodes,
  ];
};

const continueFrom = (
  definition: RegisteredWorkflow,
  stepPolicies: WorkflowStepPolicies,
  nodes: readonly WorkflowNodeSnapshot[],
  nodeInstanceId: string,
  output: unknown
) =>
  planWorkflowContinuation({
    completedNode: { nodeInstanceId, output },
    definition,
    nodes: nodes.map(node =>
      node.instanceId === nodeInstanceId ? { ...node, status: 'running' as const } : node
    ),
    stepPolicies,
    waitIdForNode: instanceId => `wait:${instanceId}`,
  });

const failFrom = (
  definition: RegisteredWorkflow,
  stepPolicies: WorkflowStepPolicies,
  nodes: readonly WorkflowNodeSnapshot[],
  nodeInstanceId: string
) =>
  planWorkflowFailure({
    definition,
    failedNode: {
      failure: { code: 'render_failed', kind: 'permanent', message: 'failed' },
      nodeInstanceId,
    },
    nodes: nodes.map(node =>
      node.instanceId === nodeInstanceId ? { ...node, status: 'running' as const } : node
    ),
    stepPolicies,
    waitIdForNode: instanceId => `wait:${instanceId}`,
  });

describe('workflow continuation planning', () => {
  test('bubbles a nested workflow result into its parent sequence', () => {
    const nested = workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      events: {
        prepared: { durability: 'durable', schema: Text, schemaVersion: 1 },
      },
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'nested',
      inputSchema: Text,
      outputSchema: Text,
      root: sequence({
        id: 'inner',
        nodes: [
          step({
            id: 'prepare',
            inputSchema: Text,
            outputSchema: Text,
            run: async ({ input }) => input,
          }),
          emit({
            event: 'prepared',
            id: 'announce',
            inputSchema: Text,
            payload: input => input,
          }),
        ],
      }),
    });
    const finish = step({
      id: 'finish',
      inputSchema: Text,
      outputSchema: Text,
      run: async ({ input }) => input,
    });
    const definition = register(
      workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'nested-continuation',
        inputSchema: Text,
        outputSchema: Text,
        root: sequence({ id: 'root', nodes: [nested, finish] }),
      })
    );
    const initial = start(definition, { text: 'input' });

    const plan = continueFrom(
      definition,
      initial.stepPolicies,
      initial.nodes,
      'root/nested/inner/prepare',
      { text: 'prepared' }
    );

    expect(plan.nodeUpdates).toEqual([
      {
        instanceId: 'root/nested/inner/prepare',
        output: { text: 'prepared' },
        status: 'completed',
      },
      {
        instanceId: 'root/nested/inner',
        output: { text: 'prepared' },
        status: 'completed',
      },
      {
        instanceId: 'root/nested',
        output: { text: 'prepared' },
        status: 'completed',
      },
      { instanceId: 'root', runtimeState: { activeIndex: 1 }, status: 'waiting' },
    ]);
    expect(plan.newNodes).toEqual([
      expect.objectContaining({
        definitionId: 'nested/announce',
        instanceId: 'root/nested/inner/announce',
        status: 'completed',
      }),
      expect.objectContaining({
        definitionId: 'finish',
        input: { text: 'prepared' },
        instanceId: 'root/finish',
        status: 'queued',
      }),
    ]);
    expect(plan.durableEvents).toEqual([
      { eventType: 'prepared', payload: { text: 'prepared' }, schemaVersion: 1 },
    ]);
  });

  test('resumes a signal declared inside a nested workflow', () => {
    const nested = workflow({
      compatibilityId: 'test-v1',
      configSchema: WorkflowExecutionDefaultsSchema,
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'approval-flow',
      inputSchema: Text,
      outputSchema: Text,
      root: waitForSignal({
        id: 'approval',
        inputSchema: Text,
        outputSchema: Text,
        payloadSchema: ApprovalSignal,
        resume: (input, payload) => ({
          text: `${input.text}:${payload.approved}`,
        }),
        signal: 'approve',
      }),
      signals: { approve: { schema: ApprovalSignal, schemaVersion: 1 } },
    });
    const definition = register(
      workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'nested-signal',
        inputSchema: Text,
        outputSchema: Text,
        root: nested,
      })
    );
    const initial = start(definition, { text: 'draft' });

    const plan = planWorkflowSignal({
      definition,
      nodeInstanceId: 'approval-flow/approval',
      nodes: initial.nodes,
      payload: { approved: true },
      stepPolicies: initial.stepPolicies,
    });

    expect(plan.signalType).toBe('approve');
    expect(plan.completedOutput).toEqual({ text: 'draft:true' });
  });

  test('advances a two-step sequence and completes its frame after the second step', () => {
    const first = step({
      id: 'first',
      inputSchema: Text,
      outputSchema: Text,
      run: async ({ input }) => input,
    });
    const second = step({
      id: 'second',
      inputSchema: Text,
      outputSchema: Text,
      run: async ({ input }) => input,
      undo: async () => undefined,
    });
    const definition = register(
      workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'linear-continuation',
        inputSchema: Text,
        outputSchema: Text,
        root: sequence({ id: 'root', nodes: [first, second] }),
      })
    );
    const initial = start(definition, { text: 'input' });

    expect(() =>
      planWorkflowContinuation({
        completedNode: { nodeInstanceId: 'root/first', output: { text: 'prepared' } },
        definition,
        nodes: initial.nodes,
        stepPolicies: initial.stepPolicies,
      })
    ).toThrow('Workflow step root/first is not running.');

    const firstPlan = continueFrom(definition, initial.stepPolicies, initial.nodes, 'root/first', {
      text: 'prepared',
    });

    expect(firstPlan.nodeUpdates).toEqual([
      {
        instanceId: 'root/first',
        output: { text: 'prepared' },
        status: 'completed',
      },
      { instanceId: 'root', runtimeState: { activeIndex: 1 }, status: 'waiting' },
    ]);
    expect(firstPlan.newNodes).toEqual([
      expect.objectContaining({
        definitionId: 'second',
        hasUndo: true,
        input: { text: 'prepared' },
        instanceId: 'root/second',
        parentInstanceId: 'root',
        status: 'queued',
      }),
    ]);
    expect(firstPlan).not.toHaveProperty('completedOutput');

    const secondPlan = continueFrom(
      definition,
      initial.stepPolicies,
      applyPlan(initial.nodes, firstPlan),
      'root/second',
      { text: 'done' }
    );
    expect(secondPlan.nodeUpdates).toEqual([
      { instanceId: 'root/second', output: { text: 'done' }, status: 'completed' },
      { instanceId: 'root', output: { text: 'done' }, status: 'completed' },
    ]);
    expect(secondPlan.completedOutput).toEqual({ text: 'done' });
  });

  test('runs a pure emit between durable steps without adding another checkpoint', () => {
    const first = step({
      id: 'first',
      inputSchema: Text,
      outputSchema: Text,
      run: async ({ input }) => input,
    });
    const announce = emit({
      event: 'prepared',
      id: 'announce',
      inputSchema: Text,
      payload: input => input,
    });
    const second = step({
      id: 'second',
      inputSchema: Text,
      outputSchema: Text,
      run: async ({ input }) => input,
    });
    const definition = register(
      workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        events: {
          prepared: { durability: 'durable', schema: Text, schemaVersion: 1 },
        },
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'emit-continuation',
        inputSchema: Text,
        outputSchema: Text,
        root: sequence({ id: 'root', nodes: [first, announce, second] }),
      })
    );
    const initial = start(definition, { text: 'input' });

    const plan = continueFrom(definition, initial.stepPolicies, initial.nodes, 'root/first', {
      text: 'prepared',
    });

    expect(plan.newNodes.map(node => [node.instanceId, node.status])).toEqual([
      ['root/announce', 'completed'],
      ['root/second', 'queued'],
    ]);
    expect(plan.durableEvents).toEqual([
      { eventType: 'prepared', payload: { text: 'prepared' }, schemaVersion: 1 },
    ]);
    expect(plan.nodeUpdates.at(-1)).toEqual({
      instanceId: 'root',
      runtimeState: { activeIndex: 2 },
      status: 'waiting',
    });
  });

  test('completes the selected route', () => {
    const selected = step({
      id: 'selected',
      inputSchema: Text,
      outputSchema: Text,
      run: async ({ input }) => input,
    });
    const other = step({
      id: 'other',
      inputSchema: Text,
      outputSchema: Text,
      run: async ({ input }) => input,
    });
    const definition = register(
      workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'route-continuation',
        inputSchema: Text,
        outputSchema: Text,
        root: routeBy({
          cases: { no: other, yes: selected },
          id: 'choice',
          inputSchema: Text,
          outputSchema: Text,
          select: () => 'yes',
        }),
      })
    );
    const initial = start(definition, { text: 'input' });

    const plan = continueFrom(definition, initial.stepPolicies, initial.nodes, 'choice/selected', {
      text: 'done',
    });

    expect(plan.nodeUpdates).toEqual([
      { instanceId: 'choice/selected', output: { text: 'done' }, status: 'completed' },
      { instanceId: 'choice', output: { text: 'done' }, status: 'completed' },
    ]);
    expect(plan.completedOutput).toEqual({ text: 'done' });
  });

  test('continues, finishes and exhausts repeat deterministically', () => {
    const State = z.object({ revision: z.number() });
    const review = step({
      id: 'review',
      inputSchema: State,
      outputSchema: repeatDecisionSchema(State),
      run: async () => finishRepeat({ revision: 0 }),
    });
    const makeDefinition = (
      maxIterations: number,
      onExhausted = (state: z.output<typeof State>) => state
    ) =>
      register(
        workflow({
          compatibilityId: 'test-v1',
          configSchema: WorkflowExecutionDefaultsSchema,
          executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
          id: `repeat-${maxIterations}`,
          inputSchema: State,
          outputSchema: State,
          root: repeat({
            body: review,
            id: 'refine',
            maxIterations,
            onExhausted,
            stateSchema: State,
          }),
        })
      );
    const definition = makeDefinition(2);
    const initial = start(definition, { revision: 0 });

    const continuePlan = continueFrom(
      definition,
      initial.stepPolicies,
      initial.nodes,
      'refine/iteration:1/review',
      continueRepeatWith({ revision: 1 })
    );
    expect(continuePlan.nodeUpdates.at(-1)).toEqual({
      instanceId: 'refine',
      runtimeState: { iteration: 2 },
      status: 'waiting',
    });
    expect(continuePlan.newNodes).toEqual([
      expect.objectContaining({
        input: { revision: 1 },
        instanceId: 'refine/iteration:2/review',
        parentInstanceId: 'refine',
      }),
    ]);

    const finishPlan = continueFrom(
      definition,
      initial.stepPolicies,
      applyPlan(initial.nodes, continuePlan),
      'refine/iteration:2/review',
      finishRepeat({ revision: 2 })
    );
    expect(finishPlan.completedOutput).toEqual({ revision: 2 });

    const exhaustedDefinition = makeDefinition(1, state => ({ revision: state.revision + 10 }));
    const exhaustedInitial = start(exhaustedDefinition, { revision: 0 });
    const exhaustedPlan = continueFrom(
      exhaustedDefinition,
      exhaustedInitial.stepPolicies,
      exhaustedInitial.nodes,
      'refine/iteration:1/review',
      continueRepeatWith({ revision: 1 })
    );
    expect(exhaustedPlan.completedOutput).toEqual({ revision: 11 });
  });

  test('fans in only after the last item and keeps the declared input order', () => {
    const FanInput = z.object({ values: z.array(z.string()) });
    const FanOutput = z.object({ values: z.array(z.string()) });
    const worker = step({
      id: 'worker',
      inputSchema: z.string(),
      outputSchema: z.string(),
      run: async ({ input }) => input,
    });
    const aggregate = vi.fn(
      (
        results: readonly FanOutResult<string, string>[],
        _parentInput: z.infer<typeof FanInput>
      ) => ({
        values: results.flatMap(result => (result.status === 'completed' ? [result.output] : [])),
      })
    );
    const definition = register(
      workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'fan-continuation',
        inputSchema: FanInput,
        outputSchema: FanOutput,
        root: fanOut({
          failureMode: 'collect',
          fanIn: aggregate,
          id: 'fan',
          inputSchema: FanInput,
          inputs: input => input.values,
          itemSchema: z.string(),
          keyBy: input => input,
          outputSchema: FanOutput,
          worker,
        }),
      })
    );
    const initial = start(definition, { values: ['first', 'second'] });

    const secondPlan = continueFrom(
      definition,
      initial.stepPolicies,
      initial.nodes,
      'fan/item:second/worker',
      'SECOND'
    );
    expect(aggregate).not.toHaveBeenCalled();
    expect(secondPlan).not.toHaveProperty('completedOutput');

    const firstPlan = continueFrom(
      definition,
      initial.stepPolicies,
      applyPlan(initial.nodes, secondPlan),
      'fan/item:first/worker',
      'FIRST'
    );
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(
      aggregate.mock.calls[0]?.[0].flatMap(result =>
        result.status === 'completed' ? [result.output] : []
      )
    ).toEqual(['FIRST', 'SECOND']);
    expect(aggregate.mock.calls[0]?.[1]).toEqual({ values: ['first', 'second'] });
    expect(firstPlan.completedOutput).toEqual({ values: ['FIRST', 'SECOND'] });

    aggregate.mockClear();
    const failedSecond = initial.nodes.map(node =>
      node.instanceId === 'fan/item:second/worker'
        ? {
            ...node,
            failure: { code: 'render_failed', kind: 'permanent' as const, message: 'failed' },
            status: 'failed' as const,
          }
        : node
    );
    continueFrom(definition, initial.stepPolicies, failedSecond, 'fan/item:first/worker', 'FIRST');
    expect(aggregate.mock.calls[0]?.[0].map(result => result.status)).toEqual([
      'completed',
      'failed',
    ]);

    aggregate.mockClear();
    const failFastDefinition = register(
      workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'fan-continuation-fail-fast',
        inputSchema: FanInput,
        outputSchema: FanOutput,
        root: fanOut({
          failureMode: 'fail-fast',
          fanIn: aggregate,
          id: 'fan',
          inputSchema: FanInput,
          inputs: input => input.values,
          itemSchema: z.string(),
          keyBy: input => input,
          outputSchema: FanOutput,
          worker,
        }),
      })
    );
    const failFastInitial = start(failFastDefinition, { values: ['first', 'second'] });
    const failure = { code: 'render_failed', kind: 'permanent' as const, message: 'failed' };
    const failFastSnapshot = failFastInitial.nodes.map(node =>
      node.instanceId === 'fan/item:second/worker'
        ? { ...node, failure, status: 'failed' as const }
        : node
    );
    const failedPlan = continueFrom(
      failFastDefinition,
      failFastInitial.stepPolicies,
      failFastSnapshot,
      'fan/item:first/worker',
      'FIRST'
    );
    expect(aggregate).not.toHaveBeenCalled();
    expect(failedPlan.nodeUpdates.at(-1)).toEqual({
      failure,
      instanceId: 'fan',
      status: 'failed',
    });
    expect(failedPlan.terminalFailure).toEqual({ failure, nodeInstanceId: 'fan' });
  });

  test('propagates an exhausted step failure through collect and fail-fast fan-out', () => {
    const FanInput = z.object({ values: z.array(z.string()) });
    const FanOutput = z.object({ failures: z.number() });
    const worker = step({
      id: 'worker',
      inputSchema: z.string(),
      outputSchema: z.string(),
      run: async ({ input }) => input,
    });
    const makeDefinition = (failureMode: 'collect' | 'fail-fast') =>
      register(
        workflow({
          compatibilityId: 'test-v1',
          configSchema: WorkflowExecutionDefaultsSchema,
          executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
          id: `failure-${failureMode}`,
          inputSchema: FanInput,
          outputSchema: FanOutput,
          root: fanOut({
            failureMode,
            fanIn: results => ({
              failures: results.filter(result => result.status === 'failed').length,
            }),
            id: 'fan',
            inputSchema: FanInput,
            inputs: input => input.values,
            itemSchema: z.string(),
            keyBy: input => input,
            outputSchema: FanOutput,
            worker,
          }),
        })
      );

    const collect = makeDefinition('collect');
    const collectStart = start(collect, { values: ['first'] });
    const collectPlan = failFrom(
      collect,
      collectStart.stepPolicies,
      collectStart.nodes,
      'fan/item:first/worker'
    );
    expect(collectPlan.completedOutput).toEqual({ failures: 1 });
    expect(collectPlan.terminalFailure).toBeUndefined();

    const failFast = makeDefinition('fail-fast');
    const failFastStart = start(failFast, { values: ['first'] });
    const failFastPlan = failFrom(
      failFast,
      failFastStart.stepPolicies,
      failFastStart.nodes,
      'fan/item:first/worker'
    );
    expect(failFastPlan.completedOutput).toBeUndefined();
    expect(failFastPlan.terminalFailure).toEqual({
      failure: { code: 'render_failed', kind: 'permanent', message: 'failed' },
      nodeInstanceId: 'fan',
    });

    const orderedFailFast = makeDefinition('fail-fast');
    const orderedStart = start(orderedFailFast, { values: ['pending', 'failed'] });
    const orderedPlan = failFrom(
      orderedFailFast,
      orderedStart.stepPolicies,
      orderedStart.nodes,
      'fan/item:failed/worker'
    );
    expect(orderedPlan.terminalFailure).toEqual({
      failure: { code: 'render_failed', kind: 'permanent', message: 'failed' },
      nodeInstanceId: 'fan',
    });
  });

  test('materializes, validates and resumes a typed signal wait', () => {
    const draft = step({
      id: 'draft',
      inputSchema: Text,
      outputSchema: Text,
      run: async ({ input }) => input,
    });
    const approval = waitForSignal({
      id: 'approval',
      inputSchema: Text,
      outputSchema: Text,
      payloadSchema: ApprovalSignal,
      resume: (input, payload) => ({
        text: `${input.text}:${payload.approved}`,
      }),
      signal: 'approve',
    });
    const definition = register(
      workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'signal-continuation',
        inputSchema: Text,
        outputSchema: Text,
        root: sequence({ id: 'root', nodes: [draft, approval] }),
        signals: { approve: { schema: ApprovalSignal, schemaVersion: 1 } },
      })
    );
    const initial = start(definition, { text: 'draft' });
    const waitingPlan = continueFrom(
      definition,
      initial.stepPolicies,
      initial.nodes,
      'root/draft',
      { text: 'draft' }
    );
    expect(waitingPlan.newWaits).toEqual([
      {
        nodeInstanceId: 'root/approval',
        schemaVersion: 1,
        signalType: 'approve',
        waitId: 'wait:root/approval',
      },
    ]);
    const waitingSnapshot = applyPlan(initial.nodes, waitingPlan);

    const plan = planWorkflowSignal({
      definition,
      nodeInstanceId: 'root/approval',
      nodes: waitingSnapshot,
      payload: { approved: true, ignored: 'not persisted' },
      stepPolicies: initial.stepPolicies,
    });

    expect(plan.completedOutput).toEqual({ text: 'draft:true' });
    expect(plan.signalPayload).toEqual({ approved: true });
    expect(plan.signalType).toBe('approve');
    expect(() =>
      planWorkflowSignal({
        definition,
        nodeInstanceId: 'root/approval',
        nodes: waitingSnapshot,
        payload: { approved: false },
        stepPolicies: initial.stepPolicies,
      })
    ).toThrow();
  });

  test('keeps a present null completion distinct from an incomplete plan', () => {
    const definition = register(
      workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'null-continuation',
        inputSchema: z.null(),
        outputSchema: z.null(),
        root: step({
          id: 'finish',
          inputSchema: z.null(),
          outputSchema: z.null(),
          run: async () => null,
        }),
      })
    );
    const initial = start(definition, null);

    const plan = continueFrom(definition, initial.stepPolicies, initial.nodes, 'finish', null);

    expect(Object.hasOwn(plan, 'completedOutput')).toBe(true);
    expect(plan.completedOutput).toBeNull();
  });

  test('normalizes completed output to its durable JSON representation', () => {
    const Output = z.object({ note: z.string().optional(), text: z.string() });
    const definition = register(
      workflow({
        compatibilityId: 'test-v1',
        configSchema: WorkflowExecutionDefaultsSchema,
        executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
        id: 'durable-output-continuation',
        inputSchema: Text,
        outputSchema: Output,
        root: step({
          id: 'finish',
          inputSchema: Text,
          outputSchema: Output,
          run: async ({ input }) => ({ text: input.text }),
        }),
      })
    );
    const initial = start(definition, { text: 'done' });
    const rawOutput = { note: undefined, text: 'done' };

    const plan = continueFrom(definition, initial.stepPolicies, initial.nodes, 'finish', rawOutput);

    expect(plan.completedOutput).toEqual({ text: 'done' });
    expect(plan.completedOutput).not.toBe(rawOutput);
  });
});
