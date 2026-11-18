import { MAX_VISUAL_LESSON_CHARS } from '@shared/lessonGenerationPolicy';
import { segmentLessonPlayback } from '@shared/lessonPlayback';
import {
  HistoricalLessonSceneSchemas,
  isLessonScene,
  LessonSceneSchema,
  STATIC_LESSON_SCENE_TYPES,
} from '@shared/lessonScene';
import { beforeEach, expect, test, vi } from 'vitest';

const { chooseIconsMock, generateStructuredOutputMock } = vi.hoisted(() => ({
  chooseIconsMock: vi.fn(async ({ scene }) => scene),
  generateStructuredOutputMock: vi.fn(),
}));

vi.mock('../../../src/services/structuredGeneration.js', () => ({
  generateStructuredOutput: generateStructuredOutputMock,
}));
vi.mock('../../../src/services/lessonScenes/lessonSceneIconChoice.js', () => ({
  chooseLessonSceneIcons: chooseIconsMock,
}));

import * as z from 'zod';
import { getGlobalModelConfig } from '../../../src/config/modelConfig.js';
import { prepareLessonPlaybackVisuals } from '../../../src/services/lessonPlayback/prepareLessonPlaybackBlock.js';
import { generateLessonScene } from '../../../src/services/lessonScenes/lessonSceneGeneration.js';
import { resolveLessonVisualModelConfig } from '../../../src/services/lessonVisualModelConfig.js';
import type { LessonPlaybackServices } from '../../../src/workflows/lessonPlaybackWorkflow.js';
import { createProductionRegistry } from '../../../src/workflows/runtime/workflowRuntimeComposition.js';
import { indexWorkflowNodes } from '../../../src/workflows/workflowNodeIndex.js';
import {
  runWorkflowStepClaim,
  type WorkflowStepRunnerStore,
} from '../../../src/workflows/workflowStepRunner.js';
import {
  guidedPathScene,
  proportionalScene as prototypeProportionalScene,
} from '../../helpers/animatedLessonScenes';
import {
  LAB_COMPOSITION_SCENE,
  LAB_COMPOSITION_SOURCE,
  LAB_QUICK_SCENES,
} from '../../helpers/lessonSceneLabExamples';
import workflowContracts from '../../workflows/fixtures/productionWorkflowContracts.json';

const { durationMs: _prototypeDuration, ...proportionalScene } = prototypeProportionalScene;

const queries = { action: 'check', concept: 'relevance', object: 'magnifying glass' };

beforeEach(() => {
  chooseIconsMock.mockClear();
  generateStructuredOutputMock.mockReset();
});

const unplannedInput = (lessonMarkdown: string) => ({
  config: resolveLessonVisualModelConfig(getGlobalModelConfig()),
  lessonMarkdown,
  sectionDescription: '',
  sectionTitle: 'Fonti',
  signal: new AbortController().signal,
});

const sceneDraft = (source: string) => ({
  body: '',
  criteria: [],
  diagram: null,
  evidence: source,
  groups: [],
  intent: 'Mostrare le parti.',
  items: [
    { label: 'Fonte', detail: source, value: null, time: null, iconQueries: queries },
    { label: 'Riscontri', detail: '', value: null, time: null, iconQueries: queries },
  ],
  note: '',
  quote: '',
  relation: null,
  title: 'Fonti',
  type: 'concepts',
});

test('chooses fixed or animated replicas from one proportional form and retains frozen choices', async () => {
  const source = 'Use 3 groups with 2 observations per group.';
  const fixed = {
    ...sceneDraft(source),
    type: 'proportional',
    variant: 'proportional-static',
    title: 'Observations in groups',
    items: [],
    quantity: 3,
    amountPerUnit: 2,
    unit: 'observations',
  };
  generateStructuredOutputMock.mockResolvedValueOnce(fixed);
  const result = await generateLessonScene(unplannedInput(source));
  expect(result).toEqual({
    kind: 'scene',
    scene: {
      type: 'proportional-static',
      title: fixed.title,
      body: '',
      items: [],
      groups: [],
      note: '',
      quote: '',
      quantity: 3,
      amountPerUnit: 2,
      unit: 'observations',
    },
  });
  const { variant: _variant, ...fields } = fixed;
  const legacy = { ...fields, type: 'proportional-static' };
  const { output } = generateStructuredOutputMock.mock.calls.at(-1)?.[0] ?? {};
  const schema = z.fromJSONSchema(output.schema);
  expect(schema.safeParse(fixed).success).toBe(true);
  expect(schema.safeParse(legacy).success).toBe(false);

  generateStructuredOutputMock.mockResolvedValueOnce({ ...fixed, outputUnit: fixed.unit });
  expect(await generateLessonScene(unplannedInput(source))).toEqual(result);
  generateStructuredOutputMock.mockResolvedValueOnce({ ...fixed, outputUnit: 'litres' });
  expect(await generateLessonScene(unplannedInput(source))).toMatchObject({
    kind: 'invalid',
    diagnostic: { errorStage: 'domain' },
  });

  generateStructuredOutputMock.mockResolvedValueOnce(legacy);
  expect(
    await generateLessonScene({
      ...unplannedInput(source),
      allowedSceneTypes: ['proportional-static'],
    })
  ).toEqual(result);

  generateStructuredOutputMock.mockResolvedValueOnce(fixed);
  expect(
    await generateLessonScene({ ...unplannedInput(source), allowedSceneTypes: ['proportional'] })
  ).toMatchObject({ kind: 'invalid' });
  generateStructuredOutputMock.mockResolvedValueOnce({ ...fixed, cues: [{ value: 3 }] });
  expect(await generateLessonScene(unplannedInput(source))).toMatchObject({
    kind: 'invalid',
    diagnostic: { errorStage: 'domain' },
  });
});

test.each([
  {
    legacy: 'signals',
    kind: 'complementary',
    label: 'Read together',
    panels: ['Visible signs', 'How to interpret them'],
    entries: ['Wilting leaves', 'Check the soil moisture'],
    source: 'Wilting leaves are a clue to read alongside soil moisture.',
  },
  {
    legacy: 'balance',
    kind: 'tradeoff',
    label: 'Benefit and cost',
    panels: ['Benefit', 'Cost'],
    entries: ['Less watering', 'Slower growth'],
    source: 'Less watering comes at the cost of slower growth.',
  },
])('generates $legacy as comparison while retaining frozen workflows', async ({
  legacy,
  kind,
  label,
  panels,
  entries,
  source,
}) => {
  const draft = {
    ...sceneDraft(source),
    items: [],
    groups: panels.map((panel, index) => ({
      label: panel,
      items: [entries[index]],
      iconQueries: [queries],
      verdict: 'none',
    })),
  };
  const oldDraft = { ...draft, type: legacy };
  const comparison = {
    ...draft,
    type: 'comparison',
    relation: { evidence: source, kind, label },
  };
  const input = unplannedInput(source);
  for (const request of [input, { ...input, narration: source }]) {
    generateStructuredOutputMock.mockResolvedValueOnce(oldDraft);
    expect(await generateLessonScene(request)).toMatchObject({
      kind: 'invalid',
      diagnostic: { errorStage: 'schema' },
    });
    generateStructuredOutputMock.mockResolvedValueOnce({
      ...comparison,
      relation: { ...comparison.relation, evidence: 'Absent evidence.' },
    });
    const rejected = await generateLessonScene(request);
    expect(rejected).toMatchObject({ kind: 'invalid', diagnostic: { errorStage: 'domain' } });
    if (rejected.kind !== 'invalid') throw new Error('Expected corrective feedback.');
    generateStructuredOutputMock.mockResolvedValueOnce(comparison);
    expect(
      await generateLessonScene({ ...request, retryFeedback: rejected.problems.join('\n') })
    ).toMatchObject({
      kind: 'scene',
      scene: {
        type: 'comparison',
        relation: comparison.relation,
        groups: panels.map((label, index) => ({ label, items: [entries[index]] })),
      },
    });
    const schema = z.fromJSONSchema(generateStructuredOutputMock.mock.lastCall?.[0].output.schema);
    expect(schema.safeParse(comparison).success).toBe(true);
    expect(schema.safeParse(oldDraft).success).toBe(false);
  }

  const legacyCatalogs = HistoricalLessonSceneSchemas.filter(
    ({ shape }) =>
      shape.type.options.includes(legacy) &&
      !shape.relation.unwrap().shape.kind.options.includes(kind)
  );
  expect(legacyCatalogs.some(({ shape }) => 'conceptLayout' in shape)).toBe(true);
  for (const { shape } of legacyCatalogs) {
    generateStructuredOutputMock.mockResolvedValueOnce(oldDraft);
    const resumed = await generateLessonScene({
      ...input,
      allowedSceneTypes: shape.type.options,
      allowedSceneRelationKinds: shape.relation.unwrap().shape.kind.options,
      supportsConceptLayout: 'conceptLayout' in shape,
    });
    expect(resumed).toMatchObject({ kind: 'scene', scene: { type: legacy } });
    if (resumed.kind !== 'scene') throw new Error('Expected a historical comparison.');
    for (const schema of [LessonSceneSchema, ...HistoricalLessonSceneSchemas]) {
      if (schema.shape.type.options.includes(legacy)) {
        expect(schema.parse(resumed.scene)).toEqual(resumed.scene);
      }
    }
    const frozenOutput = z.fromJSONSchema(
      generateStructuredOutputMock.mock.lastCall?.[0].output.schema
    );
    expect(frozenOutput.safeParse(comparison).success).toBe(false);
  }
});

const resultFirstPassage = 'The result is firm clay. Before drying, the material was soft clay.';
const maturityPassage = 'Il frutto passa da immaturo a maturo.';
const neighboringPassage = 'Heating turns firm clay into fired ceramic.';

test.each([
  {
    name: 'result mentioned first',
    speech: resultFirstPassage,
    labels: ['soft clay', 'firm clay'],
  },
  { name: 'reversed draft', speech: resultFirstPassage, labels: ['firm clay', 'soft clay'] },
  {
    name: 'state names with a shared substring',
    speech: maturityPassage,
    labels: ['immaturo', 'maturo'],
  },
  {
    name: 'evidence from the authored context',
    speech: resultFirstPassage,
    labels: ['firm clay', 'fired ceramic'],
    evidence: neighboringPassage,
    context: neighboringPassage,
  },
  {
    name: 'evidence missing from the lesson',
    speech: resultFirstPassage,
    labels: ['soft clay', 'firm clay'],
    evidence: neighboringPassage,
    rejected: true,
  },
  {
    name: 'versus relation',
    speech: resultFirstPassage,
    labels: ['soft clay', 'firm clay'],
    kind: 'versus',
    evidence: '',
  },
  {
    name: 'no explicit relation',
    speech: resultFirstPassage,
    labels: ['soft clay', 'firm clay'],
    kind: null,
  },
])('preserves baseline playback for $name', async ({
  speech,
  labels,
  kind = 'leads',
  evidence = speech,
  context,
  rejected,
}) => {
  for (const type of ['beforeafter', 'comparison'] as const) {
    const relation = kind === null ? null : { kind, label: 'State comparison', evidence };
    const groups = labels.map(label => ({ label, items: [label], icons: [''] }));
    const draft = {
      ...sceneDraft(speech),
      type,
      items: [],
      groups: groups.map(({ label, items }) => ({
        label,
        items,
        verdict: 'none',
        iconQueries: [queries],
      })),
      relation,
    };
    let attempts = 0;
    generateStructuredOutputMock.mockImplementation(async request => {
      if (request.output.name !== 'lesson_scene')
        return { plans: [{ chunk: 0, events: [], reason: 'Static scene' }] };
      attempts += 1;
      return draft;
    });
    const entirePassage = context ? `${speech}\n\n${context}` : speech;
    const prepared = await prepareLessonPlaybackVisuals({
      userId: 'comparison-playback-test',
      config: getGlobalModelConfig(),
      voice: 'Kore',
      lesson: {
        title: 'State comparison',
        sources: [{ type: 'markdown', markdown: entirePassage }],
      },
      signal: new AbortController().signal,
      block: {
        id: 'state-change',
        speech,
        heading: '',
        spans: [
          {
            sourceBlockIndex: 0,
            source: { start: 0, end: speech.length },
            speech: { start: 0, end: speech.length },
          },
        ],
        audio: [],
        visuals: [],
      },
    });
    if (rejected) {
      expect(prepared.scene).toBeUndefined();
      expect(attempts).toBeGreaterThan(1);
    } else {
      expect(prepared.scene).toMatchObject({ type, groups });
      expect(prepared.scene?.relation).toEqual(relation ?? undefined);
      expect(attempts).toBe(1);
    }
  }
});

test('offers checklist for new hypotheses and preserves a hypothesis-only resumed contract', async () => {
  const source = 'Verifica se il client usa DNS.';
  const input = unplannedInput(source);
  const draft = sceneDraft(source);

  generateStructuredOutputMock.mockResolvedValue({ ...draft, type: 'hypothesis' });
  expect(await generateLessonScene(input)).toMatchObject({ kind: 'invalid' });

  generateStructuredOutputMock.mockResolvedValue({ ...draft, type: 'checklist' });
  expect(await generateLessonScene(input)).toMatchObject({
    kind: 'scene',
    scene: { type: 'checklist' },
  });

  generateStructuredOutputMock.mockResolvedValue({ ...draft, type: 'hypothesis' });
  expect(await generateLessonScene({ ...input, allowedSceneTypes: ['hypothesis'] })).toMatchObject({
    kind: 'scene',
    scene: { type: 'hypothesis' },
  });
});

const orderedSteps = [
  ['Collect the sample', 'Field technician'],
  ['Seal the container', 'Airtight sample'],
  ['Record the location', 'Coordinates and date'],
  ['Deliver the sample', 'Lab technician'],
  ['Check the seal', 'Intact container'],
  ['Measure the sample', 'Measurement and units'],
  ['Review the measurement', 'Second technician'],
  ['Publish the result', 'Signed report'],
] as const;

const orderedDraft = (count = orderedSteps.length) => {
  const steps = orderedSteps.slice(0, count);
  const source = steps.map(([label, detail]) => `${label} (${detail}).`).join(' Then ');
  return {
    ...sceneDraft(source),
    type: 'process',
    title: 'Sample handling',
    items: steps.map(([label, detail]) => ({
      label,
      detail,
      value: null,
      time: null,
      iconQueries: queries,
    })),
  };
};

test.each([
  false,
  true,
])('resumes deployed scene catalogs and uses the ordered catalog on new work (captioned %s)', async captioned => {
  const process = orderedDraft(2);
  const source = process.evidence;
  const journey = {
    ...process,
    type: 'journey',
    items: [],
    diagram: {
      nodes: process.items.map(({ label }, index) => ({ id: `s${index}`, label, kind: 'step' })),
      edges: [{ from: 's0', to: 's1', label: 'After collection', kind: 'event', evidence: source }],
    },
  };
  const comparisonDraft = {
    ...journey,
    type: 'comparison',
    diagram: null,
    relation: { kind: 'tradeoff', label: 'Tradeoff', evidence: source },
  };
  const comparisonChoices: boolean[] = [];
  generateStructuredOutputMock.mockImplementation(async ({ output }) => {
    const schema = z.fromJSONSchema(output.schema);
    comparisonChoices.push(schema.safeParse(comparisonDraft).success);
    return schema.safeParse(journey).success ? journey : process;
  });
  const registry = createProductionRegistry();
  const workflowId = captioned ? 'prepare-lesson-playback-block' : 'lesson-generation';
  const deployments = [12, 13, 14].map(version => {
    const frozen = workflowContracts
      .find(entry => entry.version === version)
      ?.current.find(boundary => boundary.workflowId === workflowId);
    if (!frozen) throw new Error(`Expected deployed scene contract v${version}`);
    return {
      definition: registry.resolve(workflowId, frozen.definitionHash),
      type: 'journey',
      comparison: version === 14,
    };
  });
  const playbackTarget = {
    userId: 'learner',
    projectId: 'project',
    sectionId: 'lesson',
    incarnationId: 'incarnation',
    lessonKey: 'a'.repeat(64),
    blockId: '0',
    voice: 'Kore',
    model: 'tts',
  };
  const preparePlayback: LessonPlaybackServices['preparePlayback'] = async (
    { input, signal },
    allowedSceneTypes,
    _math,
    _fenced,
    _symbols,
    _sync,
    _sections,
    supportsConceptLayout,
    allowedSceneRelationKinds,
    useOrderedSceneSelection
  ) => {
    const request = {
      ...unplannedInput(source),
      narration: source,
      signal,
      allowedSceneTypes,
      allowedSceneRelationKinds,
      supportsConceptLayout,
      useOrderedSceneSelection,
    };
    const result = await generateLessonScene(request);
    if (result.kind !== 'scene') throw new Error('Expected a captioned scene');
    const block = segmentLessonPlayback([{ type: 'markdown', markdown: source }])[0];
    return { target: input, block: { ...block, prepared: { scene: result.scene, motion: [] } } };
  };
  const input = captioned
    ? playbackTarget
    : {
        ...playbackTarget,
        contextFingerprint: 'b'.repeat(64),
        lessonMarkdown: source,
        sectionTitle: 'Sample handling',
        sectionDescription: '',
        plan: {
          slotId: 'order',
          visualType: 'lesson_scene',
          complexity: 'simple',
          title: 'Sample handling',
          interactionLevel: 'none',
          requiresDepiction: false,
          concept: 'Handling a sample',
          anchorHeading: '',
          pedagogicalGoal: 'See what happens in order',
          altText: 'Sample steps',
          visualDirection: 'Two stages',
          reason: 'Show the order',
          factualRequirements: [],
          coverage: 'complete_synthesis',
          coverageRationale: 'The two actions are enough',
        },
      };
  const checkpointStep = vi.fn<WorkflowStepRunnerStore['checkpointStep']>(async () => ({
    status: 'checkpointed',
    transientEvents: [],
  }));
  const store: WorkflowStepRunnerStore = {
    checkpointStep,
    cancellation: { releaseClaim: vi.fn() },
    recordAiUsage: vi.fn(),
    providerEffects: { getResult: vi.fn(), recordResult: vi.fn(async ({ output }) => output) },
    steps: {
      heartbeat: vi.fn(async () => ({ status: 'renewed', leaseExpiresAt: '2026-11-19T00:00:00Z' })),
      recordDefinitionUnavailable: vi.fn(),
      recordFailure: vi.fn(async () => ({ status: 'failed', transientEvents: [] })),
    },
  };
  for (const { definition, type, comparison } of [
    ...deployments,
    { definition: registry.current(workflowId), type: 'process', comparison: true },
  ]) {
    if (!definition) throw new Error('Expected the registered workflow definition');
    const nodeId = [...indexWorkflowNodes(definition)].find(
      ([, { node }]) => node.id === (captioned ? 'prepare-synchronized-block' : 'render-scene')
    )?.[0];
    if (!nodeId) throw new Error('Expected the pending scene step');
    const { maxAttempts, timeoutMs } = definition.executionDefaults;
    const claim = {
      kind: 'step' as const,
      workflowId,
      definitionHash: definition.definitionHash,
      definitionHashVersion: definition.definitionHashVersion,
      nodeDefinitionId: nodeId,
      nodeInstanceId: nodeId,
      attemptNumber: 1,
      fencingToken: '1',
      input,
      maxAttempts,
      timeoutMs,
      leaseExpiresAt: '2026-11-19T00:00:00Z',
      retryFeedback: '',
      runId: '11111111-1111-4111-8111-111111111111',
      userId: playbackTarget.userId,
      workerId: 'worker',
      stepPolicies: { [nodeId]: { config: definition.executionDefaults, maxAttempts, timeoutMs } },
      stepPoliciesVersion: 1 as const,
    };
    const result = await runWorkflowStepClaim({
      claim,
      registry,
      store,
      services: {
        preparePlayback,
        generateScene: generateLessonScene,
        now: () => '2026-11-18T00:00:00Z',
      },
    });
    expect(result.status, JSON.stringify(result)).toBe('checkpointed');
    expect(comparisonChoices.at(-1)).toBe(comparison);
    expect(checkpointStep.mock.lastCall?.[0].output).toMatchObject(
      captioned
        ? { block: { prepared: { scene: { type } } } }
        : { visual: { render: { kind: 'scene', scene: { type } } } }
    );
  }
}, 45_000);

test.each([
  2, 6, 8,
])('keeps all %i ordered stages and their icon slots, owners and results', async count => {
  const draft = orderedDraft(count);
  const input = { ...unplannedInput(draft.evidence), narration: draft.evidence };
  const items = draft.items.map(({ label, detail }) => ({ label, detail, icon: '' }));
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  expect(await generateLessonScene(input)).toMatchObject({
    kind: 'scene',
    scene: { type: 'process', items },
  });
  expect(chooseIconsMock).toHaveBeenCalledWith(
    expect.objectContaining({
      entries: items.map(({ label, detail }, item) => ({
        queries,
        slot: { item, kind: 'item' },
        text: `${label} — ${detail}`,
      })),
    })
  );
});

test('keeps the compact list and process distinct on generation and retries, with a diagram for explicit links', async () => {
  const process = orderedDraft(2);
  const source = process.evidence;
  const steps = { ...process, type: 'steps' as const };
  const journey = {
    ...process,
    type: 'journey' as const,
    items: [],
    diagram: {
      nodes: process.items.map(({ label }, index) => ({ id: `s${index}`, label, kind: 'step' })),
      edges: [{ from: 's0', to: 's1', label: 'After collection', kind: 'event', evidence: source }],
    },
  };
  const input = unplannedInput(source);
  for (const request of [
    input,
    {
      ...input,
      allowedSceneTypes: LessonSceneSchema.shape.type.options,
      retryFeedback: 'Preserve both stages.',
    },
  ]) {
    generateStructuredOutputMock.mockResolvedValueOnce(journey);
    expect(await generateLessonScene(request)).toMatchObject({
      kind: 'invalid',
      diagnostic: { errorStage: 'schema' },
    });
    const flowchart = { ...journey, type: 'flowchart' };
    generateStructuredOutputMock.mockResolvedValueOnce({ ...process, diagram: journey.diagram });
    expect(await generateLessonScene(request)).toMatchObject({
      kind: 'invalid',
      problems: [expect.stringContaining('visible connections')],
    });
    const stack = { ...process, type: 'stack' };
    for (const draft of [process, steps, flowchart, stack]) {
      generateStructuredOutputMock.mockResolvedValueOnce(draft);
      expect(await generateLessonScene(request)).toMatchObject({
        kind: 'scene',
        scene: { type: draft.type },
      });
    }
  }
  for (const legacy of [steps, journey] as const) {
    generateStructuredOutputMock.mockResolvedValueOnce(legacy);
    expect(await generateLessonScene({ ...input, allowedSceneTypes: [legacy.type] })).toMatchObject(
      {
        kind: 'scene',
        scene: { type: legacy.type },
      }
    );
  }
  generateStructuredOutputMock.mockResolvedValueOnce(journey);
  expect(
    await generateLessonScene({
      ...input,
      allowedSceneTypes: HistoricalLessonSceneSchemas[2].shape.type.options,
      supportsConceptLayout: false,
      useOrderedSceneSelection: false,
      retryFeedback: 'Keep the two stops and the transition.',
    })
  ).toMatchObject({ kind: 'scene', scene: { type: 'journey', diagram: journey.diagram } });
});

test('a long scene uses the process card while generation keeps the compact-list limit', async () => {
  const draft = { ...orderedDraft(), type: 'steps' };
  const input = unplannedInput(draft.evidence);
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  expect(await generateLessonScene(input)).toMatchObject({
    kind: 'invalid',
    problems: [expect.stringContaining('at most 6')],
  });
});

test.each([
  'process',
  'steps',
])('requests a correction when a new %s would drop timed stages', async type => {
  const draft = {
    ...orderedDraft(2),
    type,
    autoplay: true,
    steps: guidedPathScene.steps,
  };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  expect(await generateLessonScene(unplannedInput(draft.evidence))).toMatchObject({
    kind: 'invalid',
    problems: [expect.stringContaining('guided-path')],
    diagnostic: { errorStage: 'domain' },
  });
});

test('a historical steps list longer than six survives domain validation and durable decoding', () => {
  const draft = orderedDraft();
  const saved = {
    title: draft.title,
    type: 'steps',
    body: '',
    note: '',
    quote: '',
    groups: [],
    items: draft.items.map(({ label, detail }) => ({ label, detail, icon: 'check' })),
  };
  const current = LessonSceneSchema.parse(saved);
  expect(isLessonScene(current)).toBe(true);
  expect(current.items).toEqual(saved.items);
  for (const schema of HistoricalLessonSceneSchemas) expect(schema.parse(saved)).toEqual(current);
});

test('generates a two-station loop without a center and retains cycle for a frozen catalog', async () => {
  const source = 'Open for exposure, close for readout, then open for the next exposure.';
  const draft = sceneDraft(source);
  const items = [
    { ...draft.items[0], label: 'Open', detail: 'During exposure' },
    { ...draft.items[1], label: 'Close', detail: 'During readout' },
  ];
  const input = { ...unplannedInput(source), narration: source };
  const cycle = { ...draft, title: 'Shutter operation', type: 'cycle', items };
  generateStructuredOutputMock.mockResolvedValueOnce({ ...cycle, type: 'flywheel' });
  expect(await generateLessonScene(input)).toMatchObject({
    kind: 'scene',
    scene: {
      type: 'flywheel',
      items: [
        { label: 'Open', detail: 'During exposure' },
        { label: 'Close', detail: 'During readout' },
      ],
    },
  });
  generateStructuredOutputMock.mockResolvedValueOnce(cycle);
  expect(await generateLessonScene(input)).toMatchObject({
    kind: 'invalid',
    diagnostic: { errorStage: 'schema' },
  });
  generateStructuredOutputMock.mockResolvedValueOnce(cycle);
  expect(
    await generateLessonScene({ ...input, allowedSceneTypes: STATIC_LESSON_SCENE_TYPES })
  ).toMatchObject({ kind: 'scene', scene: { type: 'cycle' } });
});

test.each([
  'parts',
  'claim',
  'source',
  'counterexample',
  'limits',
  'roles',
])('excludes %s from new generation but completes a frozen request that admits it', async type => {
  const source = 'A field guide identifies the tracks by shape.';
  const input = unplannedInput(source);
  generateStructuredOutputMock.mockResolvedValue({ ...sceneDraft(source), type });
  expect(await generateLessonScene(input)).toMatchObject({
    kind: 'invalid',
    diagnostic: { errorStage: 'schema' },
  });
  expect(
    await generateLessonScene({
      ...input,
      allowedSceneTypes: STATIC_LESSON_SCENE_TYPES,
      supportsConceptLayout: false,
    })
  ).toMatchObject({ kind: 'scene', scene: { type } });
});

test('keeps an authored person and responsibility together in captioned concepts', async () => {
  const source = 'The coordinator books the room. The host welcomes guests.';
  const items = [
    { label: 'Coordinator', detail: 'Books the room' },
    { label: 'Host', detail: 'Welcomes guests' },
  ];
  generateStructuredOutputMock.mockResolvedValue({
    ...sceneDraft(source),
    type: 'concepts',
    conceptLayout: 'roles',
    items: items.map(item => ({ ...item, time: null, value: null, iconQueries: queries })),
  });
  const input = { ...unplannedInput(source), narration: source };
  expect(await generateLessonScene(input)).toMatchObject({
    kind: 'scene',
    scene: { type: 'concepts', conceptLayout: 'roles', items },
  });
  expect(await generateLessonScene({ ...input, supportsConceptLayout: false })).toMatchObject({
    kind: 'invalid',
    diagnostic: { errorStage: 'schema' },
  });
});

test('corrects a flat hierarchy to a tree with child details and still generates for a frozen catalog', async () => {
  const source = 'A telescope has a lens that gathers light and a mount that holds it steady.';
  const input = { ...unplannedInput(source), narration: source };
  const draft = sceneDraft(source);
  const children = [
    { ...draft.items[0], label: 'Lens', detail: 'Gathers light' },
    { ...draft.items[1], label: 'Mount', detail: 'Holds the telescope steady' },
  ];
  const hierarchy = { ...draft, title: 'Telescope', type: 'hierarchy', items: children };
  generateStructuredOutputMock.mockResolvedValueOnce(hierarchy);
  const rejected = await generateLessonScene(input);
  expect(rejected).toMatchObject({ kind: 'invalid', diagnostic: { errorStage: 'schema' } });
  expect(chooseIconsMock).not.toHaveBeenCalled();
  if (rejected.kind !== 'invalid') throw new Error('Expected a prompt correction');

  const root = { ...draft.items[0], id: 'telescope', label: 'Telescope', detail: '' };
  const branches = children.map(item => ({ ...item, id: item.label, parent: root.id }));
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...hierarchy,
    type: 'tree',
    items: [root, ...branches],
  });
  expect(
    await generateLessonScene({ ...input, retryFeedback: rejected.problems.join('\n') })
  ).toMatchObject({
    kind: 'scene',
    scene: {
      type: 'tree',
      items: [
        { id: 'telescope', label: 'Telescope' },
        { parent: 'telescope', label: 'Lens', detail: 'Gathers light' },
        { parent: 'telescope', label: 'Mount', detail: 'Holds the telescope steady' },
      ],
    },
  });

  generateStructuredOutputMock.mockResolvedValueOnce(hierarchy);
  expect(
    await generateLessonScene({ ...input, allowedSceneTypes: STATIC_LESSON_SCENE_TYPES })
  ).toMatchObject({
    kind: 'scene',
    scene: {
      type: 'hierarchy',
      items: [
        { label: 'Lens', detail: 'Gathers light' },
        { label: 'Mount', detail: 'Holds the telescope steady' },
      ],
    },
  });
});

test('generates both limits without offering a qualitative gradient, including on resume', async () => {
  const interpretations = [
    { label: 'Holes in a leaf', detail: 'They show damage.' },
    { label: 'Cause of damage', detail: 'Identifying the insect requires another observation.' },
  ];
  const source = interpretations.map(item => item.detail).join(' ');
  const draft = {
    ...sceneDraft(source),
    title: 'Reading leaf damage',
    items: interpretations.map(item => ({
      ...item,
      value: null,
      time: null,
      iconQueries: queries,
    })),
  };
  const continuum = { ...draft, type: 'continuum' };
  const input = unplannedInput(source);
  for (const request of [
    { ...input, supportsConceptLayout: true },
    { ...input, allowedSceneTypes: LessonSceneSchema.shape.type.options },
    {
      ...input,
      allowedSceneTypes: STATIC_LESSON_SCENE_TYPES,
      narration: source,
      supportsConceptLayout: false,
    },
  ]) {
    generateStructuredOutputMock.mockResolvedValueOnce(continuum);
    expect(await generateLessonScene(request)).toMatchObject({
      kind: 'invalid',
      diagnostic: { errorStage: 'schema' },
    });
    const { output } = generateStructuredOutputMock.mock.calls.at(-1)?.[0] ?? {};
    const schema = z.fromJSONSchema(output.schema);
    expect(schema.safeParse(continuum).success).toBe(false);
    const type = request.supportsConceptLayout === false ? 'limits' : 'concepts';
    generateStructuredOutputMock.mockResolvedValueOnce({ ...draft, type });
    expect(await generateLessonScene(request)).toMatchObject({
      kind: 'scene',
      scene: { type, items: interpretations },
    });
  }
});

test('generates a numeric interval with its bounds and estimate intact', async () => {
  const source =
    'The walk takes about 20 minutes, with a lower bound of 15 and an upper bound of 25.';
  const points = [
    { label: 'Minimum', value: 15 },
    { label: 'Estimate', value: 20 },
    { label: 'Maximum', value: 25 },
  ];
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...sceneDraft(source),
    title: 'Walking time',
    type: 'interval',
    unit: 'minutes',
    items: points.map(point => ({ ...point, detail: '', time: null, iconQueries: queries })),
  });
  expect(await generateLessonScene(unplannedInput(source))).toMatchObject({
    kind: 'scene',
    scene: { type: 'interval', unit: 'minutes', items: points },
  });
});

test('current and frozen workflow contracts can still read a saved continuum', () => {
  const saved = {
    title: 'Reading leaf damage',
    type: 'continuum',
    body: '',
    quote: '',
    note: '',
    groups: [],
    items: [
      { label: 'Damage', detail: 'The leaf has holes.', icon: '' },
      { label: 'Cause', detail: 'Observe the insect separately.', icon: '' },
    ],
  };
  expect(isLessonScene(saved)).toBe(true);
  for (const schema of [LessonSceneSchema, ...HistoricalLessonSceneSchemas]) {
    expect(schema.parse(saved)).toEqual(saved);
    expect(schema.safeParse({ ...saved, type: 'limits' }).success).toBe(true);
  }
});
test.each([
  'quote',
  'definition',
])('rejects retired %s output at the provider boundary', async type => {
  const source = 'Il client trova il controller tramite DNS.';
  const draft = sceneDraft(source);
  const retired = {
    ...draft,
    type,
    items: type === 'quote' ? [] : draft.items,
    quote: type === 'quote' ? source : '',
  };
  generateStructuredOutputMock.mockResolvedValueOnce(retired);
  expect(await generateLessonScene(unplannedInput(source))).toMatchObject({ kind: 'invalid' });
  const schema = z.fromJSONSchema(generateStructuredOutputMock.mock.calls[0][0].output.schema);
  expect(schema.safeParse(retired).success).toBe(false);
  generateStructuredOutputMock.mockResolvedValueOnce(sceneDraft(source));
  expect(await generateLessonScene(unplannedInput(source))).toMatchObject({
    kind: 'scene',
    scene: {
      type: 'concepts',
      items: [
        { label: 'Fonte', detail: source },
        { label: 'Riscontri', detail: '' },
      ],
    },
  });
});

test.each([
  'body',
  'note',
] as const)('rejects %s prose in captioned generation while preserving standalone scenes', async field => {
  const source = 'Il client invia una richiesta. Il server restituisce una risposta.';
  const draft = {
    ...sceneDraft(source),
    items: sceneDraft(source).items.map(item => ({ ...item, detail: '' })),
    [field]: source,
  };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  expect(await generateLessonScene(unplannedInput(source))).toMatchObject({ kind: 'scene' });
  const captioned = { ...unplannedInput(source), narration: source };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  expect(await generateLessonScene(captioned)).toMatchObject({ kind: 'invalid' });
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...sceneDraft(source),
    items: sceneDraft(source).items.map(item => ({ ...item, detail: '' })),
  });
  expect(await generateLessonScene(captioned)).toMatchObject({
    kind: 'scene',
    scene: { body: '', note: '' },
  });
});

test.each([
  { type: 'parts', supportsConceptLayout: false },
  { type: 'concepts', supportsConceptLayout: false },
] as const)('rejects glossary descriptions in captioned $type while retaining standalone details', async ({
  supportsConceptLayout,
  ...form
}) => {
  const source = 'Input and output are the two parts of the system.';
  const draft = { ...sceneDraft(source), ...form };
  const request = { ...unplannedInput(source), supportsConceptLayout };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  expect(await generateLessonScene(request)).toMatchObject({
    kind: 'scene',
    scene: {
      items: [
        { label: 'Fonte', detail: source },
        { label: 'Riscontri', detail: '' },
      ],
    },
  });
  const captioned = { ...request, narration: source };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  expect(await generateLessonScene(captioned)).toMatchObject({ kind: 'invalid' });
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...draft,
    items: draft.items.map(item => ({ ...item, detail: '' })),
  });
  expect(await generateLessonScene(captioned)).toMatchObject({
    kind: 'scene',
    scene: {
      ...form,
      items: [
        { label: 'Fonte', detail: '' },
        { label: 'Riscontri', detail: '' },
      ],
    },
  });
});

test('keeps item-specific details in a captioned adaptive grid', async () => {
  const source = 'Use a thermometer to measure temperature and a gauge to collect rainfall.';
  const items = [
    { label: 'Thermometer', detail: 'Air temperature' },
    { label: 'Rain gauge', detail: 'Rainfall collected' },
  ];
  generateStructuredOutputMock.mockResolvedValue({
    ...sceneDraft(source),
    conceptLayout: 'grid',
    items: items.map(item => ({ ...item, time: null, value: null, iconQueries: queries })),
  });
  expect(await generateLessonScene({ ...unplannedInput(source), narration: source })).toMatchObject(
    {
      kind: 'scene',
      scene: { type: 'concepts', conceptLayout: 'grid', items },
    }
  );
});

test('reserves boundary for a named inside and outside while a single scope uses concepts', async () => {
  const source = 'Members may borrow books. Visitors may only read them on site.';
  const input = unplannedInput(source);
  const singleScope = { ...sceneDraft(source), type: 'boundary' };
  generateStructuredOutputMock.mockResolvedValueOnce(singleScope);
  expect(await generateLessonScene(input)).toMatchObject({ kind: 'invalid' });
  generateStructuredOutputMock.mockResolvedValueOnce({ ...singleScope, type: 'concepts' });
  expect(await generateLessonScene(input)).toMatchObject({ kind: 'scene' });

  const groups = [
    { label: 'Members', items: ['Borrow books'] },
    { label: 'Visitors', items: ['Read on site'] },
  ];
  const groupDraft = {
    ...singleScope,
    title: 'Library membership',
    items: [],
    groups: groups.map(group => ({ ...group, iconQueries: [queries], verdict: 'none' })),
  };
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...groupDraft,
    groups: [
      { ...groupDraft.groups[0], label: 'Books' },
      { ...groupDraft.groups[1], label: 'Opening hours' },
    ],
  });
  expect(await generateLessonScene(input)).toMatchObject({ kind: 'invalid' });

  const [first, second] = groupDraft.groups;
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...groupDraft,
    groups: [
      { ...first, scopeSide: 'outside' },
      { ...second, scopeSide: 'inside' },
    ],
  });
  expect(await generateLessonScene(input)).toMatchObject({ kind: 'invalid' });

  generateStructuredOutputMock.mockResolvedValueOnce({
    ...groupDraft,
    scopeEvidence: source,
    groups: [
      { ...first, scopeSide: 'inside' },
      { ...second, scopeSide: 'outside' },
    ],
  });
  const scoped = await generateLessonScene(input);
  expect(scoped).toMatchObject({
    kind: 'scene',
    scene: { type: 'boundary', title: 'Library membership', groups },
  });
  expect(scoped).not.toHaveProperty('scene.scopeEvidence');
});

test('asks for a plain list when boundary markers have no quote for a shared scope', async () => {
  const source = 'The library has books on two floors. It opens at nine.';
  const draft = {
    ...sceneDraft(source),
    type: 'boundary',
    title: 'Library',
    items: [],
    groups: [
      {
        label: 'Books',
        items: ['On two floors'],
        iconQueries: [queries],
        verdict: 'none',
        scopeSide: 'inside',
      },
      {
        label: 'Hours',
        items: ['Opens at nine'],
        iconQueries: [queries],
        verdict: 'none',
        scopeSide: 'outside',
      },
    ],
  };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  const input = unplannedInput(source);
  const rejected = await generateLessonScene(input);
  expect(rejected).toMatchObject({
    kind: 'invalid',
    diagnostic: { errorStage: 'domain' },
    problems: [expect.stringContaining('plain concepts list')],
  });
  expect(chooseIconsMock).not.toHaveBeenCalled();
  if (rejected.kind !== 'invalid') throw new Error('Expected corrective feedback.');

  generateStructuredOutputMock.mockResolvedValueOnce({
    ...draft,
    scopeEvidence: 'Opening hours are outside the reading area.',
  });
  expect(await generateLessonScene(input)).toMatchObject({
    kind: 'invalid',
    diagnostic: { errorStage: 'domain' },
  });

  const items = [
    { label: 'Books', detail: 'On two floors', value: null, time: null, iconQueries: queries },
    { label: 'Hours', detail: 'Opens at nine', value: null, time: null, iconQueries: queries },
  ];
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...draft,
    type: 'concepts',
    groups: [],
    items,
  });
  expect(
    await generateLessonScene({ ...input, retryFeedback: rejected.problems.join('\n') })
  ).toMatchObject({
    kind: 'scene',
    scene: {
      type: 'concepts',
      groups: [],
      items: items.map(({ label, detail }) => ({ label, detail })),
    },
  });
  expect(generateStructuredOutputMock.mock.calls.at(-1)?.[0].prompt).toContain(
    'plain concepts list'
  );
});

test('offers a list-only boundary in the frozen generation catalog', async () => {
  const source = 'The pass covers local trains and city buses.';
  const draft = {
    ...sceneDraft(source),
    type: 'boundary',
    title: 'Pass coverage',
    items: ['Local trains', 'City buses'].map(label => ({
      label,
      detail: '',
      value: null,
      time: null,
      iconQueries: queries,
    })),
  };
  const input = {
    ...unplannedInput(source),
    allowedSceneTypes: ['boundary'] as const,
    supportsConceptLayout: false,
  };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  expect(await generateLessonScene(input)).toMatchObject({
    kind: 'scene',
    scene: {
      type: 'boundary',
      title: 'Pass coverage',
      items: [{ label: 'Local trains' }, { label: 'City buses' }],
    },
  });

  const request = generateStructuredOutputMock.mock.calls[0][0];
  expect(request.system.split('\nCATALOG\n')[1]).toContain(
    '- boundary: Name a scope and list at least two items it contains.'
  );
  expect(request.output.schema.properties).not.toHaveProperty('scopeEvidence');

  generateStructuredOutputMock.mockResolvedValueOnce({
    ...draft,
    items: [],
    groups: [
      { label: 'Trains', items: ['Local trains'], iconQueries: [queries], verdict: 'none' },
      { label: 'Buses', items: ['City buses'], iconQueries: [queries], verdict: 'none' },
    ],
  });
  expect(await generateLessonScene(input)).toMatchObject({ kind: 'invalid' });
});

test.each([
  String.raw`La relazione \(x^2\) costa \$5.`,
  String.raw`La relazione è \[x^2\].`,
])('preserves explicit math delimiters through structured scene generation: %s', async source => {
  generateStructuredOutputMock.mockResolvedValueOnce(
    JSON.parse(JSON.stringify(sceneDraft(source)))
  );
  expect(await generateLessonScene(unplannedInput(source))).toMatchObject({
    kind: 'scene',
    scene: { type: 'concepts', items: [{ detail: source }, { detail: '' }] },
  });
});

test('exposes a valid scene to independent preparation before icons and keeps invalid drafts private', async () => {
  const onValidatedScene = vi.fn();
  generateStructuredOutputMock.mockResolvedValueOnce(sceneDraft('Una domanda precisa.'));
  chooseIconsMock.mockImplementationOnce(async ({ scene }) => {
    expect(onValidatedScene).toHaveBeenCalledWith(scene);
    return scene;
  });
  expect(
    await generateLessonScene({ ...unplannedInput('Una domanda precisa.'), onValidatedScene })
  ).toMatchObject({ kind: 'scene' });
  onValidatedScene.mockClear();
  generateStructuredOutputMock.mockResolvedValueOnce(sceneDraft('Citazione estranea.'));
  expect(
    await generateLessonScene({ ...unplannedInput('Una domanda precisa.'), onValidatedScene })
  ).toMatchObject({ kind: 'invalid' });
  expect(onValidatedScene).not.toHaveBeenCalled();
});

test('generation honors the catalog admitted by a resumed static-scene workflow', async () => {
  const speech = proportionalScene.body;
  const draft = { ...sceneDraft(''), ...proportionalScene, intent: 'Contare.', evidence: speech };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  const input = {
    ...unplannedInput(speech),
    allowedSceneTypes: STATIC_LESSON_SCENE_TYPES,
    supportsConceptLayout: false,
  };
  expect(await generateLessonScene(input)).toMatchObject({ kind: 'invalid' });
  const request = generateStructuredOutputMock.mock.calls[0][0];
  const schema = z.fromJSONSchema(request.output.schema);
  expect(schema.safeParse(draft).success).toBe(false);
  const staticDraft = {
    ...sceneDraft(speech),
    type: 'parts',
    evidence: speech,
    intent: 'Leggere.',
  };
  expect(schema.safeParse(staticDraft).success).toBe(true);
  generateStructuredOutputMock.mockResolvedValueOnce(staticDraft);
  expect(await generateLessonScene(input)).toMatchObject({
    kind: 'scene',
    scene: { type: 'parts' },
  });
});

test.each([
  proportionalScene,
  guidedPathScene,
])('generates $type through the advertised data schema', async scene => {
  const speech =
    scene.narration ?? `${scene.body} Da 1 a 6 repliche, inizialmente 2, 128 MB ciascuna.`;
  const { items: _items, groups: _groups, ...data } = scene;
  const draft = {
    ...sceneDraft(''),
    ...data,
    intent: 'Seguire la visualizzazione.',
    evidence: speech,
    items: [],
    groups: [],
  };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  expect(await generateLessonScene(unplannedInput(speech))).toEqual({ kind: 'scene', scene });
  const request = generateStructuredOutputMock.mock.calls[0][0];
  const schema = z.fromJSONSchema(request.output.schema);
  expect(schema.safeParse(draft).success).toBe(true);
  expect(schema.safeParse({ ...draft, script: 'quantity * amountPerUnit' }).success).toBe(false);
  expect(chooseIconsMock.mock.calls[0][0].entries).toEqual([]);
});

test.each([
  proportionalScene,
  guidedPathScene,
])('rejects disabled autoplay in generated $type scenes', async scene => {
  const speech = scene.narration ?? 'Da 1 a 6 repliche, inizialmente 2, 128 MB ciascuna.';
  generateStructuredOutputMock.mockResolvedValue({
    ...sceneDraft(''),
    ...scene,
    autoplay: false,
    intent: 'Seguire.',
    evidence: speech,
  });
  expect(await generateLessonScene(unplannedInput(speech))).toMatchObject({ kind: 'invalid' });
  expect(chooseIconsMock).not.toHaveBeenCalled();
});

test('rejects invented per-unit amounts even with exact evidence', async () => {
  const speech = 'Da 1 a 6 repliche, inizialmente 2, 128 MB ciascuna.';
  generateStructuredOutputMock.mockResolvedValue({
    ...sceneDraft(''),
    ...proportionalScene,
    amountPerUnit: 256,
    intent: 'Contare.',
    evidence: speech,
  });
  expect(await generateLessonScene(unplannedInput(speech))).toMatchObject({ kind: 'invalid' });
  expect(chooseIconsMock).not.toHaveBeenCalled();
});

test.each([
  1, 2, 8, 9,
])('advertises and enforces the guided-path boundary for %i steps', async count => {
  const speech = 'The path follows these steps.';
  const draft = {
    ...sceneDraft(''),
    ...guidedPathScene,
    narration: undefined,
    evidence: speech,
    intent: 'Follow.',
    steps: Array.from({ length: count }, (_, index) => ({
      label: `Step ${index}`,
      detail: `Detail ${index}`,
    })),
  };
  generateStructuredOutputMock.mockResolvedValue(draft);
  const result = await generateLessonScene(unplannedInput(speech));
  const schema = z.fromJSONSchema(generateStructuredOutputMock.mock.calls[0][0].output.schema);
  const valid = count >= 2 && count <= 8;
  expect(schema.safeParse(draft).success).toBe(valid);
  expect(result.kind).toBe(valid ? 'scene' : 'invalid');
});

test('generates proportional quantities beyond the replica display limit', async () => {
  const scene = { ...proportionalScene, max: 1000000 };
  const speech = '1 to 1000000 units, initially 2, each requiring 128 MB.';
  const draft = { ...sceneDraft(''), ...scene, evidence: speech, intent: 'Count.' };
  generateStructuredOutputMock.mockResolvedValue(draft);
  expect(await generateLessonScene(unplannedInput(speech))).toEqual({ kind: 'scene', scene });
  expect(
    z.fromJSONSchema(generateStructuredOutputMock.mock.calls[0][0].output.schema).safeParse(draft)
      .success
  ).toBe(true);
});

test('generates a validated scene from speech without a visual plan', async () => {
  const speech = 'Quali fonti sostengono la tesi?';
  generateStructuredOutputMock.mockResolvedValueOnce(sceneDraft(speech));
  await expect(generateLessonScene(unplannedInput(speech))).resolves.toMatchObject({
    kind: 'scene',
    scene: {
      type: 'concepts',
      items: [
        { label: 'Fonte', detail: speech },
        { label: 'Riscontri', detail: '' },
      ],
    },
  });
});

test.each([
  false,
  true,
])('preserves independent computations after rejecting a disconnected diagram (planned: %s)', async planned => {
  const computations = [
    { label: 'Somma', detail: '2 + 3 = 5' },
    { label: 'Prodotto', detail: '4 × 6 = 24' },
  ];
  const lesson = 'Due calcoli indipendenti: la somma 2 + 3 = 5 e il prodotto 4 × 6 = 24.';
  const input = {
    ...unplannedInput(lesson),
    ...(planned
      ? {
          plan: {
            anchorHeading: '',
            complexity: 'simple' as const,
            concept: 'Due calcoli indipendenti',
            factualRequirements: computations.map(item => item.detail),
            coverage: 'all_elements' as const,
            coverageRationale: 'Ogni calcolo è indipendente e necessario.',
            interactionLevel: 'none' as const,
            pedagogicalGoal: 'Mostrare entrambi i calcoli.',
            title: 'Calcoli indipendenti',
            reason: 'Affiancare i due calcoli.',
            requiresDepiction: false,
            slotId: 'independent-computations',
            visualDirection: 'Un diagramma dei due calcoli.',
            visualType: 'lesson_scene' as const,
          },
        }
      : {}),
  };
  const draft = {
    ...sceneDraft(''),
    evidence: lesson,
    intent: 'Leggere entrambi i calcoli indipendenti.',
    title: 'Calcoli indipendenti',
  };
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...draft,
    type: 'flowchart',
    diagram: {
      nodes: computations.flatMap((item, index) => [
        { id: `input-${index}`, kind: 'step', label: item.label },
        { id: `result-${index}`, kind: 'end', label: item.detail },
      ]),
      edges: computations.map((item, index) => ({
        from: `input-${index}`,
        to: `result-${index}`,
        label: '',
        kind: 'call',
        evidence: item.detail,
      })),
    },
  });
  const rejected = await generateLessonScene(input);
  expect(rejected.kind).toBe('invalid');
  if (rejected.kind !== 'invalid') throw new Error('Expected a disconnected diagram rejection');
  expect(chooseIconsMock).not.toHaveBeenCalled();

  generateStructuredOutputMock.mockResolvedValueOnce({
    ...draft,
    type: 'concepts',
    conceptLayout: 'grid',
    items: computations.map(item => ({ ...item, time: null, value: null, iconQueries: queries })),
  });
  const result = await generateLessonScene({
    ...input,
    retryFeedback: rejected.problems.join('\n'),
  });
  expect(result.kind).toBe('scene');
  if (result.kind !== 'scene') throw new Error('Expected a non-graph scene');
  expect(result.scene).toMatchObject({ type: 'concepts', conceptLayout: 'grid' });
  expect(result.scene.items).toEqual(computations.map(item => ({ ...item, icon: '' })));
  expect(result.scene.diagram).toBeUndefined();
  expect(isLessonScene(result.scene)).toBe(true);
  expect(chooseIconsMock.mock.calls[0][0].entries).toHaveLength(computations.length);
});

test('validates against the excerpt actually sent, not the unseen tail of a long lesson', async () => {
  const unseenQuote = 'Quali fonti sostengono la tesi?';
  const input = unplannedInput(`${'x'.repeat(MAX_VISUAL_LESSON_CHARS)}${unseenQuote}`);
  generateStructuredOutputMock.mockResolvedValueOnce(sceneDraft(unseenQuote));
  const result = await generateLessonScene(input);
  expect(result).toMatchObject({ kind: 'invalid' });
  expect(chooseIconsMock).not.toHaveBeenCalled();
});

test.each([
  { kind: 'scene', note: '', quote: '' },
  { kind: 'scene', note: '', quote: 'la competenza è pertinente' },
  { kind: 'scene', note: 'La pertinenza dipende dalla richiesta.', quote: '' },
  {
    kind: 'invalid',
    note: 'La pertinenza dipende dalla richiesta.',
    quote: 'la competenza è pertinente',
  },
])('validates closing text before choosing icons: $kind', async ({ kind, note, quote }) => {
  generateStructuredOutputMock.mockResolvedValueOnce({
    body: '',
    criteria: [],
    diagram: null,
    evidence: 'la competenza è pertinente',
    groups: [],
    intent: 'Riconoscere i controlli da fare.',
    items: [
      { detail: '', iconQueries: queries, label: 'Pertinenza', time: null, value: null },
      { detail: '', iconQueries: queries, label: 'Riscontri', time: null, value: null },
    ],
    note,
    quote,
    relation: null,
    title: 'Valutare una fonte',
    type: 'checklist',
  });

  const outcome = await generateLessonScene({
    config: { artifact: { model: 'gpt-6-luna', provider: 'codex', reasoningEffort: 'low' } },
    lessonMarkdown: 'Una fonte è credibile quando la competenza è pertinente.',
    plan: { concept: 'Controlli', factualRequirements: [], visualType: 'lesson_scene' },
    sectionDescription: '',
    sectionTitle: 'Fonti',
    signal: new AbortController().signal,
  } as never);

  expect(outcome.kind).toBe(kind);
  expect(chooseIconsMock).toHaveBeenCalledTimes(kind === 'scene' ? 1 : 0);
  if (kind === 'invalid') {
    expect(outcome).toEqual({
      kind: 'invalid',
      diagnostic: expect.objectContaining({ type: 'Error' }),
      problems: [
        'Use either an essential closing question or a necessary note, or leave both empty.',
      ],
    });
  } else {
    expect(outcome).toMatchObject({ scene: { note, quote } });
  }
});

test('generates scenes on the provider resolved for the run, with grounded content', async () => {
  generateStructuredOutputMock.mockResolvedValueOnce({
    body: '',
    criteria: [],
    diagram: null,
    evidence: 'la competenza è pertinente',
    groups: [],
    intent: 'Riconoscere i controlli da fare.',
    items: [
      { detail: '', iconQueries: queries, label: 'Pertinenza', time: null, value: null },
      { detail: '', iconQueries: queries, label: 'Riscontri', time: null, value: null },
    ],
    note: '',
    quote: '',
    relation: null,
    title: 'Valutare una fonte',
    type: 'checklist',
  });

  const outcome = await generateLessonScene({
    config: { artifact: { model: 'gpt-6-luna', provider: 'codex', reasoningEffort: 'low' } },
    lessonMarkdown: 'Una fonte è credibile quando la competenza è pertinente.',
    plan: { concept: 'Controlli', factualRequirements: [], visualType: 'lesson_scene' },
    sectionDescription: '',
    sectionTitle: 'Fonti',
    signal: new AbortController().signal,
  } as never);

  expect(outcome).toMatchObject({ kind: 'scene', scene: { type: 'checklist' } });
  expect(generateStructuredOutputMock.mock.calls[0]?.[0]).toMatchObject({
    config: { aiProvider: 'codex' },
    slot: 'scene',
  });
  expect(chooseIconsMock.mock.calls[0]?.[0].config.aiProvider).toBe('codex');
});

test('grounds support quotations across source whitespace without changing scene text', async () => {
  const speech = 'The client sends a request;\nthe server returns a response.';
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...sceneDraft(speech),
    evidence: 'The client sends a request; the server returns a response.',
  });
  expect(await generateLessonScene(unplannedInput(speech))).toMatchObject({
    kind: 'scene',
    scene: {
      items: [
        { label: 'Fonte', detail: speech },
        { label: 'Riscontri', detail: '' },
      ],
    },
  });
});

test('reports ungrounded evidence as contract problems instead of a scene', async () => {
  generateStructuredOutputMock.mockResolvedValueOnce({
    body: '',
    criteria: [],
    diagram: null,
    evidence: 'una frase che la lezione non contiene',
    groups: [],
    intent: 'Riconoscere i controlli da fare.',
    items: [
      { detail: '', iconQueries: queries, label: 'Pertinenza', time: null, value: null },
      { detail: '', iconQueries: queries, label: 'Riscontri', time: null, value: null },
    ],
    note: '',
    quote: '',
    relation: null,
    title: 'Valutare una fonte',
    type: 'checklist',
  });

  await expect(
    generateLessonScene({
      config: {
        artifact: { model: 'openai/gpt-6-luna', provider: 'openrouter', reasoningEffort: 'low' },
      },
      lessonMarkdown: 'Una fonte è credibile quando la competenza è pertinente.',
      plan: { concept: 'Controlli', factualRequirements: [], visualType: 'lesson_scene' },
      sectionDescription: '',
      sectionTitle: 'Fonti',
      signal: new AbortController().signal,
    } as never)
  ).resolves.toEqual({
    kind: 'invalid',
    diagnostic: expect.objectContaining({ type: 'Error' }),
    problems: ['evidence must be an exact quotation from the lesson.'],
  });
});

test('reports a malformed answer as a contract problem instead of throwing', async () => {
  generateStructuredOutputMock.mockResolvedValueOnce({
    title: 'Valutare una fonte',
    type: 'matrix',
  });

  await expect(
    generateLessonScene({
      config: { artifact: { model: 'gpt-6-luna', provider: 'codex', reasoningEffort: 'low' } },
      lessonMarkdown: 'Una fonte è credibile quando la competenza è pertinente.',
      plan: { concept: 'Controlli', factualRequirements: [], visualType: 'lesson_scene' },
      sectionDescription: '',
      sectionTitle: 'Fonti',
      signal: new AbortController().signal,
    } as never)
  ).resolves.toEqual({
    kind: 'invalid',
    diagnostic: expect.objectContaining({ type: 'Error' }),
    problems: ['The answer must follow the requested JSON structure.'],
  });
});

test('reports an unparsable answer as a contract problem', async () => {
  generateStructuredOutputMock.mockRejectedValueOnce(
    new SyntaxError('Unexpected end of JSON input')
  );

  await expect(
    generateLessonScene({
      config: { artifact: { model: 'gpt-6-luna', provider: 'codex', reasoningEffort: 'low' } },
      lessonMarkdown: 'Una fonte è credibile quando la competenza è pertinente.',
      plan: { concept: 'Controlli', factualRequirements: [], visualType: 'lesson_scene' },
      sectionDescription: '',
      sectionTitle: 'Fonti',
      signal: new AbortController().signal,
    } as never)
  ).resolves.toEqual({
    kind: 'invalid',
    diagnostic: expect.objectContaining({ type: 'Error' }),
    problems: ['The answer must follow the requested JSON structure.'],
  });
});

test.each([
  proportionalScene,
  guidedPathScene,
])('rejects model-authored durations for $type', async scene => {
  const speech = scene.narration ?? '1 2 6 128';
  const draft = { ...sceneDraft(''), ...scene, evidence: speech, durationMs: 3600000 };
  generateStructuredOutputMock.mockResolvedValue(draft);
  expect(await generateLessonScene(unplannedInput(speech))).toMatchObject({ kind: 'invalid' });
  const schema = z.fromJSONSchema(generateStructuredOutputMock.mock.calls[0][0].output.schema);
  expect(schema.safeParse(draft).success).toBe(false);
  expect(chooseIconsMock).not.toHaveBeenCalled();
});

test('generation requires supplied narration to preserve source grounding and all stored anchors', async () => {
  const speech = guidedPathScene.narration as string;
  const draft = { ...sceneDraft(''), ...guidedPathScene, evidence: speech };
  for (const narration of [speech.split('.')[0], speech.replace('l’API', 'il controllo')]) {
    generateStructuredOutputMock.mockResolvedValue({ ...draft, narration });
    expect(await generateLessonScene(unplannedInput(speech))).toMatchObject({ kind: 'invalid' });
  }
  expect(chooseIconsMock).not.toHaveBeenCalled();
  generateStructuredOutputMock.mockResolvedValue(draft);
  const result = await generateLessonScene(unplannedInput(speech));
  expect(result.kind).toBe('scene');
  if (result.kind !== 'scene') throw new Error('Expected a generated scene');
  expect(isLessonScene(result.scene)).toBe(true);
});

test.each([
  ...LAB_QUICK_SCENES,
  LAB_COMPOSITION_SCENE,
])('generates the lab $type fields and all icon slots', async example => {
  const source = `${LAB_COMPOSITION_SOURCE}\nExample data: ${JSON.stringify(example, null, 2)}`;
  const { items, groups, ...fields } = example;
  const {
    icon: centerIcon,
    panels,
    ...content
  } = fields as typeof fields & { icon?: string; panels?: typeof LAB_COMPOSITION_SCENE.panels };
  const draft = {
    ...sceneDraft(''),
    ...content,
    ...(example.type === 'proportional-static'
      ? { type: 'proportional', variant: example.type }
      : {}),
    intent: 'Understand the example.',
    evidence: LAB_COMPOSITION_SOURCE,
    items: items.map(item => {
      const { icon: _icon, ...data } = item;
      return {
        ...data,
        value: 'value' in item ? item.value : null,
        time: null,
        iconQueries: queries,
      };
    }),
    groups: groups.map(group => {
      const { icons: _icons, icon, ...data } = group as typeof group & { icon?: string };
      return {
        ...data,
        verdict: 'none',
        iconQueries: group.items.map(() => queries),
        ...(icon ? { groupIconQueries: queries } : {}),
      };
    }),
    ...(centerIcon ? { iconQueries: queries } : {}),
    ...(panels
      ? {
          panels: panels.map(panel => ({
            ...panel,
            items: panel.items.map(({ icon: _icon, ...item }) => ({
              ...item,
              iconQueries: queries,
            })),
          })),
        }
      : {}),
  };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  const result = await generateLessonScene(unplannedInput(source));
  expect(result.kind).toBe('scene');
  if (result.kind !== 'scene') throw new Error(JSON.stringify(result.problems));
  const withoutIcons = (scene: typeof result.scene) => ({
    ...scene,
    ...(scene.icon !== undefined ? { icon: '' } : {}),
    items: scene.items.map(item => ({ ...item, icon: '' })),
    groups: scene.groups.map(group => ({
      ...group,
      icons: group.icons.map(() => ''),
      ...(group.icon !== undefined ? { icon: '' } : {}),
    })),
    ...(scene.panels
      ? {
          panels: scene.panels.map(panel => ({
            ...panel,
            items: panel.items.map(item => ({ ...item, icon: '' })),
          })),
        }
      : {}),
  });
  expect(result.scene).toEqual(withoutIcons(example));
  const expectedSlots = [
    ...items.map((_, item) => ({ kind: 'item', item })),
    ...groups.flatMap((group, groupIndex) =>
      group.items.map((_, entry) => ({ kind: 'group', group: groupIndex, entry }))
    ),
    ...groups.flatMap((group, groupIndex) =>
      'icon' in group ? [{ kind: 'group-icon', group: groupIndex }] : []
    ),
    ...(centerIcon ? [{ kind: 'center' }] : []),
    ...(panels ?? []).flatMap((panel, panelIndex) =>
      panel.items.map((_, item) => ({ kind: 'panel', panel: panelIndex, item }))
    ),
  ];
  expect(
    chooseIconsMock.mock.calls[0][0].entries.map((entry: { slot: unknown }) => entry.slot)
  ).toEqual(expectedSlots);
  const schema = z.fromJSONSchema(generateStructuredOutputMock.mock.calls[0][0].output.schema);
  expect(schema.safeParse(draft).success).toBe(true);
});

test('rejects invented quantitative quick data before icon selection', async () => {
  const source =
    'Chiarezza 4, copertura 3, verifica 5 e tracciabilità 4, su un massimo di 5 punti.';
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...sceneDraft(''),
    type: 'radar',
    title: 'Criteri',
    evidence: source,
    max: 5,
    unit: 'punti',
    items: [2, 3, 5, 4].map(value => ({
      label: 'Criterio',
      detail: '',
      value,
      time: null,
      iconQueries: queries,
    })),
  });
  expect(await generateLessonScene(unplannedInput(source))).toEqual({
    kind: 'invalid',
    diagnostic: expect.objectContaining({ type: 'Error' }),
    problems: ['Quantitative values must appear in the lesson.'],
  });
  expect(chooseIconsMock).not.toHaveBeenCalled();
});

test.each([
  undefined,
  '   ',
])('ignores center icon queries without a named center %#', async center => {
  const source = 'Una domanda esatta.';
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...sceneDraft(source),
    center,
    iconQueries: queries,
  });
  const result = await generateLessonScene(unplannedInput(source));
  expect(result.kind).toBe('scene');
  if (result.kind !== 'scene') throw new Error('Expected a generated scene');
  expect(result.scene).not.toHaveProperty('icon');
  expect(chooseIconsMock.mock.calls[0][0].entries.map(entry => entry.slot.kind)).toEqual([
    'item',
    'item',
  ]);
});

test('reports schema paths and transport without retaining unknown model fields', async () => {
  generateStructuredOutputMock.mockImplementation(async request => {
    request.onOutputPath?.('json-envelope');
    return {
      ...sceneDraft('Source sentence.'),
      private_unexpected_field: 'private course content',
    };
  });
  const outcome = await generateLessonScene(unplannedInput('Source sentence.'));
  expect(outcome).toMatchObject({ kind: 'invalid' });
  if (outcome.kind !== 'invalid') throw new Error('Expected invalid scene');
  expect(JSON.parse(String(outcome.diagnostic?.originalMessage))).toEqual({
    outputPath: 'json-envelope',
    stage: 'schema',
    problems: [{ code: 'unrecognized_keys', path: [] }],
  });
  expect(JSON.stringify(outcome.diagnostic)).not.toContain('private');
});

test.each([
  { name: 'empty', source: 'A client sends a request.', evidence: '  ', outcome: 'empty' },
  {
    name: 'controlled paraphrase',
    source: 'A client sends a request.',
    evidence: 'The client issues a request.',
    outcome: 'absent',
  },
  {
    name: 'controlled Markdown representation mismatch',
    source: 'A **client** sends a request.',
    evidence: 'A client sends a request.',
    outcome: 'representation-mismatch',
  },
  {
    name: 'controlled math delimiter mismatch',
    source: 'The value is $x=1$.',
    evidence: 'The value is x=1.',
    outcome: 'representation-mismatch',
  },
  {
    name: 'outside the supplied excerpt',
    source: `${'x'.repeat(MAX_VISUAL_LESSON_CHARS)}A client sends a request.`,
    evidence: 'A client sends a request.',
    outcome: 'outside-excerpt',
  },
])('retains text-free comparison evidence for $name', async ({ source, evidence, outcome }) => {
  generateStructuredOutputMock.mockImplementation(async request => {
    request.onOutputPath?.('direct');
    return { ...sceneDraft(''), evidence };
  });
  const result = await generateLessonScene(unplannedInput(source));
  expect(result.kind).toBe('invalid');
  if (result.kind !== 'invalid') throw new Error('Expected invalid scene');
  expect(JSON.parse(String(result.diagnostic?.originalMessage))).toMatchObject({
    outputPath: 'direct',
    stage: 'domain',
    supportComparison: {
      outcome,
      sourceChars: source.length,
      excerptChars: Math.min(source.length, MAX_VISUAL_LESSON_CHARS),
      evidenceChars: evidence.length,
      normalizedEvidenceChars: evidence.trim().length,
    },
  });
  expect(JSON.stringify(result.diagnostic)).not.toContain('client');
  expect(chooseIconsMock).not.toHaveBeenCalled();
});

test('text fallback rejection retains the same comparison diagnostic', async () => {
  generateStructuredOutputMock.mockResolvedValue({
    ...sceneDraft(''),
    type: 'text',
    evidence: 'A different sentence.',
  });
  const result = await generateLessonScene({
    ...unplannedInput('Source sentence.'),
    allowTextFallback: true,
  });
  expect(result.kind).toBe('invalid');
  if (result.kind !== 'invalid') throw new Error('Expected invalid scene');
  expect(JSON.parse(String(result.diagnostic?.originalMessage))).toMatchObject({
    stage: 'domain',
    supportComparison: { outcome: 'absent' },
  });
});

import {
  FORMULA_SPOTLIGHT_MARKDOWN,
  FORMULA_SPOTLIGHT_SPEECH,
  formulaSpotlight,
} from '../../helpers/formulaSpotlight';

test('the model can choose a spotlight from authored math with canonical spoken anchors', async () => {
  generateStructuredOutputMock.mockResolvedValue({
    ...sceneDraft(''),
    ...formulaSpotlight,
    evidence: FORMULA_SPOTLIGHT_MARKDOWN,
    intent: 'Explain the symbols.',
  });
  const result = await generateLessonScene({
    ...unplannedInput(FORMULA_SPOTLIGHT_MARKDOWN),
    narration: FORMULA_SPOTLIGHT_SPEECH,
    allowTextFallback: true,
  });
  expect(result).toEqual({ kind: 'scene', scene: formulaSpotlight });
  expect(
    z.fromJSONSchema(generateStructuredOutputMock.mock.calls[0][0].output.schema).safeParse({
      ...sceneDraft(''),
      ...formulaSpotlight,
      evidence: FORMULA_SPOTLIGHT_MARKDOWN,
      intent: 'Explain.',
    }).success
  ).toBe(true);
});

test('explicit text fallback needs exact evidence and stays available to the model', async () => {
  generateStructuredOutputMock.mockResolvedValue({
    ...sceneDraft(''),
    type: 'text',
    evidence: 'Una frase.',
  });
  expect(
    await generateLessonScene({ ...unplannedInput('Una frase.'), allowTextFallback: true })
  ).toEqual({ kind: 'text' });
  expect(await generateLessonScene(unplannedInput('Una frase.'))).toMatchObject({
    kind: 'invalid',
  });
  expect(
    await generateLessonScene({ ...unplannedInput('Altra frase.'), allowTextFallback: true })
  ).toMatchObject({ kind: 'invalid' });
});

test.each([
  'Una formula\nillustrata.',
  'Una formula  illustrata.',
])('accepts text evidence when source whitespace varies: %s', async source => {
  generateStructuredOutputMock.mockResolvedValue({
    ...sceneDraft(''),
    type: 'text',
    evidence: 'Una formula illustrata.',
  });
  expect(await generateLessonScene({ ...unplannedInput(source), allowTextFallback: true })).toEqual(
    { kind: 'text' }
  );
});

test.each([
  'guided-path',
  'proportional',
] as const)('validates %s cues against spoken math while grounding quantities in source text', async type => {
  const source =
    'Consideriamo $x$. Poi osserviamo $y$. Da 1 a 6 repliche, inizialmente 2, 128 MB ciascuna.';
  const narration =
    'Consideriamo ics. Poi osserviamo ipsilon. Da uno a sei repliche, inizialmente due, centoventotto megabyte ciascuna.';
  const sceneFor = (anchors: readonly string[]) =>
    type === 'guided-path'
      ? {
          ...guidedPathScene,
          body: '',
          narration: undefined,
          steps: [
            { label: 'Prima quantità', detail: 'Osserva la prima.', anchor: anchors[0] },
            { label: 'Seconda quantità', detail: 'Osserva la seconda.', anchor: anchors[1] },
          ],
        }
      : {
          ...proportionalScene,
          body: '',
          narration: undefined,
          cues: [
            { anchor: anchors[0], value: 2 },
            { anchor: anchors[1], value: 6 },
          ],
        };
  const scene = sceneFor(['Consideriamo ics', 'Poi osserviamo ipsilon']);
  const draft = { ...sceneDraft(''), ...scene, evidence: source, intent: 'Follow the quantities.' };
  const input = { ...unplannedInput(source), narration };
  generateStructuredOutputMock.mockResolvedValue(draft);
  expect(await generateLessonScene(input)).toMatchObject({ kind: 'scene', scene: { type } });
  const rawAnchors = { ...draft, ...sceneFor(['Consideriamo $x$', 'Poi osserviamo $y$']) };
  generateStructuredOutputMock.mockResolvedValue(rawAnchors);
  expect(await generateLessonScene(input)).toMatchObject({ kind: 'invalid' });
  if (type === 'proportional') {
    generateStructuredOutputMock.mockResolvedValue({ ...draft, amountPerUnit: 256 });
    expect(await generateLessonScene(input)).toMatchObject({ kind: 'invalid' });
  }
});

test('admits a spotlight only when the caller supplies canonical narration', async () => {
  const draft = {
    ...sceneDraft(''),
    ...formulaSpotlight,
    evidence: FORMULA_SPOTLIGHT_MARKDOWN,
    intent: 'Explain the symbols.',
  };
  generateStructuredOutputMock.mockResolvedValue(draft);
  expect(await generateLessonScene(unplannedInput(FORMULA_SPOTLIGHT_MARKDOWN))).toMatchObject({
    kind: 'invalid',
  });
  const schema = z.fromJSONSchema(generateStructuredOutputMock.mock.calls[0][0].output.schema);
  expect(schema.safeParse(draft).success).toBe(false);
});
test('keeps transcription provenance separate from the admissible scene passage', async () => {
  const speech = 'Quali fonti sostengono la tesi?';
  const sourceProvenance = {
    kind: 'vision-transcription' as const,
    sources: [{ title: 'Synthetic notes', transcribedPages: [7] }],
  };
  generateStructuredOutputMock.mockResolvedValueOnce(sceneDraft(speech));
  const request = { ...unplannedInput(speech), sourceProvenance };
  expect(await generateLessonScene(request)).toMatchObject({
    kind: 'scene',
    scene: {
      items: [
        { label: 'Fonte', detail: speech },
        { label: 'Riscontri', detail: '' },
      ],
    },
  });
  const prompt = generateStructuredOutputMock.mock.calls[0][0].prompt as string;
  const metadata = prompt.split('\n').find(line => line.startsWith('Source provenance: '));
  expect(JSON.parse(metadata?.slice('Source provenance: '.length) || 'null')).toEqual(
    sourceProvenance
  );
});
