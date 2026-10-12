import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { recordWorkflowAiUsage } from '../apps/backend/src/workflows/workflowAiMetering.js';
import { type RunEvidenceContext, type RunManifest, withRunEvidence } from './run-evidence.js';

vi.mock('node:child_process', () => ({
  execFileSync: (_command: string, args: string[]) =>
    args[0] === 'rev-parse' ? 'test-commit\n' : ' M scripts/run-evidence.ts\n',
}));

const context: RunEvidenceContext = {
  scenario: 'fixture',
  provider: 'codex',
  case: 'simple',
  slots: { lesson: { model: 'fixture-model', reasoningEffort: 'low', serviceTier: 'normal' } },
};
let dataDirectory: string;
const history = async (): Promise<RunManifest[]> =>
  (await readFile(join(dataDirectory, 'runs', context.scenario, 'history.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));

beforeEach(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'nous-run-evidence-'));
  vi.stubEnv('NOUS_E2E_DATA', dataDirectory);
  vi.useFakeTimers({ toFake: ['Date', 'performance'] });
  vi.setSystemTime(new Date('2026-10-12T12:00:00.000Z'));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe('real-run evidence', () => {
  test('persists context, measurements, usage and named evidence', async () => {
    let directory = '';
    const result = await withRunEvidence(context, async recorder => {
      directory = recorder.directory;
      await recorder.writeJson('case.json', { answer: 42 });
      await recorder.writeEvidence('trace.txt', 'recorded response');
      return recorder.measure({ name: 'lesson', kind: 'call', attemptNumber: 2 }, async () => {
        await recordWorkflowAiUsage({
          provider: 'codex',
          model: 'fixture-model',
          inputTokens: 12,
          outputTokens: 7,
          cacheReadTokens: 3,
          cacheWriteTokens: 1,
          reasoningTokens: 2,
          providerCost: 0.01,
        });
        vi.advanceTimersByTime(25);
        return 42;
      });
    });
    expect(result).toBe(42);
    const manifest: RunManifest = JSON.parse(
      await readFile(join(directory, 'manifest.json'), 'utf8')
    );
    expect(manifest).toEqual({
      ...context,
      runId: expect.stringMatching(/^2026-10-12T12-00-00\.000Z-/),
      git: { commitSha: 'test-commit', dirty: true },
      startedAt: '2026-10-12T12:00:00.000Z',
      endedAt: '2026-10-12T12:00:00.025Z',
      durationMs: 25,
      outcome: 'passed',
      errorCode: null,
      measurements: [
        {
          name: 'lesson',
          kind: 'call',
          attemptNumber: 2,
          startedAt: '2026-10-12T12:00:00.000Z',
          endedAt: '2026-10-12T12:00:00.025Z',
          durationMs: 25,
          outcome: 'passed',
        },
      ],
      workflows: [],
      aiUsage: [
        {
          id: expect.any(String),
          runId: manifest.runId,
          nodeInstanceId: 'lesson',
          attemptNumber: 2,
          provider: 'codex',
          model: 'fixture-model',
          inputTokens: 12,
          outputTokens: 7,
          cacheReadTokens: 3,
          cacheWriteTokens: 1,
          reasoningTokens: 2,
          providerCost: 0.01,
        },
      ],
    });
    expect(directory).toBe(join(dataDirectory, 'runs', context.scenario, manifest.runId));
    expect(JSON.parse(await readFile(join(directory, 'case.json'), 'utf8'))).toEqual({
      answer: 42,
    });
    expect(await readFile(join(directory, 'trace.txt'), 'utf8')).toBe('recorded response');
    expect(await history()).toEqual([manifest]);
  });

  test('appends exactly one history entry for each of two separate runs', async () => {
    await withRunEvidence(context, async () => {});
    vi.advanceTimersByTime(1);
    await withRunEvidence(
      { ...context, provider: 'openrouter', case: 'realistic' },
      async () => {}
    );
    const entries = await history();
    expect(entries).toHaveLength(2);
    expect(entries.map(entry => [entry.provider, entry.case])).toEqual([
      ['codex', 'simple'],
      ['openrouter', 'realistic'],
    ]);
    expect(entries[0].runId < entries[1].runId).toBe(true);
    const directories = (await readdir(join(dataDirectory, 'runs', context.scenario))).filter(
      name => name !== 'history.jsonl'
    );
    const runIds = entries.map(entry => entry.runId);
    directories.sort((left, right) => left.localeCompare(right));
    runIds.sort((left, right) => left.localeCompare(right));
    expect(directories).toEqual(runIds);
    for (const entry of entries) {
      expect(
        JSON.parse(
          await readFile(
            join(dataDirectory, 'runs', context.scenario, entry.runId, 'manifest.json'),
            'utf8'
          )
        )
      ).toEqual(entry);
    }
  });

  test('finalizes failed work and preserves its evidence with a redacted code', async () => {
    const failure = new TypeError('secret token and private provider response');
    let directory = '';
    await expect(
      withRunEvidence(context, async recorder => {
        directory = recorder.directory;
        await recorder.writeJson('partial.json', { completed: 'draft' });
        await recorder.measure({ name: 'review', kind: 'call', attemptNumber: 3 }, async () => {
          vi.advanceTimersByTime(10);
          throw failure;
        });
      })
    ).rejects.toBe(failure);
    const manifest: RunManifest = JSON.parse(
      await readFile(join(directory, 'manifest.json'), 'utf8')
    );
    expect(manifest.outcome).toBe('failed');
    expect(manifest.errorCode).toBe('TypeError');
    expect(JSON.stringify(manifest)).not.toContain(failure.message);
    expect(manifest.durationMs).toBe(10);
    expect(manifest.endedAt).toBe('2026-10-12T12:00:00.010Z');
    expect(manifest.measurements).toEqual([
      {
        name: 'review',
        kind: 'call',
        attemptNumber: 3,
        startedAt: '2026-10-12T12:00:00.000Z',
        endedAt: '2026-10-12T12:00:00.010Z',
        durationMs: 10,
        outcome: 'failed',
      },
    ]);
    expect(await history()).toEqual([manifest]);
    expect(JSON.parse(await readFile(join(directory, 'partial.json'), 'utf8'))).toEqual({
      completed: 'draft',
    });
  });

  test('retains an error code instead of its class or sensitive message', async () => {
    const failure = Object.assign(new Error('private path and provider text'), {
      code: 'lesson_factual_support_failed',
    });
    await expect(
      withRunEvidence(context, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    const [manifest] = await history();
    expect(manifest.errorCode).toBe(failure.code);
    expect(JSON.stringify(manifest)).not.toContain(failure.message);
  });

  test.each([
    'manifest',
    'history',
  ] as const)('preserves an operation failure when final %s persistence fails', async target => {
    const failure = new Error('primary operation failed');
    let persistencePath = '';
    const run = withRunEvidence(context, async recorder => {
      persistencePath =
        target === 'manifest'
          ? join(recorder.directory, 'manifest.json')
          : join(dataDirectory, 'runs', context.scenario, 'history.jsonl');
      if (target === 'manifest') await rm(persistencePath);
      await mkdir(persistencePath);
      throw failure;
    });
    await expect(run).rejects.toBeInstanceOf(AggregateError);
    const error = await run.catch(error => error as AggregateError);
    expect(error.cause).toBe(failure);
    expect(error.errors).toHaveLength(2);
    expect(error.errors[0]).toBe(failure);
    expect(error.errors[1]).toMatchObject({ code: expect.any(String) });
  });

  test.each([
    'manifest',
    'history',
  ] as const)('reports final %s persistence failure after successful work', async target => {
    const run = withRunEvidence(context, async recorder => {
      const persistencePath =
        target === 'manifest'
          ? join(recorder.directory, 'manifest.json')
          : join(dataDirectory, 'runs', context.scenario, 'history.jsonl');
      if (target === 'manifest') await rm(persistencePath);
      await mkdir(persistencePath);
      return 42;
    });
    await expect(run).rejects.toMatchObject({ code: expect.any(String) });
    await expect(run).rejects.not.toBeInstanceOf(AggregateError);
  });

  test('requires NOUS_E2E_DATA before work starts', async () => {
    vi.stubEnv('NOUS_E2E_DATA', '');
    const operation = vi.fn(async () => {});
    await expect(withRunEvidence(context, operation)).rejects.toThrow(
      'NOUS_E2E_DATA is required for real-provider evidence.'
    );
    expect(operation).not.toHaveBeenCalled();
    expect(await readdir(dataDirectory)).toEqual([]);
  });

  test('rejects repository output before work starts', async () => {
    vi.stubEnv('NOUS_E2E_DATA', resolve('.'));
    const operation = vi.fn(async () => {});
    await expect(withRunEvidence(context, operation)).rejects.toThrow(
      'NOUS_E2E_DATA must be outside the repository.'
    );
    expect(operation).not.toHaveBeenCalled();
    const junction = join(dataDirectory, 'repository-link');
    await symlink(resolve('.'), junction, 'junction');
    vi.stubEnv('NOUS_E2E_DATA', join(junction, 'evidence'));
    await expect(withRunEvidence(context, operation)).rejects.toThrow(
      'NOUS_E2E_DATA must be outside the repository.'
    );
    expect(operation).not.toHaveBeenCalled();
  });

  test('rejects a scenario junction into the repository before writing', async () => {
    const repositoryTarget = await mkdtemp(join(resolve('.temp'), 'evidence-junction-'));
    try {
      await mkdir(join(dataDirectory, 'runs'));
      await symlink(repositoryTarget, join(dataDirectory, 'runs', context.scenario), 'junction');
      const operation = vi.fn(async () => {});
      await expect(withRunEvidence(context, operation)).rejects.toThrow(
        'NOUS_E2E_DATA must be outside the repository.'
      );
      expect(operation).not.toHaveBeenCalled();
      expect(await readdir(repositoryTarget)).toEqual([]);
    } finally {
      await rm(repositoryTarget, { recursive: true, force: true });
    }
  });

  test('keeps named evidence inside the run and protects manifest files', async () => {
    await withRunEvidence(context, async recorder => {
      await expect(recorder.writeJson('../escaped.json', {})).rejects.toThrow(
        'Evidence names must be single path components.'
      );
      await expect(recorder.writeJson('manifest.json', {})).rejects.toThrow(
        'Reserved evidence filename.'
      );
      await expect(recorder.writeEvidence('history.jsonl', '')).rejects.toThrow(
        'Reserved evidence filename.'
      );
      expect(await readdir(recorder.directory)).toEqual(['manifest.json']);
    });
    expect((await history())[0].outcome).toBe('passed');
  });
});
