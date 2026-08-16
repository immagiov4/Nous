import type { TransactionSql } from 'postgres';
import type { ZodType } from 'zod';

declare const UNSET_CONFIG_VALUE_TYPE: unique symbol;

export interface UnsetConfigValue {
  readonly [UNSET_CONFIG_VALUE_TYPE]: true;
}

type WorkflowConfigValueOverride<Value> =
  | UnsetConfigValue
  | (Value extends readonly unknown[]
      ? Value
      : Value extends object
        ? { readonly [Key in keyof Value]?: WorkflowConfigValueOverride<Value[Key]> }
        : Value);

export type WorkflowConfigOverride<Config> = Config extends object
  ? { readonly [Key in keyof Config]?: WorkflowConfigValueOverride<Config[Key]> }
  : never;

export type DeepReadonly<Value> = Value extends (...arguments_: never[]) => unknown
  ? Value
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value;

export type WorkflowNodeKind =
  | 'emit'
  | 'fanOut'
  | 'repeat'
  | 'routeBy'
  | 'sequence'
  | 'step'
  | 'workflow'
  | 'waitForSignal';

export type JsonValue =
  | boolean
  | null
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

interface StepFailureBase {
  readonly code: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
  readonly message: string;
}

export type StepFailure =
  | (StepFailureBase & {
      readonly feedback: string;
      readonly kind: 'corrective';
      readonly retryAfterMs?: never;
    })
  | (StepFailureBase & {
      readonly feedback?: never;
      readonly kind: 'operational';
      readonly retryAfterMs?: number;
    })
  | (StepFailureBase & {
      readonly feedback?: never;
      readonly kind: 'permanent';
      readonly retryAfterMs?: never;
    });

export interface WorkflowExecutionDefaults {
  maxAttempts: number;
  timeoutMs: number;
}

export interface WorkflowStepPolicy {
  config: Readonly<Record<string, unknown>>;
  maxAttempts: number;
  timeoutMs: number;
}

export type WorkflowStepPolicies = Readonly<Record<string, Readonly<WorkflowStepPolicy>>>;
export const WORKFLOW_STEP_POLICIES_VERSION = 1;

export interface WorkflowStepExecutionIdentity {
  readonly nodeInstanceId: string;
  readonly runId: string;
}

export interface WorkflowProviderEffectExecutor {
  run<Output>(input: {
    key: string;
    operation: () => Promise<Output>;
    outputSchema: ZodType<Output>;
  }): Promise<Output>;
}

export interface StepExecutionContext<Input, Config, Services> {
  attemptNumber: number;
  config: DeepReadonly<Config>;
  readonly execution: WorkflowStepExecutionIdentity;
  /** Stable across retries of this node. External adapters must use it to deduplicate effects. */
  readonly idempotencyKey: string;
  input: Input;
  previousAttemptFailure?: StepFailure;
  /** Available to provider-with-postprocessing steps for persisting the paid result first. */
  readonly providerEffect?: WorkflowProviderEffectExecutor;
  retryFeedback: string;
  services: Services;
  signal: AbortSignal;
}

export interface StepCommitContext<Input, Output, Config, Services> {
  config: DeepReadonly<Config>;
  readonly execution: WorkflowStepExecutionIdentity;
  input: Input;
  output: Output;
  services: Services;
  transaction: TransactionSql;
}

export interface StepUndoContext<Input, Output, Config, Services> {
  config: DeepReadonly<Config>;
  readonly execution: WorkflowStepExecutionIdentity;
  readonly idempotencyKey: string;
  input: Input;
  output: Output;
  services: Services;
  signal: AbortSignal;
}

export interface WorkflowNodeReference<Input = unknown, Output = unknown> {
  readonly id: string;
  readonly inputSchema: ZodType<Input>;
  readonly kind: WorkflowNodeKind;
  readonly outputSchema: ZodType<Output>;
}

declare const WORKFLOW_CONTEXT_REQUIREMENT: unique symbol;

interface WorkflowContextRequirement<Config, Services> {
  readonly [WORKFLOW_CONTEXT_REQUIREMENT]?: readonly [Readonly<Config>, Services];
}

export interface StepDefinition<
  Input = unknown,
  Output = unknown,
  Config = WorkflowExecutionDefaults,
  Services = unknown,
> extends WorkflowNodeReference<Input, Output>,
    WorkflowContextRequirement<Config, Services> {
  /** Runs atomically with the durable checkpoint and may only perform transactional effects. */
  readonly commit?: (context: StepCommitContext<Input, Output, Config, Services>) => Promise<void>;
  readonly config?: WorkflowConfigOverride<Config>;
  /**
   * Persists one authoritative result for callbacks that may outlive their attempt. Use
   * provider-with-postprocessing when a paid result must be recorded before a later effect.
   */
  readonly externalEffect?: 'provider' | 'provider-with-postprocessing';
  readonly kind: 'step';
  readonly maxAttempts?: number;
  /**
   * Executes at least once: timeout, crash, or lease loss can start a retry while an earlier
   * callback is still finishing. External effects must honor idempotencyKey; AbortSignal alone
   * is not a correctness boundary.
   */
  readonly run: (context: StepExecutionContext<Input, Config, Services>) => Promise<Output>;
  readonly timeoutMs?: number;
  /** May be retried and therefore must be idempotent for the supplied idempotencyKey. */
  readonly undo?: (context: StepUndoContext<Input, Output, Config, Services>) => Promise<void>;
}

export interface SequenceDefinition<
  Input = unknown,
  Output = unknown,
  Config = WorkflowExecutionDefaults,
  Services = unknown,
> extends WorkflowNodeReference<Input, Output>,
    WorkflowContextRequirement<Config, Services> {
  readonly kind: 'sequence';
  readonly nodes: readonly WorkflowNode[];
}

export interface WaitForSignalDefinition<Input = unknown, Payload = unknown, Output = unknown>
  extends WorkflowNodeReference<Input, Output> {
  readonly kind: 'waitForSignal';
  readonly payloadSchema: ZodType<Payload>;
  readonly resume: (input: Input, payload: Payload) => Output;
  readonly signal: string;
}

export interface EmitDefinition<Input = unknown, Output = Input>
  extends WorkflowNodeReference<Input, Output> {
  readonly event: string;
  readonly kind: 'emit';
  readonly payload: (input: Input) => unknown;
}

export type FanOutFailureMode = 'collect' | 'fail-fast';

export type FanOutResult<Input, Output> =
  | { input: Input; key: string; output: Output; status: 'completed' }
  | { failure: StepFailure; input: Input; key: string; status: 'failed' };

export interface FanOutDefinition<
  ParentInput = unknown,
  ItemInput = unknown,
  ItemOutput = unknown,
  Output = unknown,
  Config = WorkflowExecutionDefaults,
  Services = unknown,
> extends WorkflowNodeReference<ParentInput, Output>,
    WorkflowContextRequirement<Config, Services> {
  readonly failureMode: FanOutFailureMode;
  readonly fanIn: (
    results: readonly FanOutResult<ItemInput, ItemOutput>[],
    parentInput: ParentInput
  ) => Output;
  readonly inputs: (input: ParentInput) => readonly ItemInput[];
  readonly itemSchema: ZodType<ItemInput>;
  readonly keyBy: (input: ItemInput) => string;
  readonly kind: 'fanOut';
  readonly worker: WorkflowNode<ItemInput, ItemOutput, Config, Services>;
}

export interface RouteByDefinition<
  Input = unknown,
  Output = unknown,
  Config = WorkflowExecutionDefaults,
  Services = unknown,
> extends WorkflowNodeReference<Input, Output>,
    WorkflowContextRequirement<Config, Services> {
  readonly cases: Readonly<Record<string, WorkflowNode<Input, Output, Config, Services>>>;
  readonly kind: 'routeBy';
  readonly select: (input: Input) => string;
}

export type RepeatDecision<State> =
  | { kind: 'continue'; state: State }
  | { kind: 'finish'; state: State };

export interface RepeatDefinition<
  State = unknown,
  Output = State,
  Config = WorkflowExecutionDefaults,
  Services = unknown,
> extends WorkflowNodeReference<State, Output>,
    WorkflowContextRequirement<Config, Services> {
  readonly body: WorkflowNode<State, RepeatDecision<State>, Config, Services>;
  readonly kind: 'repeat';
  readonly maxIterations: number;
  readonly onExhausted: (lastState: State) => State;
}

interface RuntimeStepDefinition {
  readonly commit?: (context: never) => Promise<void>;
  readonly config?: unknown;
  readonly externalEffect?: StepDefinition['externalEffect'];
  readonly kind: 'step';
  readonly maxAttempts?: number;
  readonly run: (context: never) => Promise<unknown>;
  readonly timeoutMs?: number;
  readonly undo?: (context: never) => Promise<void>;
}

interface RuntimeSequenceDefinition {
  readonly kind: 'sequence';
  readonly nodes: readonly unknown[];
}

interface RuntimeWaitForSignalDefinition {
  readonly kind: 'waitForSignal';
  readonly payloadSchema: ZodType;
  readonly resume: (input: never, payload: unknown) => unknown;
  readonly signal: string;
}

interface RuntimeEmitDefinition {
  readonly event: string;
  readonly kind: 'emit';
  readonly payload: (input: never) => unknown;
}

interface RuntimeFanOutDefinition {
  readonly failureMode: FanOutFailureMode;
  readonly fanIn: (results: never, parentInput: never) => unknown;
  readonly inputs: (input: never) => readonly unknown[];
  readonly itemSchema: ZodType;
  readonly keyBy: (input: never) => string;
  readonly kind: 'fanOut';
  readonly worker: unknown;
}

interface RuntimeRouteByDefinition {
  readonly cases: Readonly<Record<string, unknown>>;
  readonly kind: 'routeBy';
  readonly select: (input: never) => string;
}

interface RuntimeRepeatDefinition {
  readonly body: unknown;
  readonly kind: 'repeat';
  readonly maxIterations: number;
  readonly onExhausted: (lastState: never) => unknown;
}

interface RuntimeWorkflowDefinition {
  readonly compatibilityId: string;
  readonly configSchema: ZodType;
  readonly events: Readonly<Record<string, WorkflowEventDefinition>>;
  readonly executionDefaults: Readonly<WorkflowExecutionDefaults>;
  readonly kind: 'workflow';
  readonly root: unknown;
  readonly signals: Readonly<Record<string, WorkflowSignalDefinition>>;
}

type ContextFreeWorkflowNode = RuntimeEmitDefinition | RuntimeWaitForSignalDefinition;
type ContextualWorkflowNode =
  | RuntimeFanOutDefinition
  | RuntimeRepeatDefinition
  | RuntimeRouteByDefinition
  | RuntimeSequenceDefinition
  | RuntimeStepDefinition
  | RuntimeWorkflowDefinition;

/**
 * Type-erased node used by validators, registries and persistence. Constructors retain
 * their concrete callback types; `never` prevents internal code from calling an erased
 * callback without first crossing a validated schema boundary.
 */
export type WorkflowNode<
  Input = unknown,
  Output = unknown,
  Config = unknown,
  Services = unknown,
> = WorkflowNodeReference<Input, Output> &
  (
    | ContextFreeWorkflowNode
    | (ContextualWorkflowNode & WorkflowContextRequirement<Config, Services>)
  );

export interface WorkflowEventDefinition {
  readonly durability: 'durable' | 'transient';
  readonly schema: ZodType;
  readonly schemaVersion: number;
}

export interface WorkflowSignalDefinition<Payload = unknown> {
  readonly schema: ZodType<Payload>;
  readonly schemaVersion: number;
}

export interface WorkflowDefinition<
  Input = unknown,
  Output = unknown,
  Config = WorkflowExecutionDefaults,
  Services = unknown,
> extends WorkflowNodeReference<Input, Output>,
    WorkflowContextRequirement<Config, Services> {
  /**
   * Explicit semantic contract for durable callbacks and persisted payloads.
   * Keep it for compatible changes; change it when resume behavior changes.
   */
  readonly compatibilityId: string;
  readonly configSchema: ZodType<Config>;
  readonly events: Readonly<Record<string, WorkflowEventDefinition>>;
  readonly executionDefaults: Readonly<Config & WorkflowExecutionDefaults>;
  readonly id: string;
  readonly inputSchema: ZodType<Input>;
  readonly kind: 'workflow';
  readonly outputSchema: ZodType<Output>;
  readonly root: WorkflowNode<Input, Output, Config, Services>;
  readonly signals: Readonly<Record<string, WorkflowSignalDefinition>>;
}

export interface WorkflowManifest {
  readonly compatibilityId: string;
  readonly configSchema: unknown;
  readonly definitionHashVersion: number;
  readonly events: Readonly<
    Record<string, { durability: 'durable' | 'transient'; schema: unknown; schemaVersion: number }>
  >;
  readonly id: string;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly root: unknown;
  readonly signals: Readonly<Record<string, { schema: unknown; schemaVersion: number }>>;
}

export interface RegisteredWorkflow<
  Input = unknown,
  Output = unknown,
  Config = WorkflowExecutionDefaults,
  Services = unknown,
> extends WorkflowDefinition<Input, Output, Config, Services> {
  readonly definitionHash: string;
  readonly definitionHashVersion: number;
  readonly manifest: WorkflowManifest;
}

export type ErasedWorkflowDefinition = Pick<
  WorkflowDefinition,
  'compatibilityId' | 'events' | 'id' | 'inputSchema' | 'kind' | 'outputSchema' | 'signals'
> & {
  readonly configSchema: ZodType;
  readonly executionDefaults: Readonly<WorkflowExecutionDefaults>;
  readonly root: WorkflowNode;
};

export type ErasedRegisteredWorkflow = ErasedWorkflowDefinition &
  Pick<RegisteredWorkflow, 'definitionHash' | 'definitionHashVersion' | 'manifest'>;

export interface WorkflowDefinitionBoundary {
  readonly definitionHash: string;
  readonly definitionHashVersion: number;
  readonly workflowId: string;
}

export interface WorkflowDefinitionDeployment {
  readonly current: WorkflowDefinitionBoundary;
  readonly supportedDefinitions: readonly WorkflowDefinitionBoundary[];
}

export interface WorkflowDefinitionDeploymentTombstone {
  readonly removed: true;
  readonly workflowId: string;
}

export type WorkflowDefinitionDeploymentAuthority =
  | WorkflowDefinitionDeployment
  | WorkflowDefinitionDeploymentTombstone;

export interface WorkflowDefinitionDeploymentState {
  readonly current: WorkflowDefinitionDeploymentAuthority;
  readonly previous: WorkflowDefinitionDeployment | null;
}

export type WorkflowDefinitionDeploymentDecision =
  | 'conflict'
  | 'initialize'
  | 'promote'
  | 'stale'
  | 'unchanged';

export interface WorkflowRegistration<
  Input = unknown,
  Output = unknown,
  Config = WorkflowExecutionDefaults,
  Services = unknown,
> {
  readonly current: RegisteredWorkflow<Input, Output, Config, Services>;
  /** First resumable definition retained for callers written before multi-version history. */
  readonly previous: ErasedRegisteredWorkflow | null;
  readonly previousDefinitions: readonly ErasedRegisteredWorkflow[];
}

export interface WorkflowRun {
  readonly cancellationRequested: boolean;
  readonly cleanupStatus: 'completed' | 'failed' | 'not-required' | 'pending' | 'running';
  readonly completedAt?: string;
  readonly createdAt: string;
  readonly correlationId?: string;
  readonly definitionHash: string;
  readonly definitionHashVersion: number;
  readonly id: string;
  readonly input: unknown;
  readonly error?: StepFailure;
  readonly output?: unknown;
  readonly projectId?: string;
  readonly requestKey: string;
  readonly resolvedConfig: unknown;
  readonly status:
    | 'cancelled'
    | 'completed'
    | 'expired'
    | 'failed'
    | 'queued'
    | 'running'
    | 'waiting';
  readonly updatedAt: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly stepPolicies: WorkflowStepPolicies;
  readonly stepPoliciesVersion: number;
  readonly startedAt?: string;
}

export interface WorkflowStepClaim {
  readonly correlationId?: string;
  readonly attemptNumber: number;
  readonly definitionHash: string;
  readonly definitionHashVersion: number;
  readonly fencingToken: string;
  readonly input: unknown;
  readonly kind: WorkflowNodeKind;
  readonly leaseExpiresAt: string;
  readonly maxAttempts: number;
  readonly nodeDefinitionId: string;
  readonly nodeInstanceId: string;
  readonly previousAttemptFailure?: StepFailure;
  readonly retryFeedback: string;
  readonly runId: string;
  readonly stepPolicies: WorkflowStepPolicies;
  readonly stepPoliciesVersion: number;
  readonly userId: string;
  readonly workerId: string;
  readonly workflowId: string;
  readonly timeoutMs: number;
}
