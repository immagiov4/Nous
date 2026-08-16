import type { ZodType } from 'zod';
import { isUnsetConfigValue } from './config.js';
import { snapshotDurableJson } from './jsonSnapshot.js';
import type {
  EmitDefinition,
  ErasedRegisteredWorkflow,
  ErasedWorkflowDefinition,
  FanOutDefinition,
  FanOutResult,
  RegisteredWorkflow,
  RepeatDecision,
  RepeatDefinition,
  RouteByDefinition,
  SequenceDefinition,
  StepDefinition,
  StepExecutionContext,
  WaitForSignalDefinition,
  WorkflowConfigOverride,
  WorkflowDefinition,
  WorkflowDefinitionBoundary,
  WorkflowDefinitionDeployment,
  WorkflowExecutionDefaults,
  WorkflowManifest,
  WorkflowNode,
  WorkflowNodeReference,
  WorkflowRegistration,
} from './types.js';
import {
  attestRegisteredWorkflow,
  hashPreCompatibilityIdWorkflowManifest,
  hashWorkflowManifest,
  validateWorkflowDefinition,
} from './validation.js';

export { continueRepeatWith, finishRepeat, repeatDecisionSchema } from './repeatDecision.js';
export * from './types.js';

type SchemaOutput<Schema extends ZodType> = Schema['_output'];

export const step = <
  InputSchema extends ZodType,
  OutputSchema extends ZodType,
  Config = WorkflowExecutionDefaults,
  Services = unknown,
>(options: {
  commit?: NonNullable<
    StepDefinition<
      SchemaOutput<InputSchema>,
      SchemaOutput<OutputSchema>,
      Config,
      Services
    >['commit']
  >;
  config?: WorkflowConfigOverride<Config>;
  id: string;
  inputSchema: InputSchema;
  maxAttempts?: number;
  outputSchema: OutputSchema;
  run: (
    context: StepExecutionContext<SchemaOutput<InputSchema>, Config, Services>
  ) => Promise<SchemaOutput<OutputSchema>>;
  timeoutMs?: number;
  undo?: NonNullable<
    StepDefinition<SchemaOutput<InputSchema>, SchemaOutput<OutputSchema>, Config, Services>['undo']
  >;
}): StepDefinition<SchemaOutput<InputSchema>, SchemaOutput<OutputSchema>, Config, Services> => ({
  ...options,
  kind: 'step',
});

type FirstNode<Nodes extends readonly WorkflowNode[]> = Nodes extends readonly [
  infer First extends WorkflowNode,
  ...WorkflowNode[],
]
  ? First
  : Nodes[number];
type LastNode<Nodes extends readonly WorkflowNode[]> = Nodes extends readonly [
  ...WorkflowNode[],
  infer Last extends WorkflowNode,
]
  ? Last
  : Nodes[number];
type NodeInput<Node> = Node extends WorkflowNodeReference<infer Input, unknown> ? Input : never;
type NodeOutput<Node> = Node extends WorkflowNodeReference<unknown, infer Output> ? Output : never;

type NodeContext<Node> =
  Node extends StepDefinition<infer _Input, infer _Output, infer Config, infer Services>
    ? readonly [Config, Services]
    : Node extends WorkflowDefinition<infer _Input, infer _Output, infer Config, infer Services>
      ? readonly [Config, Services]
      : Node extends SequenceDefinition<infer _Input, infer _Output, infer Config, infer Services>
        ? readonly [Config, Services]
        : Node extends FanOutDefinition<
              infer _ParentInput,
              infer _ItemInput,
              infer _ItemOutput,
              infer _Output,
              infer Config,
              infer Services
            >
          ? readonly [Config, Services]
          : Node extends RouteByDefinition<
                infer _Input,
                infer _Output,
                infer Config,
                infer Services
              >
            ? readonly [Config, Services]
            : Node extends RepeatDefinition<
                  infer _State,
                  infer _Output,
                  infer Config,
                  infer Services
                >
              ? readonly [Config, Services]
              : never;

type FirstNodeContext<Nodes extends readonly WorkflowNode[]> = Nodes extends readonly [
  infer Node extends WorkflowNode,
  ...infer Rest extends readonly WorkflowNode[],
]
  ? [NodeContext<Node>] extends [never]
    ? FirstNodeContext<Rest>
    : NodeContext<Node>
  : readonly [WorkflowExecutionDefaults, unknown];

type ContextConfig<Context> = Context extends readonly [infer Config, unknown] ? Config : never;
type ContextServices<Context> = Context extends readonly [unknown, infer Services]
  ? Services
  : never;
type SameType<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
type CompatibleNode<Node, Context> = [NodeContext<Node>] extends [never]
  ? Node
  : SameType<NodeContext<Node>, Context> extends true
    ? Node
    : never;
type CompatibleNodes<Nodes extends readonly WorkflowNode[], Context> = {
  readonly [Index in keyof Nodes]: CompatibleNode<Nodes[Index], Context>;
};

export const sequence = <const Nodes extends readonly WorkflowNode[]>(options: {
  id: string;
  nodes: Nodes & CompatibleNodes<Nodes, FirstNodeContext<Nodes>>;
}): SequenceDefinition<
  NodeInput<FirstNode<Nodes>>,
  NodeOutput<LastNode<Nodes>>,
  ContextConfig<FirstNodeContext<Nodes>>,
  ContextServices<FirstNodeContext<Nodes>>
> => {
  const [firstNode, ...remainingNodes] = options.nodes;
  if (!firstNode) throw new Error(`Sequence ${options.id} must contain at least one node.`);
  const lastNode = remainingNodes.at(-1) ?? firstNode;
  return {
    id: options.id,
    inputSchema: firstNode.inputSchema as ZodType<NodeInput<FirstNode<Nodes>>>,
    kind: 'sequence',
    nodes: options.nodes,
    outputSchema: lastNode.outputSchema as ZodType<NodeOutput<LastNode<Nodes>>>,
  };
};

export const emit = <InputSchema extends ZodType>(options: {
  event: string;
  id: string;
  inputSchema: InputSchema;
  payload: (input: SchemaOutput<InputSchema>) => unknown;
}): EmitDefinition<SchemaOutput<InputSchema>> => ({
  ...options,
  kind: 'emit',
  outputSchema: options.inputSchema,
});

export const waitForSignal = <
  InputSchema extends ZodType,
  PayloadSchema extends ZodType,
  OutputSchema extends ZodType,
>(options: {
  id: string;
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
  payloadSchema: PayloadSchema;
  resume: (
    input: SchemaOutput<InputSchema>,
    payload: SchemaOutput<PayloadSchema>
  ) => SchemaOutput<OutputSchema>;
  signal: string;
}): WaitForSignalDefinition<
  SchemaOutput<InputSchema>,
  SchemaOutput<PayloadSchema>,
  SchemaOutput<OutputSchema>
> => ({
  ...options,
  kind: 'waitForSignal',
});

export const fanOut = <
  ParentInputSchema extends ZodType,
  ItemInputSchema extends ZodType,
  ItemOutput,
  OutputSchema extends ZodType,
  Config = WorkflowExecutionDefaults,
  Services = unknown,
>(options: {
  failureMode: FanOutDefinition['failureMode'];
  fanIn: (
    results: readonly FanOutResult<SchemaOutput<ItemInputSchema>, ItemOutput>[],
    parentInput: SchemaOutput<ParentInputSchema>
  ) => SchemaOutput<OutputSchema>;
  id: string;
  inputSchema: ParentInputSchema;
  inputs: (input: SchemaOutput<ParentInputSchema>) => readonly SchemaOutput<ItemInputSchema>[];
  itemSchema: ItemInputSchema;
  keyBy: (input: SchemaOutput<ItemInputSchema>) => string;
  outputSchema: OutputSchema;
  worker: WorkflowNode<SchemaOutput<ItemInputSchema>, ItemOutput, Config, Services>;
}): FanOutDefinition<
  SchemaOutput<ParentInputSchema>,
  SchemaOutput<ItemInputSchema>,
  ItemOutput,
  SchemaOutput<OutputSchema>,
  Config,
  Services
> => ({ ...options, kind: 'fanOut' });

export const routeBy = <
  InputSchema extends ZodType,
  OutputSchema extends ZodType,
  Config = WorkflowExecutionDefaults,
  Services = unknown,
>(options: {
  cases: Readonly<
    Record<
      string,
      WorkflowNode<SchemaOutput<InputSchema>, SchemaOutput<OutputSchema>, Config, Services>
    >
  >;
  id: string;
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
  select: (input: SchemaOutput<InputSchema>) => string;
}): RouteByDefinition<SchemaOutput<InputSchema>, SchemaOutput<OutputSchema>, Config, Services> => ({
  ...options,
  kind: 'routeBy',
});

export const repeat = <
  StateSchema extends ZodType,
  Config = WorkflowExecutionDefaults,
  Services = unknown,
>(options: {
  body: WorkflowNode<
    SchemaOutput<StateSchema>,
    RepeatDecision<SchemaOutput<StateSchema>>,
    Config,
    Services
  >;
  id: string;
  maxIterations: number;
  onExhausted: (lastState: SchemaOutput<StateSchema>) => SchemaOutput<StateSchema>;
  stateSchema: StateSchema;
}): RepeatDefinition<SchemaOutput<StateSchema>, SchemaOutput<StateSchema>, Config, Services> => ({
  body: options.body,
  id: options.id,
  inputSchema: options.stateSchema,
  kind: 'repeat',
  maxIterations: options.maxIterations,
  onExhausted: options.onExhausted,
  outputSchema: options.stateSchema,
});

export const workflow = <
  InputSchema extends ZodType,
  OutputSchema extends ZodType,
  Config extends WorkflowExecutionDefaults = WorkflowExecutionDefaults,
  Services = unknown,
>(options: {
  compatibilityId: string;
  configSchema: ZodType<Config>;
  events?: WorkflowDefinition['events'];
  executionDefaults: Config;
  id: string;
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
  root: WorkflowNode<
    NoInfer<SchemaOutput<InputSchema>>,
    NoInfer<SchemaOutput<OutputSchema>>,
    Config,
    Services
  >;
  signals?: WorkflowDefinition['signals'];
}): WorkflowDefinition<
  SchemaOutput<InputSchema>,
  SchemaOutput<OutputSchema>,
  Config,
  Services
> => ({
  ...options,
  events: options.events ?? {},
  kind: 'workflow',
  signals: options.signals ?? {},
});

const freezeConfigValue = (value: unknown): unknown => {
  if (isUnsetConfigValue(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freezeConfigValue));
  if (typeof value !== 'object' || value === null) return value;
  return Object.freeze(
    Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freezeConfigValue(child)]))
  );
};

const snapshotNode = (node: WorkflowNode): WorkflowNode => {
  switch (node.kind) {
    case 'workflow':
      return Object.freeze({
        ...node,
        events: Object.freeze(
          Object.fromEntries(
            Object.entries(node.events).map(([name, event]) => [name, Object.freeze({ ...event })])
          )
        ),
        executionDefaults: freezeConfigValue(
          snapshotDurableJson(node.configSchema.parse(node.executionDefaults))
        ) as WorkflowExecutionDefaults,
        root: snapshotNode(node.root as WorkflowNode),
        signals: Object.freeze(
          Object.fromEntries(
            Object.entries(node.signals).map(([name, signal]) => [
              name,
              Object.freeze({ ...signal }),
            ])
          )
        ),
      }) as WorkflowNode;
    case 'sequence':
      return Object.freeze({
        ...node,
        nodes: Object.freeze(node.nodes.map(child => snapshotNode(child as WorkflowNode))),
      }) as WorkflowNode;
    case 'routeBy':
      return Object.freeze({
        ...node,
        cases: Object.freeze(
          Object.fromEntries(
            Object.entries(node.cases).map(([name, child]) => [
              name,
              snapshotNode(child as WorkflowNode),
            ])
          )
        ),
      }) as WorkflowNode;
    case 'fanOut':
      return Object.freeze({
        ...node,
        worker: snapshotNode(node.worker as WorkflowNode),
      }) as WorkflowNode;
    case 'repeat':
      return Object.freeze({
        ...node,
        body: snapshotNode(node.body as WorkflowNode),
      }) as WorkflowNode;
    case 'step':
      return Object.freeze({
        ...node,
        ...(node.config === undefined ? {} : { config: freezeConfigValue(node.config) }),
      }) as WorkflowNode;
    case 'emit':
    case 'waitForSignal':
      return Object.freeze({ ...node });
  }
};

const snapshotDefinition = (definition: ErasedWorkflowDefinition): ErasedWorkflowDefinition =>
  Object.freeze({
    ...definition,
    events: Object.freeze(
      Object.fromEntries(
        Object.entries(definition.events).map(([name, event]) => [
          name,
          Object.freeze({ ...event }),
        ])
      )
    ),
    executionDefaults: freezeConfigValue(
      snapshotDurableJson(definition.configSchema.parse(definition.executionDefaults))
    ) as ErasedWorkflowDefinition['executionDefaults'],
    root: snapshotNode(definition.root),
    signals: Object.freeze(
      Object.fromEntries(
        Object.entries(definition.signals).map(([name, signal]) => [
          name,
          Object.freeze({ ...signal }),
        ])
      )
    ),
  });

type PreviousWorkflowDefinition =
  | ErasedWorkflowDefinition
  | {
      readonly definition: ErasedWorkflowDefinition;
      readonly hashMode: 'pre-compatibility-id';
    };

/** Temporary resume bridge for runs persisted before compatibility ids entered the manifest. */
export const preCompatibilityIdPrevious = (
  definition: ErasedWorkflowDefinition
): PreviousWorkflowDefinition => ({ definition, hashMode: 'pre-compatibility-id' });

const registerDefinition = (
  definition: ErasedWorkflowDefinition,
  hashMode: 'current' | 'pre-compatibility-id' = 'current'
): ErasedRegisteredWorkflow => {
  validateWorkflowDefinition(definition);
  const snapshot = snapshotDefinition(definition);
  const manifest = freezeConfigValue(validateWorkflowDefinition(snapshot)) as WorkflowManifest;
  const definitionHash =
    hashMode === 'pre-compatibility-id'
      ? hashPreCompatibilityIdWorkflowManifest(manifest)
      : hashWorkflowManifest(manifest);
  return attestRegisteredWorkflow(
    Object.freeze({
      ...snapshot,
      definitionHash,
      definitionHashVersion: manifest.definitionHashVersion,
      manifest,
    }),
    hashMode
  );
};

export class WorkflowRegistry {
  private readonly registrations = new Map<string, unknown>();

  register<Input, Output, Config, Services>(input: {
    current: WorkflowDefinition<Input, Output, Config, Services>;
    previous?: PreviousWorkflowDefinition | readonly PreviousWorkflowDefinition[];
  }): WorkflowRegistration<Input, Output, Config, Services> {
    if (this.registrations.has(input.current.id)) {
      throw new Error(`Workflow already registered: ${input.current.id}`);
    }
    const current = registerDefinition(input.current) as RegisteredWorkflow<
      Input,
      Output,
      Config,
      Services
    >;
    const previousInputs =
      input.previous === undefined
        ? []
        : Array.isArray(input.previous)
          ? input.previous
          : [input.previous];
    const previousDefinitions = previousInputs.map(previousInput =>
      'hashMode' in previousInput
        ? registerDefinition(previousInput.definition, previousInput.hashMode)
        : registerDefinition(previousInput)
    );
    const allDefinitions = [current, ...previousDefinitions];
    if (allDefinitions.some(definition => definition.id !== current.id)) {
      throw new Error(`Resumable definitions must use workflow id ${current.id}.`);
    }
    const hashes = new Set(allDefinitions.map(definition => definition.definitionHash));
    if (hashes.size !== allDefinitions.length) {
      throw new Error(`Workflow ${current.id} contains duplicate definition hashes.`);
    }
    const registration = Object.freeze({
      current,
      previous: previousDefinitions[0] ?? null,
      previousDefinitions: Object.freeze(previousDefinitions),
    });
    this.registrations.set(current.id, registration);
    return registration;
  }

  current(workflowId: string): ErasedRegisteredWorkflow | null {
    const registration = this.registrations.get(workflowId) as WorkflowRegistration | undefined;
    return registration?.current ?? null;
  }

  resolve(workflowId: string, definitionHash: string): ErasedRegisteredWorkflow | null {
    const registration = this.registrations.get(workflowId) as WorkflowRegistration | undefined;
    if (!registration) return null;
    if (registration.current.definitionHash === definitionHash) return registration.current;
    return (
      registration.previousDefinitions.find(
        definition => definition.definitionHash === definitionHash
      ) ?? null
    );
  }

  listRegisteredBoundaries(): readonly WorkflowDefinitionBoundary[] {
    return [...this.registrations.values()].flatMap(value => {
      const registration = value as WorkflowRegistration;
      const definitions = [registration.current, ...registration.previousDefinitions];
      return definitions.map(definition => ({
        definitionHash: definition.definitionHash,
        definitionHashVersion: definition.definitionHashVersion,
        workflowId: definition.id,
      }));
    });
  }

  listDefinitionDeployments(): readonly WorkflowDefinitionDeployment[] {
    return [...this.registrations.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => {
        const registration = value as WorkflowRegistration;
        const toBoundary = (definition: ErasedRegisteredWorkflow) => ({
          definitionHash: definition.definitionHash,
          definitionHashVersion: definition.definitionHashVersion,
          workflowId: definition.id,
        });
        const current = toBoundary(registration.current);
        const supportedDefinitions = [
          current,
          ...registration.previousDefinitions.map(toBoundary),
        ].sort(
          (left, right) =>
            left.definitionHash.localeCompare(right.definitionHash) ||
            left.definitionHashVersion - right.definitionHashVersion
        );
        return { current, supportedDefinitions };
      });
  }
}

export const createWorkflowRegistry = (): WorkflowRegistry => new WorkflowRegistry();
