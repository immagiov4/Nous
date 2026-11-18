import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { MAX_VISUAL_LESSON_CHARS } from '../packages/shared-types/lessonGenerationPolicy.js';
import {
  measureCase,
  outsideRepository,
  parseCases,
  readOptions,
  summarize,
  type Trial,
  writeCheckpoint,
} from './scene-preference-benchmark.js';

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
    nonSelectablePairs: 0,
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

test('keeps an archived hierarchy preference without scoring an unavailable alternative', () => {
  const archived = { ...cases[0], preferred: 'hierarchy', rejected: 'tree' };
  const dataset = parseCases(JSON.stringify(archived));
  expect(dataset).toEqual([archived]);
  const result = summarize(
    dataset,
    [{ id: archived.id, repetition: 1, kind: 'scene', chosen: 'tree', latencyMs: 10 }],
    1
  );
  expect(result.dataset).toMatchObject({ coveredPairs: 0, nonSelectablePairs: 1 });
  expect(result.repetitions[0]).toMatchObject({ completed: 1, rejected: 0, accuracy: null });
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
  const quantitativePair = { ...cases[0], preferred: 'heatmap', rejected: 'interval' };
  expect(parseCases(JSON.stringify(quantitativePair))).toEqual([quantitativePair]);
  for (const input of [
    '',
    'secret passage',
    JSON.stringify({ ...cases[0], preferred: 'bogus' }),
    [cases[0], cases[0]].map(c => JSON.stringify(c)).join('\n'),
    JSON.stringify({ ...cases[0], rejected: 'steps' }),
    JSON.stringify({ ...cases[0], preferred: 'formula-spotlight' }),
    JSON.stringify({ ...cases[0], rejected: 'formula-spotlight' }),
    JSON.stringify({ ...cases[0], preferred: 'hypothesis' }),
    JSON.stringify({ ...cases[0], rejected: 'hypothesis' }),
    JSON.stringify({ ...cases[0], preferred: 'continuum' }),
    JSON.stringify({ ...cases[0], rejected: 'continuum' }),
  ]) {
    expect(() => parseCases(input)).toThrowError(new Error('Invalid benchmark dataset'));
  }
});

test('records the production excerpt boundary and hash without retaining passage text', async () => {
  const passage = `${'a'.repeat(MAX_VISUAL_LESSON_CHARS)}omitted tail`;
  for (const text of [passage, 'short passage']) {
    const trial = await measureCase({
      c: { ...cases[0], passage: text },
      repetition: 1,
      config,
      signal: new AbortController().signal,
      generate: vi.fn().mockResolvedValue({ kind: 'text' }),
    });
    expect(trial.source).toEqual({
      chars: text.length,
      excerptChars: Math.min(text.length, MAX_VISUAL_LESSON_CHARS),
      truncated: text.length > MAX_VISUAL_LESSON_CHARS,
      excerptSha256: createHash('sha256')
        .update(text.slice(0, MAX_VISUAL_LESSON_CHARS))
        .digest('hex'),
    });
    expect(JSON.stringify(trial)).not.toContain(text);
  }
});

test('rejects internal dot-dot-prefixed directories and junctions while admitting external siblings', async () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const internal = await mkdtemp(join(repo, '..private-'));
  const external = await mkdtemp(join(dirname(repo), 'benchmark-private-'));
  try {
    await expect(outsideRepository(repo)).rejects.toThrow();
    await expect(outsideRepository(internal)).rejects.toThrow();
    await expect(outsideRepository(external)).resolves.toBeTruthy();
    const alias = join(external, 'alias');
    await symlink(internal, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(outsideRepository(alias)).rejects.toThrow();
  } finally {
    await rm(external, { recursive: true, force: true });
    await rm(internal, { recursive: true, force: true });
  }
});

test('rejects empty and conflicting smoke selectors before a paid run can start', () => {
  const base = ['--dataset', 'external.jsonl', '--output', 'report.json', '--run'];
  for (const args of [
    [],
    ['--limit', ''],
    ['--limit', ' '],
    ['--limit', '0'],
    ['--repetitions', '1.5'],
    ['--cases', ''],
    ['--cases', ' '],
    ['--cases', ','],
    ['--cases', 'a,'],
    ['--cases', 'a', '--limit', '1'],
  ]) {
    expect(() => readOptions(args.length ? [...base, ...args] : args)).toThrow();
  }
  expect(readOptions([...base, '--limit', '1'])).toMatchObject({ limit: '1', repetitions: 3 });
  expect(readOptions([...base, '--cases', 'a,b'])).toMatchObject({ cases: 'a,b' });
});

test('keeps censored cancellations out of completion counts, percentiles and rate denominators', () => {
  const report = summarize(
    cases,
    [
      { id: 'synthetic-a', repetition: 1, kind: 'cancelled', latencyMs: 100000 },
      { id: 'synthetic-b', repetition: 1, kind: 'error', latencyMs: 10 },
      { id: 'synthetic-c', repetition: 1, kind: 'text', latencyMs: 20 },
    ],
    3
  );
  expect(report).toMatchObject({
    completedTrials: 2,
    cancelledTrials: 1,
    failureRate: 0.5,
    textFallbackRate: 0.5,
    latencyMs: { p50: 10, p95: 20 },
  });
  expect(report.repetitions[0].completed).toBe(2);
});

test('checkpoints never touch a stale partial link and clean failed rename temporaries', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'scene-checkpoint-'));
  try {
    const output = join(folder, 'report.json');
    const protectedFile = join(folder, 'protected.json');
    await writeFile(protectedFile, 'keep');
    const target = join(folder, 'protected');
    await mkdir(target);
    await symlink(target, `${output}.partial`, process.platform === 'win32' ? 'junction' : 'dir');
    await writeCheckpoint(output, { synthetic: true });
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({ synthetic: true });
    expect(await readFile(protectedFile, 'utf8')).toBe('keep');
    await expect(writeCheckpoint(folder, {})).rejects.toThrow();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('retains bounded technical failure codes and stages while stripping private messages and bodies', async () => {
  const error = Object.assign(new Error('private request contents'), {
    name: 'AI_APICallError',
    statusCode: 401,
    code: 'AUTH_FAILED',
    stage: 'awaiting-output',
    responseBody: 'private response',
  });
  const trial = await measureCase({
    c: cases[0],
    repetition: 1,
    config,
    signal: new AbortController().signal,
    generate: vi.fn().mockRejectedValue(error),
  });
  expect(trial.diagnostic).toMatchObject({
    type: 'AI_APICallError',
    status: 401,
    code: 'AUTH_FAILED',
    errorStage: 'awaiting-output',
  });
  expect(JSON.stringify(trial)).not.toContain('private');
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

test('captures validated form and sends only source fields to the generator', async () => {
  const generate = vi.fn(async input => {
    input.onValidatedScene({ type: 'steps' });
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
