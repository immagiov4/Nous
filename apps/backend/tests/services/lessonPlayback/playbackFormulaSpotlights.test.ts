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

test('prepares separate full-passage symbol links for repeated saved pronunciations and reuses them', async () => {
  const input = request();
  const original = structuredClone(input.block);
  expect(needsPlaybackFormulaSpotlights(input.block)).toBe(true);
  const formulaSpotlights = await preparePlaybackFormulaSpotlights(input);
  expect(formulaSpotlights).toEqual(
    Array.from({ length: 2 }, () => ({
      formula: '$x+y$',
      sourceFormula: '$x+y$',
      scene: dictatedFormulaSpotlight,
    }))
  );
  const narration = 'Prima ics più ipsilon poi ics più ipsilon fine';
  expect(generate.mock.calls.map(([input]) => input.narration)).toEqual([narration, narration]);
  expect(generate.mock.calls.map(([input]) => input.allowedSceneTypes)).toEqual([
    ['formula-spotlight'],
    ['formula-spotlight'],
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
    scene: {
      ...dictatedFormulaSpotlight,
      symbols: dictatedFormulaSpotlight.symbols.map(symbol =>
        symbol.id === 'plus'
          ? { ...symbol, latex: '-', name: 'Meno', meaning: 'Differenza' }
          : symbol
      ),
    },
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
  const sources = [
    {
      type: 'markdown' as const,
      markdown: '# Tema\n\nIntroduzione alla formula.\n\n$$x+y$$\n\nics più ipsilon',
    },
  ];
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

test('links a formula reading and explanatory mentions in the same saved passage', async () => {
  const source = {
    ...segmentLessonPlayback([
      { type: 'markdown', markdown: '$x+y$: ics indica il primo valore.' },
    ])[0],
    prepared: { motion: [], spokenMath: [{ formula: '$x+y$', spoken: 'ics più ipsilon' }] },
  };
  const scene = {
    ...dictatedFormulaSpotlight,
    symbols: dictatedFormulaSpotlight.symbols.map(symbol => ({
      ...symbol,
      ...(symbol.id === 'x'
        ? { anchorOccurrence: 0, additionalAnchors: [{ anchor: 'ics', anchorOccurrence: 1 }] }
        : {}),
    })),
  };
  generate.mockResolvedValue({ kind: 'scene', scene });
  const formulaSpotlights = await preparePlaybackFormulaSpotlights({ ...request(), block: source });
  expect(generate.mock.calls[0][0].narration).toBe('ics più ipsilon: ics indica il primo valore.');
  expect(formulaSpotlights).toEqual([{ formula: '$x+y$', sourceFormula: '$x+y$', scene }]);
});

test('corrects missing authored terms with the previous formula and exact source', async () => {
  const source = {
    ...segmentLessonPlayback([{ type: 'markdown', markdown: 'Prima $x+y$ fine' }])[0],
    prepared: { motion: [], spokenMath: [{ formula: '$x+y$', spoken: 'ics più ipsilon' }] },
  };
  const incomplete = {
    ...dictatedFormulaSpotlight,
    formula: String.raw`\nousSymbol{x}`,
    symbols: [dictatedFormulaSpotlight.symbols[0]],
  };
  generate.mockResolvedValueOnce({ kind: 'scene', scene: incomplete });
  const result = await preparePlaybackFormulaSpotlights({ ...request(), block: source });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(JSON.parse(generate.mock.calls[1][0].retryFeedback)).toMatchObject({
    sourceFormula: '$x+y$',
    previousFormula: '{x}',
    previousDraft: { formula: incomplete.formula, symbols: incomplete.symbols },
  });
  expect(result).toEqual([
    { formula: '$x+y$', sourceFormula: '$x+y$', scene: dictatedFormulaSpotlight },
  ]);
});

test('prepares only the unlinked neighbor of an existing animated formula', async () => {
  const linked = dictatedFormulaSpotlight;
  const unlinked = {
    ...linked,
    formula: linked.formula,
    symbols: linked.symbols.map(symbol => ({
      ...symbol,
      ...(symbol.id === 'plus' ? { latex: '-', name: 'Meno', meaning: 'Differenza' } : {}),
      anchor: '',
    })),
  };
  const source = {
    ...segmentLessonPlayback([{ type: 'markdown', markdown: 'ics più ipsilon' }])[0],
    visuals: [
      { kind: 'scene' as const, scene: linked },
      { kind: 'scene' as const, scene: unlinked },
    ],
    prepared: {
      motion: [],
      formulaSpotlights: [
        {
          formula: '$${x}{+}{y}$$',
          sourceFormula: linked.formula,
          scene: { ...linked, symbols: linked.symbols.map(symbol => ({ ...symbol, anchor: '' })) },
        },
      ],
    },
  };
  generate.mockResolvedValue({ kind: 'scene', scene: unlinked });
  expect(needsPlaybackFormulaSpotlights(source)).toBe(true);
  const formulaSpotlights = await preparePlaybackFormulaSpotlights({ ...request(), block: source });
  expect(generate).toHaveBeenCalledTimes(1);
  expect(generate.mock.calls[0][0].formulaSource.template).toEqual(unlinked);
  expect(formulaSpotlights).toEqual([
    { formula: '$${x}{-}{y}$$', sourceFormula: unlinked.formula, scene: unlinked },
  ]);
  const saved = { ...source, prepared: { motion: [], formulaSpotlights } };
  expect(needsPlaybackFormulaSpotlights(saved)).toBe(false);
  generate.mockClear();
  expect(await preparePlaybackFormulaSpotlights({ ...request(), block: saved })).toEqual(
    formulaSpotlights
  );
  expect(generate).not.toHaveBeenCalled();
});
