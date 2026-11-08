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
    'course-generation': fixture.current['course-generation'],
    'lesson-artifact-draft': fixture.current['lesson-artifact-draft'],
    'prepare-lesson-playback-block': fixture.current['prepare-lesson-playback-block'],
  }).toEqual(fixture.current);
  const added = registry
    .listRegisteredBoundaries()
    .filter(
      boundary =>
        !fixture.definitions.some(previous => previous.definitionHash === boundary.definitionHash)
    );
  expect(added.length).toBeGreaterThan(0);
  for (const boundary of added)
    expect([
      'prepare-lesson-playback-block',
      'course-generation',
      'lesson-artifact-draft',
    ]).toContain(boundary.workflowId);
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

test('retains structural playback checkpoints predating visual-only requests', () => {
  const historical = registry.resolve(
    'prepare-lesson-playback-block',
    '306db975b355e122ebecdd405e6b57df7641896cb2fac8f98aba499127856863'
  );
  expect(historical).toBeDefined();
  const input = {
    userId: 'user',
    projectId: 'project',
    sectionId: 'section',
    incarnationId: 'incarnation',
    lessonKey: 'a'.repeat(64),
    blockId: '0',
    voice: 'Kore',
    model: 'tts-model',
  };
  expect(historical?.inputSchema.parse({ ...input, visualOnly: true })).toEqual(input);
});

test('retains the old course boundary while promoting the diagnostic result contract', () => {
  expect(registry.current('course-generation')?.definitionHash).not.toBe(
    fixture.current['course-generation']
  );
  expect(
    registry.resolve('course-generation', fixture.current['course-generation'])
  ).not.toBeNull();
});

test('only current artifact checkpoints retain the original request while historical and ordinary visual inputs keep their contract', () => {
  const workflowId = 'lesson-artifact-draft';
  const current = registry.current(workflowId);
  const historical = registry.resolve(workflowId, fixture.current[workflowId]);
  const checkpoint = {
    kind: 'render',
    contextFingerprint: 'a'.repeat(64),
    lessonMarkdown: 'Synthetic lesson.',
    requestText: 'Draw four connected nodes with arrows as an artifact.',
    projectId: 'project',
    sectionId: 'section',
    sectionTitle: 'Synthetic lesson',
    sectionDescription: '',
    userId: 'user',
    plan: {
      slotId: 'artifact-draft',
      visualType: 'lesson_scene',
      complexity: 'simple',
      interactionLevel: 'none',
      requiresDepiction: false,
      concept: 'Directed flow',
      title: 'Directed flow',
      altText: 'Four connected nodes',
      anchorHeading: '',
      pedagogicalGoal: 'Show order',
      visualDirection: 'Left to right',
      reason: 'Explicit request',
      factualRequirements: [],
      coverage: 'complete_synthesis',
      coverageRationale: 'Entire flow',
    },
  };
  if (current?.root.kind !== 'sequence' || historical?.root.kind !== 'sequence')
    throw new Error('Expected artifact workflow sequences');
  const currentPlan = current.root.nodes[0];
  const historicalPlan = historical.root.nodes[0];
  if (currentPlan.kind !== 'step' || historicalPlan.kind !== 'step')
    throw new Error('Expected artifact planning steps');
  expect(current.definitionHash).not.toBe(historical.definitionHash);
  expect(currentPlan.outputSchema.parse(checkpoint)).toMatchObject({
    requestText: checkpoint.requestText,
  });
  const { requestText: _requestText, ...previousCheckpoint } = checkpoint;
  expect(historicalPlan.outputSchema.parse(checkpoint)).toEqual(previousCheckpoint);
  const ordinary = registry.current('retry-lesson-visual');
  expect(ordinary?.inputSchema.parse(checkpoint)).not.toHaveProperty('requestText');
});
