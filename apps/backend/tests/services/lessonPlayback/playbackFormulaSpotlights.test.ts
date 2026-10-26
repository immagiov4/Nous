import {
  needsPlaybackFormulaSpotlights,
  type PlaybackContentBlock,
  playbackFormulaTargets,
  segmentLessonPlayback,
} from '@shared/lessonPlayback';
import { playbackVisualSections } from '@shared/playbackVisualSections';
import { beforeEach, expect, test, vi } from 'vitest';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('../../../src/services/lessonScenes/lessonSceneGeneration.js', () => ({
  generateLessonScene: generate,
}));

import { getGlobalModelConfig } from '../../../src/config/modelConfig.js';
import { preparePlaybackFormulaSpotlights } from '../../../src/services/lessonPlayback/playbackFormulaSpotlights.js';
import { toStepFailure } from '../../../src/workflows/retryPolicy.js';
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
const repeatedScene = {
  ...dictatedFormulaSpotlight,
  symbols: dictatedFormulaSpotlight.symbols.map(symbol => ({
    ...symbol,
    anchorOccurrence: 0,
    additionalAnchors: [{ anchor: symbol.anchor, anchorOccurrence: 1 }],
  })),
};
beforeEach(() => {
  vi.resetAllMocks();
  generate.mockImplementation(input => ({
    kind: 'scene',
    scene:
      input.narration === 'Prima ics più ipsilon poi ics più ipsilon fine'
        ? repeatedScene
        : dictatedFormulaSpotlight,
  }));
});

test('reuses distinct authored widgets for their own repeated dictated occurrences', async () => {
  const input = request();
  const scenes = [0, 1].map(anchorOccurrence => ({
    ...dictatedFormulaSpotlight,
    title: `Occorrenza ${anchorOccurrence + 1}`,
    symbols: dictatedFormulaSpotlight.symbols.map(symbol => ({
      ...symbol,
      anchorOccurrence,
    })),
  }));
  const source = {
    ...input.block,
    visuals: scenes.map(scene => ({ kind: 'scene' as const, scene })),
  };
  const targets = playbackFormulaTargets(source);
  expect(targets.map(target => target.readingRanges)).toEqual([
    [{ start: 6, end: 21 }],
    [{ start: 26, end: 41 }],
  ]);
  expect(needsPlaybackFormulaSpotlights(source)).toBe(false);
  const prepared = await preparePlaybackFormulaSpotlights({
    ...input,
    block: source,
  });
  expect(prepared.map(entry => entry.scene)).toEqual(scenes);
  expect(generate).not.toHaveBeenCalled();
});

test('prepares the retained complete equation when inline mathematics names one of its parts', async () => {
  const sources = [
    { type: 'markdown' as const, markdown: '## Relazione\n\n$$x+y$$' },
    { type: 'markdown' as const, markdown: 'Il termine $x$ compare.' },
  ];
  const raw = segmentLessonPlayback([sources[1]])[0];
  const source = {
    ...raw,
    spans: raw.spans.map(span => ({ ...span, sourceBlockIndex: 1 })),
    prepared: { motion: [], spokenMath: [{ formula: '$x$', spoken: 'ics' }] },
  };
  const complete = {
    ...dictatedFormulaSpotlight,
    symbols: dictatedFormulaSpotlight.symbols.map(symbol => ({
      ...symbol,
      anchor: symbol.id === 'x' ? 'ics' : '',
    })),
  };
  generate.mockResolvedValue({ kind: 'scene', scene: complete });
  const original = structuredClone(source);
  const targets = playbackFormulaTargets(source, [], sources);
  expect(targets.map(target => target.formula)).toEqual(['$$x+y$$']);
  const prepared = await preparePlaybackFormulaSpotlights({
    ...request(),
    block: source,
    sources,
  });
  expect(generate).toHaveBeenCalledOnce();
  expect(prepared[0].scene).toEqual(complete);
  expect(source).toEqual(original);
  expect(
    needsPlaybackFormulaSpotlights(
      {
        ...source,
        prepared: { ...source.prepared, formulaSpotlights: prepared },
      },
      [],
      sources
    )
  ).toBe(false);
});

test('repairs an existing spotlight that omits a later dictated reading', async () => {
  const input = request();
  const firstReadingOnly = {
    ...dictatedFormulaSpotlight,
    symbols: dictatedFormulaSpotlight.symbols.map(symbol => ({ ...symbol, anchorOccurrence: 0 })),
  };
  const source = { ...input.block, prepared: { ...input.block.prepared, scene: firstReadingOnly } };
  expect(needsPlaybackFormulaSpotlights(source)).toBe(true);
  const formulaSpotlights = await preparePlaybackFormulaSpotlights({ ...input, block: source });
  expect(generate).toHaveBeenCalledOnce();
  expect(formulaSpotlights[0].scene).toEqual(repeatedScene);
  expect(
    needsPlaybackFormulaSpotlights({
      ...source,
      prepared: { ...source.prepared, formulaSpotlights },
    })
  ).toBe(false);
});

test('prepares later reading links even when source readiness was not queried', async () => {
  const input = request();
  const firstReadingOnly = {
    ...dictatedFormulaSpotlight,
    symbols: dictatedFormulaSpotlight.symbols.map(symbol => ({ ...symbol, anchorOccurrence: 0 })),
  };
  const result = await preparePlaybackFormulaSpotlights({
    ...input,
    block: { ...input.block, visuals: [{ kind: 'scene', scene: firstReadingOnly }] },
  });
  expect(generate).toHaveBeenCalledOnce();
  expect(result[0].scene).toEqual(repeatedScene);
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
    ...segmentLessonPlayback([
      { type: 'markdown', markdown: mentioned ? 'ics più ipsilon' : 'Una relazione di richiamo.' },
    ])[0],
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
      scene: repeatedScene,
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
      prepared: { ...input.block.prepared, scene: repeatedScene },
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
  expect(result[0].scene).toEqual(repeatedScene);
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
      markdown:
        '# Tema\n\nIntroduzione alla formula.\n\n$$x+y$$\n\n' +
        (mentioned ? 'ics più ipsilon' : 'La relazione rimane mostrata.'),
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
      ...(symbol.id === 'x' ? { latex: 'u', name: 'U' } : {}),
      ...(symbol.id === 'y' ? { latex: 'v', name: 'Vi' } : {}),
      ...(symbol.id === 'plus' ? { latex: '-', name: 'Meno', meaning: 'Differenza' } : {}),
      anchor: '',
    })),
  };
  const source = {
    ...segmentLessonPlayback([{ type: 'markdown', markdown: 'ics più ipsilon poi u meno vi' }])[0],
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
  const prepared = {
    ...unlinked,
    symbols: unlinked.symbols.map((symbol, index) => ({
      ...symbol,
      anchor: ['u', 'meno', 'vi'][index],
    })),
  };
  generate.mockResolvedValue({ kind: 'scene', scene: prepared });
  expect(needsPlaybackFormulaSpotlights(source)).toBe(true);
  const formulaSpotlights = await preparePlaybackFormulaSpotlights({ ...request(), block: source });
  expect(generate).toHaveBeenCalledTimes(1);
  expect(formulaSpotlights).toEqual([
    { formula: '$${x}{+}{y}$$', sourceFormula: linked.formula, scene: linked },
    { formula: '$${u}{-}{v}$$', sourceFormula: unlinked.formula, scene: prepared },
  ]);
  const saved = { ...source, prepared: { motion: [], formulaSpotlights } };
  expect(needsPlaybackFormulaSpotlights(saved)).toBe(false);
  generate.mockClear();
  expect(await preparePlaybackFormulaSpotlights({ ...request(), block: saved })).toEqual(
    formulaSpotlights
  );
  expect(generate).not.toHaveBeenCalled();
});

test('keeps separate cache slots for repeated unlinked presentations of the same formula', async () => {
  const unlinked = {
    ...dictatedFormulaSpotlight,
    symbols: dictatedFormulaSpotlight.symbols.map(symbol => ({ ...symbol, anchor: '' })),
  };
  const source = {
    ...segmentLessonPlayback([
      { type: 'markdown', markdown: 'ics più ipsilon poi ics più ipsilon' },
    ])[0],
    visuals: [
      { kind: 'scene' as const, scene: unlinked },
      { kind: 'scene' as const, scene: unlinked },
    ],
    prepared: { motion: [] },
  };
  const scenes = [0, 1].map(anchorOccurrence => ({
    ...dictatedFormulaSpotlight,
    title: `Lettura ${anchorOccurrence + 1}`,
    symbols: dictatedFormulaSpotlight.symbols.map(symbol => ({ ...symbol, anchorOccurrence })),
  }));
  for (const scene of scenes) generate.mockResolvedValueOnce({ kind: 'scene', scene });
  const formulaSpotlights = await preparePlaybackFormulaSpotlights({ ...request(), block: source });
  expect(formulaSpotlights.map(entry => entry.scene)).toEqual(
    scenes.map(scene => ({ ...scene, title: unlinked.title }))
  );
  expect(
    needsPlaybackFormulaSpotlights({
      ...source,
      prepared: { motion: [], formulaSpotlights: formulaSpotlights.slice(0, 1) },
    })
  ).toBe(true);
  expect(
    needsPlaybackFormulaSpotlights({ ...source, prepared: { motion: [], formulaSpotlights } })
  ).toBe(false);
});

test('prepares the sourced equation when a linked cached scene is incomplete and the stage cannot use it', async () => {
  const source = {
    ...segmentLessonPlayback([{ type: 'markdown', markdown: 'Prima $x+y$ fine' }])[0],
    prepared: {
      motion: [],
      spokenMath: [{ formula: '$x+y$', spoken: 'ics più ipsilon' }],
      scene: {
        ...dictatedFormulaSpotlight,
        formula: String.raw`\nousSymbol{x}`,
        symbols: [dictatedFormulaSpotlight.symbols[0]],
      },
    },
  };
  expect(needsPlaybackFormulaSpotlights(source)).toBe(true);
  const formulaSpotlights = await preparePlaybackFormulaSpotlights({ ...request(), block: source });
  expect(generate.mock.calls[0][0].formulaSource.formula).toBe('$x+y$');
  expect(formulaSpotlights).toEqual([
    { formula: '$x+y$', sourceFormula: '$x+y$', scene: dictatedFormulaSpotlight },
  ]);
  expect(
    needsPlaybackFormulaSpotlights({
      ...source,
      prepared: { ...source.prepared, formulaSpotlights },
    })
  ).toBe(false);
});

test('keeps an existing complete equation and prepares only the other dictated equation', async () => {
  const source = {
    ...segmentLessonPlayback([{ type: 'markdown', markdown: 'prima $x+y$ poi $u-v$ fine' }])[0],
    prepared: {
      motion: [],
      scene: dictatedFormulaSpotlight,
      spokenMath: [
        { formula: '$x+y$', spoken: 'ics più ipsilon' },
        { formula: '$u-v$', spoken: 'u meno vi' },
      ],
    },
  };
  const second = {
    ...dictatedFormulaSpotlight,
    symbols: dictatedFormulaSpotlight.symbols.map((symbol, index) => ({
      ...symbol,
      latex: ['u', '-', 'v'][index],
      anchor: ['u', 'meno', 'vi'][index],
    })),
  };
  generate.mockResolvedValue({ kind: 'scene', scene: second });
  expect(needsPlaybackFormulaSpotlights(source)).toBe(true);
  const formulaSpotlights = await preparePlaybackFormulaSpotlights({ ...request(), block: source });
  expect(generate).toHaveBeenCalledOnce();
  expect(generate.mock.calls[0][0].formulaSource.formula).toBe('$u-v$');
  expect(formulaSpotlights[0].scene).toBe(dictatedFormulaSpotlight);
  expect(formulaSpotlights[1].scene).toBe(second);
  expect(
    needsPlaybackFormulaSpotlights({
      ...source,
      prepared: { ...source.prepared, formulaSpotlights },
    })
  ).toBe(false);
});

test('rejects a prepared widget whose links omit its explicit formula reading', async () => {
  const input = request();
  generate.mockResolvedValue({
    kind: 'scene',
    scene: {
      ...dictatedFormulaSpotlight,
      symbols: dictatedFormulaSpotlight.symbols.map(symbol => ({ ...symbol, anchorOccurrence: 0 })),
    },
  });
  await expect(preparePlaybackFormulaSpotlights(input)).rejects.toThrow(
    'Formula highlighting preparation failed validation.'
  );
  // The first reading is valid; all attempts for the second must fail rather than save a later/earlier mention.
  expect(generate).toHaveBeenCalledTimes(4);
});

test('retains cached audio, alignment and lesson text when visual validation is exhausted', async () => {
  const input = request();
  const source = {
    ...input.block,
    audio: [
      {
        model: 'tts-model',
        voice: 'Zephyr',
        durationSeconds: 7,
        asset: { id: 'a'.repeat(64), hash: 'b'.repeat(64), byteSize: 128, mediaType: 'audio/mpeg' },
        wordAlignment: { status: 'aligned' as const, onsets: [0, 1, 2, 3, 4, 5, 6] },
      },
    ],
  };
  const original = structuredClone(source);
  generate.mockResolvedValue({
    kind: 'invalid',
    problems: ['The source words could not be linked.'],
  });
  await expect(preparePlaybackFormulaSpotlights({ ...input, block: source })).rejects.toThrow(
    'Formula highlighting preparation failed validation.'
  );
  expect(source).toEqual(original);
  expect(generate).toHaveBeenCalledTimes(3);
});

test('makes exhausted formula validation permanent at the workflow boundary', async () => {
  generate.mockResolvedValue({ kind: 'invalid', problems: ['Missing formula references.'] });
  const failure = await preparePlaybackFormulaSpotlights(request()).catch(toStepFailure);
  expect(failure).toMatchObject({
    kind: 'permanent',
    code: 'lesson_playback_formula_spotlight_invalid',
  });
  expect(generate).toHaveBeenCalledTimes(3);
});

test('keeps provider transport failures operational without starting corrective drafts', async () => {
  generate.mockRejectedValue(new Error('Provider unavailable'));
  const failure = await preparePlaybackFormulaSpotlights(request()).catch(toStepFailure);
  expect(failure).toMatchObject({ kind: 'operational' });
  expect(generate).toHaveBeenCalledOnce();
});

test.each([
  { origin: 'authored', linked: false },
  { origin: 'stored', linked: false },
  { origin: 'authored', linked: true },
  { origin: 'stored', linked: true },
])('prepares an incomplete $origin formula beside prepared list sections (linked: $linked)', async ({
  origin,
  linked,
}) => {
  const input = request();
  const scene = {
    ...dictatedFormulaSpotlight,
    symbols: dictatedFormulaSpotlight.symbols.map(symbol => ({
      ...symbol,
      anchor: linked ? symbol.anchor : '',
      anchorOccurrence: 0,
    })),
  };
  const storedVisuals = [
    {
      id: 'formula-widget',
      slotId: 'formula-slot',
      createdAt: '2026-10-26T00:00:00.000Z',
      render: { kind: 'scene' as const, scene },
    },
  ];
  const sources: PlaybackContentBlock[] = [
    { type: 'generated-visual', visualId: 'formula-widget' },
    { type: 'markdown', markdown: '- Prima $x+y$\n- Poi $x+y$' },
  ];
  const raw = segmentLessonPlayback(sources)[0];
  const sections = playbackVisualSections(raw, sources);
  expect(sections.some(section => section.items?.length === 2)).toBe(true);
  const source = {
    ...raw,
    visuals: raw.visuals.map(visual =>
      origin === 'authored' && visual.kind === 'generated-visual'
        ? { kind: 'scene' as const, scene }
        : visual
    ),
    prepared: {
      ...input.block.prepared,
      sections: sections.map(section => ({
        ...section,
        scene: { ...dictatedFormulaSpotlight, type: 'parts' as const },
      })),
    },
  };
  const original = structuredClone(source);
  expect(playbackFormulaTargets(source, storedVisuals)).toMatchObject([{ scene }]);
  expect(needsPlaybackFormulaSpotlights(source, storedVisuals)).toBe(true);
  generate.mockResolvedValue({ kind: 'scene', scene: repeatedScene });
  const formulaSpotlights = await preparePlaybackFormulaSpotlights({
    ...input,
    block: source,
    storedVisuals,
  });
  expect(generate).toHaveBeenCalledOnce();
  expect(formulaSpotlights[0].scene).toEqual(repeatedScene);
  expect(
    needsPlaybackFormulaSpotlights(
      {
        ...source,
        prepared: { ...source.prepared, formulaSpotlights },
      },
      storedVisuals
    )
  ).toBe(false);
  expect(source).toEqual(original);
});
