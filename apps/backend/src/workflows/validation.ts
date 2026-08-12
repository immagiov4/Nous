import { createHash } from 'node:crypto';

import type { ZodType } from 'zod';
import { isRecord } from '../utils/validation.js';
import {
  assertWorkflowExecutionDefaults,
  POSTGRES_INTEGER_MAX,
  resolveWorkflowStepConfig,
} from './config.js';
import { repeatDecisionSchema } from './repeatDecision.js';
import { canonicalJson, durableSchemaShape, schemasMatch } from './schemaFingerprint.js';
import type {
  ErasedWorkflowDefinition,
  RegisteredWorkflow,
  WorkflowDefinition,
  WorkflowManifest,
  WorkflowNode,
  WorkflowNodeKind,
} from './types.js';

type RuntimeEmit = Extract<WorkflowNode, { kind: 'emit' }>;
type RuntimeFanOut = Extract<WorkflowNode, { kind: 'fanOut' }>;
type RuntimeRepeat = Extract<WorkflowNode, { kind: 'repeat' }>;
type RuntimeRoute = Extract<WorkflowNode, { kind: 'routeBy' }>;
type RuntimeSequence = Extract<WorkflowNode, { kind: 'sequence' }>;
type RuntimeStep = Extract<WorkflowNode, { kind: 'step' }>;
type RuntimeWait = Extract<WorkflowNode, { kind: 'waitForSignal' }>;
type RuntimeWorkflow = Extract<WorkflowNode, { kind: 'workflow' }>;
type WorkflowCatalog = Pick<WorkflowDefinition, 'events' | 'signals'>;

type RegisteredWorkflowHashMode = 'current' | 'pre-compatibility-id';

const registeredWorkflowSnapshots = new WeakMap<object, RegisteredWorkflowHashMode>();

export const attestRegisteredWorkflow = <Definition extends object>(
  definition: Definition,
  hashMode: RegisteredWorkflowHashMode = 'current'
): Definition => {
  registeredWorkflowSnapshots.set(definition, hashMode);
  return definition;
};

const registeredWorkflowHashMode = (definition: object): RegisteredWorkflowHashMode | undefined =>
  registeredWorkflowSnapshots.get(definition);

const WORKFLOW_NODE_KINDS = new Set<WorkflowNodeKind>([
  'emit',
  'fanOut',
  'repeat',
  'routeBy',
  'sequence',
  'step',
  'workflow',
  'waitForSignal',
]);

// Retain the matching normalizer while runs with an older version remain resumable.
export const WORKFLOW_DEFINITION_HASH_VERSION = 1;

interface NodeValidationContext {
  configBases: readonly Record<string, unknown>[];
  configSchema: ZodType;
  definition: WorkflowCatalog;
  seenIds: Set<string>;
}

type WorkflowBoundary = ErasedWorkflowDefinition | RuntimeWorkflow;

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const hasOwn = (record: object, key: string): boolean => Object.hasOwn(record, key);

const assertPositiveInteger = (value: number, path: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${path} must be a positive integer.`);
  }
};

const assertPositivePostgresInteger = (value: number, path: string): void => {
  if (!Number.isSafeInteger(value) || value < 1 || value > POSTGRES_INTEGER_MAX) {
    throw new Error(`${path} must be a positive PostgreSQL integer.`);
  }
};

const assertCallback = (value: unknown, message: string): void => {
  if (typeof value !== 'function') throw new TypeError(message);
};

const schemaManifest = (schema: ZodType, path: string): unknown => {
  const manifest = durableSchemaShape(schema, path);
  if (schema.safeParse(undefined).success) {
    throw new Error(`Durable schema at ${path} cannot accept undefined.`);
  }
  return manifest;
};

const validateWorkflowIdentity = (
  definition: WorkflowBoundary,
  compatibilityError: string
): void => {
  if (typeof definition.compatibilityId !== 'string' || !definition.compatibilityId.trim()) {
    throw new Error(compatibilityError);
  }
};

const validateWorkflowConfiguration = (
  definition: WorkflowBoundary,
  defaultsPath: string,
  schemaPath: string
): void => {
  assertWorkflowExecutionDefaults(definition.executionDefaults, defaultsPath);
  schemaManifest(definition.configSchema, schemaPath);
  if (!definition.configSchema.safeParse(definition.executionDefaults).success) {
    throw new Error(`Workflow ${definition.id} has invalid execution defaults.`);
  }
};

const validateWorkflowRoot = (definition: WorkflowBoundary, rootPath: string): WorkflowNode => {
  const root = assertNodeShape(definition.root, rootPath);
  if (!schemasMatch(definition.inputSchema, root.inputSchema)) {
    throw new Error(`Workflow ${definition.id} has an incompatible root input schema.`);
  }
  if (!schemasMatch(definition.outputSchema, root.outputSchema)) {
    throw new Error(`Workflow ${definition.id} has an incompatible root output schema.`);
  }
  return root;
};

const assertNodeShape = (rawNode: unknown, path: string): WorkflowNode => {
  if (!isRecord(rawNode)) throw new TypeError(`Invalid workflow node at ${path}.`);
  if (typeof rawNode.id !== 'string' || !rawNode.id.trim()) {
    throw new Error(`Workflow node id is required at ${path}.`);
  }
  if (
    typeof rawNode.kind !== 'string' ||
    !WORKFLOW_NODE_KINDS.has(rawNode.kind as WorkflowNodeKind)
  ) {
    throw new Error(`Unknown workflow node kind "${String(rawNode.kind)}" at ${path}.`);
  }
  schemaManifest(rawNode.inputSchema as ZodType, `${path}.input`);
  schemaManifest(rawNode.outputSchema as ZodType, `${path}.output`);
  return rawNode as unknown as WorkflowNode;
};

const validateStep = (node: RuntimeStep, context: NodeValidationContext, path: string): void => {
  assertCallback(node.run, `Step ${node.id} must define a run callback.`);
  if (node.commit !== undefined) {
    assertCallback(node.commit, `Step ${node.id} has an invalid commit callback.`);
  }
  if (node.undo !== undefined) {
    assertCallback(node.undo, `Step ${node.id} has an invalid undo callback.`);
  }
  if (node.maxAttempts !== undefined) {
    assertPositivePostgresInteger(node.maxAttempts, `${path}.maxAttempts`);
  }
  if (node.timeoutMs !== undefined) {
    assertPositivePostgresInteger(node.timeoutMs, `${path}.timeoutMs`);
  }
  for (const baseConfig of context.configBases) {
    try {
      resolveWorkflowStepConfig({
        baseConfig,
        configOverride: node.config,
        configSchema: context.configSchema,
        maxAttempts: node.maxAttempts,
        path: `${path}.config`,
        timeoutMs: node.timeoutMs,
      });
    } catch {
      throw new Error(`Step ${node.id} has an invalid configuration override.`);
    }
  }
};

const validateSequence = (
  node: RuntimeSequence,
  context: NodeValidationContext,
  path: string
): void => {
  if (!Array.isArray(node.nodes) || node.nodes.length === 0) {
    throw new Error(`Sequence ${node.id} must contain at least one node.`);
  }
  const firstNode = assertNodeShape(node.nodes[0], `${path}.first`);
  const lastNode = assertNodeShape(node.nodes.at(-1), `${path}.last`);
  if (!schemasMatch(node.inputSchema, firstNode.inputSchema)) {
    throw new Error(`Sequence ${node.id} has an incompatible input schema.`);
  }
  if (!schemasMatch(node.outputSchema, lastNode.outputSchema)) {
    throw new Error(`Sequence ${node.id} has an incompatible output schema.`);
  }

  node.nodes.forEach((child, index) => {
    const childNode = assertNodeShape(child, `${path}.node.${index}`);
    const previousValue = node.nodes[index - 1];
    const previous = previousValue
      ? assertNodeShape(previousValue, `${path}.node.${index - 1}`)
      : undefined;
    if (previous && !schemasMatch(previous.outputSchema, childNode.inputSchema)) {
      throw new Error(
        `Sequence ${node.id} connects incompatible schemas between ${previous.id} and ${childNode.id}`
      );
    }
    visitNode(childNode, context, `${path}.${childNode.id}`);
  });
};

const validateEmit = (node: RuntimeEmit, definition: WorkflowCatalog): void => {
  if (typeof node.event !== 'string' || !hasOwn(definition.events, node.event)) {
    throw new Error(`Unknown event "${String(node.event)}" in node ${node.id}`);
  }
  assertCallback(node.payload, `Emit ${node.id} must define a payload callback.`);
  if (!schemasMatch(node.inputSchema, node.outputSchema)) {
    throw new Error(`Emit ${node.id} must preserve its input schema.`);
  }
};

const validateWait = (node: RuntimeWait, definition: WorkflowCatalog): void => {
  if (typeof node.signal !== 'string' || !hasOwn(definition.signals, node.signal)) {
    throw new Error(`Unknown signal "${String(node.signal)}" in node ${node.id}`);
  }
  const signal = definition.signals[node.signal];
  if (!signal || !schemasMatch(node.payloadSchema, signal.schema)) {
    throw new Error(`Signal wait ${node.id} has an incompatible payload schema.`);
  }
  assertCallback(node.resume, `Signal wait ${node.id} must define a resume callback.`);
};

const validateFanOut = (
  node: RuntimeFanOut,
  context: NodeValidationContext,
  path: string
): void => {
  if (node.failureMode !== 'collect' && node.failureMode !== 'fail-fast') {
    throw new Error(`Fan-out ${node.id} has an unknown failure mode.`);
  }
  assertCallback(node.inputs, `Fan-out ${node.id} must define an inputs callback.`);
  assertCallback(node.keyBy, `Fan-out ${node.id} must define a keyBy callback.`);
  assertCallback(node.fanIn, `Fan-out ${node.id} must define a fanIn callback.`);
  schemaManifest(node.itemSchema, `${path}.item`);
  const worker = assertNodeShape(node.worker, `${path}.worker`);
  if (!schemasMatch(node.itemSchema, worker.inputSchema)) {
    throw new Error(`Fan-out ${node.id} connects an incompatible worker input schema.`);
  }
  visitNode(worker, context, `${path}.${worker.id}`);
};

const validateRoute = (node: RuntimeRoute, context: NodeValidationContext, path: string): void => {
  assertCallback(node.select, `Route ${node.id} must define a select callback.`);
  if (!isRecord(node.cases) || Object.keys(node.cases).length === 0) {
    throw new Error(`Route ${node.id} must declare at least one case.`);
  }
  Object.entries(node.cases).forEach(([caseName, rawChild]) => {
    const child = assertNodeShape(rawChild, `${path}.${caseName}`);
    if (
      !schemasMatch(node.inputSchema, child.inputSchema) ||
      !schemasMatch(node.outputSchema, child.outputSchema)
    ) {
      throw new Error(`Route ${node.id} case ${caseName} has incompatible schemas.`);
    }
    visitNode(child, context, `${path}.${caseName}.${child.id}`);
  });
};

const validateRepeat = (
  node: RuntimeRepeat,
  context: NodeValidationContext,
  path: string
): void => {
  assertPositiveInteger(node.maxIterations, `${path}.maxIterations`);
  assertCallback(node.onExhausted, `Repeat ${node.id} must define an onExhausted callback.`);
  const body = assertNodeShape(node.body, `${path}.body`);
  if (!schemasMatch(node.inputSchema, node.outputSchema)) {
    throw new Error(`Repeat ${node.id} must preserve its state schema.`);
  }
  if (!schemasMatch(node.inputSchema, body.inputSchema)) {
    throw new Error(`Repeat ${node.id} has an incompatible body input schema.`);
  }
  if (!schemasMatch(body.outputSchema, repeatDecisionSchema(node.inputSchema))) {
    throw new Error(`Repeat ${node.id} has an incompatible body output schema.`);
  }
  visitNode(body, context, `${path}.${body.id}`);
};

function validateNestedWorkflow(
  node: RuntimeWorkflow,
  context: NodeValidationContext,
  path: string
): void {
  validateWorkflowIdentity(node, `compatibilityId is required at ${path}.`);
  if (!schemasMatch(context.configSchema, node.configSchema)) {
    throw new Error(`Nested workflow ${node.id} has an incompatible configuration schema.`);
  }
  validateWorkflowConfiguration(node, `${path}.executionDefaults`, `${path}.config`);
  validateEventDefinitions(node);
  validateSignalDefinitions(node);

  const rootPath = `${path}.root.${String((node.root as { id?: unknown }).id)}`;
  const root = validateWorkflowRoot(node, rootPath);
  visitNode(
    root,
    {
      configBases: [
        ...context.configBases,
        node.executionDefaults as unknown as Record<string, unknown>,
      ],
      configSchema: node.configSchema,
      definition: node,
      seenIds: new Set(),
    },
    rootPath
  );
}

const visitNode = (rawNode: unknown, context: NodeValidationContext, path: string): void => {
  const node = assertNodeShape(rawNode, path);
  if (context.seenIds.has(node.id)) throw new Error(`Duplicate workflow node id: ${node.id}`);
  context.seenIds.add(node.id);

  switch (node.kind) {
    case 'step':
      validateStep(node, context, path);
      return;
    case 'sequence':
      validateSequence(node, context, path);
      return;
    case 'emit':
      validateEmit(node, context.definition);
      return;
    case 'waitForSignal':
      validateWait(node, context.definition);
      return;
    case 'fanOut':
      validateFanOut(node, context, path);
      return;
    case 'routeBy':
      validateRoute(node, context, path);
      return;
    case 'repeat':
      validateRepeat(node, context, path);
      return;
    case 'workflow':
      validateNestedWorkflow(node, context, path);
  }
};

const nodeManifest = (node: WorkflowNode, path: string): unknown => {
  const common = {
    id: node.id,
    inputSchema: schemaManifest(node.inputSchema, `${path}.input`),
    kind: node.kind,
    outputSchema: schemaManifest(node.outputSchema, `${path}.output`),
  };
  switch (node.kind) {
    case 'step':
      return { ...common, hasCommit: node.commit !== undefined, hasUndo: node.undo !== undefined };
    case 'sequence':
      return {
        ...common,
        nodes: node.nodes.map(child => {
          const childNode = assertNodeShape(child, `${path}.child`);
          return nodeManifest(childNode, `${path}.${childNode.id}`);
        }),
      };
    case 'emit':
      return { ...common, event: node.event };
    case 'waitForSignal':
      return { ...common, signal: node.signal };
    case 'fanOut': {
      const worker = assertNodeShape(node.worker, `${path}.worker`);
      return {
        ...common,
        failureMode: node.failureMode,
        itemSchema: schemaManifest(node.itemSchema, `${path}.item`),
        worker: nodeManifest(worker, `${path}.${worker.id}`),
      };
    }
    case 'routeBy':
      return {
        ...common,
        cases: Object.fromEntries(
          Object.entries(node.cases)
            .sort(([left], [right]) => compareCodeUnits(left, right))
            .map(([key, child]) => {
              const childNode = assertNodeShape(child, `${path}.${key}`);
              return [key, nodeManifest(childNode, `${path}.${key}.${childNode.id}`)];
            })
        ),
      };
    case 'repeat': {
      const body = assertNodeShape(node.body, `${path}.body`);
      return {
        ...common,
        body: nodeManifest(body, `${path}.${body.id}`),
        maxIterations: node.maxIterations,
      };
    }
    case 'workflow': {
      const root = assertNodeShape(node.root, `${path}.root`);
      return {
        ...common,
        compatibilityId: node.compatibilityId,
        configSchema: schemaManifest(node.configSchema, `${path}.config`),
        definitionHashVersion: WORKFLOW_DEFINITION_HASH_VERSION,
        events: eventManifest(node, `${path}.events`),
        root: nodeManifest(root, `${path}.root.${root.id}`),
        signals: signalManifest(node, `${path}.signals`),
      };
    }
  }
};

const validateEventDefinitions = (definition: WorkflowCatalog): void => {
  Object.entries(definition.events).forEach(([name, event]) => {
    if (event.durability !== 'durable' && event.durability !== 'transient') {
      throw new Error(`Event ${name} has an unknown durability.`);
    }
    assertPositivePostgresInteger(event.schemaVersion, `events.${name}.schemaVersion`);
    schemaManifest(event.schema, `events.${name}`);
  });
};

const validateSignalDefinitions = (definition: WorkflowCatalog): void => {
  Object.entries(definition.signals).forEach(([name, signal]) => {
    assertPositivePostgresInteger(signal.schemaVersion, `signals.${name}.schemaVersion`);
    schemaManifest(signal.schema, `signals.${name}`);
  });
};

const eventManifest = (definition: WorkflowCatalog, path: string): WorkflowManifest['events'] =>
  Object.fromEntries(
    Object.entries(definition.events)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([name, event]) => [
        name,
        {
          durability: event.durability,
          schema: schemaManifest(event.schema, `${path}.${name}`),
          schemaVersion: event.schemaVersion,
        },
      ])
  );

const signalManifest = (definition: WorkflowCatalog, path: string): WorkflowManifest['signals'] =>
  Object.fromEntries(
    Object.entries(definition.signals)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([name, signal]) => [
        name,
        {
          schema: schemaManifest(signal.schema, `${path}.${name}`),
          schemaVersion: signal.schemaVersion,
        },
      ])
  );

export const validateWorkflowDefinition = (
  definition: ErasedWorkflowDefinition
): WorkflowManifest => {
  if (!definition.id.trim()) throw new Error('Workflow id is required.');
  validateWorkflowIdentity(definition, 'compatibilityId is required.');
  validateWorkflowConfiguration(definition, 'executionDefaults', 'workflow.config');
  schemaManifest(definition.inputSchema, 'workflow.input');
  schemaManifest(definition.outputSchema, 'workflow.output');

  const rootPath = `root.${String((definition.root as { id?: unknown }).id)}`;
  const root = validateWorkflowRoot(definition, rootPath);

  validateEventDefinitions(definition);
  validateSignalDefinitions(definition);
  visitNode(
    root,
    {
      configBases: [definition.executionDefaults as unknown as Record<string, unknown>],
      configSchema: definition.configSchema,
      definition,
      seenIds: new Set(),
    },
    rootPath
  );

  return {
    compatibilityId: definition.compatibilityId,
    configSchema: schemaManifest(definition.configSchema, 'workflow.config'),
    definitionHashVersion: WORKFLOW_DEFINITION_HASH_VERSION,
    events: eventManifest(definition, 'events'),
    id: definition.id,
    inputSchema: schemaManifest(definition.inputSchema, 'workflow.input'),
    outputSchema: schemaManifest(definition.outputSchema, 'workflow.output'),
    root: nodeManifest(root, rootPath),
    signals: signalManifest(definition, 'signals'),
  };
};

export const hashWorkflowManifest = (manifest: WorkflowManifest): string =>
  createHash('sha256').update(canonicalJson(manifest)).digest('hex');

const omitCompatibilityIds = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(omitCompatibilityIds);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'compatibilityId')
      .map(([key, child]) => [key, omitCompatibilityIds(child)])
  );
};

/** Reconstructs hashes written before compatibility ids became part of workflow manifests. */
export const hashPreCompatibilityIdWorkflowManifest = (manifest: WorkflowManifest): string =>
  createHash('sha256')
    .update(canonicalJson(omitCompatibilityIds(manifest)))
    .digest('hex');

export const assertRegisteredWorkflowIntegrity = <Input, Output, Config, Services>(
  definition: RegisteredWorkflow<Input, Output, Config, Services>
): WorkflowManifest => {
  const hashMode = registeredWorkflowHashMode(definition);
  if (
    hashMode === undefined ||
    typeof definition.definitionHash !== 'string' ||
    definition.manifest === undefined
  ) {
    throw new Error('Workflow definition must be registered before materialization.');
  }
  const currentManifest = validateWorkflowDefinition(definition);
  const currentHash =
    hashMode === 'pre-compatibility-id'
      ? hashPreCompatibilityIdWorkflowManifest(currentManifest)
      : hashWorkflowManifest(currentManifest);
  if (currentHash !== definition.definitionHash) {
    throw new Error(`Registered workflow definition ${definition.id} changed after registration.`);
  }
  return currentManifest;
};
