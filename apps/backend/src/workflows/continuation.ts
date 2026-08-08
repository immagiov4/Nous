import { snapshotDurableJson } from './jsonSnapshot.js';
import {
  type MaterializedWorkflowEvent,
  type MaterializedWorkflowNode,
  type MaterializedWorkflowWait,
  materializeWorkflowBranch,
} from './materialization.js';
import type {
  FanOutResult,
  RegisteredWorkflow,
  RepeatDecision,
  StepFailure,
  WorkflowExecutionDefaults,
  WorkflowNode,
  WorkflowStepPolicies,
} from './types.js';
import { assertRegisteredWorkflowIntegrity } from './validation.js';
import {
  escapeWorkflowPathSegment,
  indexWorkflowNodes,
  workflowChildPath,
} from './workflowNodeIndex.js';

type RuntimeFanOut = Extract<WorkflowNode, { kind: 'fanOut' }>;
type RuntimeRepeat = Extract<WorkflowNode, { kind: 'repeat' }>;
type RuntimeRoute = Extract<WorkflowNode, { kind: 'routeBy' }>;
type RuntimeSequence = Extract<WorkflowNode, { kind: 'sequence' }>;
type RuntimeWorkflow = Extract<WorkflowNode, { kind: 'workflow' }>;

export type WorkflowNodeSnapshotStatus =
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'queued'
  | 'retrying'
  | 'running'
  | 'waiting';

export interface WorkflowNodeSnapshot extends Omit<MaterializedWorkflowNode, 'status'> {
  failure?: StepFailure;
  status: WorkflowNodeSnapshotStatus;
}

export type WorkflowNodeUpdate =
  | {
      failure: StepFailure;
      instanceId: string;
      status: 'failed';
    }
  | {
      instanceId: string;
      output: unknown;
      status: 'completed';
    }
  | {
      instanceId: string;
      runtimeState: Record<string, unknown>;
      status: 'waiting';
    };

export interface WorkflowContinuationPlan {
  completedOutput?: unknown;
  durableEvents: MaterializedWorkflowEvent[];
  newNodes: MaterializedWorkflowNode[];
  newWaits: MaterializedWorkflowWait[];
  nodeUpdates: WorkflowNodeUpdate[];
  terminalFailure?: { failure: StepFailure; nodeInstanceId: string };
  transientEvents: MaterializedWorkflowEvent[];
}

export interface WorkflowSignalPlan extends WorkflowContinuationPlan {
  signalPayload: unknown;
  signalSchemaVersion: number;
  signalType: string;
}

/**
 * `nodes` must be loaded after serializing the run inside the checkpoint transaction.
 * Planning from an earlier snapshot can miss a concurrently completed fan-out sibling.
 */
export interface WorkflowContinuationInput<
  Input = unknown,
  Output = unknown,
  Config extends WorkflowExecutionDefaults = WorkflowExecutionDefaults,
  Services = unknown,
> {
  completedNode: { nodeInstanceId: string; output: unknown };
  definition: RegisteredWorkflow<Input, Output, Config, Services>;
  nodes: readonly WorkflowNodeSnapshot[];
  stepPolicies: WorkflowStepPolicies;
  waitIdForNode?: (nodeInstanceId: string) => string;
}

export interface WorkflowFailureInput<
  Input = unknown,
  Output = unknown,
  Config extends WorkflowExecutionDefaults = WorkflowExecutionDefaults,
  Services = unknown,
> {
  definition: RegisteredWorkflow<Input, Output, Config, Services>;
  failedNode: { failure: StepFailure; nodeInstanceId: string };
  nodes: readonly WorkflowNodeSnapshot[];
  stepPolicies: WorkflowStepPolicies;
  waitIdForNode?: (nodeInstanceId: string) => string;
}

/** The store resolves `nodeInstanceId` from an owned, active, one-shot wait before calling this. */
export interface WorkflowSignalInput<
  Input = unknown,
  Output = unknown,
  Config extends WorkflowExecutionDefaults = WorkflowExecutionDefaults,
  Services = unknown,
> {
  definition: RegisteredWorkflow<Input, Output, Config, Services>;
  nodeInstanceId: string;
  nodes: readonly WorkflowNodeSnapshot[];
  payload: unknown;
  stepPolicies: WorkflowStepPolicies;
  waitIdForNode?: (nodeInstanceId: string) => string;
}

interface PlanningContext {
  definition: Pick<RegisteredWorkflow, 'events' | 'outputSchema' | 'signals'>;
  definitions: ReturnType<typeof indexWorkflowNodes>;
  insertedNodes: Map<string, MaterializedWorkflowNode>;
  plan: WorkflowContinuationPlan;
  snapshotNodes: ReadonlyMap<string, WorkflowNodeSnapshot>;
  stepPolicies: WorkflowStepPolicies;
  updates: Map<string, WorkflowNodeUpdate>;
  waitIdForNode?: (nodeInstanceId: string) => string;
}

const asWorkflowNode = (value: unknown): WorkflowNode => value as WorkflowNode;

const indexSnapshotNodes = (
  nodes: readonly WorkflowNodeSnapshot[]
): ReadonlyMap<string, WorkflowNodeSnapshot> => {
  const indexed = new Map<string, WorkflowNodeSnapshot>();
  for (const node of nodes) {
    if (indexed.has(node.instanceId)) {
      throw new Error(`Duplicate workflow node instance ${node.instanceId}.`);
    }
    indexed.set(node.instanceId, node);
  }
  return indexed;
};

const definitionFor = (context: PlanningContext, node: WorkflowNodeSnapshot): WorkflowNode => {
  const definition = context.definitions.get(node.definitionId)?.node;
  if (definition?.kind !== node.kind) {
    throw new Error(`Workflow node ${node.instanceId} does not match its registered definition.`);
  }
  return definition;
};

const definitionNamespaceFor = (
  context: PlanningContext,
  node: WorkflowNodeSnapshot
): string | undefined => {
  const indexed = context.definitions.get(node.definitionId);
  if (indexed?.node.kind !== node.kind) {
    throw new Error(`Workflow node ${node.instanceId} does not match its registered definition.`);
  }
  return indexed.namespace;
};

const currentNode = (context: PlanningContext, instanceId: string): WorkflowNodeSnapshot => {
  const inserted = context.insertedNodes.get(instanceId);
  const snapshot = inserted ?? context.snapshotNodes.get(instanceId);
  if (!snapshot) throw new Error(`Unknown workflow node instance ${instanceId}.`);
  const update = context.updates.get(instanceId);
  return update ? ({ ...snapshot, ...update } as WorkflowNodeSnapshot) : snapshot;
};

const recordUpdate = (context: PlanningContext, update: WorkflowNodeUpdate): void => {
  const inserted = context.insertedNodes.get(update.instanceId);
  if (inserted) {
    Object.assign(inserted, update);
    return;
  }
  if (!context.snapshotNodes.has(update.instanceId)) {
    throw new Error(`Cannot update unknown workflow node ${update.instanceId}.`);
  }
  context.updates.set(update.instanceId, update);
};

const completedOutput = (node: WorkflowNodeSnapshot): unknown => {
  if (node.status !== 'completed' || !Object.hasOwn(node, 'output')) {
    throw new Error(`Workflow node ${node.instanceId} has no completed output.`);
  }
  return node.output;
};

const integerState = (node: WorkflowNodeSnapshot, key: string): number => {
  const value = node.runtimeState?.[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Workflow node ${node.instanceId} has invalid ${key} state.`);
  }
  return value as number;
};

const stringState = (node: WorkflowNodeSnapshot, key: string): string => {
  const value = node.runtimeState?.[key];
  if (typeof value !== 'string') {
    throw new TypeError(`Workflow node ${node.instanceId} has invalid ${key} state.`);
  }
  return value;
};

const stringArrayState = (node: WorkflowNodeSnapshot, key: string): readonly string[] => {
  const value = node.runtimeState?.[key];
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new TypeError(`Workflow node ${node.instanceId} has invalid ${key} state.`);
  }
  return value as string[];
};

const assertExpectedChild = (
  parent: WorkflowNodeSnapshot,
  child: WorkflowNodeSnapshot,
  expectedInstanceId: string
): void => {
  if (child.parentInstanceId !== parent.instanceId || child.instanceId !== expectedInstanceId) {
    throw new Error(
      `Workflow node ${child.instanceId} is not the active child of ${parent.instanceId}.`
    );
  }
};

const addBranch = (
  context: PlanningContext,
  input: unknown,
  node: WorkflowNode,
  definitionNamespace: string | undefined,
  instancePath: string,
  parent: WorkflowNodeSnapshot
): { completed: false } | { completed: true; output: unknown } => {
  const branch = materializeWorkflowBranch({
    createWaitId: instanceId => {
      if (!context.waitIdForNode) {
        throw new Error(`A stable wait id is required for workflow node ${instanceId}.`);
      }
      return context.waitIdForNode(instanceId);
    },
    defaults: { maxAttempts: parent.maxAttempts, timeoutMs: parent.timeoutMs },
    definitionNamespace,
    definitions: context.definitions,
    instancePath,
    node,
    parentInstanceId: parent.instanceId,
    rawInput: input,
    stepPolicies: context.stepPolicies,
  });
  for (const materialized of branch.nodes) {
    if (
      context.snapshotNodes.has(materialized.instanceId) ||
      context.insertedNodes.has(materialized.instanceId)
    ) {
      throw new Error(`Workflow node instance ${materialized.instanceId} already exists.`);
    }
    context.insertedNodes.set(materialized.instanceId, materialized);
    context.plan.newNodes.push(materialized);
  }
  context.plan.newWaits.push(...branch.waits);
  context.plan.durableEvents.push(...branch.durableEvents);
  context.plan.transientEvents.push(...branch.transientEvents);
  return Object.hasOwn(branch, 'completedOutput')
    ? { completed: true, output: branch.completedOutput }
    : { completed: false };
};

const completeFrame = (
  context: PlanningContext,
  frame: WorkflowNodeSnapshot,
  definition: WorkflowNode,
  rawOutput: unknown
): void => {
  const output = snapshotDurableJson(definition.outputSchema.parse(rawOutput));
  recordUpdate(context, { instanceId: frame.instanceId, output, status: 'completed' });
  advanceParent(context, currentNode(context, frame.instanceId), output);
};

const failFrame = (
  context: PlanningContext,
  frame: WorkflowNodeSnapshot,
  failure: StepFailure
): void => {
  recordUpdate(context, { failure, instanceId: frame.instanceId, status: 'failed' });
  advanceFailedParent(context, currentNode(context, frame.instanceId), failure);
};

const advanceSequence = (
  context: PlanningContext,
  frame: WorkflowNodeSnapshot,
  definition: RuntimeSequence,
  child: WorkflowNodeSnapshot,
  output: unknown
): void => {
  let index = integerState(frame, 'activeIndex');
  const activeDefinition = asWorkflowNode(definition.nodes[index]);
  if (!activeDefinition) throw new Error(`Sequence ${definition.id} has no active node ${index}.`);
  assertExpectedChild(frame, child, workflowChildPath(frame.instanceId, activeDefinition.id));

  let value = output;
  while (index + 1 < definition.nodes.length) {
    index += 1;
    recordUpdate(context, {
      instanceId: frame.instanceId,
      runtimeState: { activeIndex: index },
      status: 'waiting',
    });
    const next = asWorkflowNode(definition.nodes[index]);
    const expansion = addBranch(
      context,
      value,
      next,
      definitionNamespaceFor(context, frame),
      frame.instanceId,
      frame
    );
    if (!expansion.completed) return;
    value = expansion.output;
  }
  completeFrame(context, frame, definition, value);
};

const advanceRoute = (
  context: PlanningContext,
  frame: WorkflowNodeSnapshot,
  definition: RuntimeRoute,
  child: WorkflowNodeSnapshot,
  output: unknown
): void => {
  const selectedCase = stringState(frame, 'selectedCase');
  const selected = definition.cases[selectedCase];
  if (!selected) throw new Error(`Route ${definition.id} has no selected case ${selectedCase}.`);
  assertExpectedChild(
    frame,
    child,
    workflowChildPath(frame.instanceId, asWorkflowNode(selected).id)
  );
  completeFrame(context, frame, definition, output);
};

const repeatDecision = (value: unknown, nodeId: string): RepeatDecision<unknown> => {
  if (typeof value !== 'object' || value === null || !('kind' in value) || !('state' in value)) {
    throw new Error(`Repeat ${nodeId} received an invalid decision.`);
  }
  const decision = value as { kind: unknown; state: unknown };
  if (decision.kind !== 'continue' && decision.kind !== 'finish') {
    throw new Error(`Repeat ${nodeId} received an invalid decision.`);
  }
  return decision as RepeatDecision<unknown>;
};

const advanceRepeat = (
  context: PlanningContext,
  frame: WorkflowNodeSnapshot,
  definition: RuntimeRepeat,
  child: WorkflowNodeSnapshot,
  output: unknown
): void => {
  let iteration = integerState(frame, 'iteration');
  if (iteration < 1 || iteration > definition.maxIterations) {
    throw new Error(`Repeat ${definition.id} has invalid iteration ${iteration}.`);
  }
  const body = asWorkflowNode(definition.body);
  assertExpectedChild(
    frame,
    child,
    workflowChildPath(`${frame.instanceId}/iteration:${iteration}`, body.id)
  );

  let decision = repeatDecision(output, definition.id);
  while (decision.kind === 'continue' && iteration < definition.maxIterations) {
    iteration += 1;
    recordUpdate(context, {
      instanceId: frame.instanceId,
      runtimeState: { iteration },
      status: 'waiting',
    });
    const expansion = addBranch(
      context,
      decision.state,
      body,
      definitionNamespaceFor(context, frame),
      `${frame.instanceId}/iteration:${iteration}`,
      frame
    );
    if (!expansion.completed) return;
    decision = repeatDecision(expansion.output, definition.id);
  }
  if (decision.kind === 'finish') {
    completeFrame(context, frame, definition, decision.state);
    return;
  }
  const onExhausted = definition.onExhausted as (state: unknown) => unknown;
  completeFrame(context, frame, definition, onExhausted(decision.state));
};

const directFanOutChildren = (
  context: PlanningContext,
  frame: WorkflowNodeSnapshot
): readonly WorkflowNodeSnapshot[] => {
  const children = [...context.snapshotNodes.values(), ...context.insertedNodes.values()].filter(
    node => node.parentInstanceId === frame.instanceId && node.itemKey !== undefined
  );
  const unique = new Set(children.map(node => node.itemKey));
  if (unique.size !== children.length) {
    throw new Error(`Fan-out ${frame.definitionId} has duplicate materialized item keys.`);
  }
  return children.map(node => currentNode(context, node.instanceId));
};

const fanOutItemParentPath = (frame: WorkflowNodeSnapshot, key: string): string => {
  const itemSegment = escapeWorkflowPathSegment(`item:${key}`);
  return `${frame.instanceId}/${itemSegment}`;
};

const finishFanOutIfReady = (
  context: PlanningContext,
  frame: WorkflowNodeSnapshot,
  definition: RuntimeFanOut
): void => {
  const childrenByKey = new Map(
    directFanOutChildren(context, frame).map(materialized => [materialized.itemKey, materialized])
  );
  const orderedItems = stringArrayState(frame, 'keys').map(expectedKey => {
    const item = childrenByKey.get(expectedKey);
    if (!item) throw new Error(`Fan-out ${definition.id} is missing item ${expectedKey}.`);
    return { expectedKey, item };
  });
  if (definition.failureMode === 'fail-fast') {
    const failed = orderedItems.find(entry => entry.item.status === 'failed');
    if (failed) {
      if (!failed.item.failure) {
        throw new Error(`Fan-out item ${failed.item.instanceId} has no failure details.`);
      }
      failFrame(context, frame, failed.item.failure);
      return;
    }
  }
  const results: FanOutResult<unknown, unknown>[] = [];
  for (const { expectedKey, item } of orderedItems) {
    if (item.status === 'completed') {
      results.push({
        input: item.input,
        key: expectedKey,
        output: completedOutput(item),
        status: 'completed',
      });
      continue;
    }
    if (item.status !== 'failed') return;
    if (!item.failure) throw new Error(`Fan-out item ${item.instanceId} has no failure details.`);
    results.push({
      failure: item.failure,
      input: item.input,
      key: expectedKey,
      status: 'failed',
    });
  }
  const fanIn = definition.fanIn as (
    results: readonly FanOutResult<unknown, unknown>[],
    parentInput: unknown
  ) => unknown;
  completeFrame(context, frame, definition, fanIn(results, frame.input));
};

const advanceFanOut = (
  context: PlanningContext,
  frame: WorkflowNodeSnapshot,
  definition: RuntimeFanOut,
  child: WorkflowNodeSnapshot
): void => {
  const key = child.itemKey;
  if (key === undefined) throw new Error(`Fan-out child ${child.instanceId} has no item key.`);
  const worker = asWorkflowNode(definition.worker);
  assertExpectedChild(frame, child, workflowChildPath(fanOutItemParentPath(frame, key), worker.id));

  finishFanOutIfReady(context, frame, definition);
};

const assertNestedWorkflowChild = (
  frame: WorkflowNodeSnapshot,
  definition: RuntimeWorkflow,
  child: WorkflowNodeSnapshot
): void => {
  const root = asWorkflowNode(definition.root);
  assertExpectedChild(frame, child, workflowChildPath(frame.instanceId, root.id));
  if (child.definitionId !== workflowChildPath(frame.definitionId, root.id)) {
    throw new Error(`Workflow node ${child.instanceId} is outside ${frame.instanceId}.`);
  }
};

const advanceFailedParent = (
  context: PlanningContext,
  child: WorkflowNodeSnapshot,
  failure: StepFailure
): void => {
  if (child.parentInstanceId === undefined) {
    context.plan.terminalFailure = { failure, nodeInstanceId: child.instanceId };
    return;
  }
  const frame = currentNode(context, child.parentInstanceId);
  if (frame.status !== 'waiting') {
    throw new Error(`Workflow frame ${frame.instanceId} is not waiting for a child.`);
  }
  const definition = definitionFor(context, frame);
  switch (definition.kind) {
    case 'fanOut': {
      const key = child.itemKey;
      if (key === undefined) throw new Error(`Fan-out child ${child.instanceId} has no item key.`);
      const worker = asWorkflowNode(definition.worker);
      const itemParent = fanOutItemParentPath(frame, key);
      assertExpectedChild(frame, child, workflowChildPath(itemParent, worker.id));
      finishFanOutIfReady(context, frame, definition);
      return;
    }
    case 'workflow':
      assertNestedWorkflowChild(frame, definition, child);
      failFrame(context, frame, failure);
      return;
    case 'repeat':
    case 'routeBy':
    case 'sequence':
      failFrame(context, frame, failure);
      return;
    case 'emit':
    case 'step':
    case 'waitForSignal':
      throw new Error(`Workflow node ${frame.instanceId} cannot contain child nodes.`);
  }
};

const advanceParent = (
  context: PlanningContext,
  child: WorkflowNodeSnapshot,
  output: unknown
): void => {
  if (child.parentInstanceId === undefined) {
    context.plan.completedOutput = snapshotDurableJson(
      context.definition.outputSchema.parse(output)
    );
    return;
  }
  const frame = currentNode(context, child.parentInstanceId);
  if (frame.status !== 'waiting') {
    throw new Error(`Workflow frame ${frame.instanceId} is not waiting for a child.`);
  }
  const definition = definitionFor(context, frame);
  switch (definition.kind) {
    case 'sequence':
      advanceSequence(context, frame, definition, child, output);
      return;
    case 'routeBy':
      advanceRoute(context, frame, definition, child, output);
      return;
    case 'repeat':
      advanceRepeat(context, frame, definition, child, output);
      return;
    case 'fanOut':
      advanceFanOut(context, frame, definition, child);
      return;
    case 'workflow':
      assertNestedWorkflowChild(frame, definition, child);
      completeFrame(context, frame, definition, output);
      return;
    case 'emit':
    case 'step':
    case 'waitForSignal':
      throw new Error(`Workflow node ${frame.instanceId} cannot contain child nodes.`);
  }
};

const createContext = <Input, Output, Config extends WorkflowExecutionDefaults, Services>(input: {
  definition: RegisteredWorkflow<Input, Output, Config, Services>;
  nodes: readonly WorkflowNodeSnapshot[];
  stepPolicies: WorkflowStepPolicies;
  waitIdForNode?: (nodeInstanceId: string) => string;
}): PlanningContext => {
  assertRegisteredWorkflowIntegrity(input.definition);
  return {
    definition: input.definition,
    definitions: indexWorkflowNodes(input.definition),
    insertedNodes: new Map(),
    plan: {
      durableEvents: [],
      newNodes: [],
      newWaits: [],
      nodeUpdates: [],
      transientEvents: [],
    },
    snapshotNodes: indexSnapshotNodes(input.nodes),
    stepPolicies: input.stepPolicies,
    updates: new Map(),
    waitIdForNode: input.waitIdForNode,
  };
};

const planCompletedNode = <Input, Output, Config extends WorkflowExecutionDefaults, Services>(
  input: WorkflowContinuationInput<Input, Output, Config, Services>,
  allowSignalWait: boolean
): WorkflowContinuationPlan => {
  const context = createContext(input);
  const node = currentNode(context, input.completedNode.nodeInstanceId);
  const definition = definitionFor(context, node);
  if (node.status === 'completed') {
    throw new Error(`Workflow node ${node.instanceId} is already completed.`);
  }
  if (definition.kind === 'waitForSignal' && !allowSignalWait) {
    throw new Error(`Workflow wait ${node.instanceId} must be completed by a typed signal.`);
  }
  if (definition.kind !== 'step' && definition.kind !== 'waitForSignal') {
    throw new Error(`Workflow node ${node.instanceId} is not an executable boundary.`);
  }
  if (definition.kind === 'step' && node.status !== 'running') {
    throw new Error(`Workflow step ${node.instanceId} is not running.`);
  }
  const output = snapshotDurableJson(definition.outputSchema.parse(input.completedNode.output));
  recordUpdate(context, { instanceId: node.instanceId, output, status: 'completed' });
  advanceParent(context, currentNode(context, node.instanceId), output);
  context.plan.nodeUpdates = [...context.updates.values()];
  return context.plan;
};

export const planWorkflowContinuation = <
  Input,
  Output,
  Config extends WorkflowExecutionDefaults,
  Services,
>(
  input: WorkflowContinuationInput<Input, Output, Config, Services>
): WorkflowContinuationPlan => planCompletedNode(input, false);

export const planWorkflowFailure = <
  Input,
  Output,
  Config extends WorkflowExecutionDefaults,
  Services,
>(
  input: WorkflowFailureInput<Input, Output, Config, Services>
): WorkflowContinuationPlan => {
  const context = createContext(input);
  const node = currentNode(context, input.failedNode.nodeInstanceId);
  const definition = definitionFor(context, node);
  if (definition.kind !== 'step' || node.status !== 'running') {
    throw new Error(`Workflow step ${node.instanceId} is not running.`);
  }
  recordUpdate(context, {
    failure: input.failedNode.failure,
    instanceId: node.instanceId,
    status: 'failed',
  });
  advanceFailedParent(context, currentNode(context, node.instanceId), input.failedNode.failure);
  context.plan.nodeUpdates = [...context.updates.values()];
  return context.plan;
};

export const planWorkflowSignal = <
  Input,
  Output,
  Config extends WorkflowExecutionDefaults,
  Services,
>(
  input: WorkflowSignalInput<Input, Output, Config, Services>
): WorkflowSignalPlan => {
  assertRegisteredWorkflowIntegrity(input.definition);
  const node = input.nodes.find(candidate => candidate.instanceId === input.nodeInstanceId);
  if (node?.status !== 'waiting') {
    throw new Error(`Workflow wait ${input.nodeInstanceId} is not active.`);
  }
  const indexed = indexWorkflowNodes(input.definition).get(node.definitionId);
  if (indexed?.node.kind !== 'waitForSignal') {
    throw new Error(`Workflow node ${input.nodeInstanceId} is not a signal wait.`);
  }
  const definition = indexed.node;
  const signal = indexed.signals[definition.signal];
  if (!signal) throw new Error(`Unknown workflow signal ${definition.signal}.`);
  const payload = snapshotDurableJson(signal.schema.parse(input.payload));
  const resume = definition.resume as (nodeInput: unknown, value: unknown) => unknown;
  const plan = planCompletedNode(
    {
      completedNode: {
        nodeInstanceId: input.nodeInstanceId,
        output: resume(node.input, payload),
      },
      definition: input.definition,
      nodes: input.nodes,
      stepPolicies: input.stepPolicies,
      waitIdForNode: input.waitIdForNode,
    },
    true
  );
  return {
    ...plan,
    signalPayload: payload,
    signalSchemaVersion: signal.schemaVersion,
    signalType: definition.signal,
  };
};
