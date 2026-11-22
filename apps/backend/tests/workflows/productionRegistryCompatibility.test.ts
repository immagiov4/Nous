import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { createProductionRegistry } from '../../src/workflows/runtime/workflowRuntimeComposition.js';
import { classifyWorkflowDefinitionDeployment } from '../../src/workflows/workflowDefinitionReconciler.js';
import previousProduction from './fixtures/previousProductionWorkflowDeployment.json';
import integratedContracts from './fixtures/productionRegistryComparisonIntegration.json';
import comparisonContracts from './fixtures/productionRegistryComparisonRelations.json';
import conceptContracts from './fixtures/productionRegistryConceptLayouts.json';
import diagnosticContracts from './fixtures/productionRegistryDegradation.json';
import orderedContracts from './fixtures/productionRegistryOrderedScenes.json';
import combinedContracts from './fixtures/productionRegistryPhaseDiagnostics.json';
import workflowSets from './fixtures/productionWorkflowContracts.json';
import fixture from './productionRegistryCompatibility.fixture.json';

// Keep model settings explicit so local environment overrides do not change the comparison.
vi.mock('../../src/config/modelConfig.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/config/modelConfig.js')>()),
  getGlobalModelConfig: () => fixture.modelConfig,
}));

// The fixture identifies the revision defining these current and historical registry outputs.
const registry = createProductionRegistry();
const candidateDeployments = registry.listDefinitionDeployments();
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textOnlyPlayback = {
  workflowId: 'prepare-lesson-playback-block',
  definitionHash: 'da89fb448a37dfca3e44bccd159edd724b953c25ebcd1a2d6550238b55f235be',
  definitionHashVersion: 1,
  manifestSha256: 'f21a5faf5b91e7a376a03df2b4d9bc3a6e129bd82c1bb2d8e89eec64e2c1866b',
  defaultsSha256: '6c0f290aa85f95b38ae7bb71d2f4602476fc7240e6b4c25139b2548c3468fbc5',
};

const comparisonTextOnlyPlayback = {
  ...conceptContracts.textOnlyPlayback,
  definitionHash: 'd39584808e5076110fda82ab47ed5a259f3be6be0764b46c1669faa16dab6e23',
  manifestSha256: 'f85c8e5c0cf1124d4b9ac4b69f25cf7921b7076617e23728dfb01bb56856a44b',
};

const orderedTextOnlyPlayback = {
  ...comparisonTextOnlyPlayback,
  definitionHash: '35cc02c7a94f93d2cacddbccc05eec5b3afe997809b2818da85e28040e428f87',
  manifestSha256: 'fb8408ba32c1dcff008f53ef58a9d9a04a469f7dd10be2b2eeed0a7e93c68a1a',
};

test.each(
  previousProduction.deployments
)('upgrades the previous production deployment for $current.workflowId', previous => {
  const candidate = candidateDeployments.find(
    ({ current }) => current.workflowId === previous.current.workflowId
  );
  if (!candidate) throw new Error(`Missing production workflow: ${previous.current.workflowId}`);
  expect(['promote', 'unchanged']).toContain(
    classifyWorkflowDefinitionDeployment({ current: previous, previous: null }, candidate)
  );
  expect(candidate.supportedDefinitions).toEqual(
    expect.arrayContaining(previous.supportedDefinitions)
  );
  for (const {
    workflowId,
    definitionHash,
    definitionHashVersion,
  } of previous.supportedDefinitions) {
    expect(registry.resolve(workflowId, definitionHash)?.definitionHashVersion).toBe(
      definitionHashVersion
    );
  }
});

const candidateMigrations = readdirSync(
  new URL('../../../../supabase/migrations/', import.meta.url)
);

test('retains every migration tracked by the previous production release', () => {
  expect(candidateMigrations).toEqual(expect.arrayContaining(previousProduction.migrations));
});

test('includes every migration version already applied in production', () => {
  const productionVersions = readFileSync(
    new URL('./fixtures/productionAppliedMigrationVersions.txt', import.meta.url),
    'utf8'
  )
    .trim()
    .split(/\r?\n/);
  const candidateVersions = new Set(
    candidateMigrations.filter(file => file.endsWith('.sql')).map(file => file.split('_', 1)[0])
  );
  expect(productionVersions.filter(version => !candidateVersions.has(version))).toEqual([]);
});

test('promotes only scene workflows and preserves every preceding durable fingerprint byte for byte', () => {
  const current = Object.fromEntries(
    registry
      .listDefinitionDeployments()
      .map(({ current }) => [current.workflowId, current.definitionHash])
  );
  const beforeStudios = workflowSets.find(({ version }) => version === 17);
  if (!beforeStudios) throw new Error('Missing the published pre-studio workflow set');
  expect(
    beforeStudios.current
      .filter(boundary => current[boundary.workflowId] !== boundary.definitionHash)
      .map(boundary => boundary.workflowId)
  ).toEqual([
    'lesson-artifact-draft',
    'lesson-generation',
    'prepare-lesson-playback-block',
    'retry-lesson-visual',
  ]);
  const prior = [
    ...fixture.definitions,
    ...combinedContracts.addedDefinitions,
    ...comparisonContracts.addedDefinitions,
    ...integratedContracts.addedDefinitions,
    ...conceptContracts.addedDefinitions,
    ...orderedContracts.addedDefinitions,
    textOnlyPlayback,
    conceptContracts.textOnlyPlayback,
    comparisonTextOnlyPlayback,
    orderedTextOnlyPlayback,
  ];
  const expected = new Map(prior.map(definition => [definition.definitionHash, definition]));
  const registered = registry.listRegisteredBoundaries().map(boundary => {
    const definition = registry.resolve(boundary.workflowId, boundary.definitionHash);
    if (!definition) throw new Error(`Unresolvable definition: ${boundary.workflowId}`);
    return {
      ...boundary,
      manifestSha256: sha256(definition.manifest),
      defaultsSha256: sha256(definition.executionDefaults),
    };
  });
  const publishedHashes = new Set([
    ...expected.keys(),
    ...workflowSets.flatMap(set => set.current.map(boundary => boundary.definitionHash)),
  ]);
  expect(new Set(registered.map(boundary => boundary.definitionHash))).toEqual(publishedHashes);
  expect(registered).toEqual(expect.arrayContaining([...expected.values()]));
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

test('retains the immediately preceding course source-mapping boundary', () => {
  const previousHash = 'a0281bd3c245fd1bb4441c30982501b0a10e6a38de2395c39e10ae850933eca5';
  expect(registry.resolve('course-generation', previousHash)).not.toBeNull();
  expect(registry.current('course-generation')?.definitionHash).not.toBe(previousHash);
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

// Frozen from the registry before #603 at f519dc1, using its unchanged defaults.
test.each([
  ['course-generation', '63a25e1442392de839f5b72f53949285902dcf6e872d3d7d530ff585bc2dcf53'],
  ['pdf-mapping-repair', '67eacc4ec881db634368c3b7b2e8dfc7e541378b60f1260cb3e1463b850e6928'],
])('retains the pre-observation %s definition while promoting the current schema', (workflowId, hash) => {
  expect(registry.resolve(workflowId, hash)).not.toBeNull();
  expect(registry.current(workflowId)?.definitionHash).not.toBe(hash);
});

test('preserves PR602 current and historical degradation fingerprints exactly', () => {
  for (const [workflowId, definitionHash] of Object.entries(diagnosticContracts.current)) {
    expect(registry.resolve(workflowId, definitionHash)?.definitionHash).toBe(definitionHash);
  }
  expect(
    diagnosticContracts.addedDefinitions.map(
      ({ manifestSha256: _manifest, defaultsSha256: _defaults, ...boundary }) => {
        const definition = registry.resolve(boundary.workflowId, boundary.definitionHash);
        if (!definition) throw new Error(`Unresolvable PR602 definition: ${boundary.workflowId}`);
        return {
          ...boundary,
          manifestSha256: sha256(definition.manifest),
          defaultsSha256: sha256(definition.executionDefaults),
        };
      }
    )
  ).toEqual(diagnosticContracts.addedDefinitions);
});
