import { describe, expect, test, vi } from 'vitest';

import { createProductionRegistry } from '../../src/workflows/runtime/workflowRuntimeComposition.js';
import {
  classifyWorkflowDefinitionDeployment,
  reconcileUnavailableWorkflowDefinitions,
} from '../../src/workflows/workflowDefinitionReconciler.js';
import { A7AE56D_WORKFLOW_DEFINITIONS } from './a7ae56dWorkflowDefinitions.fixture.js';

const registryStartedAt = performance.now();
const registry = createProductionRegistry();
console.info(
  `Production registry construction: ${Math.round(performance.now() - registryStartedAt)} ms`
);
const deployments = registry.listDefinitionDeployments();
const precedingDeployments = A7AE56D_WORKFLOW_DEFINITIONS.map(fixture => ({
  current: {
    definitionHash: fixture.currentHash,
    definitionHashVersion: fixture.definitionHashVersion,
    workflowId: fixture.workflowId,
  },
  supportedDefinitions: fixture.supportedHashes.map(definitionHash => ({
    definitionHash,
    definitionHashVersion: fixture.definitionHashVersion,
    workflowId: fixture.workflowId,
  })),
}));

describe('direct OpenAI removal deployment compatibility', () => {
  test.each(precedingDeployments)('activates over the deployed $current.workflowId', deployed => {
    const local = deployments.find(
      entry => entry.current.workflowId === deployed.current.workflowId
    );
    if (!local) throw new Error(`Missing deployment: ${deployed.current.workflowId}`);

    expect(classifyWorkflowDefinitionDeployment({ current: deployed, previous: null }, local)).toBe(
      deployed.current.workflowId === 'prepare-lesson-playback-block' ? 'unchanged' : 'promote'
    );
  });

  test.each(
    precedingDeployments
  )('resolves every a7ae56d $current.workflowId boundary', deployed => {
    const local = deployments.find(
      entry => entry.current.workflowId === deployed.current.workflowId
    );
    for (const boundary of deployed.supportedDefinitions) {
      expect(local?.supportedDefinitions).toContainEqual(boundary);
      expect(
        registry.resolve(boundary.workflowId, boundary.definitionHash)?.definitionHashVersion
      ).toBe(boundary.definitionHashVersion);
    }
  });

  test('keeps pending runs on every preceding boundary available during reconciliation', async () => {
    const failNextRun = vi.fn().mockResolvedValue({ status: 'empty' });
    const store = {
      activateDeployments: vi.fn().mockResolvedValue(deployments),
      failNextRun,
      listActiveBoundaries: vi
        .fn()
        .mockResolvedValue(precedingDeployments.flatMap(deployed => deployed.supportedDefinitions)),
    };

    await expect(reconcileUnavailableWorkflowDefinitions({ registry, store })).resolves.toEqual([]);
    expect(failNextRun).not.toHaveBeenCalled();
  });
});
