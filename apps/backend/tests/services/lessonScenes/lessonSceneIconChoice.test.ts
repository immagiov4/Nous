import type { LessonScene } from '@shared/lessonScene';
import { beforeEach, expect, test, vi } from 'vitest';

const { generateStructuredOutputMock } = vi.hoisted(() => ({
  generateStructuredOutputMock: vi.fn(),
}));

vi.mock('../../../src/services/structuredGeneration.js', () => ({
  generateStructuredOutput: generateStructuredOutputMock,
}));

// Each query text embeds to a one-hot vector over a tiny catalog, so retrieval is predictable.
const ICONS = ['school', 'search', 'file-text', 'certificate', 'point'];
vi.mock('../../../src/services/lessonScenes/lessonSceneIcons.js', () => ({
  describeTablerIcon: (icon: { name: string }) => `${icon.name} [-: ]`,
  embedTexts: vi.fn(async (_model: string, texts: string[]) =>
    texts.map(text => Float32Array.from(ICONS, name => (text.includes(name) ? 1 : 0)))
  ),
  loadIconIndex: vi.fn(async () => ({
    icons: ICONS.map(name => ({ category: '', name, tags: [] })),
    vectors: ICONS.map((_, row) =>
      Float32Array.from(ICONS, (_, column) => (row === column ? 1 : 0))
    ),
  })),
  nearestIcons: (
    index: { icons: { name: string }[]; vectors: Float32Array[] },
    query: Float32Array,
    count: number
  ) =>
    index.vectors
      .map((vector, row) => ({
        row,
        score: vector.reduce((sum, value, i) => sum + value * (query[i] ?? 0), 0),
      }))
      .sort((first, second) => second.score - first.score)
      .slice(0, count)
      .map(({ row }) => index.icons[row]),
}));

import { getGlobalModelConfig } from '../../../src/config/modelConfig.js';
import { chooseLessonSceneIcons } from '../../../src/services/lessonScenes/lessonSceneIconChoice.js';

const scene: LessonScene = {
  body: '',
  groups: [],
  items: [
    { detail: '', icon: '', label: 'Competenza' },
    { detail: '', icon: '', label: 'Prove' },
  ],
  note: '',
  quote: '',
  title: 'Valutare una fonte',
  type: 'checklist',
};

const entries = [
  {
    queries: { action: 'study', concept: 'expertise', object: 'school' },
    slot: { item: 0, kind: 'item' as const },
    text: 'Competenza',
  },
  {
    queries: { action: 'search', concept: 'evidence from school', object: 'file-text' },
    slot: { item: 1, kind: 'item' as const },
    text: 'Prove',
  },
];

beforeEach(() => {
  generateStructuredOutputMock.mockReset();
});

test('chooses icons only among retrieved candidates and retries a reused icon', async () => {
  generateStructuredOutputMock
    .mockResolvedValueOnce({
      choices: [
        { concept: 'competenza', icon: 'school', slot: 'items.0' },
        { concept: 'prove', icon: 'school', slot: 'items.1' },
      ],
    })
    .mockResolvedValueOnce({
      choices: [
        { concept: 'competenza', icon: 'school', slot: 'items.0' },
        { concept: 'prove', icon: 'file-text', slot: 'items.1' },
      ],
    });

  const chosen = await chooseLessonSceneIcons({
    config: getGlobalModelConfig(),
    entries,
    scene,
    signal: new AbortController().signal,
  });

  expect(chosen.items.map(item => item.icon)).toEqual(['school', 'file-text']);
  expect(generateStructuredOutputMock).toHaveBeenCalledTimes(2);
  expect(generateStructuredOutputMock.mock.calls[1]?.[0]).toMatchObject({ slot: 'sceneIcon' });
  expect(generateStructuredOutputMock.mock.calls[1]?.[0].prompt).toContain('(school)');
});

test('falls back to a neutral icon when the chooser never returns a valid candidate', async () => {
  generateStructuredOutputMock.mockResolvedValue({
    choices: [
      { concept: 'competenza', icon: 'rocket', slot: 'items.0' },
      { concept: 'prove', icon: 'search', slot: 'items.1' },
    ],
  });

  const chosen = await chooseLessonSceneIcons({
    config: getGlobalModelConfig(),
    entries,
    scene,
    signal: new AbortController().signal,
  });

  expect(chosen.items.map(item => item.icon)).toEqual(['point', 'search']);
  expect(generateStructuredOutputMock).toHaveBeenCalledTimes(3);
});
