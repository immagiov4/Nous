import { snapshotImmutableJson } from './jsonSnapshot.js';
import type {
  ErasedRegisteredWorkflow,
  RegisteredWorkflow,
  StepFailure,
  WorkflowNode,
  WorkflowStepClaim,
} from './types.js';
import { WORKFLOW_STEP_POLICIES_VERSION } from './types.js';
import { assertRegisteredWorkflowIntegrity } from './validation.js';
import { indexWorkflowNodes } from './workflowNodeIndex.js';
import { workflowOperationIdempotencyKey } from './workflowStepAttempt.js';

export interface WorkflowDefinitionResolver {
  resolve(workflowId: string, definitionHash: string): ErasedRegisteredWorkflow | null;
}

export type ResolvedWorkflowStep = {
  config: Readonly<Record<string, unknown>>;
  definition: ErasedRegisteredWorkflow;
  input: unknown;
  step: Extract<WorkflowNode, { kind: 'step' }>;
};

export type WorkflowStepResolution =
  | { failure: StepFailure; registeredDefinition: ErasedRegisteredWorkflow | null; resolved: false }
  | { resolved: true; value: ResolvedWorkflowStep };

export type WorkflowClaimResolutionFailure = {
  definition: ErasedRegisteredWorkflow | null;
  reason:
    | 'config-incompatible'
    | 'definition-incompatible'
    | 'definition-unavailable'
    | 'policy-snapshot-incompatible'
    | 'policy-version-incompatible';
  resolved: false;
};

type WorkflowClaimedDefinitionResolution =
  | WorkflowClaimResolutionFailure
  | {
      resolved: true;
      value: {
        definition: ErasedRegisteredWorkflow;
        node: WorkflowNode | undefined;
      };
    };

type WorkflowClaimedPolicyResolution =
  | WorkflowClaimResolutionFailure
  | { config: Readonly<Record<string, unknown>>; resolved: true };

const permanentFailure = (code: string, message: string): StepFailure => ({
  code,
  kind: 'permanent',
  message,
});

const STEP_CLAIM_FAILURES: Record<
  WorkflowClaimResolutionFailure['reason'],
  readonly [code: string, message: string]
> = {
  'config-incompatible': [
    'workflow_step_config_incompatible',
    'The workflow step configuration does not match its durable schema.',
  ],
  'definition-incompatible': [
    'workflow_definition_incompatible',
    'The claimed workflow definition is incompatible with this worker.',
  ],
  'definition-unavailable': [
    'workflow_definition_unavailable',
    'The workflow definition required by this run is unavailable.',
  ],
  'policy-snapshot-incompatible': [
    'workflow_step_policy_incompatible',
    'The claimed workflow step policy differs from the run snapshot.',
  ],
  'policy-version-incompatible': [
    'workflow_step_policy_incompatible',
    'The claimed workflow step policy version is unsupported.',
  ],
};

export const workflowStepIdempotencyKey = (claim: WorkflowStepClaim): string =>
  workflowOperationIdempotencyKey('forward', claim.runId, claim.nodeInstanceId);

export const resolveClaimedWorkflowDefinition = (
  registry: WorkflowDefinitionResolver,
  claim: Pick<
    WorkflowStepClaim,
    'definitionHash' | 'definitionHashVersion' | 'nodeDefinitionId' | 'workflowId'
  >
): WorkflowClaimedDefinitionResolution => {
  const definition = registry.resolve(claim.workflowId, claim.definitionHash);
  if (!definition) {
    return {
      definition: null,
      reason: 'definition-unavailable',
      resolved: false,
    };
  }
  if (
    definition.id !== claim.workflowId ||
    definition.definitionHash !== claim.definitionHash ||
    definition.definitionHashVersion !== claim.definitionHashVersion
  ) {
    return { definition: null, reason: 'definition-incompatible', resolved: false };
  }
  try {
    assertRegisteredWorkflowIntegrity(definition as unknown as RegisteredWorkflow);
  } catch {
    return { definition: null, reason: 'definition-incompatible', resolved: false };
  }

  const node = indexWorkflowNodes(definition).get(claim.nodeDefinitionId)?.node;
  return { resolved: true, value: { definition, node } };
};

export const resolveClaimedWorkflowStepPolicy = (
  definition: ErasedRegisteredWorkflow,
  claim: Pick<
    WorkflowStepClaim,
    'maxAttempts' | 'nodeDefinitionId' | 'stepPolicies' | 'stepPoliciesVersion' | 'timeoutMs'
  >
): WorkflowClaimedPolicyResolution => {
  if (claim.stepPoliciesVersion !== WORKFLOW_STEP_POLICIES_VERSION) {
    return {
      definition,
      reason: 'policy-version-incompatible',
      resolved: false,
    };
  }
  const policy = claim.stepPolicies[claim.nodeDefinitionId];
  if (policy?.maxAttempts !== claim.maxAttempts || policy?.timeoutMs !== claim.timeoutMs) {
    return {
      definition,
      reason: 'policy-snapshot-incompatible',
      resolved: false,
    };
  }

  let config: Readonly<Record<string, unknown>>;
  try {
    config = snapshotImmutableJson(definition.configSchema.parse(policy.config)) as Readonly<
      Record<string, unknown>
    >;
    if (config.maxAttempts !== policy.maxAttempts || config.timeoutMs !== policy.timeoutMs) {
      throw new Error('Step policy configuration mismatch.');
    }
  } catch {
    return {
      definition,
      reason: 'config-incompatible',
      resolved: false,
    };
  }
  return { config, resolved: true };
};

const mapClaimResolutionFailure = (
  resolution: WorkflowClaimResolutionFailure
): WorkflowStepResolution => {
  const [code, message] = STEP_CLAIM_FAILURES[resolution.reason];
  return {
    failure: permanentFailure(code, message),
    registeredDefinition: resolution.definition,
    resolved: false,
  };
};

export const resolveWorkflowStepClaim = (
  registry: WorkflowDefinitionResolver,
  claim: WorkflowStepClaim
): WorkflowStepResolution => {
  const claimedDefinition = resolveClaimedWorkflowDefinition(registry, claim);
  if (!claimedDefinition.resolved) return mapClaimResolutionFailure(claimedDefinition);

  const { definition, node } = claimedDefinition.value;
  if (claim.kind !== 'step' || node?.kind !== 'step') {
    return {
      failure: permanentFailure(
        'workflow_step_definition_incompatible',
        'The claimed workflow step is not present in the registered definition.'
      ),
      registeredDefinition: null,
      resolved: false,
    };
  }
  const claimedPolicy = resolveClaimedWorkflowStepPolicy(definition, claim);
  if (!claimedPolicy.resolved) return mapClaimResolutionFailure(claimedPolicy);

  try {
    return {
      resolved: true,
      value: {
        config: claimedPolicy.config,
        definition,
        input: snapshotImmutableJson(node.inputSchema.parse(claim.input)),
        step: node,
      },
    };
  } catch {
    return {
      failure: permanentFailure(
        'workflow_step_input_incompatible',
        'The workflow step input does not match its durable schema.'
      ),
      registeredDefinition: definition,
      resolved: false,
    };
  }
};
