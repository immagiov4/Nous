import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { findLessonSceneProblems } from '@shared/lessonScene';
import { beforeEach, expect, test, vi } from 'vitest';

const { generateText, chooseIcons } = vi.hoisted(() => ({
  generateText: vi.fn(),
  chooseIcons: vi.fn(async ({ scene }) => scene),
}));
vi.mock('ai', async original => ({ ...(await original<typeof import('ai')>()), generateText }));
vi.mock('../../../src/services/aiSdkTextModel.js', () => ({
  createConfiguredTextModelFromResolution: () => ({ model: 'model', providerOptions: {} }),
}));
vi.mock('../../../src/services/lessonScenes/lessonSceneIconChoice.js', () => ({
  chooseLessonSceneIcons: chooseIcons,
}));

import { getGlobalModelConfig } from '../../../src/config/modelConfig.js';
import { generateLessonScene } from '../../../src/services/lessonScenes/lessonSceneGeneration.js';
import { resolveLessonVisualModelConfig } from '../../../src/services/lessonVisualModelConfig.js';

beforeEach(() => {
  generateText.mockReset();
  chooseIcons.mockClear();
});

const quote = 'A system has boundaries and interactions.';
const draft = {
  intent: 'Read the definition.',
  evidence: quote,
  type: 'quote',
  title: 'Systems',
  body: '',
  items: [],
  groups: [],
  criteria: [],
  quote,
  note: '',
  relation: null,
  diagram: null,
};

test.each([
  'direct',
  'json-envelope',
] as const)('grounds a real scene across annotation boundaries through %s', async path => {
  if (path === 'json-envelope')
    generateText.mockRejectedValueOnce(new Error('Schema is too complex'));
  generateText.mockResolvedValueOnce({
    output: path === 'direct' ? draft : { payload: JSON.stringify(draft) },
  });
  const block = segmentLessonPlayback([
    {
      type: 'markdown',
      markdown:
        'A system has <mark data-nous-annotation-id="note">boundaries</mark> and <mark>interactions</mark>.',
    },
  ])[0];
  const outcome = await generateLessonScene({
    config: resolveLessonVisualModelConfig(getGlobalModelConfig()),
    lessonMarkdown: block.speech,
    sectionTitle: 'Systems',
    sectionDescription: '',
    signal: new AbortController().signal,
  });
  expect(outcome).toMatchObject({ kind: 'scene', scene: { type: 'quote', quote } });
  if (outcome.kind !== 'scene') throw new Error('Expected grounded scene');
  expect(findLessonSceneProblems(outcome.scene, block.speech)).toEqual([]);
});

test('restores optional scene fields from an envelope without relaxing required nullable fields', async () => {
  generateText.mockRejectedValueOnce(new Error('Schema is too complex'));
  generateText.mockResolvedValueOnce({
    output: { payload: JSON.stringify({ ...draft, narration: null, steps: null }) },
  });
  const outcome = await generateLessonScene({
    config: resolveLessonVisualModelConfig(getGlobalModelConfig()),
    lessonMarkdown: quote,
    sectionTitle: 'Systems',
    sectionDescription: '',
    signal: new AbortController().signal,
  });
  expect(outcome).toMatchObject({ kind: 'scene' });
  if (outcome.kind !== 'scene') throw new Error('Expected valid scene');
  expect(findLessonSceneProblems(outcome.scene, quote)).toEqual([]);
  expect(outcome.scene).not.toHaveProperty('narration');
});

test('envelope normalization leaves invalid required scene content for domain rejection', async () => {
  generateText.mockRejectedValueOnce(new Error('Schema is too complex'));
  generateText.mockResolvedValueOnce({
    output: { payload: JSON.stringify({ ...draft, evidence: null, narration: null }) },
  });
  const outcome = await generateLessonScene({
    config: resolveLessonVisualModelConfig(getGlobalModelConfig()),
    lessonMarkdown: quote,
    sectionTitle: 'Systems',
    sectionDescription: '',
    signal: new AbortController().signal,
  });
  expect(outcome).toMatchObject({ kind: 'invalid' });
  expect(chooseIcons).not.toHaveBeenCalled();
});
