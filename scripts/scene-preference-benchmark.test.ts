import { expect, test, vi } from 'vitest';
import { measureCase, parseCases, summarize, type Trial } from './scene-preference-benchmark.js';

const cases = [
  {
    id: 'synthetic-a',
    passage: 'Rain falls, then water flows.',
    sectionTitle: 'Water',
    sectionDescription: '',
    preferred: 'steps',
    rejected: 'concepts',
    tie: false,
  },
  {
    id: 'synthetic-b',
    passage: 'Compare two routes.',
    sectionTitle: 'Routes',
    sectionDescription: '',
    preferred: 'comparison',
    rejected: 'parts',
    tie: false,
  },
  {
    id: 'synthetic-c',
    passage: 'A point lies within a polygon.',
    sectionTitle: 'Geometry',
    sectionDescription: '',
    preferred: 'uncovered:polygon',
    rejected: 'steps',
    tie: false,
  },
  {
    id: 'synthetic-tie',
    passage: 'Two equal options.',
    sectionTitle: 'Options',
    sectionDescription: '',
    preferred: 'parts',
    rejected: 'concepts',
    tie: true,
  },
];

test('scores only decisive covered pairs; neither and failures remain visible', () => {
  const trials: Trial[] = [
    { id: 'synthetic-a', repetition: 1, kind: 'scene', chosen: 'steps', latencyMs: 10 },
    { id: 'synthetic-b', repetition: 1, kind: 'scene', chosen: 'parts', latencyMs: 20 },
    { id: 'synthetic-c', repetition: 1, kind: 'scene', chosen: 'steps', latencyMs: 30 },
    { id: 'synthetic-a', repetition: 2, kind: 'scene', chosen: 'network', latencyMs: 40 },
    { id: 'synthetic-b', repetition: 2, kind: 'text', latencyMs: 50 },
    { id: 'synthetic-a', repetition: 3, kind: 'invalid', latencyMs: 60 },
    { id: 'synthetic-b', repetition: 3, kind: 'error', latencyMs: 70 },
  ];
  const report = summarize(cases, trials, 3);
  expect(report.dataset).toEqual({
    total: 4,
    decisive: 3,
    ties: 1,
    coveredPairs: 2,
    uncoveredPreferred: { polygon: 1 },
    uncoveredPreferredShare: 1 / 3,
  });
  expect(report.repetitions.map(r => [r.preferred, r.rejected, r.neither, r.accuracy])).toEqual([
    [1, 1, 0, 0.5],
    [0, 0, 1, null],
    [0, 0, 0, null],
  ]);
  expect(report.accuracy).toEqual({
    mean: 0.5,
    min: 0.5,
    max: 0.5,
    spread: 0,
    scoredRepetitions: 1,
  });
  expect(report.latencyMs).toEqual({ p50: 40, p95: 70 });
  expect(report.failureRate).toBe(2 / 7);
  expect(report.textFallbackRate).toBe(1 / 7);
  expect(report.completedTrials).toBe(7);
  expect(report.expectedTrials).toBe(9);
});

test('reports spread across repetitions and no accuracy for empty pairs', () => {
  const trials: Trial[] = [1, 2, 3].flatMap(repetition => [
    {
      id: 'synthetic-a',
      repetition,
      kind: 'scene' as const,
      chosen: repetition === 1 ? 'concepts' : 'steps',
      latencyMs: 1,
    },
    { id: 'synthetic-b', repetition, kind: 'scene' as const, chosen: 'comparison', latencyMs: 1 },
  ]);
  expect(summarize(cases, trials, 3).accuracy).toEqual({
    mean: 5 / 6,
    min: 0.5,
    max: 1,
    spread: 0.5,
    scoredRepetitions: 3,
  });
  expect(summarize(cases, [], 3).accuracy.mean).toBeNull();
});

test('validates JSONL without echoing private records in errors', () => {
  expect(parseCases(cases.map(c => JSON.stringify(c)).join('\n'))).toEqual(cases);
  for (const input of [
    '',
    'secret passage',
    JSON.stringify({ ...cases[0], preferred: 'bogus' }),
    [cases[0], cases[0]].map(c => JSON.stringify(c)).join('\n'),
    JSON.stringify({ ...cases[0], rejected: 'steps' }),
  ]) {
    expect(() => parseCases(input)).toThrow('Invalid benchmark dataset');
  }
});

const slot = {
  model: 'synthetic',
  provider: 'openrouter' as const,
  reasoningEffort: 'low' as const,
};
const config = {
  artifact: slot,
  artifactInteractive: slot,
  image: slot,
  review: { enabled: false, maxRounds: 1 },
};

test('observes validated form before icons and sends only source fields to the generator', async () => {
  let reachedIcons = false;
  const generate = vi.fn(async input => {
    input.onValidatedScene({ type: 'steps' });
    reachedIcons = true;
    return { kind: 'invalid' as const, problems: [] };
  });
  const result = await measureCase({
    c: cases[0],
    repetition: 1,
    config,
    signal: new AbortController().signal,
    generate,
  });
  expect(result).toMatchObject({
    id: 'synthetic-a',
    repetition: 1,
    kind: 'scene',
    chosen: 'steps',
  });
  expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  expect(reachedIcons).toBe(false);
  const input = generate.mock.calls[0][0];
  expect(input.lessonMarkdown).toBe(cases[0].passage);
  expect(Object.keys(input).sort()).toEqual([
    'allowTextFallback',
    'config',
    'lessonMarkdown',
    'onValidatedScene',
    'sectionDescription',
    'sectionTitle',
    'signal',
  ]);
});

test('distinguishes text, invalid output, provider failure and cancellation without leaking errors', async () => {
  const signal = new AbortController().signal;
  const base = { c: cases[0], repetition: 1, config, signal };
  for (const kind of ['text', 'invalid']) {
    expect(
      (await measureCase({ ...base, generate: vi.fn().mockResolvedValue({ kind }) })).kind
    ).toBe(kind);
  }
  const failure = await measureCase({
    ...base,
    generate: vi.fn().mockRejectedValue(new Error('private request contents')),
  });
  expect(failure.kind).toBe('error');
  expect(JSON.stringify(failure)).not.toContain('private request contents');
  expect(
    (
      await measureCase({
        ...base,
        signal: AbortSignal.abort(),
        generate: vi.fn().mockRejectedValue(new Error('abort')),
      })
    ).kind
  ).toBe('cancelled');
});
