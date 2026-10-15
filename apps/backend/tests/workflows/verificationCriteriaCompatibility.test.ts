import { describe, expect, test } from 'vitest';
import { createProductionRegistry } from '../../src/workflows/runtime/workflowRuntimeComposition.js';
import { classifyWorkflowDefinitionDeployment } from '../../src/workflows/workflowDefinitionReconciler.js';

// Frozen before adding checkable criteria, from main 7b38cd6's schema boundary.
const priorBoundary = {
  definitionHash: '6457e1939d1d6a312b699eb3a2f088ac9099b89748e523d5650c0cabee89bb31',
  definitionHashVersion: 1,
  workflowId: 'course-generation',
};
const priorDeployment = { current: priorBoundary, supportedDefinitions: [priorBoundary] };

const registry = createProductionRegistry();
const deployment = registry
  .listDefinitionDeployments()
  .find(entry => entry.current.workflowId === 'course-generation');

describe('checkable verification deployment contracts', () => {
  test('promotes over the frozen pre-criteria course boundary and preserves its resolver', () => {
    if (!deployment) throw new Error('Missing current course deployment.');
    expect(
      classifyWorkflowDefinitionDeployment({ current: priorDeployment, previous: null }, deployment)
    ).toBe('promote');
    expect(
      registry.resolve(priorDeployment.current.workflowId, priorDeployment.current.definitionHash)
    ).not.toBeNull();
  });
});
