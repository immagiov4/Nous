import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { createProductionRegistry } from '../../src/workflows/runtime/workflowRuntimeComposition.js';
import fixture from './productionRegistryCompatibility.fixture.json';

// Keep model settings explicit so local environment overrides do not change the comparison.
vi.mock('../../src/config/modelConfig.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/config/modelConfig.js')>()),
  getGlobalModelConfig: () => fixture.modelConfig,
}));

// The fixture identifies the revision defining these current and historical registry outputs.
const registry = createProductionRegistry();
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('preserves every production registry output and durable fingerprint byte for byte', () => {
  expect(
    Object.fromEntries(
      registry
        .listDefinitionDeployments()
        .map(({ current }) => [current.workflowId, current.definitionHash])
    )
  ).toEqual(fixture.current);
  expect(
    registry.listRegisteredBoundaries().map(boundary => {
      const definition = registry.resolve(boundary.workflowId, boundary.definitionHash);
      if (!definition) throw new Error(`Unresolvable definition: ${boundary.workflowId}`);
      return {
        ...boundary,
        manifestSha256: sha256(definition.manifest),
        defaultsSha256: sha256(definition.executionDefaults),
      };
    })
  ).toEqual(fixture.definitions);
});
