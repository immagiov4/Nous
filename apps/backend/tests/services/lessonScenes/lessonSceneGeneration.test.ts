import { MAX_VISUAL_LESSON_CHARS } from '@shared/lessonGenerationPolicy';
import { STATIC_LESSON_SCENE_TYPES } from '@shared/lessonScene';
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
import { generateLessonScene } from '../../../src/services/lessonScenes/lessonSceneGeneration.js';
import { resolveLessonVisualModelConfig } from '../../../src/services/lessonVisualModelConfig.js';
import { guidedPathScene, proportionalScene } from '../../helpers/animatedLessonScenes';

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

const quoteDraft = (quote: string) => ({
  body: '',
  criteria: [],
  diagram: null,
  evidence: quote,
  groups: [],
  intent: 'Leggere la domanda.',
  items: [],
  note: '',
  quote,
  relation: null,
  title: 'Fonti',
  type: 'quote',
});

test('generation honors the catalog admitted by a resumed static-scene workflow', async () => {
  const speech = proportionalScene.body;
  const draft = { ...quoteDraft(''), ...proportionalScene, intent: 'Contare.', evidence: speech };
  generateStructuredOutputMock.mockResolvedValueOnce(draft);
  const input = { ...unplannedInput(speech), allowedSceneTypes: STATIC_LESSON_SCENE_TYPES };
  expect(await generateLessonScene(input)).toMatchObject({ kind: 'invalid' });
  const request = generateStructuredOutputMock.mock.calls[0][0];
  const schema = z.fromJSONSchema(request.output.schema);
  expect(schema.safeParse(draft).success).toBe(false);
  const staticDraft = { ...quoteDraft(speech), evidence: speech, intent: 'Leggere.' };
  expect(schema.safeParse(staticDraft).success).toBe(true);
  generateStructuredOutputMock.mockResolvedValueOnce(staticDraft);
  expect(await generateLessonScene(input)).toMatchObject({
    kind: 'scene',
    scene: { type: 'quote' },
  });
});

test.each([
  proportionalScene,
  guidedPathScene,
])('generates $type through the advertised data schema', async scene => {
  const speech = scene.narration ?? scene.body;
  const { items: _items, groups: _groups, ...data } = scene;
  const draft = {
    ...quoteDraft(''),
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
  expect(schema.safeParse({ ...draft, formula: 'quantity * amountPerUnit' }).success).toBe(false);
  expect(chooseIconsMock.mock.calls[0][0].entries).toEqual([]);
});

test('generates a validated scene from speech without a visual plan', async () => {
  const speech = 'Quali fonti sostengono la tesi?';
  generateStructuredOutputMock.mockResolvedValueOnce(quoteDraft(speech));
  await expect(generateLessonScene(unplannedInput(speech))).resolves.toMatchObject({
    kind: 'scene',
    scene: { type: 'quote', quote: speech },
  });
});

test('validates against the excerpt actually sent, not the unseen tail of a long lesson', async () => {
  const unseenQuote = 'Quali fonti sostengono la tesi?';
  const input = unplannedInput(`${'x'.repeat(MAX_VISUAL_LESSON_CHARS)}${unseenQuote}`);
  generateStructuredOutputMock.mockResolvedValueOnce(quoteDraft(unseenQuote));
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
    problems: ['The answer must follow the requested JSON structure.'],
  });
});
