import {
  type FormulaSpotlightData,
  formulaSpotlightCovers,
  hasFormulaSpotlightReferences,
  resolveFormulaReferences,
} from '@shared/formulaSpotlight';
import { MAX_VISUAL_LESSON_CHARS } from '@shared/lessonGenerationPolicy';
import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { isLessonScene, type LessonScene, STATIC_LESSON_SCENE_TYPES } from '@shared/lessonScene';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  dictatedFormulaSpotlight,
  unlinkedIndexedFormulaSpotlight,
} from '../../helpers/formulaSpotlight';

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
import { preparePlaybackFormulaSpotlights } from '../../../src/services/lessonPlayback/playbackFormulaSpotlights.js';
import { generateLessonScene } from '../../../src/services/lessonScenes/lessonSceneGeneration.js';
import { resolveLessonVisualModelConfig } from '../../../src/services/lessonVisualModelConfig.js';
import {
  guidedPathScene,
  proportionalScene as prototypeProportionalScene,
} from '../../helpers/animatedLessonScenes';
import {
  LAB_COMPOSITION_SCENE,
  LAB_COMPOSITION_SOURCE,
  LAB_QUICK_SCENES,
} from '../../helpers/lessonSceneLabExamples';

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
  type: 'parts',
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
      type: 'parts',
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
  'parts',
  'concepts',
] as const)('rejects glossary descriptions in captioned %s while retaining standalone details', async type => {
  const source = 'Input and output are the two parts of the system.';
  const draft = { ...sceneDraft(source), type };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  expect(await generateLessonScene(unplannedInput(source))).toMatchObject({
    kind: 'scene',
    scene: {
      items: [
        { label: 'Fonte', detail: source },
        { label: 'Riscontri', detail: '' },
      ],
    },
  });
  const captioned = { ...unplannedInput(source), narration: source };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  expect(await generateLessonScene(captioned)).toMatchObject({ kind: 'invalid' });
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...draft,
    items: draft.items.map(item => ({ ...item, detail: '' })),
  });
  expect(await generateLessonScene(captioned)).toMatchObject({
    kind: 'scene',
    scene: {
      type,
      items: [
        { label: 'Fonte', detail: '' },
        { label: 'Riscontri', detail: '' },
      ],
    },
  });
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
    scene: { type: 'parts', items: [{ detail: source }, { detail: '' }] },
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
  const input = { ...unplannedInput(speech), allowedSceneTypes: STATIC_LESSON_SCENE_TYPES };
  expect(await generateLessonScene(input)).toMatchObject({ kind: 'invalid' });
  const request = generateStructuredOutputMock.mock.calls[0][0];
  const schema = z.fromJSONSchema(request.output.schema);
  expect(schema.safeParse(draft).success).toBe(false);
  const staticDraft = { ...sceneDraft(speech), evidence: speech, intent: 'Leggere.' };
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
      type: 'parts',
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
    type: 'parts',
    items: computations.map(item => ({ ...item, time: null, value: null, iconQueries: queries })),
  });
  const result = await generateLessonScene({
    ...input,
    retryFeedback: rejected.problems.join('\n'),
  });
  expect(result.kind).toBe('scene');
  if (result.kind !== 'scene') throw new Error('Expected a non-graph scene');
  expect(result.scene.type).toBe('parts');
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

const boundSourceSymbol = (input: {
  id: string;
  first: number;
  last?: number;
  word?: number;
  lastWord?: number;
  needsGroup?: boolean;
}) => ({
  id: input.id,
  ranges: [
    {
      first: `t${input.first}`,
      last: `t${input.last ?? input.first}`,
      needsGroup: input.needsGroup ?? false,
    },
  ],
  name: input.id,
  meaning: 'Il valore indicato dalla fonte.',
  mentions:
    input.word === undefined
      ? []
      : [{ first: `w${input.word}`, last: `w${input.lastWord ?? input.word}` }],
});
const sourceBoundDraft = () => ({
  mentioned: true,
  title: 'La formula',
  summary: 'La relazione fornita.',
  symbols: [
    boundSourceSymbol({ id: 'x', first: 0, word: 0 }),
    boundSourceSymbol({ id: 'y', first: 2, word: 2 }),
  ],
});
const sourceBoundInput = (formula = '$x+y$', narration = 'ics poi ipsilon') => ({
  ...unplannedInput(formula + '\n' + narration),
  narration,
  allowedSceneTypes: ['formula-spotlight'] as const,
  formulaSource: { formula },
});

test.each([
  true,
  false,
])('binds original widget IDs while retaining all authored metadata (mentioned: %s)', async mentioned => {
  const authored = {
    ...dictatedFormulaSpotlight,
    title: 'Vetted authored explanation',
    body: 'Authored context',
    note: 'Authored note',
    autoplay: false,
    symbols: dictatedFormulaSpotlight.symbols.map(symbol => ({
      ...symbol,
      name: `Vetted ${symbol.id}`,
      meaning: `Vetted meaning ${symbol.id}`,
      anchor: '',
    })),
  };
  const source = {
    ...segmentLessonPlayback([
      { type: 'markdown', markdown: mentioned ? '$x+y$' : 'Una relazione di richiamo.' },
    ])[0],
    visuals: [{ kind: 'scene' as const, scene: authored }],
    prepared: {
      motion: [],
      spokenMath: mentioned ? [{ formula: '$x+y$', spoken: 'ics più ipsilon' }] : [],
    },
  };
  const original = structuredClone(source);
  generateStructuredOutputMock.mockResolvedValueOnce({
    title: 'Generated replacement',
    summary: 'Generated summary',
    mentioned,
    symbols: [...authored.symbols].reverse().map(symbol => ({
      id: symbol.id,
      name: 'Generated name',
      meaning: 'Generated meaning',
      ranges: [
        {
          first: `t${1 + ['x', 'plus', 'y'].indexOf(symbol.id) * 3}`,
          last: `t${1 + ['x', 'plus', 'y'].indexOf(symbol.id) * 3}`,
          needsGroup: false,
        },
      ],
      mentions: mentioned
        ? [
            {
              first: `w${['x', 'plus', 'y'].indexOf(symbol.id)}`,
              last: `w${['x', 'plus', 'y'].indexOf(symbol.id)}`,
            },
          ]
        : [],
    })),
  });
  const formulaSpotlights = await preparePlaybackFormulaSpotlights({
    config: getGlobalModelConfig(),
    signal: new AbortController().signal,
    block: source,
  });
  const withoutLinks = (scene: LessonScene & FormulaSpotlightData) => ({
    ...scene,
    symbols: scene.symbols.map(
      ({
        anchor: _anchor,
        anchorOccurrence: _occurrence,
        additionalAnchors: _additional,
        ...symbol
      }) => symbol
    ),
  });
  expect(withoutLinks(formulaSpotlights[0].scene as typeof authored)).toEqual(
    withoutLinks(authored)
  );
  expect(
    resolveFormulaReferences(
      formulaSpotlights[0].scene as FormulaSpotlightData,
      mentioned ? 'ics più ipsilon' : source.speech
    )
  ).toHaveLength(mentioned ? 3 : 0);
  expect(source).toEqual(original);
  generateStructuredOutputMock.mockClear();
  const cached = formulaSpotlights.map(entry => ({
    ...entry,
    scene: {
      ...entry.scene,
      title: 'Stale generated title',
      symbols: (entry.scene as FormulaSpotlightData).symbols.map(symbol => ({
        ...symbol,
        name: 'Stale name',
        meaning: 'Stale meaning',
      })),
    },
  }));
  expect(
    await preparePlaybackFormulaSpotlights({
      config: getGlobalModelConfig(),
      signal: new AbortController().signal,
      block: { ...source, prepared: { ...source.prepared, formulaSpotlights: cached } },
    })
  ).toEqual(formulaSpotlights);
  expect(generateStructuredOutputMock).not.toHaveBeenCalled();
});

test.each([
  'unknown',
  'duplicate',
  'missing',
])('rejects %s authored symbol IDs before saving links', async defect => {
  const symbols = dictatedFormulaSpotlight.symbols.map(symbol => ({ id: symbol.id, mentions: [] }));
  if (defect === 'unknown') symbols[0].id = 'invented';
  if (defect === 'duplicate') symbols[0].id = symbols[1].id;
  if (defect === 'missing') symbols.pop();
  generateStructuredOutputMock.mockResolvedValueOnce({ mentioned: false, symbols });
  const outcome = await generateLessonScene({
    ...sourceBoundInput(),
    formulaSource: { formula: '$x+y$', scene: dictatedFormulaSpotlight },
  });
  expect(outcome.kind).toBe('invalid');
});

test('returns exact reference-selection diagnostics privately to formula preparation', async () => {
  const draft = {
    ...sourceBoundDraft(),
    symbols: [boundSourceSymbol({ id: 'x', first: 0, word: 99 })],
  };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  const outcome = await generateLessonScene(sourceBoundInput());
  expect(outcome.kind).toBe('invalid');
  if (outcome.kind !== 'invalid') throw new Error('An unknown heard word must fail');
  expect(outcome.formulaCorrection).toMatchObject({
    draft,
    selection: {
      selection: { first: 'w99', last: 'w99' },
      available: [
        { id: 'w0', text: 'ics' },
        { id: 'w1', text: 'poi' },
        { id: 'w2', text: 'ipsilon' },
      ],
    },
  });
});

test('preserves authored macros, operators and scripts while inserting only explicit source references', async () => {
  const formula = String.raw`$$\mathbf h=a[\beta_0+\Omega_0 x]$$`;
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...sourceBoundDraft(),
    symbols: [
      boundSourceSymbol({ id: 'h', first: 0, last: 2, word: 0 }),
      boundSourceSymbol({ id: 'a', first: 4, word: 2 }),
      boundSourceSymbol({ id: 'beta', first: 6, word: 3 }),
      boundSourceSymbol({ id: 'bzero', first: 8, word: 4, needsGroup: true }),
      boundSourceSymbol({ id: 'omega', first: 10, word: 5 }),
      boundSourceSymbol({ id: 'ozero', first: 12, word: 6, needsGroup: true }),
      boundSourceSymbol({ id: 'x', first: 14, word: 7 }),
    ],
  });
  const outcome = await generateLessonScene(
    sourceBoundInput(formula, 'Acca; funzione a; beta zero; omega zero; ics.')
  );
  expect(outcome.kind).toBe('scene');
  if (outcome.kind !== 'scene' || outcome.scene.type !== 'formula-spotlight')
    throw new Error('Source-bound formula must validate');
  expect(outcome.scene.formula).toBe(
    String.raw`\nousSymbol{h}=\nousSymbol{a}[\nousSymbol{beta}_{\nousSymbol{bzero}}+\nousSymbol{omega}_{\nousSymbol{ozero}} \nousSymbol{x}]`
  );
  expect(formulaSpotlightCovers(outcome.scene as FormulaSpotlightData, [formula])).toBe(true);
});

test('rejects nonexistent source tokens instead of changing or guessing the authored math', async () => {
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...sourceBoundDraft(),
    symbols: [boundSourceSymbol({ id: 'h', first: 99, word: 0 })],
  });
  const outcome = await generateLessonScene(sourceBoundInput(String.raw`$\mathbf h$`, 'acca'));
  expect(outcome.kind).toBe('invalid');
  if (outcome.kind !== 'invalid') throw new Error('A missing source token must fail');
  expect(outcome.formulaCorrection).toMatchObject({
    selection: {
      selection: { first: 't99', last: 't99' },
      available: [
        { id: 't0', text: String.raw`\mathbf` },
        { id: 't1', text: ' ' },
        { id: 't2', text: 'h' },
      ],
    },
  });
});

test('rejects reversed source token selections before building a component', async () => {
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...sourceBoundDraft(),
    symbols: [boundSourceSymbol({ id: 'x', first: 2, last: 0, word: 0 })],
  });
  const outcome = await generateLessonScene(sourceBoundInput());
  expect(outcome.kind).toBe('invalid');
  if (outcome.kind !== 'invalid') throw new Error('Reversed source selections must fail');
  expect(outcome.formulaCorrection).toMatchObject({
    selection: { selection: { first: 't2', last: 't0' } },
  });
});

test('rejects overlapping source selections before building a component', async () => {
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...sourceBoundDraft(),
    symbols: [
      boundSourceSymbol({ id: 'sum', first: 0, last: 2, word: 0 }),
      boundSourceSymbol({ id: 'x', first: 0, word: 2 }),
    ],
  });
  const outcome = await generateLessonScene(sourceBoundInput('$x+y$', 'somma poi ics'));
  expect(outcome.kind).toBe('invalid');
  if (outcome.kind !== 'invalid') throw new Error('Overlapping source selections must fail');
  expect(outcome.formulaCorrection).toMatchObject({
    selection: { previousEnd: 1, range: { start: 0, end: 3 } },
  });
});

test('requires different source fragments to retain their own symbol IDs', async () => {
  const symbol = boundSourceSymbol({ id: 'both', first: 0, word: 0 });
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...sourceBoundDraft(),
    symbols: [
      { ...symbol, ranges: [...symbol.ranges, { first: 't2', last: 't2', needsGroup: false }] },
    ],
  });
  const outcome = await generateLessonScene(sourceBoundInput());
  expect(outcome.kind).toBe('invalid');
  if (outcome.kind !== 'invalid')
    throw new Error('Different mathematics must not share one replacement');
  expect(outcome.formulaCorrection).toMatchObject({ selection: { symbol: 'both' } });
});

test('copies selected heard words to exact persisted occurrences including punctuation and embedded repeats', async () => {
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...sourceBoundDraft(),
    symbols: [
      boundSourceSymbol({ id: 'first', first: 0, word: 1 }),
      boundSourceSymbol({ id: 'second', first: 2, word: 3 }),
    ],
  });
  const outcome = await generateLessonScene(sourceBoundInput('$0+0$', 'azzero zero e zero.'));
  expect(outcome.kind).toBe('scene');
  if (outcome.kind !== 'scene') throw new Error('Selected heard words must validate');
  const scene = outcome.scene as FormulaSpotlightData;
  expect(scene.symbols[0]).toMatchObject({ anchor: 'zero', anchorOccurrence: 1 });
  expect(scene.symbols[1]).toMatchObject({ anchor: 'zero.', anchorOccurrence: 0 });
  expect(
    resolveFormulaReferences(scene, 'azzero zero e zero.').map(({ start, end }) => [start, end])
  ).toEqual([
    [7, 11],
    [14, 19],
  ]);
});

test('links every explicitly selected family member to one heard mention', async () => {
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...sourceBoundDraft(),
    symbols: [
      boundSourceSymbol({ id: 'x', first: 0, word: 0 }),
      boundSourceSymbol({ id: 'y', first: 2, word: 0 }),
    ],
  });
  const outcome = await generateLessonScene(sourceBoundInput('$x+y$', 'coordinate'));
  expect(outcome.kind).toBe('scene');
  if (outcome.kind !== 'scene') throw new Error('An explicit family mention must validate');
  expect(
    resolveFormulaReferences(outcome.scene as FormulaSpotlightData, 'coordinate').map(
      ({ index, start, end }) => ({ index, start, end })
    )
  ).toEqual([
    { index: 0, start: 0, end: 10 },
    { index: 1, start: 0, end: 10 },
  ]);
});

test('reports an omitted source identifier so the service can add its unlinked definition', async () => {
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...sourceBoundDraft(),
    symbols: [boundSourceSymbol({ id: 'x', first: 0, word: 0 })],
  });
  const outcome = await generateLessonScene(sourceBoundInput());
  expect(outcome.kind).toBe('invalid');
  if (outcome.kind !== 'invalid') throw new Error('Unrepresented source identifiers must fail');
  expect(outcome.formulaCorrection).toMatchObject({ selection: { unwrappedMath: 'y' } });
});

test('saves a model-declared static formula without reauthoring its math', async () => {
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...sourceBoundDraft(),
    mentioned: false,
    symbols: [],
  });
  const outcome = await generateLessonScene(
    sourceBoundInput('$x+y$', 'Una relazione mostrata come richiamo.')
  );
  expect(outcome.kind).toBe('scene');
  if (outcome.kind !== 'scene') throw new Error('A static decision must validate');
  expect(hasFormulaSpotlightReferences(outcome.scene as FormulaSpotlightData)).toBe(false);
  expect(formulaSpotlightCovers(outcome.scene as FormulaSpotlightData, ['$x+y$'])).toBe(true);
});

test('rejects a static decision that would silently discard supplied narration links', async () => {
  generateStructuredOutputMock.mockResolvedValueOnce({ ...sourceBoundDraft(), mentioned: false });
  expect((await generateLessonScene(sourceBoundInput())).kind).toBe('invalid');
});

test('requires links for an authoritative dictated formula range', async () => {
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...sourceBoundDraft(),
    mentioned: false,
    symbols: [],
  });
  const input = sourceBoundInput();
  expect(
    (
      await generateLessonScene({
        ...input,
        formulaSource: {
          ...input.formulaSource,
          dictatedRanges: [{ start: 0, end: input.narration.length }],
        },
      })
    ).kind
  ).toBe('invalid');
});

test('validates references for every repeated dictated range before accepting a source-bound scene', async () => {
  const input = {
    ...sourceBoundInput('$x$', 'ics poi ics'),
    formulaSource: {
      formula: '$x$',
      dictatedRanges: [
        { start: 0, end: 3 },
        { start: 8, end: 11 },
      ],
    },
  };
  const symbol = boundSourceSymbol({ id: 'x', first: 0, word: 0 });
  generateStructuredOutputMock.mockResolvedValueOnce({ ...sourceBoundDraft(), symbols: [symbol] });
  expect((await generateLessonScene(input)).kind).toBe('invalid');
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...sourceBoundDraft(),
    symbols: [{ ...symbol, mentions: [...symbol.mentions, { first: 'w2', last: 'w2' }] }],
  });
  const outcome = await generateLessonScene(input);
  expect(outcome.kind).toBe('scene');
  if (outcome.kind !== 'scene') throw new Error('Both explicit readings must be accepted');
  expect(
    resolveFormulaReferences(outcome.scene as FormulaSpotlightData, input.narration).map(
      reference => reference.start
    )
  ).toEqual([0, 8]);
});

test('supplies the exact words of this reading separately from repeated references', async () => {
  const narration = 'prima ics più ipsilon dopo ics più ipsilon fine';
  const range = { start: narration.lastIndexOf('ics'), end: narration.indexOf(' fine') };
  generateStructuredOutputMock.mockResolvedValueOnce({
    ...sourceBoundDraft(),
    symbols: [
      boundSourceSymbol({ id: 'x', first: 0, word: 5 }),
      boundSourceSymbol({ id: 'y', first: 2, word: 7 }),
    ],
  });
  const input = sourceBoundInput('$x+y$', narration);
  const outcome = await generateLessonScene({
    ...input,
    formulaSource: { ...input.formulaSource, dictatedRanges: [range] },
  });
  const request = JSON.parse(generateStructuredOutputMock.mock.calls[0][0].prompt);
  expect(
    request.dictatedWords[0].map(({ id, text }: { id: string; text: string }) => ({ id, text }))
  ).toEqual([
    { id: 'w5', text: 'ics' },
    { id: 'w6', text: 'più' },
    { id: 'w7', text: 'ipsilon' },
  ]);
  expect(outcome.kind).toBe('scene');
  if (outcome.kind !== 'scene') throw new Error('The selected second reading must validate');
  expect(
    resolveFormulaReferences(outcome.scene as FormulaSpotlightData, narration).map(
      ({ start, end }) => ({ start, end })
    )
  ).toEqual([
    { start: range.start, end: range.start + 3 },
    { start: narration.lastIndexOf('ipsilon'), end: range.end },
  ]);
});

test('retains authored shared-base grouping while linking each heard index', async () => {
  const original = unlinkedIndexedFormulaSpotlight;
  const block = {
    ...segmentLessonPlayback([{ type: 'markdown' as const, markdown: 'delta i poi delta k' }])[0],
    prepared: { motion: [], scene: original },
  };
  generateStructuredOutputMock.mockResolvedValueOnce({
    mentioned: true,
    symbols: [
      {
        id: 'd',
        mentions: [
          { first: 'w0', last: 'w0' },
          { first: 'w3', last: 'w3' },
        ],
      },
      { id: 'i', mentions: [{ first: 'w1', last: 'w1' }] },
      { id: 'k', mentions: [{ first: 'w4', last: 'w4' }] },
    ],
  });
  const result = await preparePlaybackFormulaSpotlights({
    block,
    config: getGlobalModelConfig(),
    signal: new AbortController().signal,
  });
  const scene = result[0].scene as FormulaSpotlightData;
  expect(result[0].sourceFormula).toBe(original.formula);
  expect(formulaSpotlightCovers(scene, ['$D_i+D_k$'])).toBe(true);
  expect(scene.formula).toBe(original.formula);
  expect(scene.symbols.map(symbol => symbol.id)).toEqual(['d', 'i', 'k']);
  expect(
    resolveFormulaReferences(scene, block.speech).map(({ index, start, end }) => ({
      index,
      start,
      end,
    }))
  ).toEqual([
    { index: 0, start: 0, end: 5 },
    { index: 1, start: 6, end: 7 },
    { index: 0, start: 12, end: 17 },
    { index: 2, start: 18, end: 19 },
  ]);
});

test('propagates a formula-provider transport failure without converting it into a correction draft', async () => {
  const error = new Error('provider offline');
  generateStructuredOutputMock.mockRejectedValueOnce(error);
  await expect(generateLessonScene(sourceBoundInput())).rejects.toBe(error);
});
