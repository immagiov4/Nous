import { createCanvas } from '@napi-rs/canvas';
import { MAX_VISUAL_LESSON_CHARS } from '@shared/lessonGenerationPolicy';
import { segmentLessonPlayback } from '@shared/lessonPlayback';
import {
  HistoricalLessonSceneSchemas,
  isLessonScene,
  isRetiredLessonScene,
  LessonSceneSchema,
  STATIC_LESSON_SCENE_TYPES,
} from '@shared/lessonScene';
import { studioReaderCues } from '@shared/lessonSceneAnimation';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

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
import {
  getGlobalModelConfig,
  resolveCodexServiceTierForSlot,
  resolveTextModelConfig,
} from '../../../src/config/modelConfig.js';
import { prepareLessonPlaybackVisuals } from '../../../src/services/lessonPlayback/prepareLessonPlaybackBlock.js';
import { generateLessonScene } from '../../../src/services/lessonScenes/lessonSceneGeneration.js';
import {
  checkStudioOperands,
  decodeStudioDraft,
  segmentStudioPhrases,
} from '../../../src/services/lessonScenes/lessonStudioSelection.js';
import { resolveLessonVisualModelConfig } from '../../../src/services/lessonVisualModelConfig.js';
import type { LessonPlaybackServices } from '../../../src/workflows/lessonPlaybackWorkflow.js';
import { currentWorkflowAiCallAttribution } from '../../../src/workflows/modelExchanges.js';
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

import { commonsVisionGold } from './commonsVisionGold';

const { durationMs: _prototypeDuration, ...proportionalScene } = prototypeProportionalScene;

const queries = { action: 'check', concept: 'relevance', object: 'magnifying glass' };
let productionRegistry: ReturnType<typeof createProductionRegistry> | undefined;

function readProductionRegistry() {
  productionRegistry ??= createProductionRegistry();
  return productionRegistry;
}

beforeEach(() => {
  chooseIconsMock.mockClear();
  generateStructuredOutputMock.mockReset();
  vi.stubEnv('LESSON_STUDIOS_ENABLED', undefined);
  vi.stubEnv('LESSON_STUDIO_SELECTION_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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

const studioNarration = 'Confrontiamo 4 e 3. I due valori si scambiano.';
const italianStudioInput = (narration: string) => ({
  ...unplannedInput(narration),
  studioNarration: narration,
  studioLanguage: 'Italiano',
});
const studioRequest = {
  ...italianStudioInput(studioNarration),
  allowedSceneTypes: ['algorithm', 'beforeafter', 'concepts'] as const,
};
const bubbleDraft = {
  type: 'algorithm',
  studio: 'array-algorithm',
  spec: {
    algorithm: 'bubble',
    input: [4, 3],
    callouts: [
      { at: 1, event: 'compare#1' },
      { at: 2, event: 'swap#1' },
    ],
  },
};

const studioFallbackDraft = {
  ...sceneDraft(studioNarration),
  type: 'beforeafter',
  items: [],
  groups: [
    { label: 'Prima', items: ['Quattro e tre'], iconQueries: [queries], verdict: 'none' },
    { label: 'Dopo', items: ['Tre e quattro'], iconQueries: [queries], verdict: 'none' },
  ],
};

test.each([
  { phrase: 'Partiamo con i valori [3, 4].', accepted: true },
  { phrase: 'Partiamo con i valori tre e quattro.', accepted: true },
  { phrase: 'Partiamo con un array già ordinato.', accepted: false },
  { phrase: 'Partiamo con i valori [4, 3].', accepted: false },
  { phrase: 'Partiamo con i valori [3, 4, 5].', accepted: false },
  { phrase: 'Partiamo con i valori [3, due, 4].', accepted: false },
  { phrase: 'Partiamo con i valori [3, 4].', operandsAt: 2, accepted: false },
])('publishes only the exact written array from the cited phrase: $phrase', async ({
  phrase,
  operandsAt = 1,
  accepted,
}) => {
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...bubbleDraft,
    operandsAt,
    spec: { ...bubbleDraft.spec, input: [3, 4], callouts: [] },
  });
  if (!accepted) generateStructuredOutputMock.mockResolvedValueOnce(null);
  generateStructuredOutputMock.mockResolvedValueOnce({ ...studioFallbackDraft, evidence: phrase });
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    const result = await generateLessonScene({
      ...studioRequest,
      ...italianStudioInput(phrase),
    });
    if (accepted) {
      expect(result, JSON.stringify(log.mock.calls)).toMatchObject({
        kind: 'scene',
        scene: { type: 'algorithm' },
      });
      expect(generateStructuredOutputMock).toHaveBeenCalledTimes(1);
    } else {
      expect(result).toMatchObject({ kind: 'scene', scene: { type: 'beforeafter' } });
      expect(log).toHaveBeenCalledWith(
        '[lesson-studio] fallback',
        expect.objectContaining({
          decisionId: expect.stringMatching(/^[\da-f-]{36}$/u),
          reason: 'operand-grounding',
          rejectedField: 'spec.input',
        })
      );
    }
  } finally {
    log.mockRestore();
  }
});

test.each([
  { section: 'Partiamo da [3, 4].', quote: '[3, 4]', accepted: true },
  { section: 'Partiamo da [3, 4, 5].', quote: '3, 4', accepted: false },
  { section: 'Partiamo da [3, 4, 5].', quote: '[3, 4]', accepted: false },
  { section: 'Partiamo da [4, 3].', quote: '[4, 3]', accepted: false },
  { section: 'Non partiamo da [3, 4].', quote: '[3, 4]', accepted: false },
  { section: 'Non dobbiamo usare [3, 4]; usiamo [5, 6].', quote: '[3, 4]', accepted: false },
  { section: 'Non dobbiamo usare [3, 4]; usiamo [5, 6].', quote: 'usare [3, 4]', accepted: false },
  { section: 'Partiamo da [3, 4]. Poi ripetiamo [3, 4].', quote: '[3, 4]', accepted: false },
])('grounds initial operands only in the cited section span: $section / $quote', async ({
  section,
  quote,
  accepted,
}) => {
  const narration = 'Osserviamo il confronto tra gli elementi.';
  generateStructuredOutputMock
    .mockResolvedValueOnce({
      ...bubbleDraft,
      operandSources: [{ field: 'spec.input', quote }],
      spec: { ...bubbleDraft.spec, input: [3, 4], callouts: [] },
    })
    .mockResolvedValue(null);
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    const result = await generateLessonScene({
      ...studioRequest,
      ...italianStudioInput(narration),
      lessonMarkdown: section,
    });
    expect(result).toMatchObject({
      kind: 'scene',
      scene: { type: accepted ? 'algorithm' : 'concepts' },
    });
    if (accepted) {
      const start = section.indexOf(quote);
      expect(log).toHaveBeenCalledWith(
        '[lesson-studio] selected',
        expect.objectContaining({
          operandEvidence: [
            { field: 'spec.input', source: 'section', start, end: start + quote.length },
          ],
        })
      );
    } else {
      expect(log).toHaveBeenCalledWith(
        '[lesson-studio] fallback',
        expect.objectContaining({ rejectedField: 'spec.input' })
      );
    }
  } finally {
    log.mockRestore();
  }
});

test('keeps a complete bare operand list in one numbered narration phrase', () => {
  const narration =
    'Prima osserviamo attentamente questi valori uno, due, tre, quattro, cinque, sei, sette e otto mentre procediamo.';
  const phrases = segmentStudioPhrases(narration);
  const operandsAt = phrases.findIndex(phrase => phrase.includes('uno,')) + 1;
  const draft = {
    ...bubbleDraft,
    operandsAt,
    spec: { ...bubbleDraft.spec, input: [1, 2, 3, 4, 5, 6, 7, 8], callouts: [] },
  };
  const scene = decodeStudioDraft(draft, narration, phrases);
  if (!scene) throw new Error('Expected an array draft');
  expect(checkStudioOperands(scene, draft, phrases, '').rejectedField).toBeUndefined();
});

test('does not use a partial list even with a supplied phrase boundary', () => {
  const narration =
    'Prima osserviamo e poi annotiamo nella nuova tabella tutti quanti questi otto distinti valori 1, 2, 3, 4, 5, 6, 7 e 8.';
  const split = narration.indexOf('5, 6,');
  const phrases = [narration.slice(0, split).trimEnd(), narration.slice(split)];
  const draft = {
    ...bubbleDraft,
    operandsAt: 2,
    spec: { ...bubbleDraft.spec, input: [5, 6, 7, 8], callouts: [] },
  };
  const scene = decodeStudioDraft(draft, narration, phrases);
  if (!scene) throw new Error('Expected an array draft');
  expect(checkStudioOperands(scene, draft, phrases, '').rejectedField).toBe('spec.input');
});

test('does not ground a section target that the owning sentence negates', () => {
  const narration = 'Partiamo da [1, 3, 7]. Osserviamo la ricerca nella lista.';
  const phrases = segmentStudioPhrases(narration);
  const draft = {
    ...bubbleDraft,
    operandsAt: 1,
    operandSources: [{ field: 'spec.target', quote: 'cerchiamo tre' }],
    spec: { algorithm: 'binary-search', input: [1, 3, 7], target: 3, callouts: [] },
  };
  const scene = decodeStudioDraft(draft, narration, phrases);
  if (!scene) throw new Error('Expected a binary-search draft');
  expect(
    checkStudioOperands(scene, draft, phrases, 'Non cerchiamo tre. Cerchiamo due.').rejectedField
  ).toBe('spec.target');
});

const weightedGraphDraft = {
  type: 'geometry',
  geometryStudio: {
    id: 'graph',
    spec: {
      title: 'Cammino minimo',
      layout: 'ring',
      nodes: [
        { id: 'A', label: 'A' },
        { id: 'B', label: 'B' },
      ],
      edges: [{ from: 'A', to: 'B', weight: 3 }],
      algorithm: { kind: 'dijkstra', start: 'A', target: 'B' },
      beats: [
        { at: 'b1', event: 'start' },
        { at: 'b2', event: 'done' },
      ],
    },
  },
};

test.each([
  {
    edge: { from: 'A', to: 'B', weight: 3 },
    phrase: 'L’arco fra A e B ha peso [3].',
    reason: 'layout-gate',
  },
  {
    edge: { from: 'A', to: 'B', weight: 3 },
    phrase: 'L’arco fra A e B pesa tre.',
    reason: 'operand-grounding',
  },
  {
    edge: { from: 'A', to: 'B' },
    phrase: 'L’arco fra A e B ha peso [1].',
    reason: 'operand-grounding',
  },
])('grounds Dijkstra weights before layout: $phrase', async ({ edge, phrase, reason }) => {
  const narration = `${phrase} Poi troviamo il cammino minimo.`;
  const { geometryStudio } = weightedGraphDraft;
  generateStructuredOutputMock
    .mockResolvedValueOnce({
      ...weightedGraphDraft,
      geometryStudio: { ...geometryStudio, spec: { ...geometryStudio.spec, edges: [edge] } },
    })
    .mockResolvedValueOnce(sceneDraft(narration));
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    const evidence =
      reason === 'operand-grounding'
        ? { reason, rejectedField: 'geometryStudio.spec.edges.weight' }
        : { reason, failedChecks: expect.arrayContaining(['min-gap']) };
    const result = await generateLessonScene({
      ...italianStudioInput(narration),
      allowedSceneTypes: ['geometry', 'concepts'],
    });
    expect(result).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
    expect(log).toHaveBeenCalledWith('[lesson-studio] fallback', expect.objectContaining(evidence));
  } finally {
    log.mockRestore();
  }
});

test.each([
  { ending: 'Poi passiamo da [45] a [90] gradi.', accepted: true },
  { ending: 'Poi portiamo il raggio a novanta gradi.', accepted: false },
])('grounds a plane update in the phrase that changes it: $ending', async ({
  ending,
  accepted,
}) => {
  const narration = `Portiamo il raggio a [45] gradi. ${ending}`;
  generateStructuredOutputMock
    .mockResolvedValueOnce({
      type: 'geometry',
      geometryStudio: {
        id: 'plane',
        spec: {
          title: 'Il raggio ruota',
          x: [-1.3, 3],
          y: [-1.25, 1.25],
          grid: false,
          parameters: { theta: 45 },
          layers: [{ id: 'wave', type: 'unit-circle-wave', angle: 'theta', waveStart: 1.5 }],
          beats: [
            { at: 'b1', focus: ['wave'] },
            { at: 'b2', focus: ['wave'], set: { theta: 90 } },
          ],
        },
      },
    })
    .mockResolvedValueOnce(sceneDraft(narration));
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    const result = await generateLessonScene({
      ...italianStudioInput(narration),
      allowedSceneTypes: ['geometry', 'concepts'],
    });
    if (accepted) {
      expect(result, JSON.stringify(log.mock.calls)).toMatchObject({
        kind: 'scene',
        scene: { type: 'geometry' },
      });
    } else {
      expect(result).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
      expect(log).toHaveBeenCalledWith(
        '[lesson-studio] fallback',
        expect.objectContaining({
          reason: 'operand-grounding',
          rejectedField: 'geometryStudio.spec.beats.1.set',
        })
      );
    }
  } finally {
    log.mockRestore();
  }
});

test('rejects a plot when its coefficients are stated only outside the cited phrase', async () => {
  const narration = 'I coefficienti iniziali sono [1, 0, 0]. La parabola si apre verso l’alto.';
  generateStructuredOutputMock
    .mockResolvedValueOnce({
      type: 'geometry',
      geometryStudio: {
        id: 'function-plot',
        spec: {
          family: 'quadratic',
          xRange: [-2, 2],
          yRange: [-4, 4],
          keyframes: [{ at: 'b2', params: { a: 1, b: 0, c: 0 } }],
        },
      },
    })
    .mockResolvedValueOnce(sceneDraft(narration));
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    expect(
      await generateLessonScene({
        ...italianStudioInput(narration),
        allowedSceneTypes: ['geometry', 'concepts'],
      })
    ).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
    expect(log).toHaveBeenCalledWith(
      '[lesson-studio] fallback',
      expect.objectContaining({
        reason: 'operand-grounding',
        rejectedField: 'geometryStudio.spec.keyframes.0.params',
      })
    );
  } finally {
    log.mockRestore();
  }
});

test.each([
  undefined,
  'English',
])('uses the catalog for studio narration with language %s', async studioLanguage => {
  generateStructuredOutputMock.mockResolvedValue(sceneDraft(studioNarration));
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    await generateLessonScene({ ...studioRequest, studioLanguage });
    expect(generateStructuredOutputMock).toHaveBeenCalledTimes(1);
    expect(generateStructuredOutputMock.mock.calls[0][0].output.name).toBe('lesson_scene');
    expect(log).toHaveBeenCalledWith(
      '[lesson-scene] studio selection skipped',
      expect.objectContaining({
        studioSelection: 'unsupported-language',
      })
    );
  } finally {
    log.mockRestore();
  }
});

test.each([
  { narration: 'Cerchiamo il valore sette nella lista [1, 7, 9].', target: 1, grounded: false },
  { narration: 'Cerchiamo il valore sette nella lista [1, 7, 9].', target: 7, grounded: true },
  { narration: 'Cerchiamo il valore 7 nella lista [1, 7, 9].', target: 7, grounded: true },
  { narration: 'Cerchiamo 1/2 nella lista [1, 7, 9].', target: 1, grounded: false },
  {
    narration: 'La lista contiene [1, 7, 9]. Applichiamo la ricerca binaria.',
    target: 7,
    grounded: false,
  },
  { narration: 'Cerchiamo 7 nella lista [1, 7, 9]. Poi cerchiamo 9.', target: 7, grounded: false },
  {
    narration: 'Cerchiamo 7 oppure il numero 9 nella lista [1, 7, 9].',
    target: 7,
    grounded: false,
  },
  { narration: 'Non cerchiamo 7 nella lista [1, 7, 9].', target: 7, grounded: false },
])('grounds binary-search target $target in $narration', ({ narration, target, grounded }) => {
  const scene = decodeStudioDraft(
    {
      type: 'algorithm',
      studio: 'array-algorithm',
      spec: { algorithm: 'binary-search', input: [1, 7, 9], target, callouts: [] },
    },
    narration,
    segmentStudioPhrases(narration)
  );
  if (scene?.type !== 'algorithm') throw new Error('Expected a binary-search draft');
  expect(checkStudioOperands(scene, { operandsAt: 1 }, [narration], '').rejectedField).toBe(
    grounded ? undefined : 'spec.target'
  );
});

test('bounds authored concepts titles and labels after recovery is exhausted', async () => {
  const phrase = 'caratterizzazione sperimentale '.repeat(11).trim();
  const narration = `${phrase}. ${phrase}.`;
  generateStructuredOutputMock.mockResolvedValue(null);
  const outcome = await generateLessonScene({
    ...studioRequest,
    sectionTitle: phrase,
    lessonMarkdown: narration,
    studioNarration: narration,
  });
  if (outcome.kind !== 'scene') throw new Error('Expected a usable concepts scene');
  expect(outcome.scene.type).toBe('concepts');
  expect(isLessonScene(outcome.scene)).toBe(true);
  expect(outcome.scene.title.length).toBeLessThanOrEqual(160);
  expect(outcome.scene.items.length).toBeGreaterThanOrEqual(2);
  for (const item of outcome.scene.items) {
    expect(item.label.length).toBeLessThanOrEqual(160);
    expect(item.label).toMatch(/\p{L}/u);
  }
});

test.each([
  { studioType: 'algorithm', setting: undefined },
  { studioType: 'algorithm', setting: '' },
  { studioType: 'geometry', setting: '' },
] as const)('sends the ordinary scene-slot request for $studioType with studio selection set to $setting', async ({
  studioType,
  setting,
}) => {
  vi.stubEnv('LESSON_STUDIO_SELECTION_ENABLED', setting);
  vi.stubEnv('LESSON_STUDIOS_ENABLED', setting);
  const models = {
    ...getGlobalModelConfig(),
    aiProvider: 'codex' as const,
    aiProviderOverrides: {},
  };
  const config = resolveLessonVisualModelConfig(models);
  const stageStudioImage = vi.fn();
  generateStructuredOutputMock.mockResolvedValue(sceneDraft(studioNarration));
  await generateLessonScene({
    ...studioRequest,
    config,
    stageStudioImage,
    allowedSceneTypes: ['beforeafter', 'concepts'],
    studioNarration: undefined,
  });
  expect(generateStructuredOutputMock).toHaveBeenCalledTimes(1);
  const [ordinaryRequest] = generateStructuredOutputMock.mock.calls[0];
  generateStructuredOutputMock.mockClear();

  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    const result = await generateLessonScene({
      ...studioRequest,
      config,
      stageStudioImage,
      allowedSceneTypes: [studioType, 'beforeafter', 'concepts'],
    });
    expect(result).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
    expect(generateStructuredOutputMock).toHaveBeenCalledTimes(1);
    expect(stageStudioImage).not.toHaveBeenCalled();
    const [request] = generateStructuredOutputMock.mock.calls[0];
    expect(request).toMatchObject({ slot: 'scene', config: { aiProvider: 'codex' } });
    expect(request).not.toHaveProperty('model');
    expect(resolveTextModelConfig(request.config, request.slot).model).toBe(models.codexSceneModel);
    expect(resolveCodexServiceTierForSlot(request.config, request.slot)).toBe('fast');
    expect(request.output.name).toBe('lesson_scene');
    expect(JSON.stringify(request.output)).toBe(JSON.stringify(ordinaryRequest.output));
    expect(request.prompt).toBe(ordinaryRequest.prompt);
    expect(request.system).toBe(ordinaryRequest.system);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[lesson-scene] studio selection skipped',
      expect.objectContaining({
        decisionId: expect.any(String),
        offered: [],
        studioSelection: setting === undefined ? 'no-compatible-studio' : 'disabled',
      })
    );
  } finally {
    log.mockRestore();
  }
});

test('disabled studio selection rejects a studio draft without studio recovery', async () => {
  vi.stubEnv('LESSON_STUDIO_SELECTION_ENABLED', 'false');
  generateStructuredOutputMock.mockResolvedValue(bubbleDraft);
  const result = await generateLessonScene(studioRequest);
  expect(result).toMatchObject({ kind: 'invalid' });
  expect(generateStructuredOutputMock).toHaveBeenCalledTimes(1);
});

test.each([
  'transport',
  'decode',
  'schema',
  'layout',
  'exhausted repairs',
] as const)('stores a usable catalog scene after a studio failure in %s', async failure => {
  const selection = {
    decode: { studio: 'heap', spec: {} },
    schema: { type: 'algorithm', studio: 'heap', spec: {} },
    layout: bubbleDraft,
    'exhausted repairs': bubbleDraft,
  };
  if (failure === 'transport') {
    generateStructuredOutputMock.mockRejectedValueOnce(new TypeError('fetch failed'));
  } else {
    generateStructuredOutputMock.mockResolvedValueOnce(selection[failure]);
  }
  const repairExpected = failure !== 'transport' && failure !== 'decode';
  if (repairExpected) generateStructuredOutputMock.mockResolvedValueOnce(null);
  generateStructuredOutputMock.mockResolvedValue(
    failure === 'exhausted repairs' ? null : sceneDraft(studioNarration)
  );
  const outcome = await generateLessonScene(studioRequest);
  expect(outcome).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
  if (outcome.kind !== 'scene') throw new Error('Studio failure left an unusable slot');
  expect(LessonSceneSchema.safeParse(outcome.scene).success).toBe(true);
  const catalogCalls = generateStructuredOutputMock.mock.calls.slice(repairExpected ? 2 : 1);
  expect(catalogCalls.length).toBeGreaterThan(0);
  for (const [request] of catalogCalls) {
    expect(request.output.name).toBe('lesson_scene');
  }
});

test('an exhausted studio never displays the first half of an authored expression', async () => {
  const expression = `sigla${'x'.repeat(700)}fine`;
  const narration = `Guardiamo ora il simbolo ${expression} prima di leggere i dati.`;
  generateStructuredOutputMock.mockResolvedValue(null);
  const outcome = await generateLessonScene({
    ...studioRequest,
    lessonMarkdown: narration,
    studioNarration: narration,
  });
  expect(outcome).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
  if (outcome.kind !== 'scene') throw new Error('Studio failure left an unusable slot');
  expect(outcome.scene.items.map(item => item.label).join(' ')).not.toContain('sigla');
  expect(outcome.scene.items.map(item => item.label).join(' ')).toContain('…');
  expect(LessonSceneSchema.safeParse(outcome.scene).success).toBe(true);
});

test.each([
  'Osserva i valori quotati.',
  '',
])('an exhausted studio keeps usable labels when every narrated token exceeds the catalog limit (title: %j)', async sectionTitle => {
  const narration = ['a', 'b', 'c', 'd'].map(letter => letter.repeat(650)).join(' ');
  generateStructuredOutputMock
    .mockResolvedValueOnce({ type: 'algorithm', studio: 'heap', spec: {} })
    .mockResolvedValue(null);
  const outcome = await generateLessonScene({
    ...studioRequest,
    sectionTitle,
    lessonMarkdown: narration,
    studioNarration: narration,
  });
  expect(outcome).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
  if (outcome.kind !== 'scene') throw new Error('Expected a catalog scene');
  expect(LessonSceneSchema.safeParse(outcome.scene).success).toBe(true);
  expect(isLessonScene(outcome.scene)).toBe(true);
  expect(outcome.scene.items.length).toBeGreaterThanOrEqual(2);
  expect(outcome.scene.items.every(({ label }) => /[\p{L}\p{N}]/u.test(label))).toBe(true);
  if (sectionTitle) {
    expect(outcome.scene.items.map(item => item.label).join(' ')).toBe(sectionTitle);
  }
});

const circleNarration = 'I valori di centro e raggio del cerchio unitario sono [0, 0, 1].';
const circleDraft = {
  type: 'geometry',
  geometryStudio: {
    id: 'plane',
    spec: {
      title: 'Cerchio unitario',
      x: [-1.3, 8],
      y: [-1.25, 1.25],
      grid: false,
      layers: [{ id: 'unit', type: 'circle', center: [0, 0], radius: 1 }],
      beats: [{ at: 'b1', focus: ['unit'] }],
    },
  },
};

test('a plane beat rejects imperative prose even without spaces and recovers to the catalog', async () => {
  const narration = 'Portiamo il raggio a quarantacinque gradi. Poi mostriamo il punto B.';
  generateStructuredOutputMock
    .mockResolvedValueOnce({
      type: 'geometry',
      geometryStudio: {
        id: 'plane',
        spec: {
          title: 'Il raggio ruota',
          x: [-1.3, 3],
          y: [-1.25, 1.25],
          grid: false,
          parameters: { theta: 45 },
          layers: [
            { id: 'wave', type: 'unit-circle-wave', angle: 'theta', waveStart: 1.5 },
            { id: 'B', type: 'point', name: 'B', at: [2.6, 1] },
          ],
          beats: [
            { at: 'b1', focus: ['wave'], show: ['wave'] },
            { at: 'b2', focus: ['B'], label: 'Vai!Sali', set: { theta: 90 } },
          ],
        },
      },
    })
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(sceneDraft(narration));
  const result = await generateLessonScene({
    ...italianStudioInput(narration),
    allowedSceneTypes: ['geometry', 'concepts'],
  });
  expect(result).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
  expect(generateStructuredOutputMock).toHaveBeenCalledTimes(3);
});

test.each([
  'transport',
  'decode',
] as const)('recovers to a usable catalog scene after a geometry selection failure in %s', async failure => {
  const narration = 'Il cerchio unitario ha raggio uno.';
  if (failure === 'transport') {
    generateStructuredOutputMock.mockRejectedValueOnce(new TypeError('fetch failed'));
  } else {
    generateStructuredOutputMock.mockResolvedValueOnce({
      geometryStudio: circleDraft.geometryStudio,
    });
  }
  generateStructuredOutputMock.mockResolvedValueOnce(sceneDraft(narration));
  const result = await generateLessonScene({
    ...italianStudioInput(narration),
    allowedSceneTypes: ['geometry', 'concepts'],
  });
  expect(result).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
  if (result.kind !== 'scene') throw new Error('Geometry failure left an unusable slot');
  expect(LessonSceneSchema.safeParse(result.scene).success).toBe(true);
  expect(generateStructuredOutputMock).toHaveBeenCalledTimes(2);
});

test('an incomplete geometry envelope still invokes the ordinary catalog', async () => {
  const narration = 'Il cerchio unitario ha raggio uno.';
  generateStructuredOutputMock
    .mockResolvedValueOnce({ type: 'geometry', geometryStudio: { spec: {} } })
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(sceneDraft(narration));
  expect(
    await generateLessonScene({
      ...italianStudioInput(narration),
      allowedSceneTypes: ['geometry', 'concepts'],
    })
  ).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
  expect(generateStructuredOutputMock).toHaveBeenCalledTimes(3);
});

test('a rejected plane and unusable catalog responses leave a renderable scene', async () => {
  const narration = 'Il cerchio unitario ha raggio uno. Osserviamo il centro del cerchio.';
  const calls: ReturnType<typeof currentWorkflowAiCallAttribution>[] = [];
  generateStructuredOutputMock.mockImplementation(async ({ output }) => {
    calls.push(currentWorkflowAiCallAttribution());
    return output.name === 'lesson_studio_selection' ? circleDraft : null;
  });
  expect(
    await generateLessonScene({
      ...italianStudioInput(narration),
      allowedSceneTypes: ['geometry', 'concepts', 'beforeafter'],
    })
  ).toMatchObject({
    kind: 'scene',
    scene: {
      type: 'concepts',
      items: [
        { label: 'Il cerchio unitario ha raggio uno.' },
        { label: 'Osserviamo il centro del cerchio.' },
      ],
    },
  });
  expect(generateStructuredOutputMock.mock.calls.map(([request]) => request.output.name)).toEqual([
    'lesson_studio_selection',
    'lesson_studio_selection',
    'lesson_scene',
    'lesson_scene',
  ]);
  expect(calls).toEqual([
    { decisionId: expect.any(String), role: 'studio-selection' },
    { decisionId: calls[0]?.decisionId, role: 'studio-repair' },
    { decisionId: calls[0]?.decisionId, role: 'catalog-fallback' },
    { decisionId: calls[0]?.decisionId, role: 'catalog-repair' },
  ]);
});

test('catalog responses cannot carry a geometry studio payload', async () => {
  const source = 'Confrontiamo i criteri con le fonti disponibili.';
  const catalog = sceneDraft(source);
  generateStructuredOutputMock
    .mockResolvedValueOnce({ ...catalog, geometryStudio: circleDraft.geometryStudio })
    .mockResolvedValueOnce(catalog);
  expect(await generateLessonScene(unplannedInput(source))).toMatchObject({
    kind: 'invalid',
    diagnostic: { errorStage: 'schema' },
  });
  const result = await generateLessonScene(unplannedInput(source));
  expect(result).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
  expect(result).not.toHaveProperty('scene.geometryStudio');
  expect(generateStructuredOutputMock).toHaveBeenCalledTimes(2);
});

test('uses the valid catalog scene returned by the studio repair', async () => {
  const catalog = { ...sceneDraft(studioNarration), title: 'Confronto dei valori' };
  const onValidatedScene = vi.fn();
  generateStructuredOutputMock
    .mockResolvedValueOnce({ ...bubbleDraft, spec: { ...bubbleDraft.spec, callouts: [] } })
    .mockResolvedValueOnce(catalog)
    .mockResolvedValue(null);
  const result = await generateLessonScene({ ...studioRequest, onValidatedScene });
  expect(result).toMatchObject({
    kind: 'scene',
    scene: { type: 'concepts', title: catalog.title },
  });
  expect(onValidatedScene).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ title: catalog.title })
  );
  expect(generateStructuredOutputMock).toHaveBeenCalledTimes(2);
});

test.each([
  { name: 'geometry only', allowedSceneTypes: ['geometry', 'concepts'] },
  { name: 'no catalog alternative', allowedSceneTypes: ['geometry'] },
  { name: 'geometry and algorithm', allowedSceneTypes: ['algorithm', 'geometry', 'concepts'] },
] as const)('generates a plotted parabola with $name studios', async ({ allowedSceneTypes }) => {
  const first = 'Con i coefficienti [1, 0, 0] la parabola si apre verso l’alto.';
  const second = 'Con i coefficienti [-1,5; 0; 0] la concavità si inverte.';
  const narration = `${first} ${second}`;
  generateStructuredOutputMock.mockResolvedValueOnce({
    type: 'geometry',
    geometryStudio: {
      id: 'function-plot',
      spec: {
        family: 'quadratic',
        xRange: [-2, 2],
        yRange: [-4, 4],
        keyframes: [
          { at: 'b1', params: { a: 1, b: 0, c: 0 } },
          { at: 'b2', params: { a: -1.5, b: 0, c: 0 } },
        ],
      },
    },
  });
  expect(
    await generateLessonScene({
      ...italianStudioInput(narration),
      allowedSceneTypes,
    })
  ).toMatchObject({
    kind: 'scene',
    scene: {
      type: 'geometry',
      geometryStudio: { id: 'function-plot' },
      studioCues: [{ anchor: first }, { anchor: second }],
    },
  });
  expect(generateStructuredOutputMock).toHaveBeenCalledTimes(1);
  if (allowedSceneTypes.length === 1) {
    expect(generateStructuredOutputMock.mock.calls[0]?.[0].output.schema).toMatchObject({
      properties: { type: { const: 'geometry' } },
    });
  }
});

test('a rejected studio with no admitted catalog alternative retains a scene after one repair call', async () => {
  const narration = circleNarration;
  generateStructuredOutputMock.mockResolvedValueOnce(circleDraft);
  expect(
    await generateLessonScene({
      ...italianStudioInput(narration),
      allowedSceneTypes: ['geometry'],
    })
  ).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
  expect(generateStructuredOutputMock).toHaveBeenCalledTimes(2);
});

test('repairs a rejected stationary beat once with the validator feedback and publishes the corrected scene', async () => {
  const first = 'Con i coefficienti [1, 0, 0] la parabola si apre verso l’alto.';
  const second = 'Con i coefficienti [-1, 0, 0] la concavità si inverte.';
  const narration = first + ' ' + second;
  const draft = (a: number) => ({
    type: 'geometry',
    geometryStudio: {
      id: 'function-plot',
      spec: {
        family: 'quadratic',
        xRange: [-2, 2],
        yRange: [-4, 4],
        keyframes: [
          { at: 'b1', params: { a: 1, b: 0, c: 0 } },
          { at: 'b2', params: { a, b: 0, c: 0 } },
        ],
      },
    },
  });
  const attribution = vi.fn();
  const onValidatedScene = vi.fn();
  generateStructuredOutputMock
    .mockImplementationOnce(async () => {
      attribution(currentWorkflowAiCallAttribution());
      return {
        ...draft(1),
        operandSources: [{ field: 'geometryStudio.spec.keyframes.1.params', quote: '[1, 0, 0]' }],
      };
    })
    .mockImplementationOnce(async request => {
      attribution(currentWorkflowAiCallAttribution(), request.prompt);
      return draft(-1);
    });
  const outcome = await generateLessonScene({
    ...italianStudioInput(narration),
    allowedSceneTypes: ['geometry', 'concepts'],
    onValidatedScene,
  });
  expect(outcome).toMatchObject({
    kind: 'scene',
    scene: {
      type: 'geometry',
      studioCues: [{ anchor: first }, { anchor: second }],
      geometryStudio: draft(-1).geometryStudio,
    },
  });
  expect(generateStructuredOutputMock).toHaveBeenCalledTimes(2);
  expect(onValidatedScene).toHaveBeenCalledTimes(1);
  expect(attribution).toHaveBeenNthCalledWith(
    2,
    { decisionId: attribution.mock.calls[0][0].decisionId, role: 'studio-repair' },
    expect.stringContaining('dead-stage')
  );
});

test('a valid but static circle uses the studio’s catalog fallback', async () => {
  const narration = circleNarration;
  generateStructuredOutputMock
    .mockResolvedValueOnce(circleDraft)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(sceneDraft(narration));
  expect(
    await generateLessonScene({
      ...italianStudioInput(narration),
      allowedSceneTypes: ['algorithm', 'geometry', 'concepts'],
    })
  ).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
  expect(generateStructuredOutputMock).toHaveBeenCalledTimes(3);
});

test('keeps the catalog scene and joins the rejected stage size to its selection decision', async () => {
  const narration = circleNarration;
  generateStructuredOutputMock
    .mockResolvedValueOnce(circleDraft)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(sceneDraft(narration));
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    expect(
      await generateLessonScene({
        ...italianStudioInput(narration),
        allowedSceneTypes: ['geometry', 'concepts'],
      })
    ).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
    const rejection = log.mock.calls.find(
      ([message]) => message === '[lesson-studio] reader layout rejected'
    )?.[1];
    expect(rejection).toMatchObject({
      decisionId: expect.any(String),
      width: expect.any(Number),
      height: expect.any(Number),
      checks: expect.arrayContaining(['dead-stage']),
    });
    expect(log).toHaveBeenCalledWith(
      '[lesson-studio] fallback',
      expect.objectContaining({ decisionId: rejection?.decisionId, reason: 'layout-gate' })
    );
  } finally {
    log.mockRestore();
  }
});

test('a stretched circle falls back to the plane studio’s catalog kind', async () => {
  const narration = circleNarration;
  generateStructuredOutputMock
    .mockResolvedValueOnce({
      ...circleDraft,
      geometryStudio: {
        ...circleDraft.geometryStudio,
        spec: { ...circleDraft.geometryStudio.spec, scale: 'independent' },
      },
    })
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(sceneDraft(narration));
  expect(
    await generateLessonScene({
      ...italianStudioInput(narration),
      allowedSceneTypes: ['algorithm', 'geometry', 'concepts', 'beforeafter'],
    })
  ).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
  expect(generateStructuredOutputMock).toHaveBeenCalledTimes(3);
});

test('resolves exact narration anchors from phrase IDs', () => {
  expect(
    decodeStudioDraft(bubbleDraft, studioNarration, segmentStudioPhrases(studioNarration))
  ).toMatchObject({
    type: 'algorithm',
    studioCues: [{ anchor: 'Confrontiamo 4 e 3.' }, { anchor: 'I due valori si scambiano.' }],
  });
});

test('a numbered cue selects the second of two indistinguishable phrases', () => {
  const phrase = 'Ora confrontiamo questi valori.';
  const narration = `${phrase} ${phrase}`;
  const candidate = decodeStudioDraft(
    { ...bubbleDraft, spec: { ...bubbleDraft.spec, callouts: [{ at: 2, event: 'compare#1' }] } },
    narration,
    segmentStudioPhrases(narration)
  );
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error('The selected occurrence was rejected');
  expect(candidate.studioCues).toEqual([{ anchor: phrase, occurrence: 1 }]);
  expect(studioReaderCues(candidate)).toEqual([1000]);
  expect(LessonSceneSchema.safeParse(candidate).success).toBe(true);
});

test('does not publish an internally valid sort with operands that contradict narration', async () => {
  const narration = 'Confrontiamo sette e otto. Il passaggio senza scambi conferma l’ordine.';
  generateStructuredOutputMock
    .mockResolvedValueOnce({
      ...bubbleDraft,
      spec: { ...bubbleDraft.spec, input: [3, 4], callouts: [] },
    })
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(sceneDraft(narration));
  expect(
    await generateLessonScene({
      ...studioRequest,
      lessonMarkdown: narration,
      studioNarration: narration,
    })
  ).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
});

test.each([
  'Confrontiamo dodici e tredici. Il passaggio senza scambi conferma l’ordine.',
  'Partiamo dalla lista [3,4,5]. Un passaggio senza scambi conferma l’ordine.',
  'Partiamo con quattro e tre. Alla fine troviamo tre e quattro.',
])('keeps the full narrated initial array for %s', async narration => {
  generateStructuredOutputMock
    .mockResolvedValueOnce({
      ...bubbleDraft,
      spec: { ...bubbleDraft.spec, input: [3, 4], callouts: [] },
    })
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(sceneDraft(narration));
  expect(
    await generateLessonScene({
      ...studioRequest,
      lessonMarkdown: narration,
      studioNarration: narration,
    })
  ).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
});

test('a heap construction passage cannot publish the extraction phase of heapsort', async () => {
  const narration = 'Costruiamo un max heap con [4, 3]. Il massimo arriva in cima.';
  generateStructuredOutputMock
    .mockResolvedValueOnce({
      type: 'algorithm',
      studio: 'heap',
      operandsAt: 1,
      spec: { operation: 'sort', input: [4, 3], beats: [] },
    })
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(sceneDraft(narration));
  expect(
    await generateLessonScene({
      ...studioRequest,
      lessonMarkdown: narration,
      studioNarration: narration,
    })
  ).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
});

test.each([
  {
    narration:
      'Il risultato atteso è [3, 4]. Partiamo da [4, 3]. Scambiamo il primo e il secondo elemento.',
    input: [3, 4],
  },
  {
    narration:
      'Il risultato atteso è [3, 4]. Partiamo da [4, 3]. Scambiamo il primo e il secondo elemento.',
    input: [4, 3],
  },
  { narration: 'Vediamo i valori [3, 4]. Poi consideriamo anche [5, 6].', input: [5, 6] },
  { narration: 'Vediamo i valori [3, 4]. Poi consideriamo anche [5, 6].', input: [4, 5] },
  { narration: 'Il risultato atteso è [3, 4]. Vediamo come calcolarlo.', input: [3, 4] },
  { narration: 'Ecco l’array risultante: [3, 4]. Vediamo come calcolarlo.', input: [3, 4] },
  { narration: 'Partiamo da meno tre e quattro. Osserva cosa succede dopo.', input: [3, 4] },
])('falls back when $input is not unambiguously grounded in $narration', async ({
  narration,
  input,
}) => {
  generateStructuredOutputMock
    .mockResolvedValueOnce({
      ...bubbleDraft,
      operandsAt: 1,
      spec: { ...bubbleDraft.spec, input, callouts: [] },
    })
    .mockResolvedValue(null);
  expect(
    await generateLessonScene({
      ...studioRequest,
      lessonMarkdown: narration,
      studioNarration: narration,
    })
  ).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
});

test.each([
  'Partiamo da [3, 4]. Il risultato è [3, 4]. Il passaggio conferma l’ordine.',
  'Vediamo i valori [3, 4]. Poi consideriamo anche [5, 6].',
])('publishes the first cited list for %j', async narration => {
  generateStructuredOutputMock
    .mockResolvedValueOnce({
      ...bubbleDraft,
      operandsAt: 1,
      spec: { ...bubbleDraft.spec, input: [3, 4], callouts: [] },
    })
    .mockResolvedValue(null);
  expect(
    await generateLessonScene({
      ...studioRequest,
      lessonMarkdown: narration,
      studioNarration: narration,
    })
  ).toMatchObject({
    kind: 'scene',
    scene: { type: 'algorithm', studio: { spec: { input: [3, 4] } } },
  });
});

test.each([
  {
    instruction: 'Non estraiamo il massimo: per ora osserviamo soltanto la costruzione.',
    operation: 'sort',
    type: 'concepts',
  },
  {
    instruction: 'Non estraiamo il massimo: per ora osserviamo soltanto la costruzione.',
    operation: 'build',
    type: 'algorithm',
  },
  {
    instruction: 'Estraiamo il massimo e ordiniamo i valori.',
    operation: 'sort',
    type: 'algorithm',
  },
  {
    instruction: 'Estraiamo il massimo e ordiniamo i valori.',
    operation: 'build',
    type: 'concepts',
  },
  {
    instruction: 'Ordiniamo i valori. Non estraiamo il massimo.',
    operation: 'sort',
    type: 'concepts',
  },
  {
    instruction: 'Ordiniamo i valori. Non estraiamo il massimo.',
    operation: 'build',
    type: 'concepts',
  },
  {
    instruction: 'Estraiamo il massimo. Non ordiniamo i valori.',
    operation: 'sort',
    type: 'algorithm',
  },
  {
    instruction: 'Heapsort uses a heap.',
    operation: 'sort',
    type: 'algorithm',
  },
])('publishes $type for heap $operation when narration says $instruction', async ({
  instruction,
  operation,
  type,
}) => {
  const narration = `Costruiamo un max heap con [4, 3]. ${instruction}`;
  generateStructuredOutputMock
    .mockResolvedValueOnce({
      type: 'algorithm',
      studio: 'heap',
      operandsAt: 1,
      spec: { operation, input: [4, 3], beats: [] },
    })
    .mockResolvedValue(null);
  expect(
    await generateLessonScene({
      ...studioRequest,
      lessonMarkdown: narration,
      studioNarration: narration,
    })
  ).toMatchObject({
    kind: 'scene',
    scene: { type, ...(type === 'algorithm' ? { studio: { spec: { operation } } } : {}) },
  });
});

test('publishes a studio when the generated scene passes the geometry gate', async () => {
  const narration = 'Confrontiamo 3 e 4. Il passaggio senza scambi conferma l’ordine.';
  generateStructuredOutputMock
    .mockResolvedValueOnce({
      ...bubbleDraft,
      operandsAt: 1,
      spec: { ...bubbleDraft.spec, input: [3, 4], callouts: [] },
    })
    .mockResolvedValueOnce(studioFallbackDraft);

  expect(
    await generateLessonScene({
      ...studioRequest,
      lessonMarkdown: narration,
      studioNarration: narration,
    })
  ).toMatchObject({
    kind: 'scene',
    scene: { type: 'algorithm' },
  });
  expect(generateStructuredOutputMock).toHaveBeenCalledTimes(1);
});

test('asks Terra on the standard tier and falls back when scene elements collide', async () => {
  generateStructuredOutputMock
    .mockResolvedValueOnce(bubbleDraft)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(studioFallbackDraft);
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    expect(await generateLessonScene(studioRequest)).toMatchObject({
      kind: 'scene',
      scene: { type: 'beforeafter' },
    });
    expect(log).toHaveBeenCalledWith(
      '[lesson-studio] fallback',
      expect.objectContaining({
        failedChecks: expect.arrayContaining(['overlap', 'min-gap']),
      })
    );
  } finally {
    log.mockRestore();
  }
  const [request] = generateStructuredOutputMock.mock.calls[0];
  expect(request.model).toEqual({
    provider: request.model.provider,
    model: request.model.provider === 'codex' ? 'gpt-6.1-terra' : 'openai/gpt-6.1-terra',
    reasoningEffort: 'low',
  });
});

const commonsSceneProposal = {
  type: 'image-annotate',
  concept: { it: 'Punto di fuga', en: 'Vanishing point' },
  query: 'perspective vanishing point',
};
const commonsThumbnail =
  'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Test.jpg/640px-Test.jpg';
const commonsSource = 'https://commons.wikimedia.org/wiki/File:Test.jpg';
const commonsNarration = 'Le linee parallele convergono in un punto di fuga.';
const illustratorInput = () => ({
  ...italianStudioInput(commonsNarration),
  allowedSceneTypes: ['geometry', 'concepts'] as const,
  stageStudioImage: vi.fn(
    async ({ bytes, mediaType }: { bytes: Uint8Array; mediaType: string }) => ({
      byteSize: bytes.byteLength,
      mediaType,
      id: 'a'.repeat(64),
      hash: 'b'.repeat(64),
    })
  ),
});

test.each([
  undefined,
  'images',
])('offers only annotated images with LESSON_STUDIOS_ENABLED=%s', async setting => {
  vi.stubEnv('LESSON_STUDIO_SELECTION_ENABLED', undefined);
  vi.stubEnv('LESSON_STUDIOS_ENABLED', setting);
  const input = illustratorInput();
  const calls: ReturnType<typeof currentWorkflowAiCallAttribution>[] = [];
  const answers = [{ type: 'catalog' }, sceneDraft(commonsNarration)];
  generateStructuredOutputMock.mockImplementation(async () => {
    calls.push(currentWorkflowAiCallAttribution());
    return answers.shift();
  });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);

  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    const outcome = await generateLessonScene({
      ...input,
      allowedSceneTypes: ['algorithm', 'geometry', 'concepts'],
    });
    expect(outcome).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
    expect(log).toHaveBeenCalledWith('[lesson-studio] catalog selected', {
      decisionId: calls[0]?.decisionId,
      reason: 'image-subject-decision',
      sceneType: 'concepts',
    });
  } finally {
    log.mockRestore();
  }
  expect(generateStructuredOutputMock).toHaveBeenCalledTimes(2);
  const [request] = generateStructuredOutputMock.mock.calls[0];
  expect(request.output.name).toBe('lesson_image_subject');
  const schema = JSON.stringify(request.output.schema);
  expect(schema).toContain('image-annotate');
  expect(schema).not.toMatch(/iconQueries|array-algorithm|function-plot|space-3d|geometryStudio/u);
  expect(request.system).toContain('concrete subject');
  expect(request.system).not.toMatch(
    /ICON SEARCH|complete operand list|array-algorithm|Dijkstra|geometryStudio/u
  );
  expect(generateStructuredOutputMock.mock.calls[1][0].output.name).toBe('lesson_scene');
  expect(calls).toEqual([
    { decisionId: expect.any(String), role: 'studio-selection' },
    { decisionId: calls[0]?.decisionId, role: 'catalog-fallback' },
  ]);
  expect(fetch).not.toHaveBeenCalled();
  expect(input.stageStudioImage).not.toHaveBeenCalled();
});

test('the explicit list supersedes the legacy all-studio switch and rejects an unoffered draft', async () => {
  vi.stubEnv('LESSON_STUDIOS_ENABLED', 'heap');
  generateStructuredOutputMock
    .mockResolvedValueOnce(bubbleDraft)
    .mockResolvedValueOnce(sceneDraft(studioNarration));
  const result = await generateLessonScene(studioRequest);
  expect(result).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
  expect(generateStructuredOutputMock).toHaveBeenCalledTimes(2);
  const [request] = generateStructuredOutputMock.mock.calls[0];
  expect(JSON.stringify(request.output.schema)).toContain('"heap"');
  expect(JSON.stringify(request.output.schema)).not.toContain('array-algorithm');
  expect(request.system).not.toContain('array-algorithm');
  const [catalogRequest] = generateStructuredOutputMock.mock.calls[1];
  expect(JSON.stringify(catalogRequest.output.schema)).toMatch(/beforeafter.*concepts/u);
});

function mockIllustrationFetch(media: Response, license = 'Public domain') {
  const fetch = vi.fn(async (url: URL) => {
    if (url.hostname === 'upload.wikimedia.org') return media;
    const pages = [
      {
        title: 'File:Test.jpg',
        imageinfo: [
          {
            descriptionurl: commonsSource,
            thumburl: commonsThumbnail,
            mime: 'image/jpeg',
            thumbwidth: 640,
            thumbheight: 500,
            extmetadata: {
              Artist: { value: 'Author' },
              LicenseShortName: { value: license },
            },
          },
        ],
      },
    ];
    return Response.json({ query: url.searchParams.has('gsrsearch') ? { pages } : {} });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

test('a stalled Commons request releases the step to the catalog within five seconds', async () => {
  vi.useFakeTimers();
  const input = illustratorInput();
  const stopped: AbortSignal[] = [];
  const fetch = vi.fn((_url: URL, request?: RequestInit) => {
    const signal = request?.signal;
    if (!signal) throw new Error('Commons lookup needs the retrieval signal');
    return new Promise<Response>((_, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          stopped.push(signal);
          reject(signal.reason);
        },
        { once: true }
      );
    });
  });
  vi.stubGlobal('fetch', fetch);
  generateStructuredOutputMock
    .mockResolvedValueOnce(commonsSceneProposal)
    .mockResolvedValueOnce(sceneDraft(commonsNarration));
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    const scene = generateLessonScene(input);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(stopped).toHaveLength(3);
    await expect(scene).resolves.toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
    expect(input.signal.aborted).toBe(false);
    expect(input.stageStudioImage).not.toHaveBeenCalled();
    const offered = log.mock.calls.find(([event]) => event === '[lesson-studio] offered')?.[1];
    expect(offered).toEqual(
      expect.objectContaining({
        decisionId: expect.any(String),
        offered: expect.arrayContaining(['image-annotate']),
      })
    );
    expect(log).toHaveBeenCalledWith('[lesson-studio] proposed', {
      decisionId: offered.decisionId,
      studio: 'image-annotate',
      subject: commonsSceneProposal.concept,
      query: commonsSceneProposal.query,
    });
    expect(log).toHaveBeenCalledWith(
      '[lesson-studio] Commons retrieval',
      expect.objectContaining({
        decisionId: offered.decisionId,
        durationMs: expect.any(Number),
      })
    );
    expect(log).toHaveBeenCalledWith(
      '[lesson-studio] fallback',
      expect.objectContaining({
        decisionId: offered.decisionId,
        studio: 'image-annotate',
        reason: 'commons-retrieval-timeout',
      })
    );
  } finally {
    vi.useRealTimers();
    log.mockRestore();
  }
});

test('a completed preview reaches vision even when another preview uses the remaining deadline', async () => {
  vi.useFakeTimers();
  const input = illustratorInput();
  const raster = createCanvas(7, 3).toBuffer('image/png');
  const fixture = mockIllustrationFetch(new Response(new Uint8Array(raster)));
  const slowThumb = commonsThumbnail.replaceAll('Test.jpg', 'Slow.jpg');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL, { signal }: RequestInit) => {
      if (url.href === slowThumb) {
        return new Promise<Response>((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      const response = await fixture(url);
      if (!url.searchParams.has('gsrsearch')) return response;
      const payload = await response.json();
      const first = payload.query.pages[0];
      const slow = {
        ...first,
        title: 'File:Slow.jpg',
        imageinfo: [
          {
            ...first.imageinfo[0],
            descriptionurl: commonsSource.replace('Test.jpg', 'Slow.jpg'),
            thumburl: slowThumb,
          },
        ],
      };
      return Response.json({ query: { pages: [first, slow] } });
    })
  );
  generateStructuredOutputMock
    .mockResolvedValueOnce(commonsSceneProposal)
    .mockRejectedValueOnce(new TypeError('vision transport failed'))
    .mockResolvedValueOnce(sceneDraft(commonsNarration));
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    const pending = generateLessonScene(input);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
    expect(generateStructuredOutputMock.mock.calls[1][0].images).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      '[lesson-studio] fallback',
      expect.objectContaining({
        reason: 'commons-vision-failed',
      })
    );
    expect(input.stageStudioImage).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    log.mockRestore();
  }
});

test('a chosen Commons thumbnail is read once and staged with actual raster dimensions and credit', async () => {
  const input = illustratorInput();
  const raster = createCanvas(7, 3).toBuffer('image/png');
  const fetch = mockIllustrationFetch(new Response(new Uint8Array(raster)));
  generateStructuredOutputMock.mockResolvedValueOnce(commonsSceneProposal).mockResolvedValueOnce({
    chosen: 1,
    annotation: {
      title: 'Punto di fuga',
      alt: 'Linee convergenti',
      beats: [{ at: 'b1', region: { x: 0.25, y: 0, w: 0.5, h: 1 } }],
    },
  });
  expect(await generateLessonScene(input)).toMatchObject({
    kind: 'scene',
    scene: {
      type: 'geometry',
      geometryStudio: {
        id: 'image-annotate',
        asset: { id: 'a'.repeat(64) },
        spec: {
          image: {
            width: 7,
            height: 3,
            source: commonsSource,
            author: 'Author',
            license: 'Public domain',
          },
        },
      },
    },
  });
  expect(input.stageStudioImage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ mediaType: 'image/png' })
  );
  expect(fetch.mock.calls.filter(([url]) => url.hostname === 'upload.wikimedia.org')).toHaveLength(
    1
  );
  const [request] = generateStructuredOutputMock.mock.calls[1];
  expect(request.images).toEqual([expect.stringMatching(/^data:image\/png;base64,/u)]);
  expect(request.prompt).toContain(JSON.stringify(['File:Test.jpg']));
});

test.each([
  { license: 'Public domain', status: 200, reason: 'commons-no-confident-pick', vision: true },
  { license: '', status: 200, reason: 'commons-no-eligible-candidate', vision: false },
  { license: 'Public domain', status: 429, reason: 'commons-thumbnail-failed', vision: false },
])('a Commons rejection uses the catalog without staging ($reason)', async ({
  license,
  status,
  reason,
  vision,
}) => {
  const input = illustratorInput();
  const raster = createCanvas(7, 3).toBuffer('image/png');
  mockIllustrationFetch(new Response(new Uint8Array(raster), { status }), license);
  generateStructuredOutputMock.mockResolvedValueOnce(commonsSceneProposal);
  if (vision)
    generateStructuredOutputMock.mockResolvedValueOnce({
      chosen: null,
      annotation: null,
      rejections: [{ candidate: 1, reason: 'target-not-visible' }],
    });
  generateStructuredOutputMock.mockResolvedValueOnce(sceneDraft(commonsNarration));
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    expect(await generateLessonScene(input)).toMatchObject({
      kind: 'scene',
      scene: { type: 'concepts' },
    });
    expect(input.stageStudioImage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      '[lesson-studio] fallback',
      expect.objectContaining({
        studio: 'image-annotate',
        decisionId: expect.any(String),
        reason,
      })
    );
    expect(generateStructuredOutputMock).toHaveBeenCalledTimes(vision ? 3 : 2);
    if (vision) {
      const decision = log.mock.calls.find(([event]) => event === '[lesson-studio] proposed')?.[1];
      expect(log).toHaveBeenCalledWith('[lesson-studio] Commons candidate rejected', {
        decisionId: decision?.decisionId,
        source: commonsSource,
        reason: 'target-not-visible',
      });
    }
  } finally {
    log.mockRestore();
  }
});

test.each(
  commonsVisionGold.filter(gold => gold.only)
)('keeps the catalog when the selector declines the $id distractors', async ({
  it,
  en,
  phrases,
}) => {
  const narration = phrases.join(' ');
  const input = illustratorInput();
  const raster = createCanvas(7, 3).toBuffer('image/png');
  mockIllustrationFetch(new Response(new Uint8Array(raster)));
  const calls: ReturnType<typeof currentWorkflowAiCallAttribution>[] = [];
  const answers = [
    { type: 'image-annotate', concept: { it, en }, query: en },
    { chosen: null, annotation: null },
    sceneDraft(narration),
  ];
  generateStructuredOutputMock.mockImplementation(async () => {
    calls.push(currentWorkflowAiCallAttribution());
    return answers.shift();
  });
  expect(
    await generateLessonScene({ ...input, studioNarration: narration, lessonMarkdown: narration })
  ).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
  expect(input.stageStudioImage).not.toHaveBeenCalled();
  expect(calls).toEqual([
    { decisionId: expect.any(String), role: 'studio-selection' },
    { decisionId: calls[0]?.decisionId, role: 'studio-selection' },
    { decisionId: calls[0]?.decisionId, role: 'catalog-fallback' },
  ]);
});

test('a picture without a visible annotation uses the catalog', async () => {
  const input = illustratorInput();
  const raster = createCanvas(7, 3).toBuffer('image/png');
  mockIllustrationFetch(new Response(new Uint8Array(raster)));
  generateStructuredOutputMock
    .mockResolvedValueOnce(commonsSceneProposal)
    .mockResolvedValueOnce({
      chosen: 1,
      annotation: {
        title: 'Punto di fuga',
        alt: 'Linee convergenti',
        beats: [{ at: 'b1' }],
      },
    })
    .mockResolvedValueOnce(sceneDraft(commonsNarration));
  expect(await generateLessonScene(input)).toMatchObject({
    kind: 'scene',
    scene: { type: 'concepts' },
  });
  expect(input.stageStudioImage).not.toHaveBeenCalled();
});

test('a Commons label that cannot fit uses the catalog with the measured stage and decision ID', async () => {
  const input = illustratorInput();
  const raster = createCanvas(7, 3).toBuffer('image/png');
  mockIllustrationFetch(new Response(new Uint8Array(raster)));
  generateStructuredOutputMock
    .mockResolvedValueOnce(commonsSceneProposal)
    .mockResolvedValueOnce({
      chosen: 1,
      annotation: {
        title: 'Punto di fuga',
        alt: 'Linee convergenti',
        beats: [{ at: 'b1', label: 'Le linee parallele convergono nello stesso punto di fuga.' }],
      },
    })
    .mockResolvedValueOnce(sceneDraft(commonsNarration));
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    expect(await generateLessonScene(input)).toMatchObject({
      kind: 'scene',
      scene: { type: 'concepts' },
    });
    expect(input.stageStudioImage).not.toHaveBeenCalled();
    const rejection = log.mock.calls.find(
      ([event]) => event === '[lesson-studio] reader layout rejected'
    );
    expect(rejection?.[1]).toMatchObject({
      studio: 'image-annotate',
      decisionId: expect.any(String),
      width: expect.any(Number),
      height: expect.any(Number),
      checks: ['label-placement'],
    });
    expect(log).toHaveBeenCalledWith(
      '[lesson-studio] fallback',
      expect.objectContaining({
        decisionId: rejection?.[1].decisionId,
        reason: 'commons-layout-rejected',
        failedChecks: ['label-placement'],
      })
    );
  } finally {
    log.mockRestore();
  }
});

test('an out-of-range phrase ID uses the declared catalog fallback', async () => {
  generateStructuredOutputMock
    .mockResolvedValueOnce({
      ...bubbleDraft,
      spec: { ...bubbleDraft.spec, callouts: [{ at: 99, event: 'swap#1' }] },
    })
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(studioFallbackDraft);
  expect(await generateLessonScene(studioRequest)).toMatchObject({
    kind: 'scene',
    scene: { type: 'beforeafter' },
  });
  expect(generateStructuredOutputMock).toHaveBeenCalledTimes(3);
  const fallbackSchema = z.fromJSONSchema(
    generateStructuredOutputMock.mock.calls[2][0].output.schema
  );
  expect(fallbackSchema.safeParse(bubbleDraft).success).toBe(false);
});

test('preserves the ordinary catalog choice when the studio and its restricted replacement fail', async () => {
  const narration = 'Prima la ricerca trova il valore. Poi la ricerca non trova il valore.';
  generateStructuredOutputMock
    .mockResolvedValueOnce({ type: 'algorithm', studio: 'array-algorithm', spec: {} })
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ type: 'beforeafter' })
    .mockResolvedValueOnce(sceneDraft(narration));

  expect(
    await generateLessonScene({
      ...studioRequest,
      lessonMarkdown: narration,
      studioNarration: narration,
    })
  ).toMatchObject({ kind: 'scene', scene: { type: 'concepts' } });
  expect(generateStructuredOutputMock.mock.calls.map(([request]) => request.output.name)).toEqual([
    'lesson_studio_selection',
    'lesson_studio_selection',
    'lesson_scene',
    'lesson_scene',
  ]);
});

test('attributes studio selection and both catalog calls to the same decision', async () => {
  const observations: ReturnType<typeof currentWorkflowAiCallAttribution>[] = [];
  const responses = [
    { type: 'algorithm', studio: 'heap', spec: {} },
    null,
    null,
    sceneDraft(studioNarration),
  ];
  generateStructuredOutputMock.mockImplementation(async () => {
    observations.push(currentWorkflowAiCallAttribution());
    return responses.shift();
  });
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    expect(await generateLessonScene(studioRequest)).toMatchObject({ kind: 'scene' });
    expect(observations).toEqual([
      { decisionId: expect.any(String), role: 'studio-selection' },
      { decisionId: observations[0]?.decisionId, role: 'studio-repair' },
      { decisionId: observations[0]?.decisionId, role: 'catalog-fallback' },
      { decisionId: observations[0]?.decisionId, role: 'catalog-repair' },
    ]);
    expect(log).toHaveBeenCalledWith(
      '[lesson-studio] fallback',
      expect.objectContaining({ decisionId: observations[0]?.decisionId })
    );
  } finally {
    log.mockRestore();
  }
});

test('a generated heap must declare whether it ends at construction or sorts', () => {
  const narration = 'Sistemiamo i due valori. Il massimo arriva in cima.';
  const candidate = {
    type: 'algorithm',
    studio: 'heap',
    spec: { input: [4, 3], beats: [{ at: 2, event: 'heapified' }] },
  };
  const phrases = segmentStudioPhrases(narration);
  expect(decodeStudioDraft(candidate, narration, phrases)).toBeUndefined();
  expect(
    decodeStudioDraft(
      { ...candidate, spec: { ...candidate.spec, operation: 'build' } },
      narration,
      phrases
    )
  ).toMatchObject({
    title: 'Costruzione di un max-heap',
    studio: { spec: { operation: 'build' } },
  });
});

test('keeps a renderable authored catalog scene when every replacement response fails', async () => {
  generateStructuredOutputMock
    .mockResolvedValueOnce({ type: 'algorithm', studio: 'heap', spec: {} })
    .mockResolvedValue(null);
  const onValidatedScene = vi.fn();

  const outcome = await generateLessonScene({
    ...studioRequest,
    onValidatedScene,
  });
  expect(outcome).toMatchObject({
    kind: 'scene',
    scene: {
      type: 'concepts',
      items: [{ label: 'Confrontiamo 4 e 3.' }, { label: 'I due valori si scambiano.' }],
    },
  });
  if (outcome.kind !== 'scene') throw new Error('Expected a visual instead of a retry slot');
  expect(LessonSceneSchema.safeParse(outcome.scene).success).toBe(true);
  expect(isRetiredLessonScene(outcome.scene)).toBe(false);
  expect(onValidatedScene).toHaveBeenCalledExactlyOnceWith(outcome.scene);
});

test('a studio whose action ends before the narration falls back instead of leaving a stale stage', async () => {
  const tail = 'La spiegazione prosegue con materiale non rappresentato. '.repeat(10);
  const narration = `${studioNarration} ${tail}`;
  generateStructuredOutputMock
    .mockResolvedValueOnce(bubbleDraft)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(studioFallbackDraft);
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    expect(
      await generateLessonScene({
        ...studioRequest,
        lessonMarkdown: narration,
        studioNarration: narration,
      })
    ).toMatchObject({ kind: 'scene', scene: { type: 'beforeafter' } });
    expect(log).toHaveBeenCalledWith(
      '[lesson-studio] fallback',
      expect.objectContaining({
        failedChecks: expect.arrayContaining(['dead-stage']),
      })
    );
  } finally {
    log.mockRestore();
  }
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

const prepareQuantitativePlayback = (
  speech: string,
  contract: Partial<Parameters<typeof prepareLessonPlaybackVisuals>[0]> = {}
) =>
  prepareLessonPlaybackVisuals({
    userId: 'quantitative-playback-test',
    config: getGlobalModelConfig(),
    voice: 'Kore',
    lesson: { title: 'Measurements', sources: [{ type: 'markdown', markdown: speech }] },
    signal: new AbortController().signal,
    block: {
      id: 'quantities',
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
    ...contract,
  });

type HeatmapReviewFixture = {
  quote: string;
  role: 'applies' | 'observation' | 'other-scope' | 'not-a-range' | 'unclear';
  unit: string | null;
  qualifier?: string;
};

const reviewHeatmapRanges = (
  claims: readonly HeatmapReviewFixture[],
  unmatched: 'not-a-range' | 'unclear' = 'not-a-range'
) =>
  generateStructuredOutputMock.mockImplementationOnce(async ({ prompt }: { prompt: string }) => {
    const { lesson, possibleRanges } = JSON.parse(prompt) as {
      lesson: string;
      possibleRanges: { id: number; start: number; text: string }[];
    };
    const visible = lesson.replaceAll('\n', ' ');
    return {
      ranges: possibleRanges.map(range => {
        const claimed = claims.find(({ quote }) => {
          const plain = quote.replaceAll('**', '');
          const start = visible.lastIndexOf(plain);
          return (
            start >= 0 &&
            range.start >= start &&
            range.start + range.text.length <= start + plain.length
          );
        });
        return {
          id: range.id,
          ...(claimed ?? { role: unmatched, quote: lesson, unit: null }),
        };
      }),
    };
  });

const confirmHeatmapScale = (quote: string, unit: string, unmatched?: 'not-a-range' | 'unclear') =>
  reviewHeatmapRanges([{ quote, unit, role: 'applies' }], unmatched);

test.each([
  {
    type: 'security',
    source:
      'For records, owners can edit, reviewers can read, and visitors have no access. For notes, owners can read, reviewers can edit and visitor access is unknown.',
    columns: ['Owner', 'Reviewer', 'Visitor'],
    rows: [
      { label: 'Records', values: ['Edit', 'Read', 'No access'] },
      { label: 'Notes', values: ['Read', 'Edit', 'Unknown'] },
    ],
  },
  {
    type: 'heatmap',
    source: 'Use a scale of 0 to 10 cases. The north reports 0, 2.5 and 10 across three months.',
    columns: ['January', 'February', 'March'],
    rows: [{ label: 'North', values: [0, 2.5, 10] }],
    max: 10,
    unit: 'cases',
  },
] as const)('corrects an incomplete $type matrix and preserves every ordered cell on retry', async example => {
  const { source, type, ...table } = example;
  const input = unplannedInput(source);
  const draft = {
    ...sceneDraft(source),
    ...table,
    ...(type === 'heatmap' ? { scaleEvidence: 'scale of 0 to 10 cases' } : {}),
    items: [],
    type: 'matrix',
    variant: type,
  };
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...draft,
    rows: [{ ...table.rows[0], values: table.rows[0].values.slice(1) }],
  });
  const invalid = await generateLessonScene(input);
  expect(invalid).toMatchObject({ kind: 'invalid', problems: ['Invalid matrix dimensions.'] });
  if (invalid.kind !== 'invalid') throw new Error('Expected corrective feedback');
  expect(chooseIconsMock).not.toHaveBeenCalled();

  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  if (type === 'heatmap') confirmHeatmapScale('scale of 0 to 10 cases', example.unit);
  const corrected = await generateLessonScene({
    ...input,
    retryFeedback: invalid.problems.join('\n'),
  });
  expect(corrected).toMatchObject({ kind: 'scene', scene: { ...table, type } });
  const { output } =
    generateStructuredOutputMock.mock.calls.findLast(
      ([request]) => request.output.name === 'lesson_scene'
    )?.[0] ?? {};
  const schema = z.fromJSONSchema(output.schema);
  const { variant: _variant, ...fields } = draft;
  const legacy = { ...fields, type };
  expect(schema.safeParse(draft).success).toBe(true);
  expect(schema.safeParse(legacy).success).toBe(false);

  generateStructuredOutputMock.mockResolvedValueOnce(legacy);
  if (type === 'heatmap') confirmHeatmapScale('scale of 0 to 10 cases', example.unit);
  expect(await generateLessonScene({ ...input, allowedSceneTypes: [type] })).toEqual(corrected);
  generateStructuredOutputMock.mockResolvedValueOnce(fields);
  expect(await generateLessonScene(input)).toMatchObject({ kind: 'invalid' });
});

test('accepts only the full sourced heatmap scale when observations stop below it', async () => {
  const source =
    'Use a scale of 0 to 10 cases per week. North reports 0 in January and 5 in February.';
  const draft = {
    ...sceneDraft(source),
    type: 'matrix',
    variant: 'heatmap',
    items: [],
    columns: ['January', 'February'],
    rows: [{ label: 'North', values: [0, 5] }],
    max: 10,
    unit: 'cases per week',
    scaleEvidence: 'scale of 0 to 10 cases per week',
  };
  for (const change of [
    { max: 5 },
    { scaleEvidence: 'scale of 0 to 5 cases per week', max: 5 },
    { scaleEvidence: 'scale of 0 to 10 cases', unit: 'cases' },
    { unit: 'cases per month' },
    { scaleEvidence: undefined },
  ]) {
    const { scaleEvidence, ...candidate } = { ...draft, ...change };
    generateStructuredOutputMock.mockResolvedValueOnce({
      ...candidate,
      ...(scaleEvidence === undefined ? {} : { scaleEvidence }),
    });
    const result = await generateLessonScene(unplannedInput(source));
    expect(result).toMatchObject({ kind: 'scene', scene: { type: 'heatmap', rows: draft.rows } });
    if (result.kind !== 'scene') throw new Error('Expected a numeric table');
    expect(result.scene).not.toHaveProperty('max');
    expect(result.scene).not.toHaveProperty('unit');
  }
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  confirmHeatmapScale(draft.scaleEvidence, draft.unit);
  const outcome = await generateLessonScene(unplannedInput(source));
  expect(outcome).toMatchObject({
    kind: 'scene',
    scene: { type: 'heatmap', max: 10, unit: draft.unit, rows: draft.rows },
  });
  if (outcome.kind !== 'scene') throw new Error('Expected a heatmap');
  expect(outcome.scene).not.toHaveProperty('scaleEvidence');
});

test.each([
  { declaration: 'escala de 0 a 10 puntos', unit: 'puntos', markdown: 'escala de 0 a 10 puntos' },
  { declaration: 'Scale of 0 to 10 cases', unit: 'cases', markdown: '**Scale of 0 to 10 cases**' },
  {
    declaration: '**Scale of 0 to 10 cases**',
    unit: 'cases',
    markdown: '**Scale of 0 to 10 cases**',
  },
])('grounds the visible heatmap scale "$declaration"', async ({ declaration, unit, markdown }) => {
  const values = 'North reports 0 in January and 5 in February.';
  const source = `${markdown}\n\n${values}`;
  const draft = {
    ...sceneDraft(values),
    type: 'matrix',
    variant: 'heatmap',
    items: [],
    columns: ['January', 'February'],
    rows: [{ label: 'North', values: [0, 5] }],
    max: 10,
    unit,
    scaleEvidence: declaration,
  };
  for (const change of [{ max: 5 }, { scaleEvidence: declaration.replace('10', '5'), max: 5 }]) {
    generateStructuredOutputMock.mockResolvedValueOnce({ ...draft, ...change });
    const result = await generateLessonScene(unplannedInput(source));
    expect(result).toMatchObject({ kind: 'scene', scene: { rows: draft.rows } });
    if (result.kind !== 'scene') throw new Error('Expected a numeric table');
    expect(result.scene).not.toHaveProperty('max');
  }
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  confirmHeatmapScale(declaration, unit);
  expect(await generateLessonScene(unplannedInput(source))).toMatchObject({
    kind: 'scene',
    scene: { type: 'heatmap', max: 10, unit, rows: draft.rows },
  });
});
test('keeps a visible heatmap scale when the draft puts the unit in unitLabel', async () => {
  const quote = '**Scale of 0 to 10 cases**';
  const source = `${quote}\n\nNorth reports 0 in January and 5 in February.`;
  const draft = {
    ...sceneDraft(source),
    type: 'matrix',
    variant: 'heatmap',
    items: [],
    columns: ['January', 'February'],
    rows: [{ label: 'North', values: [0, 5] }],
    max: 10,
    unitLabel: 'cases',
    scaleEvidence: quote,
  };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  confirmHeatmapScale('Scale of 0 to 10 cases', 'cases');

  const result = await generateLessonScene(unplannedInput(source));
  expect(result).toMatchObject({
    kind: 'scene',
    scene: { rows: draft.rows, max: 10, unit: 'cases' },
  });
  if (result.kind !== 'scene') throw new Error('Expected a heatmap');
  expect(result.scene).not.toHaveProperty('unitLabel');
});

test.each([
  {
    declaration: 'scale of 0 to 10 cases for every region',
    source: 'Use a scale of 0 to 10 cases for every region. North reports 0 and 5.',
    confirmed: false,
  },
  {
    declaration: 'La escala de 0 a 10 puntos, compartida por todas las celdas.',
    source: 'La escala de 0 a 10 puntos, compartida por todas las celdas. Norte registra 0 y 5.',
    unit: 'puntos',
    confirmed: false,
  },
  {
    declaration: 'La escala de 0 a 10 puntos; compartida por todas las celdas.',
    source: 'La escala de 0 a 10 puntos; compartida por todas las celdas. Norte registra 0 y 5.',
    unit: 'puntos',
  },
  {
    declaration: 'Scale of 0 to 10 cases',
    source:
      'DraftScale of 0 to 10 cases is a heading key. Scale of 0 to 10 cases. North reports 0 and 5.',
  },
])('checks the unit boundary in "$source"', async ({
  declaration,
  source,
  unit = 'cases',
  confirmed = true,
}) => {
  const draft = {
    ...sceneDraft(source),
    type: 'matrix',
    variant: 'heatmap',
    items: [],
    columns: ['January', 'February'],
    rows: [{ label: 'North', values: [0, 5] }],
    max: 10,
    unit,
    scaleEvidence: declaration,
  };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  confirmHeatmapScale(declaration, unit);
  const result = await generateLessonScene(unplannedInput(source));
  expect(result).toMatchObject({ kind: 'scene', scene: { type: 'heatmap', rows: draft.rows } });
  if (result.kind !== 'scene') throw new Error('Expected exact values');
  expect(result.scene.max).toBe(confirmed ? 10 : undefined);
  expect(result.scene.unit).toBe(confirmed ? unit : undefined);
});
test.each([
  {
    source: 'Scale: 0–10 cases. Observed range: 0–5 cases.',
    quote: 'Observed range: 0–5 cases',
    max: 5,
    unit: 'cases',
    confirmed: false,
    scale: { quote: 'Scale: 0–10 cases', max: 10, unit: 'cases' },
  },
  {
    source: 'Use a scale of 0 to 10 cases per week. North reports 0 and 5.',
    quote: 'Use a scale of 0 to 10 cases per week',
    max: 10,
    unit: 'cases',
    confirmed: false,
    scale: { quote: 'Use a scale of 0 to 10 cases per week', max: 10, unit: 'cases per week' },
  },
  {
    source: '<!-- Scale: 0–5 cases -->\n\nScale: 0–10 cases. North reports 0 and 5.',
    quote: 'Scale: 0–5 cases',
    max: 5,
    unit: 'cases',
    confirmed: false,
    scale: { quote: 'Scale: 0–10 cases', max: 10, unit: 'cases' },
  },
  {
    source: '<!-- Scale: 0–5 cases -->\n\nScale: 0–10 cases. North reports 0 and 5.',
    quote: 'Scale: 0–10 cases',
    max: 10,
    unit: 'cases',
    confirmed: true,
  },
  {
    source: 'Escala de 0 a 10 casos, por semana en cada región. Norte registra 0 y 5.',
    quote: 'Escala de 0 a 10 casos, por semana en cada región',
    max: 10,
    unit: 'casos',
    confirmed: false,
    scale: {
      quote: 'Escala de 0 a 10 casos, por semana en cada región',
      max: 10,
      unit: 'casos, por semana',
    },
  },
  {
    source: 'One scale is 0–10 cases. Another scale is 0–5 cases. North reports 0 and 5.',
    quote: 'One scale is 0–10 cases',
    max: 10,
    unit: 'cases',
    confirmed: false,
    scale: null,
  },
  {
    source: 'Scale: 0–10%. North reports 0 and 5.',
    quote: 'Scale: 0–10%',
    max: 10,
    unit: '%',
    confirmed: true,
  },
  {
    source: 'Scale: 0–10  \n**cases per week**. North reports 0 and 5.',
    quote: 'Scale: 0–10 cases per week',
    max: 10,
    unit: 'cases per week',
    confirmed: true,
  },
  {
    source: 'Escala de 0 a 10 puntos, para todas las estaciones. Norte registra 0 y 5.',
    quote: 'Escala de 0 a 10 puntos, para todas las estaciones',
    max: 10,
    unit: 'puntos',
    confirmed: false,
  },
])('uses a bar only when the scale and complete unit are clear in "$source"', async example => {
  const draft = {
    ...sceneDraft(example.source),
    type: 'matrix',
    variant: 'heatmap',
    items: [],
    columns: ['January', 'February'],
    rows: [{ label: 'North', values: [0, 5] }],
    max: example.max,
    unit: example.unit,
    scaleEvidence: example.quote,
  };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  const scale =
    example.scale === undefined
      ? { max: example.max, unit: example.unit, quote: example.quote }
      : example.scale;
  if (scale) confirmHeatmapScale(scale.quote, scale.unit);
  else reviewHeatmapRanges([], 'unclear');
  const outcome = await generateLessonScene(unplannedInput(example.source));
  const verification = generateStructuredOutputMock.mock.calls.find(
    ([request]) => request.output.name === 'heatmap_source_scale'
  )?.[0];
  if (example.source.startsWith('<!--') && !example.confirmed) {
    expect(verification).toBeUndefined();
  } else if (verification) {
    expect(JSON.parse(verification.prompt)).toEqual(expect.objectContaining({ rows: draft.rows }));
    expect(JSON.parse(verification.prompt)).not.toHaveProperty('max');
    expect(JSON.parse(verification.prompt).lesson).not.toContain('<!--');
    if (example.source.startsWith('<!--'))
      expect(JSON.parse(verification.prompt).lesson).not.toContain('Scale: 0–5 cases');
  }
  if (example.confirmed) expect(verification).toBeDefined();
  expect(outcome).toMatchObject({ kind: 'scene', scene: { type: 'heatmap', rows: draft.rows } });
  if (outcome.kind !== 'scene') throw new Error('Expected the numeric table');
  expect(outcome.scene.max).toBe(example.confirmed ? example.max : undefined);
  expect(outcome.scene.unit).toBe(example.confirmed ? example.unit : undefined);
});
test.each([
  {
    source:
      'Survey. <span hidden>Scale: 0–5 cases.</span> Scale: 0–10 cases. North reports 0 and 5.',
    quote: 'Scale: 0–5 cases',
    max: 5,
    unit: 'cases',
    expected: undefined,
  },
  {
    source:
      'Survey. <span hidden>Scale: 0–5 cases.</span> Scale: 0–10 cases. North reports 0 and 5.',
    quote: 'Scale: 0–10 cases',
    max: 10,
    unit: 'cases',
    expected: 10,
  },
  {
    source: '**Scale: 0%–10%**. North reports 0 and 5.',
    quote: 'Scale: 0%–10%',
    max: 10,
    unit: '%',
    expected: 10,
  },
  {
    source:
      'The table may use either scale. Scale: 0–10 cases. Scale: 0–5 cases. North reports 0 and 5.',
    quote: 'Scale: 0–10 cases',
    max: 10,
    unit: 'cases',
    expected: undefined,
  },
  {
    source: 'Both scales are listed. Scale: 0–10 cases. Scale: 0–10 points. North reports 0 and 5.',
    quote: 'Scale: 0–10 cases',
    max: 10,
    unit: 'cases',
    expected: undefined,
  },
  {
    source: 'Use either scale of 0 to 10 cases or 0 to 5 cases here. North reports 0 and 5.',
    quote: 'Use either scale of 0 to 10 cases or 0 to 5 cases here',
    max: 10,
    unit: 'cases',
    expected: undefined,
  },
])('keeps only a unique visible scale for "$source" and "$quote"', async example => {
  const draft = {
    ...sceneDraft(example.source),
    type: 'matrix',
    variant: 'heatmap',
    items: [],
    columns: ['January', 'February'],
    rows: [{ label: 'North', values: [0, 5] }],
    max: example.max,
    unit: example.unit,
    scaleEvidence: example.quote,
  };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  confirmHeatmapScale(example.quote, example.unit, example.expected ? 'not-a-range' : 'unclear');
  const outcome = await generateLessonScene(unplannedInput(example.source));
  expect(outcome).toMatchObject({ kind: 'scene', scene: { rows: draft.rows } });
  if (outcome.kind !== 'scene') throw new Error('Expected a numeric table');
  expect(outcome.scene.max).toBe(example.expected);
});

test.each([
  {
    source: 'North reports 0 on a scale of 0–10 cases. Then it reports 5.',
    quote: 'scale of 0–10 cases',
    reason: 'not-a-range',
    relatedQuote: 'North reports 0 on a scale of 0–10 cases',
    expected: 10,
  },
  {
    source: 'Scale: 0–10 cases. Observed range: 0–5 cases.',
    quote: 'Scale: 0–10 cases',
    reason: 'observation',
    relatedQuote: 'Observed range: 0–5 cases',
    expected: 10,
  },
  {
    source: 'North scale: 0–10 cases. South scale: 0–5 cases. North reports 0 and 5.',
    quote: 'North scale: 0–10 cases',
    reason: 'other-scope',
    relatedQuote: 'South scale: 0–5 cases',
    expected: 10,
  },
  {
    source: 'Both scales may apply. Scale: 0–10 cases. Alternative scale: from 0 to 5 cases.',
    quote: 'Scale: 0–10 cases',
    reason: 'applies',
    relatedQuote: 'Alternative scale: from 0 to 5 cases',
    relatedUnit: 'cases',
    expected: undefined,
  },
  {
    source:
      'Both scales may apply. Scale: 0–10 cases. Alternative scale: 0–10 cases per week. North reports 0 and 5.',
    quote: 'Scale: 0–10 cases',
    reason: 'applies',
    relatedQuote: 'Alternative scale: 0–10 cases per week',
    relatedUnit: 'cases per week',
    expected: undefined,
  },
] as const)('uses the scale for this table in "$source"', async example => {
  const draft = {
    ...sceneDraft(example.source),
    type: 'matrix',
    variant: 'heatmap',
    items: [],
    columns: ['January', 'February'],
    rows: [{ label: 'North', values: [0, 5] }],
    max: 10,
    unit: 'cases',
    scaleEvidence: example.quote,
  };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  reviewHeatmapRanges([
    { quote: example.quote, unit: draft.unit, role: 'applies' },
    {
      quote: example.relatedQuote,
      unit: 'relatedUnit' in example ? example.relatedUnit : null,
      role: example.reason,
    },
  ]);

  const result = await generateLessonScene(unplannedInput(example.source));
  expect(result).toMatchObject({ kind: 'scene', scene: { rows: draft.rows } });
  if (result.kind !== 'scene') throw new Error('Expected a numeric table');
  expect(result.scene.max).toBe(example.expected);
  expect(result.scene.unit).toBe(example.expected ? draft.unit : undefined);
  const verification = generateStructuredOutputMock.mock.calls.find(
    ([request]) => request.output.name === 'heatmap_source_scale'
  )?.[0];
  expect(JSON.parse(verification.prompt).possibleRanges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: '0–10' }),
      expect.objectContaining({ text: expect.stringContaining('0') }),
    ])
  );
  expect(JSON.parse(verification.prompt).possibleRanges.length).toBeGreaterThanOrEqual(2);
});

test.each([
  {
    ranges: [{ id: 0, role: 'applies', quote: 'Scale: 0–10 cases', unit: 'cases' }],
  },
  {
    ranges: [
      { id: 0, role: 'applies', quote: 'Scale: 0–10 cases', unit: 'cases' },
      { id: 1, role: 'other-scope', quote: 'South alone uses 0 to 5 cases', unit: null },
    ],
  },
])('keeps numbers when possible scale choices lack grounded review', async response => {
  const source = 'Both scales may apply. Scale: 0–10 cases. Scale: 0 to 5 cases.';
  const rows = [{ label: 'North', values: [0, 5] }];
  generateStructuredOutputMock
    .mockResolvedValueOnce({
      ...sceneDraft(source),
      type: 'matrix',
      variant: 'heatmap',
      items: [],
      columns: ['January', 'February'],
      rows,
      max: 10,
      unit: 'cases',
      scaleEvidence: 'Scale: 0–10 cases',
    })
    .mockResolvedValueOnce(response);
  const outcome = await generateLessonScene(unplannedInput(source));
  expect(outcome).toMatchObject({ kind: 'scene', scene: { rows } });
  if (outcome.kind !== 'scene') throw new Error('Expected a numeric table');
  expect(outcome.scene).not.toHaveProperty('max');
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

test.each([
  {
    label: 'the Spanish scope qualifier',
    source: 'Escala de 0 a 10 puntos, compartida por todas las celdas. Norte registra 2 y 5.',
    quote: 'Escala de 0 a 10 puntos, compartida por todas las celdas',
    qualifier: ', compartida por todas las celdas',
    unit: 'puntos',
    expected: 10,
  },
  {
    label: 'a Spanish scale cited by a draft with no maximum',
    source: 'Escala de 0 a 10 puntos, compartida por todas las celdas. Norte registra 2 y 5.',
    quote: 'Escala de 0 a 10 puntos, compartida por todas las celdas',
    qualifier: 'compartida por todas las celdas',
    reviewQualifier: 'compartida por todas las celdas',
    unit: 'puntos',
    omitMaximum: true,
    expected: 10,
  },
  {
    label: 'the English scope qualifier',
    source: 'Use a scale of 0 to 10 cases for every region. North reports 2 and 5.',
    quote: 'Use a scale of 0 to 10 cases for every region',
    qualifier: 'for every region',
    unit: 'cases',
    expected: 10,
  },
  {
    label: 'a scope omitted from the draft field but visible in the full quote',
    source: 'Use a scale of 0 to 10 cases for every region. North reports 2 and 5.',
    quote: 'Use a scale of 0 to 10 cases for every region',
    unit: 'cases',
    reviewQualifier: 'for every region',
  },
  {
    label: 'a separate scope with source punctuation',
    source: 'Escala de 0 a 10 puntos, compartida por todas las celdas. Norte registra 2 y 5.',
    quote: 'Escala de 0 a 10 puntos',
    reviewQuote: 'Escala de 0 a 10 puntos, compartida por todas las celdas',
    qualifier: 'compartida por todas las celdas.',
    reviewQualifier: ', compartida por todas las celdas',
    unit: 'puntos',
    expected: 10,
  },
  {
    label: 'an exclusion without its scope',
    source: 'Scale: 0–10 cases. Alternative scale: from 0 to 5 cases. North reports 2 and 5.',
    quote: 'Scale: 0–10 cases',
    unit: 'cases',
    alternate: { quote: '0 to 5 cases', role: 'other-scope', unit: null },
  },
  {
    label: 'a competing scale that starts at one',
    source: 'Scale: 0–10 cases. Alternative scale: 1–5 cases. North reports 2 and 5.',
    quote: 'Scale: 0–10 cases',
    unit: 'cases',
    alternate: { quote: 'Alternative scale: 1–5 cases', role: 'applies', unit: 'cases' },
  },
  {
    label: 'a verifier tries to recast an unclaimed rate as scope',
    source: 'Scale: 0–10 cases per week. North reports 2 and 5.',
    quote: 'Scale: 0–10 cases per week',
    unit: 'cases',
    reviewQualifier: 'per week',
  },
  {
    label: 'the same incomplete unit from both models',
    source: 'Scale: 0–10 cases per week. North reports 2 and 5.',
    quote: 'Scale: 0–10 cases per week',
    unit: 'cases',
  },
  {
    label: 'a scale before a sentence beginning with a number',
    source: 'Scale: 0–10 cases. 10 cases were counted overall. North reports 2 and 5.',
    quote: 'Scale: 0–10 cases',
    unit: 'cases',
    expected: 10,
  },
  {
    label: 'a rate the verifier identifies as part of the unit',
    source: 'Scale: 0–10 cases per week. North reports 2 and 5.',
    quote: 'Scale: 0–10 cases per week',
    unit: 'cases',
    qualifier: 'per week',
    reviewUnit: 'cases per week',
  },
  {
    label: 'a qualified complete rate',
    source: 'Use a scale of 0 to 10 cases per week for every region. North reports 2 and 5.',
    quote: 'Use a scale of 0 to 10 cases per week for every region',
    unit: 'cases per week',
    qualifier: 'for every region',
    expected: 10,
  },
  {
    label: 'a confirmed complete unit',
    source: 'Scale: 0–10 cases per week. North reports 2 and 5.',
    quote: 'Scale: 0–10 cases per week',
    unit: 'cases per week',
    expected: 10,
  },
] as const)('prepares heatmap values with $label', async example => {
  const rows = [{ label: 'North', values: [2, 5] }];
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...sceneDraft(example.source),
    type: 'matrix',
    variant: 'heatmap',
    items: [],
    columns: ['January', 'February'],
    rows,
    ...(!('omitMaximum' in example) ? { max: 10 } : {}),
    unit: example.unit,
    scaleEvidence: example.quote,
    ...('qualifier' in example ? { scaleQualifier: example.qualifier } : {}),
  });
  reviewHeatmapRanges([
    {
      quote: 'reviewQuote' in example ? example.reviewQuote : example.quote,
      unit: 'reviewUnit' in example ? example.reviewUnit : example.unit,
      role: 'applies',
      ...('reviewQualifier' in example
        ? { qualifier: example.reviewQualifier }
        : 'qualifier' in example && !('reviewUnit' in example)
          ? { qualifier: example.qualifier }
          : {}),
    },
    ...('alternate' in example ? [example.alternate] : []),
  ]);
  const prepared = await prepareQuantitativePlayback(example.source);
  const expected = 'expected' in example ? example.expected : undefined;
  expect(prepared.scene).toMatchObject({ type: 'heatmap', rows });
  expect(prepared.scene?.max).toBe(expected);
  expect(prepared.scene?.unit).toBe(expected ? example.unit : undefined);
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
  const registry = readProductionRegistry();
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
    _textOnly,
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

const repeatedStudioCue = 'Ora confrontiamo questi valori.';
const repeatedStudioNarration = `Partiamo da [3, 4]. ${repeatedStudioCue} ${repeatedStudioCue}`;

test.each([
  {
    name: 'heap construction',
    narration: 'Costruiamo un max heap con [4, 3]. La struttura finale rimane sullo schermo.',
    draft: {
      type: 'algorithm',
      studio: 'heap',
      spec: { input: [4, 3], operation: 'build', beats: [{ at: 1, event: 'heapified' }] },
    },
    detail: { studio: { spec: { operation: 'build' } } },
  },
  ...([0, 1] as const).map(occurrence => ({
    name: `repeated cue occurrence ${occurrence}`,
    narration: repeatedStudioNarration,
    draft: {
      ...bubbleDraft,
      operandsAt: 1,
      spec: {
        ...bubbleDraft.spec,
        input: [3, 4],
        callouts: [{ at: 2 + occurrence, event: 'compare#1' }],
      },
    },
    detail: { studioCues: [{ anchor: repeatedStudioCue, occurrence }] },
  })),
])('the deployed v18 checkpoint preserves $name', async ({ narration, draft, detail }) => {
  const registry = readProductionRegistry();
  const workflowId = 'lesson-generation';
  const v18 = workflowContracts
    .find(entry => entry.version === 18)
    ?.current.find(boundary => boundary.workflowId === workflowId);
  if (!v18) throw new Error('Expected deployed workflow v18');
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
  const definition = registry.resolve(workflowId, v18.definitionHash);
  if (!definition) throw new Error('Expected a registered lesson workflow');
  generateStructuredOutputMock.mockResolvedValueOnce(draft).mockResolvedValue(null);
  const nodeId = [...indexWorkflowNodes(definition)].find(
    ([, { node }]) => node.id === 'render-scene'
  )?.[0];
  if (!nodeId) throw new Error('Expected the pending scene step');
  const { maxAttempts, timeoutMs } = definition.executionDefaults;
  const result = await runWorkflowStepClaim({
    registry,
    store,
    services: { generateScene: generateLessonScene, now: () => '2026-11-18T00:00:00Z' },
    claim: {
      kind: 'step',
      workflowId,
      definitionHash: definition.definitionHash,
      definitionHashVersion: definition.definitionHashVersion,
      nodeDefinitionId: nodeId,
      nodeInstanceId: nodeId,
      attemptNumber: 1,
      fencingToken: '1',
      maxAttempts,
      timeoutMs,
      leaseExpiresAt: '2026-11-19T00:00:00Z',
      retryFeedback: '',
      runId: '11111111-1111-4111-8111-111111111111',
      userId: 'learner',
      workerId: 'worker',
      stepPolicies: {
        [nodeId]: { config: definition.executionDefaults, maxAttempts, timeoutMs },
      },
      stepPoliciesVersion: 1,
      input: {
        userId: 'learner',
        projectId: 'project',
        sectionId: 'lesson',
        contextFingerprint: 'b'.repeat(64),
        lessonMarkdown: narration,
        studioNarration: narration,
        studioLanguage: 'it-IT',
        sectionTitle: 'Passaggi',
        sectionDescription: '',
        plan: {
          slotId: 'studio',
          visualType: 'lesson_scene',
          complexity: 'simple',
          title: 'Passaggi',
          interactionLevel: 'none',
          requiresDepiction: false,
          concept: 'Trace',
          anchorHeading: '',
          pedagogicalGoal: 'Follow the steps',
          altText: 'Values',
          visualDirection: 'Show the trace',
          reason: 'Show the order',
          factualRequirements: [],
          coverage: 'complete_synthesis',
          coverageRationale: 'Covered in full',
        },
      },
    },
  });
  expect(result.status, JSON.stringify(result)).toBe('checkpointed');
  expect(checkpointStep.mock.lastCall?.[0].output).toMatchObject({
    visual: {
      render: {
        kind: 'scene',
        scene: { type: 'algorithm', ...detail },
      },
    },
  });
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

  const v15 = { ...input, useClosedLoopSelection: false };
  generateStructuredOutputMock.mockResolvedValueOnce(cycle);
  expect(await generateLessonScene(v15)).toMatchObject({ kind: 'scene', scene: { type: 'cycle' } });
  expect(generateStructuredOutputMock.mock.lastCall?.[0].system).toContain(
    'flywheel: 3–6 ordered items and center'
  );
  generateStructuredOutputMock.mockResolvedValueOnce({ ...cycle, type: 'flywheel' });
  expect(await generateLessonScene(v15)).toMatchObject({
    kind: 'invalid',
    diagnostic: { errorStage: 'domain' },
  });
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

test.each([
  {
    label: 'a total offered as the scale',
    source:
      'Scale: 0–5 points. 10 points were awarded overall. Clarity earned 2, speed 3, and reliability 5.',
    wrongQuote: '10 points were awarded overall',
    actualQuote: 'Scale: 0–5 points',
    actual: 5,
  },
  {
    label: 'a scale that starts at one',
    source: 'Scale: 1–10 points. Clarity earned 2, speed 3, and reliability 5.',
    wrongQuote: 'Scale: 1–10 points',
    actualQuote: 'Scale: 1–10 points',
  },
] as const)('prepares exact values instead of $label', async example => {
  generateStructuredOutputMock.mockResolvedValue({
    plans: [{ chunk: 0, events: [], reason: 'Static scene' }],
  });
  const draft = (max: number) => ({
    ...sceneDraft(example.source),
    type: 'bars',
    items: ['Clarity', 'Speed', 'Reliability'].map((label, index) => ({
      detail: '',
      label: `${label} (out of ${max} points)`,
      value: [2, 3, 5][index],
      time: null,
      iconQueries: queries,
    })),
    max,
    unit: 'points',
  });
  const scale = (max: number, quote: string) => ({
    status: 'declared',
    scale: { quote, max, unit: 'points' },
    ranges: [{ id: 0, role: 'applies', quote: example.actualQuote, unit: 'points' }],
  });
  generateStructuredOutputMock
    .mockResolvedValueOnce(draft(10))
    .mockResolvedValueOnce(scale(10, example.wrongQuote));
  if ('actual' in example) {
    generateStructuredOutputMock
      .mockResolvedValueOnce(draft(example.actual))
      .mockResolvedValueOnce(scale(example.actual, example.actualQuote));
  } else {
    generateStructuredOutputMock.mockImplementation(async ({ output }) =>
      output.name === 'lesson_scene'
        ? draft(10)
        : { ...scale(10, example.wrongQuote), status: 'unclear', scale: null }
    );
  }
  const prepared = await prepareQuantitativePlayback(example.source);
  if ('actual' in example) {
    expect(prepared.scene).toMatchObject({
      type: 'bars',
      max: example.actual,
      unit: 'points',
      items: [
        { label: 'Clarity (out of 5 points)', value: 2 },
        { label: 'Speed (out of 5 points)', value: 3 },
        { label: 'Reliability (out of 5 points)', value: 5 },
      ],
    });
  } else {
    expect(prepared.scene).toBeUndefined();
    expect(prepared.textOnlyRanges).toEqual([{ start: 0, end: example.source.length }]);
  }
  expect(
    generateStructuredOutputMock.mock.calls.filter(([r]) => r.output.name === 'lesson_scene')
  ).toHaveLength('actual' in example ? 2 : 1);
});

test.each([
  { source: 'Scores are out of 10 points.', expected: 10 },
  { source: 'Overall the test awarded 10 points. Scores are out of 10 points.', expected: 10 },
  { source: 'Scale: 0–10 points. Scores are out of 10 points.', expected: 10 },
  {
    source: 'Scores are out of 10 points. Scale: 0–10 points.',
    citation: 'Scale: 0–10 points',
    expected: 10,
  },
  {
    source: 'Scale: 0–10 points, for all traits. Scores are out of 10 points for all traits.',
    citation: 'Scale: 0–10 points, for all traits',
    scaleQualifier: 'for all traits',
    rangeQualifiers: [', for all traits', 'for all traits'],
    expected: 10,
  },
  { source: 'Scores are out of 10 points. Scores are out of 5 points.', expected: undefined },
  { source: 'Scale: 0–5 points. Scores are out of 10 points.', expected: undefined },
  { source: 'Scale: 1–10 points. Scores are out of 10 points.', expected: undefined },
  {
    source: 'Scale: 0–10 points per week. Scores are out of 10 points.',
    rangeUnits: ['points per week', 'points'],
    expected: undefined,
  },
  {
    source: 'Scale: 0–10 points per week. Scores are out of 10 points.',
    rangeQualifiers: ['per week'],
    expected: undefined,
  },
])('prepares bars when the score scales agree in "$source"', async example => {
  const { source, expected, citation = 'Scores are out of 10 points', rangeUnits = [] } = example;
  const speech = `${source} Clarity earned 2, speed 3, and reliability 5.`;
  const items = ['Clarity', 'Speed', 'Reliability'].map((name, index) => ({
    label: `${name} (out of 10 points)`,
    value: [2, 3, 5][index],
    detail: '',
    time: null,
    iconQueries: queries,
  }));
  const draft = { ...sceneDraft(speech), type: 'bars', items, max: 10, unit: 'points' };
  generateStructuredOutputMock.mockImplementation(async ({ output, prompt }) => {
    if (output.name === 'lesson_scene') return draft;
    if (output.name !== 'bar_source_scale')
      return { plans: [{ chunk: 0, events: [], reason: 'Static scene' }] };
    const { possibleRanges } = JSON.parse(prompt) as {
      possibleRanges: { id: number; context: string }[];
    };
    return {
      status: 'declared',
      scale: { quote: citation, max: 10, unit: 'points', qualifier: example.scaleQualifier },
      ranges: possibleRanges.map(({ id, context }) => ({
        id,
        role: 'applies',
        quote: context,
        unit: rangeUnits[id] ?? 'points',
        qualifier: example.rangeQualifiers?.[id],
      })),
    };
  });
  const prepared = await prepareQuantitativePlayback(speech);
  if (expected) {
    expect(prepared.scene).toMatchObject({
      type: 'bars',
      max: expected,
      unit: 'points',
      items: items.map(({ label, value }) => ({ label, value })),
    });
  } else {
    expect(prepared.scene).toBeUndefined();
    expect(prepared.textOnlyRanges).toEqual([{ start: 0, end: speech.length }]);
  }
});

const falseMaximumExamples = [
  { source: 'Scale: 0–5 points. Overall the test awarded 10 points.', range: true },
  { source: 'Overall the test awarded 10 points. Scale: 0–5 points.', range: true },
  { source: 'Overall the test awarded 10 points.', range: false },
];

test.each(
  falseMaximumExamples.flatMap(example => [false, true].map(legacy => ({ ...example, legacy })))
)('preserves the numbers after "$source" (legacy: $legacy)', async ({ source, range, legacy }) => {
  const labels = ['Clarity', 'Speed', 'Reliability'];
  const values = [2, 3, 5];
  const speech = `${source} Clarity earned 2, speed 3, and reliability 5.`;
  const draft = {
    ...sceneDraft(speech),
    type: 'bars',
    max: 10,
    unit: 'points',
    items: labels.map((label, i) => ({
      label: `${label} (out of 10 points)`,
      detail: '',
      value: values[i],
      time: null,
      iconQueries: queries,
    })),
  };
  const rows = labels.map((label, index) => ({ label, values: [values[index]] }));
  let attempts = 0;
  generateStructuredOutputMock.mockImplementation(async ({ output }) => {
    if (output.name === 'lesson_scene') {
      attempts++;
      if (attempts === 1 || !legacy) return draft;
      return {
        ...sceneDraft(speech),
        type: 'matrix',
        variant: 'heatmap',
        items: [],
        columns: ['Points earned'],
        rows,
      };
    }
    if (output.name === 'bar_source_scale')
      return {
        status: 'declared',
        scale: { quote: 'Overall the test awarded 10 points', max: 10, unit: 'points' },
        ranges: range
          ? [{ id: 0, role: 'other-scope', quote: 'Scale: 0–5 points', unit: null }]
          : [],
      };
    return { plans: [{ chunk: 0, events: [], reason: 'Static scene' }] };
  });
  const frozenCatalog = HistoricalLessonSceneSchemas.at(-1);
  if (!frozenCatalog) throw new Error('Expected a deployed scene catalog.');
  const prepared = await prepareQuantitativePlayback(
    speech,
    legacy
      ? {
          supportsTextOnlyVisuals: false,
          useOrderedSceneSelection: true,
          allowedSceneTypes: frozenCatalog.shape.type.options,
        }
      : {}
  );
  expect(attempts).toBe(legacy ? 2 : 1);
  if (legacy) {
    expect(prepared.scene).toMatchObject({ type: 'heatmap', rows, columns: ['Points earned'] });
    expect(prepared.scene).not.toHaveProperty('max');
    expect(prepared.textOnlyRanges).toBeUndefined();
    const request = generateStructuredOutputMock.mock.calls.find(
      ([call]) => call.output.name === 'lesson_scene'
    )?.[0];
    expect(request.output.schema.properties.type.enum).not.toContain('text');
    expect(frozenCatalog.parse(prepared.scene)).toEqual(prepared.scene);
  } else {
    expect(prepared.scene).toBeUndefined();
    expect(prepared.textOnlyRanges).toEqual([{ start: 0, end: speech.length }]);
  }
});

test('keeps a lone number in prose and compares independent criteria with bars', async () => {
  const single = 'The jar contains 3 litres of water.';
  const observation = {
    label: 'Litres of water',
    value: 3,
    detail: '',
    time: null,
    iconQueries: queries,
  };
  const number = { ...sceneDraft(single), type: 'number', items: [observation] };
  generateStructuredOutputMock.mockResolvedValueOnce(number);
  expect(
    await generateLessonScene({
      ...unplannedInput(single),
      narration: single,
      allowTextFallback: true,
    })
  ).toMatchObject({ kind: 'invalid' });
  generateStructuredOutputMock.mockResolvedValueOnce({ ...number, type: 'text', items: [] });
  expect(
    await generateLessonScene({
      ...unplannedInput(single),
      narration: single,
      allowTextFallback: true,
    })
  ).toEqual({ kind: 'text' });

  const source =
    'Clarity scores 3/10 points. Speed scores 8/10 points. Reliability scores 6/10 points.';
  const criteria = [
    { label: 'Clarity (out of 10 points)', value: 3 },
    { label: 'Speed (out of 10 points)', value: 8 },
    { label: 'Reliability (out of 10 points)', value: 6 },
  ];
  const chart = {
    ...sceneDraft(source),
    title: 'Scores by criterion',
    items: criteria.map(criterion => ({ ...observation, ...criterion })),
    max: 10,
    unit: 'points',
  };
  const constrained = { ...unplannedInput(source), allowedSceneTypes: STATIC_LESSON_SCENE_TYPES };
  generateStructuredOutputMock.mockResolvedValueOnce({ ...chart, type: 'radar' });
  expect(await generateLessonScene(unplannedInput(source))).toMatchObject({ kind: 'invalid' });
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...chart,
    type: 'bars',
    items: chart.items.map(item => ({ ...item, label: item.label.replace('out of 10 ', '') })),
  });
  expect(await generateLessonScene(constrained)).toMatchObject({ kind: 'invalid' });
  generateStructuredOutputMock.mockResolvedValueOnce({ ...chart, type: 'bars' });
  generateStructuredOutputMock.mockResolvedValueOnce({
    status: 'declared',
    ranges: [],
    scale: { quote: 'Clarity scores 3/10 points', max: 10, unit: 'points' },
  });
  expect(await generateLessonScene(constrained)).toMatchObject({
    kind: 'scene',
    scene: { type: 'bars', items: criteria },
  });
});

test.each([
  {
    label: 'the full score scale',
    source: 'Scores are out of 10 points. Clarity is 3, speed is 4, and reliability is 5.',
    scale: { quote: 'Scores are out of 10 points', max: 10, unit: 'points' },
    candidate: { max: 10, unit: 'points' },
    expected: 'scene',
  },
  {
    label: 'a shared denominator in every score',
    source: 'Clarity got 3/10 points. Speed got 4/10 points. Reliability got 5/10 points.',
    scale: { quote: 'Clarity got 3/10 points', max: 10, unit: 'points' },
    candidate: { max: 10, unit: 'points' },
    expected: 'scene',
  },
  {
    label: 'a denominator written for only one of the scores',
    source: 'Clarity got 3/10 points. Speed got 4 points. Reliability got 5 points.',
    scale: { quote: 'Clarity got 3/10 points', max: 10, unit: 'points' },
    candidate: { max: 10, unit: 'points' },
    expected: 'invalid',
  },
  {
    label: 'an observed value as the maximum',
    source: 'Scores are out of 10 points. Clarity is 3, speed is 4, and reliability is 5.',
    scale: { quote: 'Scores are out of 10 points', max: 10, unit: 'points' },
    candidate: { max: 5, unit: 'points' },
    expected: 'invalid',
  },
  {
    label: 'a missing maximum when a scale is declared',
    source: 'Scores are out of 10 points. Clarity is 3, speed is 4, and reliability is 5.',
    scale: { quote: 'Scores are out of 10 points', max: 10, unit: 'points' },
    candidate: {},
    expected: 'invalid',
  },
  {
    label: 'a scale check with no visible quotation',
    source: 'Scores are out of 10 points. Clarity is 3, speed is 4, and reliability is 5.',
    scale: { quote: '', max: 10, unit: 'points' },
    candidate: { max: 10, unit: 'points' },
    expected: 'invalid',
  },
  {
    label: 'ordinary counts without a stated scale',
    source: 'Clarity received 3 votes, speed received 4, and reliability received 5.',
    scale: null,
    candidate: {},
    expected: 'scene',
  },
])('checks $label before accepting a bar chart', async ({ source, scale, candidate, expected }) => {
  const draft = {
    ...sceneDraft(source),
    title: 'Measurements by criterion',
    type: 'bars',
    items: ['Clarity', 'Speed', 'Reliability'].map((name, index) => ({
      detail: '',
      label: candidate.max ? `${name} (out of ${candidate.max} points)` : `${name} (votes)`,
      value: index + 3,
      time: null,
      iconQueries: queries,
    })),
    ...candidate,
  };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  generateStructuredOutputMock.mockImplementationOnce(async ({ prompt }) => {
    const { possibleRanges } = JSON.parse(prompt) as {
      possibleRanges: { id: number; context: string }[];
    };
    return {
      status: scale ? 'declared' : 'absent',
      ranges: possibleRanges.map(({ id, context }) => ({
        id,
        role: 'applies',
        quote: context,
        unit: 'points',
      })),
      scale,
    };
  });
  const result = await generateLessonScene(unplannedInput(source));
  expect(result.kind).toBe(expected);
  if (result.kind === 'scene') {
    expect(result.scene.max).toBe(candidate.max);
    expect(result.scene.items.map(item => item.value)).toEqual([3, 4, 5]);
  }
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
  ...LAB_QUICK_SCENES.filter(scene => scene.type !== 'radar'),
  LAB_COMPOSITION_SCENE,
])('generates the lab $type fields and all icon slots', async example => {
  const scaleEvidence =
    example.type === 'heatmap' ? `scale: 0–${example.max} ${example.unit}` : undefined;
  const source = `${LAB_COMPOSITION_SOURCE}\nExample data: ${JSON.stringify(example, null, 2)}${scaleEvidence ? `\n${scaleEvidence}.` : ''}`;
  const { items, groups, ...fields } = example;
  const {
    icon: centerIcon,
    panels,
    ...content
  } = fields as typeof fields & { icon?: string; panels?: typeof LAB_COMPOSITION_SCENE.panels };
  const draft = {
    ...sceneDraft(''),
    ...content,
    ...(scaleEvidence ? { scaleEvidence } : {}),
    ...(example.type === 'proportional-static'
      ? { type: 'proportional', variant: example.type }
      : {}),
    ...(example.type === 'heatmap' || example.type === 'security'
      ? { type: 'matrix', variant: example.type }
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
  if (example.type === 'heatmap' && scaleEvidence && example.max && example.unit)
    confirmHeatmapScale(scaleEvidence, example.unit);
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
    'Mattina 4, pomeriggio 3, sera 5 e notte 4, su un massimo di 5 richieste. Poi torna mattina.';
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...sceneDraft(''),
    type: 'polar',
    title: 'Richieste nella giornata',
    evidence: source,
    max: 5,
    unit: 'richieste',
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
