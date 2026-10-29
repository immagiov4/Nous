import { vi } from 'vitest';
import {
  type CourseGenerationWorkflowServices,
  createCourseGenerationWorkflow,
} from '../../src/workflows/courseGenerationWorkflow.js';
import type { CourseGenerationWorkflowConfig } from '../../src/workflows/courseGenerationWorkflowContract.js';
import { createWorkflowRegistry } from '../../src/workflows/definition.js';
import type { WorkflowStepClaim } from '../../src/workflows/types.js';
import { indexWorkflowNodes } from '../../src/workflows/workflowNodeIndex.js';
import {
  runWorkflowStepClaim,
  type WorkflowStepRunnerStore,
} from '../../src/workflows/workflowStepRunner.js';

/** Runs a real course node through claim resolution, output validation and checkpointing. */
export const checkpointCourseStage = async (
  nodeId: string,
  input: unknown,
  config: CourseGenerationWorkflowConfig,
  services: Partial<CourseGenerationWorkflowServices>
) => {
  const registry = createWorkflowRegistry();
  const definition = registry.register({ current: createCourseGenerationWorkflow(config) }).current;
  const entry = [...indexWorkflowNodes(definition).entries()].find(
    ([, entry]) => entry.node.id === nodeId
  );
  if (!entry) throw new Error(`Missing workflow node ${nodeId}.`);
  const [nodeDefinitionId] = entry;
  const claim: WorkflowStepClaim = {
    attemptNumber: config.maxAttempts,
    definitionHash: definition.definitionHash,
    definitionHashVersion: definition.definitionHashVersion,
    fencingToken: '1',
    input,
    kind: 'step',
    leaseExpiresAt: '2026-10-29T12:00:00.000Z',
    maxAttempts: config.maxAttempts,
    nodeDefinitionId,
    nodeInstanceId: nodeDefinitionId,
    retryFeedback: '',
    runId: 'run-1',
    stepPolicies: {
      [nodeDefinitionId]: { config, maxAttempts: config.maxAttempts, timeoutMs: config.timeoutMs },
    },
    stepPoliciesVersion: 1,
    timeoutMs: config.timeoutMs,
    userId: 'user-1',
    workerId: 'worker-1',
    workflowId: definition.id,
  };
  const checkpointStep = vi.fn<WorkflowStepRunnerStore['checkpointStep']>(async () => ({
    status: 'checkpointed',
    transientEvents: [],
  }));
  const recordResult = vi.fn<WorkflowStepRunnerStore['providerEffects']['recordResult']>(
    async input => input.output
  );
  const store: WorkflowStepRunnerStore = {
    checkpointStep,
    cancellation: { releaseClaim: vi.fn() },
    recordAiUsage: vi.fn(),
    providerEffects: { getResult: vi.fn(), recordResult },
    steps: {
      heartbeat: vi.fn(async () => ({ status: 'renewed', leaseExpiresAt: claim.leaseExpiresAt })),
      recordDefinitionUnavailable: vi.fn(),
      recordFailure: vi.fn(async () => ({ status: 'failed', transientEvents: [] })),
    },
  };
  const result = await runWorkflowStepClaim({ claim, registry, services, store });
  if (result.status !== 'checkpointed')
    throw new Error(`Course stage did not checkpoint: ${JSON.stringify(result)}`);
  return {
    output: checkpointStep.mock.calls[0]?.[0].output,
    providerOutput: recordResult.mock.calls[0]?.[0].output,
  };
};
