import { describe, expect, test } from 'vitest';

import { createProductionRegistry } from '../../src/workflows/runtime/workflowRuntimeComposition.js';
import { classifyWorkflowDefinitionDeployment } from '../../src/workflows/workflowDefinitionReconciler.js';

// Captured from the routing deployment e2b3123 before evidence fields were added.
const previousHashes = [
  '358796024b1bcf409a8aa7fecf0b291fdaa2ed8238bb9c50271ec5587277d092',
  '6292d426839791f56c4850799d265ad727aaf374c3989f84269ed2e53ef539dc',
  '71f3e1783106cc4e7d7e792a9439c7745f6f09fb16fb80c76f9bc74e0940cd66',
  '7ed46edd6ab7ee09440eebae86079ccb13e0709f44c162a57a5c169b05ecdee2',
  '9a75fcddc0ff92d1c9097236b733709ccdd4157b9e481485fc5e358798697f47',
  'c2a9a7589283bec039060d545903c65ab90465400e0319ed803a749275541024',
  'c9d21983b2c81796f5b235129cc854faab285ce6b1e076320875d116b91a1954',
  'ec69547055bd7c687c7d6cec929bb6e6395ed5ec5957674a7c52dcd1a718c378',
];
const boundary = (definitionHash: string) => ({
  definitionHash,
  definitionHashVersion: 1,
  workflowId: 'lesson-generation',
});
const previous = {
  current: boundary('c2a9a7589283bec039060d545903c65ab90465400e0319ed803a749275541024'),
  supportedDefinitions: previousHashes.map(boundary),
};

describe('lesson evidence deployment compatibility', () => {
  const registry = createProductionRegistry();
  const deployment = registry
    .listDefinitionDeployments()
    .find(candidate => candidate.current.workflowId === 'lesson-generation');
  if (!deployment) throw new Error('Missing lesson workflow registration.');

  test('promotes from the preceding routing deployment and keeps old replicas stale', () => {
    expect(
      classifyWorkflowDefinitionDeployment({ current: previous, previous: null }, deployment)
    ).toBe('promote');
    expect(classifyWorkflowDefinitionDeployment({ current: deployment, previous }, previous)).toBe(
      'stale'
    );
  });

  test.each(previousHashes)('retains exact durable boundary %s', hash => {
    expect(deployment.supportedDefinitions).toContainEqual(boundary(hash));
    expect(registry.resolve('lesson-generation', hash)).toMatchObject({ definitionHashVersion: 1 });
  });
});
