import { needsPlaybackFormulaSpotlights, segmentLessonPlayback } from '@shared/lessonPlayback';
import { beforeEach, expect, test, vi } from 'vitest';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('../../../src/services/lessonScenes/lessonSceneGeneration.js', () => ({
  generateLessonScene: generate,
}));

import { getGlobalModelConfig } from '../../../src/config/modelConfig.js';
import { preparePlaybackFormulaSpotlights } from '../../../src/services/lessonPlayback/playbackFormulaSpotlights.js';
import { dictatedFormulaSpotlight } from '../../helpers/formulaSpotlight';

const block = () => ({
  ...segmentLessonPlayback([{ type: 'markdown', markdown: 'Prima $x+y$ poi $x+y$ fine' }])[0],
  prepared: {
    motion: [],
    spokenMath: [
      { formula: '$x+y$', spoken: 'ics più ipsilon' },
      { formula: '$x+y$', spoken: 'ics più ipsilon' },
    ],
  },
});
const request = () => ({
  block: block(),
  config: getGlobalModelConfig(),
  signal: new AbortController().signal,
});
beforeEach(() => {
  vi.resetAllMocks();
  generate.mockResolvedValue({ kind: 'scene', scene: dictatedFormulaSpotlight });
});

test.each([
  true,
  false,
])('prepares and caches an unlinked spotlight while the service decides its spoken references (mentioned: %s)', async mentioned => {
  const unlinked = {
    ...dictatedFormulaSpotlight,
    symbols: dictatedFormulaSpotlight.symbols.map(symbol => ({ ...symbol, anchor: '' })),
  };
  const source = {
    ...segmentLessonPlayback([{ type: 'markdown', markdown: 'ics più ipsilon' }])[0],
    prepared: { motion: [], scene: unlinked },
  };
  const scene = mentioned ? dictatedFormulaSpotlight : unlinked;
  generate.mockResolvedValue({ kind: 'scene', scene });
  expect(needsPlaybackFormulaSpotlights(source)).toBe(true);
  const formulaSpotlights = await preparePlaybackFormulaSpotlights({ ...request(), block: source });
  expect(formulaSpotlights).toEqual([
    { formula: '$${x}{+}{y}$$', sourceFormula: unlinked.formula, scene },
  ]);
  const saved = { ...source, prepared: { ...source.prepared, formulaSpotlights } };
  expect(needsPlaybackFormulaSpotlights(saved)).toBe(false);
  generate.mockClear();
  expect(await preparePlaybackFormulaSpotlights({ ...request(), block: saved })).toEqual(
    formulaSpotlights
  );
  expect(generate).not.toHaveBeenCalled();
});

test('prepares separate local symbol links for repeated saved pronunciations and reuses them', async () => {
  const input = request();
  const original = structuredClone(input.block);
  expect(needsPlaybackFormulaSpotlights(input.block)).toBe(true);
  const formulaSpotlights = await preparePlaybackFormulaSpotlights(input);
  expect(formulaSpotlights).toEqual(
    Array.from({ length: 2 }, () => ({ formula: '$x+y$', scene: dictatedFormulaSpotlight }))
  );
  expect(
    generate.mock.calls.map(([input]) => ({
      source: input.lessonMarkdown,
      speech: input.narration,
      types: input.allowedSceneTypes,
    }))
  ).toEqual([
    { source: '$x+y$\n\nics più ipsilon', speech: 'ics più ipsilon', types: ['formula-spotlight'] },
    { source: '$x+y$\n\nics più ipsilon', speech: 'ics più ipsilon', types: ['formula-spotlight'] },
  ]);
  expect(input.block).toEqual(original);
  const saved = { ...input.block, prepared: { ...input.block.prepared, formulaSpotlights } };
  expect(needsPlaybackFormulaSpotlights(saved)).toBe(false);
  generate.mockClear();
  expect(await preparePlaybackFormulaSpotlights({ ...input, block: saved })).toEqual(
    formulaSpotlights
  );
  expect(generate).not.toHaveBeenCalled();
  expect(
    needsPlaybackFormulaSpotlights({
      ...input.block,
      prepared: { ...input.block.prepared, scene: dictatedFormulaSpotlight },
    })
  ).toBe(false);
  expect(needsPlaybackFormulaSpotlights({ ...input.block, prepared: { motion: [] } })).toBe(true);
});

test('rejects a mathematically different widget before saving and corrects it through the same service', async () => {
  generate.mockResolvedValueOnce({
    kind: 'scene',
    scene: { ...dictatedFormulaSpotlight, formula: String.raw`\nousSymbol{x}-\nousSymbol{y}` },
  });
  const result = await preparePlaybackFormulaSpotlights(request());
  expect(result[0].scene).toEqual(dictatedFormulaSpotlight);
  expect(generate).toHaveBeenCalledTimes(3);
});

test('cancels between occurrences without starting another provider request', async () => {
  const controller = new AbortController();
  generate.mockImplementationOnce(async () => {
    controller.abort();
    return { kind: 'scene', scene: dictatedFormulaSpotlight };
  });
  await expect(
    preparePlaybackFormulaSpotlights({ ...request(), signal: controller.signal })
  ).rejects.toThrow();
  expect(generate).toHaveBeenCalledTimes(1);
});

test.each([
  true,
  false,
])('prepares and caches inherited formula references through the service (mentioned: %s)', async mentioned => {
  const sources = [{ type: 'markdown' as const, markdown: '# Tema\n\n$$x+y$$\n\nics più ipsilon' }];
  const raw = segmentLessonPlayback(sources).at(-1);
  if (!raw) throw new Error('The reference passage must exist');
  const source = { ...raw, prepared: { motion: [] } };
  const scene = mentioned
    ? dictatedFormulaSpotlight
    : {
        ...dictatedFormulaSpotlight,
        symbols: dictatedFormulaSpotlight.symbols.map(symbol => ({ ...symbol, anchor: '' })),
      };
  generate.mockResolvedValue({ kind: 'scene', scene });
  expect(needsPlaybackFormulaSpotlights(source, [], sources)).toBe(true);
  const formulaSpotlights = await preparePlaybackFormulaSpotlights({
    ...request(),
    block: source,
    sources,
  });
  expect(formulaSpotlights).toEqual([{ formula: '$$x+y$$', sourceFormula: '$$x+y$$', scene }]);
  expect(generate.mock.calls[0][0].narration).toBe(source.speech);
  const saved = { ...source, prepared: { ...source.prepared, formulaSpotlights } };
  expect(needsPlaybackFormulaSpotlights(saved, [], sources)).toBe(false);
  generate.mockClear();
  expect(await preparePlaybackFormulaSpotlights({ ...request(), block: saved, sources })).toEqual(
    formulaSpotlights
  );
  expect(generate).not.toHaveBeenCalled();
});
