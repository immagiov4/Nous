import { randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';

import { assertWorkflowExecutionDefaults, resolveWorkflowStepConfig } from './config.js';
import { snapshotDurableJson, snapshotImmutableJson } from './jsonSnapshot.js';
import type {
  FanOutResult,
  RegisteredWorkflow,
  RepeatDecision,
  WorkflowExecutionDefaults,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowStepPolicies,
} from './types.js';
import { WORKFLOW_STEP_POLICIES_VERSION } from './types.js';
import { assertRegisteredWorkflowIntegrity } from './validation.js';
import {
  escapeWorkflowPathSegment,
  type IndexedWorkflowNode,
  indexWorkflowNodes,
  workflowChildPath,
} from './workflowNodeIndex.js';

type RuntimeEmit = Extract<WorkflowNode, { kind: 'emit' }>;
type RuntimeFanOut = Extract<WorkflowNode, { kind: 'fanOut' }>;
type RuntimeRepeat = Extract<WorkflowNode, { kind: 'repeat' }>;
type RuntimeRoute = Extract<WorkflowNode, { kind: 'routeBy' }>;
type RuntimeSequence = Extract<WorkflowNode, { kind: 'sequence' }>;
type RuntimeStep = Extract<WorkflowNode, { kind: 'step' }>;
type RuntimeWait = Extract<WorkflowNode, { kind: 'waitForSignal' }>;
type RuntimeWorkflow = Extract<WorkflowNode, { kind: 'workflow' }>;

export interface MaterializedWorkflowNode {
  definitionId: string;
  hasUndo: boolean;
  input: unknown;
  instanceId: string;
  itemKey?: string;
  kind: WorkflowNodeKind;
  maxAttempts: number;
  output?: unknown;
  parentInstanceId: string | undefined;
  runtimeState: Record<string, unknown> | undefined;
  status: 'completed' | 'queued' | 'waiting';
  timeoutMs: number;
}

export interface MaterializedWorkflowWait {
  nodeInstanceId: string;
  schemaVersion: number;
  signalType: string;
  waitId: string;
}

export interface MaterializedWorkflowEvent {
  eventType: string;
  payload: unknown;
  schemaVersion: number;
}

export interface WorkflowBranchMaterialization {
  completedOutput?: unknown;
  durableEvents: MaterializedWorkflowEvent[];
  nodes: MaterializedWorkflowNode[];
  transientEvents: MaterializedWorkflowEvent[];
  waits: MaterializedWorkflowWait[];
}

export interface WorkflowStartMaterialization extends WorkflowBranchMaterialization {
  stepPolicies: WorkflowStepPolicies;
  stepPoliciesVersion: typeof WORKFLOW_STEP_POLICIES_VERSION;
}

interface MaterializationContext {
  createId: (nodeInstanceId: string) => string;
  defaults: WorkflowExecutionDefaults;
  definitions: ReadonlyMap<string, IndexedWorkflowNode>;
  result: WorkflowBranchMaterialization;
  stepPolicies: WorkflowStepPolicies;
}

interface ExpansionArguments<Node extends WorkflowNode = WorkflowNode> {
  context: MaterializationContext;
  definitionId: string;
  definitionNamespace: string | undefined;
  input: unknown;
  instanceId: string;
  itemKey?: string;
  node: Node;
  parentInstanceId: string | undefined;
}

type ExpansionResult = { completed: false } | { completed: true; output: unknown };

interface ExpansionLocation {
  definitionNamespace: string | undefined;
  instancePath: string | undefined;
  parentInstanceId: string | undefined;
}

const registeredNode = (value: unknown): WorkflowNode => value as WorkflowNode;

const collectStepPolicies = (
  node: WorkflowNode,
  defaults: WorkflowExecutionDefaults,
  configSchema: ZodType,
  entries: Array<
    [string, { config: Readonly<Record<string, unknown>>; maxAttempts: number; timeoutMs: number }]
  >,
  namespace: string | undefined
): void => {
  const definitionId = workflowChildPath(namespace, node.id);
  switch (node.kind) {
    case 'step': {
      const config = snapshotImmutableJson(
        resolveWorkflowStepConfig({
          baseConfig: defaults as unknown as Record<string, unknown>,
          configOverride: node.config,
          configSchema,
          maxAttempts: node.maxAttempts,
          path: `steps.${definitionId}.config`,
          timeoutMs: node.timeoutMs,
        })
      );
      entries.push([
        definitionId,
        Object.freeze({
          config,
          maxAttempts: config.maxAttempts as number,
          timeoutMs: config.timeoutMs as number,
        }),
      ]);
      return;
    }
    case 'sequence':
      node.nodes.forEach(child => {
        collectStepPolicies(registeredNode(child), defaults, configSchema, entries, namespace);
      });
      return;
    case 'routeBy':
      Object.values(node.cases).forEach(child => {
        collectStepPolicies(registeredNode(child), defaults, configSchema, entries, namespace);
      });
      return;
    case 'fanOut':
      collectStepPolicies(registeredNode(node.worker), defaults, configSchema, entries, namespace);
      return;
    case 'repeat':
      collectStepPolicies(registeredNode(node.body), defaults, configSchema, entries, namespace);
      return;
    case 'workflow':
      collectStepPolicies(registeredNode(node.root), defaults, configSchema, entries, definitionId);
      return;
    case 'emit':
    case 'waitForSignal':
      return;
  }
};

const resolveStepPolicies = (
  root: WorkflowNode,
  defaults: WorkflowExecutionDefaults,
  configSchema: ZodType
): WorkflowStepPolicies => {
  const entries: Array<
    [string, { config: Readonly<Record<string, unknown>>; maxAttempts: number; timeoutMs: number }]
  > = [];
  collectStepPolicies(root, defaults, configSchema, entries, undefined);
  entries.sort(([left], [right]) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
  return Object.freeze(Object.fromEntries(entries));
};

const makeNode = (input: {
  context: MaterializationContext;
  definitionId: string;
  input: unknown;
  instanceId: string;
  itemKey?: string;
  node: WorkflowNode;
  parentInstanceId: string | undefined;
  runtimeState?: Record<string, unknown>;
  status: MaterializedWorkflowNode['status'];
}): MaterializedWorkflowNode => {
  const executionPolicy =
    input.node.kind === 'step'
      ? input.context.stepPolicies[input.definitionId]
      : input.context.defaults;
  if (!executionPolicy) {
    throw new Error(`Missing execution policy for step ${input.definitionId}.`);
  }
  return {
    definitionId: input.definitionId,
    hasUndo: input.node.kind === 'step' && input.node.undo !== undefined,
    input: input.input,
    instanceId: input.instanceId,
    ...(input.itemKey === undefined ? {} : { itemKey: input.itemKey }),
    kind: input.node.kind,
    maxAttempts: executionPolicy.maxAttempts,
    parentInstanceId: input.parentInstanceId,
    runtimeState: input.runtimeState,
    status: input.status,
    timeoutMs: executionPolicy.timeoutMs,
  };
};

const completeFrame = (
  frame: MaterializedWorkflowNode,
  node: WorkflowNode,
  output: unknown
): ExpansionResult => {
  const parsedOutput = snapshotDurableJson(node.outputSchema.parse(output));
  frame.status = 'completed';
  frame.output = parsedOutput;
  return { completed: true, output: parsedOutput };
};

const expandStep = (input: ExpansionArguments<RuntimeStep>): ExpansionResult => {
  input.context.result.nodes.push(makeNode({ ...input, status: 'queued' }));
  return { completed: false };
};

const expandSequence = (input: ExpansionArguments<RuntimeSequence>): ExpansionResult => {
  const frame = makeNode({
    ...input,
    runtimeState: { activeIndex: 0 },
    status: 'waiting',
  });
  input.context.result.nodes.push(frame);
  let value = input.input;
  for (const [index, rawChild] of input.node.nodes.entries()) {
    const child = registeredNode(rawChild);
    frame.runtimeState = { activeIndex: index };
    const childResult = expandNode(
      child,
      value,
      {
        definitionNamespace: input.definitionNamespace,
        instancePath: input.instanceId,
        parentInstanceId: input.instanceId,
      },
      input.context
    );
    if (!childResult.completed) return childResult;
    value = childResult.output;
  }
  return completeFrame(frame, input.node, value);
};

const expandRoute = (input: ExpansionArguments<RuntimeRoute>): ExpansionResult => {
  const select = input.node.select as (value: unknown) => string;
  const selectedCase = select(input.input);
  const rawSelectedNode = input.node.cases[selectedCase];
  if (!Object.hasOwn(input.node.cases, selectedCase) || !rawSelectedNode) {
    throw new Error(`Route ${input.node.id} selected unknown case "${selectedCase}".`);
  }
  const selectedNode = registeredNode(rawSelectedNode);
  const frame = makeNode({
    ...input,
    runtimeState: { selectedCase },
    status: 'waiting',
  });
  input.context.result.nodes.push(frame);
  const childResult = expandNode(
    selectedNode,
    input.input,
    {
      definitionNamespace: input.definitionNamespace,
      instancePath: input.instanceId,
      parentInstanceId: input.instanceId,
    },
    input.context
  );
  return childResult.completed ? completeFrame(frame, input.node, childResult.output) : childResult;
};

const keyedFanOutInputs = (
  node: RuntimeFanOut,
  parentInput: unknown
): readonly { input: unknown; key: string }[] => {
  const inputs = node.inputs as (input: unknown) => readonly unknown[];
  const keyBy = node.keyBy as (input: unknown) => string;
  const keyedInputs = inputs(parentInput).map(item => {
    const parsedItem = snapshotDurableJson(node.itemSchema.parse(item));
    const key = keyBy(parsedItem);
    if (!key.trim()) throw new Error(`Fan-out ${node.id} produced an empty key.`);
    return { input: parsedItem, key };
  });
  const seenKeys = new Set<string>();
  for (const entry of keyedInputs) {
    if (seenKeys.has(entry.key)) {
      throw new Error(`Fan-out ${node.id} produced duplicate key "${entry.key}".`);
    }
    seenKeys.add(entry.key);
  }
  return keyedInputs;
};

const expandFanOut = (input: ExpansionArguments<RuntimeFanOut>): ExpansionResult => {
  const keyedInputs = keyedFanOutInputs(input.node, input.input);
  const frame = makeNode({
    ...input,
    runtimeState: { keys: keyedInputs.map(entry => entry.key) },
    status: 'waiting',
  });
  input.context.result.nodes.push(frame);
  const results: FanOutResult<unknown, unknown>[] = [];
  let pending = false;
  for (const entry of keyedInputs) {
    const itemSegment = escapeWorkflowPathSegment(`item:${entry.key}`);
    const itemParent = `${input.instanceId}/${itemSegment}`;
    const childResult = expandNode(
      registeredNode(input.node.worker),
      entry.input,
      {
        definitionNamespace: input.definitionNamespace,
        instancePath: itemParent,
        parentInstanceId: input.instanceId,
      },
      input.context,
      entry.key
    );
    if (!childResult.completed) {
      pending = true;
      continue;
    }
    results.push({
      input: entry.input,
      key: entry.key,
      output: childResult.output,
      status: 'completed',
    });
  }
  if (pending) return { completed: false };
  const fanIn = input.node.fanIn as (
    results: readonly FanOutResult<unknown, unknown>[],
    parentInput: unknown
  ) => unknown;
  return completeFrame(frame, input.node, fanIn(results, input.input));
};

const assertUniqueValues = (values: readonly string[], message: string): void => {
  if (new Set(values).size !== values.length) throw new Error(message);
};

const expandRepeat = (input: ExpansionArguments<RuntimeRepeat>): ExpansionResult => {
  const frame = makeNode({
    ...input,
    runtimeState: { iteration: 1 },
    status: 'waiting',
  });
  input.context.result.nodes.push(frame);
  let state = input.input;
  for (let iteration = 1; iteration <= input.node.maxIterations; iteration += 1) {
    frame.runtimeState = { iteration };
    const iterationParent = `${input.instanceId}/iteration:${iteration}`;
    const childResult = expandNode(
      registeredNode(input.node.body),
      state,
      {
        definitionNamespace: input.definitionNamespace,
        instancePath: iterationParent,
        parentInstanceId: input.instanceId,
      },
      input.context
    );
    if (!childResult.completed) return childResult;
    const decision = childResult.output as RepeatDecision<unknown>;
    if (decision.kind === 'finish') return completeFrame(frame, input.node, decision.state);
    state = decision.state;
  }
  const onExhausted = input.node.onExhausted as (lastState: unknown) => unknown;
  return completeFrame(frame, input.node, onExhausted(state));
};

const expandWait = (input: ExpansionArguments<RuntimeWait>): ExpansionResult => {
  const signal = input.context.definitions.get(input.definitionId)?.signals[input.node.signal];
  if (!signal) throw new Error(`Unknown workflow signal: ${input.node.signal}`);
  input.context.result.nodes.push(makeNode({ ...input, status: 'waiting' }));
  input.context.result.waits.push({
    nodeInstanceId: input.instanceId,
    schemaVersion: signal.schemaVersion,
    signalType: input.node.signal,
    waitId: input.context.createId(input.instanceId),
  });
  return { completed: false };
};

const expandEmit = (input: ExpansionArguments<RuntimeEmit>): ExpansionResult => {
  const events = input.context.definitions.get(input.definitionId)?.events;
  const eventDefinition = events?.[input.node.event];
  if (!events || !Object.hasOwn(events, input.node.event) || !eventDefinition) {
    throw new Error(`Unknown workflow event: ${input.node.event}`);
  }
  const makePayload = input.node.payload as (input: unknown) => unknown;
  const payload = snapshotDurableJson(eventDefinition.schema.parse(makePayload(input.input)));
  const event = {
    eventType: input.node.event,
    payload,
    schemaVersion: eventDefinition.schemaVersion,
  };
  input.context.result[
    eventDefinition.durability === 'durable' ? 'durableEvents' : 'transientEvents'
  ].push(event);
  const frame = makeNode({ ...input, status: 'completed' });
  input.context.result.nodes.push(frame);
  return completeFrame(frame, input.node, input.input);
};

const expandWorkflow = (input: ExpansionArguments<RuntimeWorkflow>): ExpansionResult => {
  const frame = makeNode({ ...input, status: 'waiting' });
  input.context.result.nodes.push(frame);
  const childResult = expandNode(
    registeredNode(input.node.root),
    input.input,
    {
      definitionNamespace: input.definitionId,
      instancePath: input.instanceId,
      parentInstanceId: input.instanceId,
    },
    input.context
  );
  return childResult.completed ? completeFrame(frame, input.node, childResult.output) : childResult;
};

const expandNode = (
  node: WorkflowNode,
  rawInput: unknown,
  location: ExpansionLocation,
  context: MaterializationContext,
  itemKey?: string
): ExpansionResult => {
  const input = snapshotDurableJson(node.inputSchema.parse(rawInput));
  const definitionId = workflowChildPath(location.definitionNamespace, node.id);
  const indexed = context.definitions.get(definitionId);
  if (indexed?.node.kind !== node.kind) {
    throw new Error(`Workflow node definition ${definitionId} is not registered.`);
  }
  const expansion = {
    context,
    definitionId,
    definitionNamespace: location.definitionNamespace,
    input,
    instanceId: workflowChildPath(location.instancePath, node.id),
    ...(itemKey === undefined ? {} : { itemKey }),
    node,
    parentInstanceId: location.parentInstanceId,
  };
  switch (node.kind) {
    case 'step':
      return expandStep({ ...expansion, node });
    case 'sequence':
      return expandSequence({ ...expansion, node });
    case 'routeBy':
      return expandRoute({ ...expansion, node });
    case 'fanOut':
      return expandFanOut({ ...expansion, node });
    case 'repeat':
      return expandRepeat({ ...expansion, node });
    case 'workflow':
      return expandWorkflow({ ...expansion, node });
    case 'waitForSignal':
      return expandWait({ ...expansion, node });
    case 'emit':
      return expandEmit({ ...expansion, node });
  }
};

export const materializeWorkflowBranch = (input: {
  createWaitId: (nodeInstanceId: string) => string;
  defaults: WorkflowExecutionDefaults;
  definitionNamespace: string | undefined;
  definitions: ReadonlyMap<string, IndexedWorkflowNode>;
  instancePath: string | undefined;
  node: WorkflowNode;
  parentInstanceId: string | undefined;
  rawInput: unknown;
  stepPolicies: WorkflowStepPolicies;
}): WorkflowBranchMaterialization => {
  const result: WorkflowBranchMaterialization = {
    durableEvents: [],
    nodes: [],
    transientEvents: [],
    waits: [],
  };
  const expansion = expandNode(
    input.node,
    input.rawInput,
    {
      definitionNamespace: input.definitionNamespace,
      instancePath: input.instancePath,
      parentInstanceId: input.parentInstanceId,
    },
    {
      createId: input.createWaitId,
      defaults: input.defaults,
      definitions: input.definitions,
      result,
      stepPolicies: input.stepPolicies,
    }
  );
  if (expansion.completed) result.completedOutput = expansion.output;
  assertUniqueValues(
    result.nodes.map(node => node.instanceId),
    'Workflow materialization produced duplicate node instance ids.'
  );
  assertUniqueValues(
    result.waits.map(wait => wait.waitId),
    'Workflow materialization produced duplicate wait ids.'
  );
  return result;
};

export const materializeWorkflowStart = <
  Input,
  Output,
  Config extends WorkflowExecutionDefaults,
  Services,
>(
  definition: RegisteredWorkflow<Input, Output, Config, Services>,
  rawInput: unknown,
  options: { createId?: (nodeInstanceId: string) => string; resolvedConfig: unknown }
): WorkflowStartMaterialization => {
  assertRegisteredWorkflowIntegrity(definition);
  const input = snapshotDurableJson(definition.inputSchema.parse(rawInput));
  const defaults = snapshotDurableJson(definition.configSchema.parse(options.resolvedConfig));
  assertWorkflowExecutionDefaults(defaults, 'resolvedConfig');
  const definitions = indexWorkflowNodes(definition);
  const stepPolicies = resolveStepPolicies(definition.root, defaults, definition.configSchema);
  const branch = materializeWorkflowBranch({
    createWaitId: options.createId ?? (() => randomUUID()),
    defaults,
    definitionNamespace: undefined,
    definitions,
    instancePath: undefined,
    node: definition.root,
    parentInstanceId: undefined,
    rawInput: input,
    stepPolicies,
  });
  return { ...branch, stepPolicies, stepPoliciesVersion: WORKFLOW_STEP_POLICIES_VERSION };
};
