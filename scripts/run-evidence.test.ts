import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getGlobalModelConfig } from '../apps/backend/src/config/modelConfig.js';
import { verifyLessonEvidence } from '../apps/backend/src/services/lessonEvidenceVerification.js';
import { LessonGenerationCorrectionError } from '../apps/backend/src/services/lessonGenerationCorrection.js';
import { startModelExchange } from '../apps/backend/src/workflows/modelExchanges.js';
import { recordWorkflowAiUsage } from '../apps/backend/src/workflows/workflowAiMetering.js';
import type { WorkflowPublicRunState } from '../apps/backend/src/workflows/workflowReadModel.js';
import {
  type RunEvidenceContext,
  RunEvidenceRecorder,
  type RunManifest,
  resolveRunEvidenceTextSlot,
  withRunCleanup,
  withRunEvidence,
} from './run-evidence.js';

vi.mock('./git-identity.js', () => ({
  readGitIdentity: () => ({ commitSha: 'test-commit', dirty: true }),
}));

vi.mock('../apps/backend/src/services/lessonEvidenceVerification.js', async importOriginal => ({
  ...(await importOriginal<
    typeof import('../apps/backend/src/services/lessonEvidenceVerification.js')
  >()),
  verifyLessonEvidence: vi.fn(),
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
  vi.mocked(verifyLessonEvidence).mockReset();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe('real-run evidence', () => {
  test('writes opted-in exchanges in start order and drains interrupted calls before finalizing', async () => {
    let directory = '';
    let entered!: () => void;
    const operationEntered = new Promise<void>(resolve => {
      entered = resolve;
    });
    const write = vi.spyOn(RunEvidenceRecorder.prototype, 'writeEvidence');
    let completeLate!: () => void;
    const late = new Promise<void>(resolve => {
      completeLate = resolve;
    });
    const running = withRunEvidence({ ...context, captureModelExchanges: true }, async recorder => {
      directory = recorder.directory;
      const first = startModelExchange(() => ({
        provider: 'codex',
        model: 'first',
        serviceTier: 'normal',
        request: { prompt: 'full synthetic prompt' },
      }));
      vi.advanceTimersByTime(10);
      const second = startModelExchange(() => ({
        provider: 'codex',
        model: 'second',
        serviceTier: 'normal',
        request: {},
      }));
      second?.finish('completed');
      void late.then(() => first?.finish('interrupted'));
      entered();
      throw new Error('synthetic failure');
    });
    void running.catch(() => undefined);
    try {
      await operationEntered;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      completeLate();
    }
    await expect(running).rejects.toThrow('synthetic failure');
    const rows = (await readFile(join(directory, 'model-exchanges.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(rows).toMatchObject([
      {
        model: 'first',
        status: 'interrupted',
        latencyMs: 10,
        request: { prompt: 'full synthetic prompt' },
      },
      { model: 'second', status: 'completed', latencyMs: 0 },
    ]);
    await withRunEvidence(context, async recorder => {
      directory = recorder.directory;
    });
    expect(await readdir(directory)).not.toContain('model-exchanges.jsonl');
  });
  test('resolves effective provider settings and role overrides', () => {
    const config = {
      ...getGlobalModelConfig(),
      aiProvider: 'codex' as const,
      aiProviderOverrides: {},
      codexFastModelSlots: ['lesson'] as const,
      codexLessonModel: 'fixture-lesson',
      codexResearchModel: 'fixture-research',
      lessonReasoningEffort: 'low' as const,
      researchReasoningEffort: 'none' as const,
    };
    const models = { ...config, codexFastModelSlots: [...config.codexFastModelSlots] };
    expect(resolveRunEvidenceTextSlot(models, 'research')).toEqual({
      model: 'fixture-research',
      reasoningEffort: 'low',
      serviceTier: 'normal',
    });
    expect(resolveRunEvidenceTextSlot(models, 'lesson', 'medium')).toEqual({
      model: 'fixture-lesson',
      reasoningEffort: 'medium',
      serviceTier: 'fast',
    });
    expect(
      resolveRunEvidenceTextSlot(
        { ...models, aiProvider: 'openrouter', lessonModel: 'fixture-router' },
        'lesson',
        'none'
      )
    ).toEqual({
      model: 'fixture-router',
      reasoningEffort: 'none',
      serviceTier: 'normal',
    });
  });

  test('records a mismatching lesson case as failed and still runs the remaining case', async () => {
    vi.stubEnv('REAL_LESSON_QUALITY_TESTS', 'I_ACCEPT_REAL_PROVIDER_COSTS');
    const correction = new LessonGenerationCorrectionError({
      code: 'lesson_factual_support_failed',
      feedback: 'fixture correction',
      message: 'fixture',
    });
    vi.mocked(verifyLessonEvidence).mockRejectedValue(correction);
    await expect(import('./run-lesson-evidence-quality.js')).rejects.toThrow(
      'Factual inference evaluation failed.'
    );
    expect(verifyLessonEvidence).toHaveBeenCalledTimes(2);
    const scenarioDirectory = join(dataDirectory, 'runs', 'lesson-evidence-quality');
    const entry: RunManifest = JSON.parse(
      (await readFile(join(scenarioDirectory, 'history.jsonl'), 'utf8')).trim()
    );
    expect(entry.outcome).toBe('failed');
    expect(
      entry.measurements
        .filter(measurement => measurement.kind === 'case')
        .map(measurement => [measurement.name, measurement.outcome])
    ).toEqual([
      ['valid-deduction', 'failed'],
      ['missing-external-premise', 'passed'],
    ]);
    expect(entry.slots.lessonVerification).toEqual({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
      serviceTier: expect.any(String),
    });
    expect(
      JSON.parse(await readFile(join(scenarioDirectory, entry.runId, 'manifest.json'), 'utf8'))
    ).toEqual(entry);
  });

  test('replaces running workflow evidence with drained state while retaining the primary error', async () => {
    const timestamp = '2026-10-12T12:00:00.000Z';
    const running: Pick<WorkflowPublicRunState, 'run' | 'nodes'> = {
      run: {
        id: 'durable-run',
        workflowId: 'lesson-generation',
        requestKey: 'fixture',
        definitionHash: 'fixture',
        definitionHashVersion: 1,
        cancellationRequested: false,
        cleanupStatus: 'not-required',
        createdAt: timestamp,
        updatedAt: timestamp,
        status: 'running',
      },
      nodes: [
        {
          instanceId: 'draft',
          definitionId: 'draft',
          kind: 'step',
          status: 'running',
          attemptCount: 1,
          maxAttempts: 1,
          createdAt: timestamp,
          availableAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    };
    const completedAt = '2026-10-12T12:00:00.025Z';
    const finalState = {
      run: { ...running.run, status: 'completed' as const, updatedAt: completedAt, completedAt },
      nodes: running.nodes.map(node => ({
        ...node,
        status: 'completed' as const,
        updatedAt: completedAt,
        completedAt,
      })),
    };
    const failure = new Error('workflow timed out');
    let directory = '';
    await expect(
      withRunEvidence(context, async recorder => {
        directory = recorder.directory;
        const workflow = { name: 'lesson', runId: running.run.id };
        recorder.manifest.workflows.push(workflow);
        await recorder.recordWorkflowState(workflow, running);
        await withRunCleanup(
          async () => {
            throw failure;
          },
          async () => {
            vi.advanceTimersByTime(25);
            await recorder.recordWorkflowState(workflow, finalState);
          }
        );
      })
    ).rejects.toBe(failure);
    const [manifest] = await history();
    expect(manifest.outcome).toBe('failed');
    expect(manifest.workflows).toEqual([
      {
        name: 'lesson',
        runId: 'durable-run',
        status: 'completed',
        nodes: [
          {
            instanceId: 'draft',
            definitionId: 'draft',
            status: 'completed',
            attemptCount: 1,
            createdAt: timestamp,
            availableAt: timestamp,
            updatedAt: completedAt,
            completedAt,
            lifetimeDurationMs: 25,
          },
        ],
      },
    ]);
    expect(JSON.parse(await readFile(join(directory, 'lesson-state.json'), 'utf8'))).toEqual(
      finalState
    );
    expect(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))).toEqual(manifest);
  });

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

  test('retains the primary error code when cleanup also fails', async () => {
    const failure = Object.assign(new Error('provider text'), { code: 'workflow_timeout' });
    await expect(
      withRunEvidence(context, () =>
        withRunCleanup(
          async () => {
            throw failure;
          },
          async () => {
            throw new Error('cleanup failed');
          }
        )
      )
    ).rejects.toBeInstanceOf(AggregateError);
    const [manifest] = await history();
    expect(manifest.errorCode).toBe(failure.code);
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
    const repositoryParent = join(resolve('.temp'), `evidence-junction-${randomUUID()}`);
    await mkdir(repositoryParent, { recursive: true });
    try {
      const repositoryTarget = await mkdtemp(join(repositoryParent, 'target-'));
      await mkdir(join(dataDirectory, 'runs'));
      await symlink(repositoryTarget, join(dataDirectory, 'runs', context.scenario), 'junction');
      const operation = vi.fn(async () => {});
      await expect(withRunEvidence(context, operation)).rejects.toThrow(
        'NOUS_E2E_DATA must be outside the repository.'
      );
      expect(operation).not.toHaveBeenCalled();
      expect(await readdir(repositoryTarget)).toEqual([]);
    } finally {
      await rm(repositoryParent, { recursive: true, force: true });
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
