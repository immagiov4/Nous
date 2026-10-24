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
  const current = Object.fromEntries(
    registry
      .listDefinitionDeployments()
      .map(({ current }) => [current.workflowId, current.definitionHash])
  );
  expect({
    ...current,
    'prepare-lesson-playback-block': fixture.current['prepare-lesson-playback-block'],
  }).toEqual(fixture.current);
  const added = registry
    .listRegisteredBoundaries()
    .filter(
      boundary =>
        !fixture.definitions.some(previous => previous.definitionHash === boundary.definitionHash)
    );
  expect(added.length).toBeGreaterThan(0);
  for (const boundary of added) expect(boundary.workflowId).toBe('prepare-lesson-playback-block');
  expect(
    fixture.definitions.map(
      ({ manifestSha256: _manifest, defaultsSha256: _defaults, ...boundary }) => {
        const definition = registry.resolve(boundary.workflowId, boundary.definitionHash);
        if (!definition) throw new Error(`Unresolvable definition: ${boundary.workflowId}`);
        return {
          ...boundary,
          manifestSha256: sha256(definition.manifest),
          defaultsSha256: sha256(definition.executionDefaults),
        };
      }
    )
  ).toEqual(fixture.definitions);
});

test('registers visual-only requests while preserving the historical input contract', () => {
  const input = {
    userId: 'user',
    projectId: 'project',
    sectionId: 'section',
    incarnationId: 'incarnation',
    lessonKey: 'a'.repeat(64),
    blockId: '0',
    voice: 'Kore',
    model: 'tts-model',
    visualOnly: true,
  };
  const current = registry.current('prepare-lesson-playback-block');
  const historical = registry.resolve(
    'prepare-lesson-playback-block',
    fixture.current['prepare-lesson-playback-block']
  );
  expect(current?.inputSchema.parse(input)).toEqual(input);
  const { visualOnly: _visualOnly, ...previousInput } = input;
  expect(historical?.inputSchema.parse(input)).toEqual(previousInput);
});
