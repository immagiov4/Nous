import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { structured, icons, heavy } = vi.hoisted(() => ({
  structured: vi.fn(),
  icons: vi.fn(),
  heavy: vi.fn().mockResolvedValue(0),
}));
vi.mock('../apps/backend/src/config/env.js', () => {
  process.env.MODEL_SCENE = 'synthetic-scene-from-env';
  process.env.AI_PROVIDER = 'openrouter';
  process.env.OPENROUTER_API_KEY = 'synthetic-key';
  return {};
});
vi.mock('../apps/backend/src/services/structuredGeneration.js', () => ({
  generateStructuredOutput: structured,
}));
vi.mock('../apps/backend/src/services/lessonScenes/lessonSceneIconChoice.js', () => ({
  chooseLessonSceneIcons: icons,
}));
vi.mock('./heavy-run.mjs', () => ({ main: heavy }));

import { runBenchmark, runCli } from './scene-preference-benchmark.js';

const passage = 'Rain falls and water flows.';
const fixture = {
  id: 'synthetic-cli',
  passage,
  sectionTitle: 'Water',
  sectionDescription: '',
  preferred: 'concepts',
  rejected: 'comparison',
  tie: false,
};
const queries = { action: 'flow', object: 'water', concept: 'rain' };
const draft = {
  intent: 'Show parts',
  evidence: passage,
  type: 'concepts',
  conceptLayout: 'grid',
  title: 'Water',
  body: '',
  criteria: [],
  diagram: null,
  groups: [],
  note: '',
  quote: '',
  relation: null,
  items: [
    { label: 'Rain', detail: '', value: null, time: null, iconQueries: queries },
    { label: 'Water', detail: '', value: null, time: null, iconQueries: queries },
  ],
};
const originalEnv = { ...process.env };
beforeEach(() => {
  // CI runs coverage under Node; exercise the Bun Git adapter against the real local Git process.
  vi.stubGlobal('Bun', {
    spawnSync: (args: string[], options: { cwd: string; windowsHide: boolean }) => {
      const result = spawnSync(args[0], args.slice(1), options);
      return { ...result, success: result.status === 0 };
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

test('runs the production generator after environment initialization, before icons, and saves three complete repetitions', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'scene-cli-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'table').mockImplementation(() => {});
  structured.mockResolvedValue(draft);
  try {
    const dataset = join(folder, 'cases.jsonl');
    const output = join(folder, 'report.json');
    await writeFile(
      dataset,
      `${JSON.stringify(fixture)}\n${JSON.stringify({ ...fixture, id: 'synthetic-tie', tie: true })}\n`
    );
    const args = ['--dataset', dataset, '--output', output];
    await runBenchmark(args);
    expect(structured).not.toHaveBeenCalled();
    await runBenchmark([...args, '--run']);
    const report = JSON.parse(await readFile(output, 'utf8'));
    expect(report.metadata).toMatchObject({
      model: 'synthetic-scene-from-env',
      provider: 'openrouter',
      reasoningEffort: 'low',
      dirty: expect.any(Boolean),
      commit: expect.any(String),
      diffSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(report.summary).toMatchObject({
      completedTrials: 3,
      expectedTrials: 3,
      cancelledTrials: 0,
      accuracy: { mean: 1, spread: 0 },
    });
    expect(report.trials.every((trial: { chosen: string }) => trial.chosen === 'concepts')).toBe(
      true
    );
    expect(structured).toHaveBeenCalledTimes(3);
    expect(icons).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(fixture.id);
    await expect(runBenchmark([...args, '--run'])).rejects.toMatchObject({ code: 'EEXIST' });
    expect(structured).toHaveBeenCalledTimes(3);
    await runBenchmark([
      '--dataset',
      dataset,
      '--output',
      join(folder, 'limited.json'),
      '--limit',
      '1',
    ]);
    await runBenchmark([
      '--dataset',
      dataset,
      '--output',
      join(folder, 'selected.json'),
      '--cases',
      fixture.id,
    ]);
    await expect(
      runBenchmark([
        '--dataset',
        dataset,
        '--output',
        join(folder, 'unknown.json'),
        '--cases',
        'unknown',
      ])
    ).rejects.toThrow('Unknown case');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    await expect(
      runBenchmark(['--dataset', dataset, '--output', join(folder, 'key.json'), '--run'])
    ).rejects.toThrow('OPENROUTER_API_KEY');
  } finally {
    for (const key of ['MODEL_SCENE', 'AI_PROVIDER', 'OPENROUTER_API_KEY']) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    await rm(folder, { recursive: true, force: true });
  }
});

test('retains partial cancellation without counting the censored trial as completed', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'scene-cancel-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'table').mockImplementation(() => {});
  vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-key');
  structured.mockImplementationOnce(async () => {
    process.emit('SIGINT');
    throw new Error('cancelled');
  });
  try {
    const dataset = join(folder, 'cases.jsonl');
    const output = join(folder, 'report.json');
    await writeFile(dataset, JSON.stringify(fixture));
    await runBenchmark(['--dataset', dataset, '--output', output, '--run']);
    const report = JSON.parse(await readFile(output, 'utf8'));
    expect(report).toMatchObject({
      cancelled: true,
      summary: {
        completedTrials: 0,
        cancelledTrials: 1,
        latencyMs: { p50: null, p95: null },
        failureRate: null,
      },
    });
    expect(process.exitCode).toBe(130);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('routes real batches through the existing shared lease and reuses inherited admission', async () => {
  vi.stubEnv('CI', 'false');
  vi.stubEnv('HEAVY_RUN_HELD', '');
  await runCli(['--run', '--dataset', 'synthetic.jsonl', '--output', 'report.json']);
  expect(heavy).toHaveBeenCalledWith(
    expect.arrayContaining(['--label', 'scene-preferences', '--', process.execPath, '--run']),
    { onInterrupt: expect.any(Function) }
  );
  vi.stubEnv('HEAVY_RUN_HELD', '1');
  await expect(runCli(['--run'])).rejects.toThrow('Usage:');
});

test('requests one graceful cancellation and leaves repeated interruption to forced lease cleanup', async () => {
  vi.stubEnv('CI', 'false');
  vi.stubEnv('HEAVY_RUN_HELD', '');
  heavy.mockImplementationOnce(async (args, options) => {
    const cancelFile = args.at(-1);
    expect(options.onInterrupt()).toBe(false);
    writeFileSync(`${cancelFile}.ready`, '', { flag: 'wx' });
    expect(options.onInterrupt()).toBe(true);
    expect(existsSync(cancelFile)).toBe(true);
    expect(options.onInterrupt()).toBe(false);
    return 130;
  });
  await runCli(['--run']);
  expect(process.exitCode).toBe(130);
});

test.each([
  'schema',
  'domain',
])('retains the real generator %s failure stage without private diagnostics', async stage => {
  const folder = await mkdtemp(join(tmpdir(), 'scene-invalid-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'table').mockImplementation(() => {});
  vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-key');
  structured.mockResolvedValue(
    stage === 'schema' ? {} : { ...draft, evidence: 'private invalid quotation' }
  );
  try {
    const dataset = join(folder, 'cases.jsonl');
    const output = join(folder, 'report.json');
    await writeFile(dataset, JSON.stringify(fixture));
    await runBenchmark(['--dataset', dataset, '--output', output, '--repetitions', '1', '--run']);
    const report = JSON.parse(await readFile(output, 'utf8'));
    expect(report.trials[0]).toMatchObject({
      kind: 'invalid',
      diagnostic: { type: 'Error', errorStage: stage },
    });
    expect(report.trials[0].diagnostic).not.toHaveProperty('originalMessage');
    expect(JSON.stringify(report)).not.toContain('private invalid quotation');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

import { spawnSync } from 'node:child_process';
