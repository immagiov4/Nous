import { execFileSync } from 'node:child_process';
import * as filesystem from 'node:fs/promises';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { type Browser, chromium } from 'playwright';
import * as postgresModule from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGlobalModelConfig } from '../../../apps/backend/src/config/modelConfig';
import { PostgresProjectStore } from '../../../apps/backend/src/projects/postgresProjectStore';
import {
  buildProjectMeta,
  normalizeProjectSnapshot,
} from '../../../apps/backend/src/projects/projectMeta';
import { PostgresWorkflowStore } from '../../../apps/backend/src/workflows/persistence/postgresWorkflowStore';
import type { PlaytestAdapter } from '../../../packages/playtest/src/adapter';
import type { LearnerDecision } from '../../../packages/playtest/src/learner/loop';
import { createPiDecisionSource } from '../../../packages/playtest/src/learner/piDecisionSource';
import { createScriptedDecisionSource } from '../../../packages/playtest/src/learner/scriptedDecisionSource';
import * as operator from '../../../packages/playtest/src/operator/session';
import * as reports from '../../../packages/playtest/src/report/writeReports';
import { loadStories } from '../../../packages/playtest/src/stories';
import type { Story } from '../../../packages/playtest/src/types';
import { RunEvidenceRecorder, type RunManifest } from '../../../scripts/run-evidence';
import adapter from '../adapter';
import { importFixture } from '../fixtures';
import {
  createPreparationDeadline,
  FRESH_CONTENT_PREPARATION_TIMEOUT_MS,
  regenerateLesson,
} from '../freshness';
import { syntheticCourse } from '../prepare';
import { main } from '../run';
import * as stack from '../stack';
import { settleAccountWorkflows } from '../workflowCleanup';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});
vi.mock('postgres', async importOriginal => {
  const actual = await importOriginal<{ default: typeof postgresModule.default }>();
  return { ...actual, default: vi.fn(actual.default) };
});
vi.mock('../../../scripts/git-identity', () => ({
  readGitIdentity: (cwd: string) => ({
    commitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim() !== '',
  }),
}));
vi.mock('../adapter', () => ({
  default: {
    appDescription: () => 'A deterministic test page.',
    baseUrl: vi.fn(),
    locale: () => 'it-IT',
    ensureStack: vi.fn(async () => {}),
    skipReason: vi.fn(async (): Promise<string | undefined> => undefined),
    prepare: vi.fn(async () => ({
      credentials: { email: 'test@example.test', password: 'secret' },
    })),
    classify: vi.fn(() => ({ stop: false as const })),
    styleReference: () => [],
    taxonomy: () => '',
    taxonomyClasses: () => [],
    probeClass: () => undefined,
    thresholds: () => ({}),
  } satisfies PlaytestAdapter,
}));
vi.mock('../../../packages/playtest/src/stories', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../packages/playtest/src/stories')>()),
  loadStories: vi.fn(),
}));
vi.mock('../../../packages/playtest/src/learner/piDecisionSource', () => ({
  createPiDecisionSource: vi.fn(),
}));
vi.mock('../../../packages/playtest/src/inspector/judge', () => ({
  createPiVisualJudge: () => ({ judge: async () => [] }),
}));

const postgresFactory = vi.mocked(postgresModule.default).getMockImplementation();
if (!postgresFactory) throw new Error('Postgres test factory missing');
let server: Server;
let dataDirectory: string;
const args = ['--provider', 'scripted', '--model', 'deterministic', '--concurrency', '1'];
const story: Story = {
  id: 'scripted',
  title: 'Scripted run',
  kind: 'check',
  viewports: ['desktop'],
  requires: {},
  surfaces: ['library'],
  tags: [],
  budget: { steps: 1 },
  body: 'Read the page.',
  sourcePath: 'scripted.md',
};

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<main><h1>A course</h1><button>Open</button></main>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address.');
  vi.mocked(adapter.baseUrl).mockReturnValue(`http://127.0.0.1:${address.port}`);
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve()))
  );
});
beforeEach(async () => {
  vi.mocked(postgresModule.default).mockReset().mockImplementation(postgresFactory);
  dataDirectory = await mkdtemp(join(tmpdir(), 'nous-playtest-evidence-'));
  vi.stubEnv('NOUS_E2E_DATA', dataDirectory);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(stack, 'stopStack').mockResolvedValue();
  vi.mocked(loadStories).mockResolvedValue([story]);
  vi.mocked(adapter.ensureStack).mockResolvedValue();
  if (!adapter.skipReason) throw new Error('Skip policy fixture missing');
  vi.mocked(adapter.skipReason).mockResolvedValue(undefined);
  vi.mocked(adapter.prepare).mockResolvedValue({
    credentials: { email: 'test@example.test', password: 'secret' },
  });
  vi.mocked(adapter.classify).mockReturnValue({ stop: false });
  vi.mocked(createPiDecisionSource).mockImplementation(() =>
    createScriptedDecisionSource([{ type: 'stop', reason: 'completed', summary: 'Done.' }])
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await rm(dataDirectory, { recursive: true, force: true });
});

async function evidence(generation = false) {
  const scenarioDirectory = join(dataDirectory, 'runs', 'playtest');
  const entries = await readdir(scenarioDirectory);
  const runId = entries.find(entry => entry !== 'history.jsonl');
  expect(entries).toHaveLength(2);
  if (!runId) throw new Error('Missing run directory.');
  const directory = join(scenarioDirectory, runId);
  const manifest: RunManifest = JSON.parse(
    await readFile(join(directory, 'manifest.json'), 'utf8')
  );
  const history = (await readFile(join(scenarioDirectory, 'history.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  expect(history).toEqual([manifest]);
  expect(manifest.runId).toBe(runId);
  expect(manifest.endedAt).toBeTruthy();
  expect(manifest.durationMs).toBeGreaterThanOrEqual(0);
  expect(
    manifest.measurements.filter(measurement =>
      generation ? measurement.name === 'playtest' : true
    )
  ).toEqual([
    expect.objectContaining({
      name: 'playtest',
      kind: 'case',
      outcome: manifest.outcome,
      durationMs: expect.any(Number),
    }),
  ]);
  return { directory, manifest };
}

it('finalizes ordinary-story reports and shutdown after stalled workflow retirement', async () => {
  const blocked = Promise.withResolvers<never>();
  const sql = Object.assign(
    vi.fn(() => blocked.promise),
    {
      end: vi.fn(async () => {
        blocked.reject(new Error('Connection destroyed'));
      }),
    }
  );
  vi.mocked(adapter.prepare).mockResolvedValue({
    credentials: { email: 'test@example.test', password: 'secret' },
    cleanup: async () => {
      vi.useFakeTimers();
      const pending = settleAccountWorkflows(sql as unknown as postgresModule.Sql, 'account');
      const observed = pending.catch(error => error);
      try {
        await vi.advanceTimersByTimeAsync(stack.STACK_SHUTDOWN_GRACE_MS);
        throw await observed;
      } finally {
        vi.useRealTimers();
      }
    },
  });
  await expect(main(args)).rejects.toMatchObject({ code: 'PLAYTEST_OPERATIONAL_ERROR' });
  const { directory, manifest } = await evidence();
  const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
  const record = JSON.parse(await readFile(summary.records[0].reportPath, 'utf8'));
  expect(record.cleanupError).toBe('The adapter could not clean up the synthetic story account.');
  expect(record.diagnostics.cleanup).toContain('retirement timed out');
  expect(manifest.outcome).toBe('failed');
  expect(stack.stopStack).toHaveBeenCalled();
  expect(sql.end).toHaveBeenCalledWith({ timeout: 0 });
});

describe('Nous playtest evidence entrypoint', () => {
  it('retains a skipped run without starting or stopping application services', async () => {
    if (!adapter.skipReason) throw new Error('Skip policy fixture missing');
    vi.mocked(adapter.skipReason).mockResolvedValue('Private fixtures require local opt-in.');
    await main(args);
    const saved = await evidence();
    expect(adapter.ensureStack).not.toHaveBeenCalled();
    expect(stack.stopStack).not.toHaveBeenCalled();
    expect(adapter.prepare).not.toHaveBeenCalled();
    expect(createPiDecisionSource).not.toHaveBeenCalled();
    const summary = JSON.parse(await readFile(join(saved.directory, 'summary.json'), 'utf8'));
    expect(summary.records[0]).toMatchObject({
      outcome: 'skipped',
      reason: 'Private fixtures require local opt-in.',
    });
  });
  it('retains separate provenance for concurrent legacy JSON imports with the same project ID', async () => {
    const snapshot = normalizeProjectSnapshot(syntheticCourse(), true);
    await mkdir(join(dataDirectory, 'fixtures'));
    const filenames = ['desktop.json', 'mobile.json'];
    for (const filename of filenames)
      await writeFile(
        join(dataDirectory, 'fixtures', filename),
        JSON.stringify({ ...snapshot, version: filename })
      );
    vi.spyOn(PostgresProjectStore.prototype, 'importProject').mockResolvedValue({
      snapshot,
      meta: buildProjectMeta(snapshot),
    });
    const store = new PostgresProjectStore('postgres://unused');
    const imports: Awaited<ReturnType<typeof importFixture>>[] = [];
    vi.mocked(loadStories).mockResolvedValue([{ ...story, viewports: ['desktop', 'mobile'] }]);
    vi.mocked(adapter.prepare).mockImplementation(async (_story, viewport) => {
      const fixture = await importFixture(`${viewport}.json`, store, viewport);
      imports.push(fixture);
      return { credentials: { email: `${viewport}@example.test`, password: 'secret' } };
    });
    await main(['--provider', 'scripted', '--model', 'deterministic']);
    const { directory, manifest } = await evidence();
    const artifacts = manifest.artifacts?.filter(path => path.startsWith('fixture-')) ?? [];
    expect(artifacts).toHaveLength(filenames.length);
    const retained = await Promise.all(
      artifacts.map(async path => JSON.parse(await readFile(join(directory, path), 'utf8')))
    );
    expect(retained).toEqual(expect.arrayContaining(imports));
    expect(new Set(retained.map(fixture => fixture.importedProjectId)).size).toBe(1);
    expect(new Set(retained.map(fixture => fixture.sha256)).size).toBe(filenames.length);
  });

  it.each([
    'completed',
    'abandoned',
    'harness-limit',
    'app-error',
  ] as const)('finalizes execution independently of the %s story outcome', async outcome => {
    const decision: LearnerDecision =
      outcome === 'harness-limit'
        ? { type: 'diary', entry: 'Still exploring.' }
        : {
            type: 'stop',
            reason: outcome === 'abandoned' ? 'abandoned' : 'completed',
            summary: 'Recorded.',
          };
    vi.mocked(createPiDecisionSource).mockImplementation(() =>
      createScriptedDecisionSource([decision])
    );
    if (outcome === 'app-error')
      vi.mocked(adapter.classify).mockReturnValue({ stop: true, reason: 'Product problem.' });
    const summary = await main([...args, '--video']);
    const { directory, manifest } = await evidence();
    expect(summary.runDir).toBe(directory);
    expect(summary.records[0].outcome).toBe(outcome);
    expect(manifest.outcome).toBe('passed');
    expect(manifest.errorCode).toBeNull();
    expect(manifest.git).toEqual({
      commitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '',
    });
    expect(manifest.slots).toEqual({
      learner: { model: 'deterministic', serviceTier: 'normal' },
      judge: { model: 'deterministic', serviceTier: 'normal' },
    });
    const record = summary.records[0];
    const report = JSON.parse(await readFile(record.reportPath, 'utf8'));
    expect(report.outcome).toBe(outcome);
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(manifest.artifacts).toEqual(
      expect.arrayContaining([
        'summary.json',
        'summary.html',
        relative(directory, record.reportPath).replaceAll('\\', '/'),
      ])
    );
    expect(manifest.artifacts?.some(path => path.endsWith('/trace.zip'))).toBe(true);
    expect(manifest.artifacts?.some(path => path.endsWith('/video.webm'))).toBe(true);
    expect(manifest.artifacts?.some(path => path.endsWith('.png'))).toBe(true);
    for (const artifact of manifest.artifacts ?? [])
      expect((await stat(join(directory, artifact))).isFile()).toBe(true);
    expect(await readdir(join(dataDirectory, 'runs'))).toEqual(['playtest']);
  });

  it.each(
    (['observation', 'decision', 'action', 'final-probe-drain'] as const).flatMap(stage =>
      (['stop-first', 'failure-first'] as const).map(order => ({ stage, order }))
    )
  )('retains $stage failure with $order through reports and the manifest', async ({
    stage,
    order,
  }) => {
    const open = operator.openOperatorSession;
    const failure = new Error(`Synthetic ${stage} failure`);
    let stopApp: () => void;
    vi.mocked(adapter.classify).mockImplementation(event =>
      event.kind === 'console' && event.text === 'Application stopped'
        ? { stop: true, reason: 'Product problem.', correlationId: 'race-stop' }
        : { stop: false }
    );
    vi.spyOn(operator, 'openOperatorSession').mockImplementation(async options => {
      const session = await open(options);
      stopApp = () =>
        options.onEvent?.({
          kind: 'console',
          level: 'error',
          text: 'Application stopped',
        });
      const fail = async () => {
        // Hold the operation pending while delivering the competing terminal signal.
        await Promise.resolve();
        if (order === 'stop-first') stopApp();
        throw failure;
      };
      return {
        ...session,
        observe: stage === 'observation' ? fail : session.observe,
        act: stage === 'action' ? fail : session.act,
        signals:
          stage === 'final-probe-drain'
            ? vi
                .fn(session.signals)
                .mockImplementationOnce(session.signals)
                .mockImplementation(fail)
            : session.signals,
        close: async () => {
          if (order === 'failure-first') stopApp();
          return session.close();
        },
      };
    });
    vi.mocked(createPiDecisionSource).mockImplementation(() => ({
      decide: async () => {
        if (stage === 'decision') {
          await Promise.resolve();
          if (order === 'stop-first') stopApp();
          throw failure;
        }
        return stage === 'action'
          ? { type: 'act', action: { type: 'observe' }, expectation: 'Read again.' }
          : { type: 'stop', reason: 'completed', summary: 'Done.' };
      },
    }));
    await expect(main(args)).rejects.toMatchObject({ code: 'PLAYTEST_OPERATIONAL_ERROR' });
    const { directory, manifest } = await evidence();
    expect(manifest.outcome).toBe('failed');
    expect(manifest.errorCode).toBe('PLAYTEST_OPERATIONAL_ERROR');
    const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
    const record = summary.records[0];
    const saved = JSON.parse(await readFile(record.reportPath, 'utf8'));
    for (const report of [record, saved]) {
      expect(report).toMatchObject({
        outcome: 'app-error',
        reason: 'Product problem.',
        correlationId: 'race-stop',
        operationalFailure: true,
      });
      expect(report.diagnostics[stage]).toContain(failure.message);
    }
    expect(manifest.artifacts?.some(path => path.endsWith('/trace.zip'))).toBe(true);
    expect((await stat(saved.tracePath)).isFile()).toBe(true);
  });

  it('fails execution when the page closes during the final decision but retains its trace', async () => {
    const open = operator.openOperatorSession;
    let closePage: () => Promise<void>;
    vi.spyOn(operator, 'openOperatorSession').mockImplementation(async options => {
      const session = await open(options);
      closePage = async () => {
        const [page] = options.browser.contexts().flatMap(context => context.pages());
        await page.close();
      };
      return session;
    });
    vi.mocked(createPiDecisionSource).mockImplementation(() => ({
      decide: async () => {
        await closePage();
        return { type: 'stop', reason: 'completed', summary: 'Done.' };
      },
    }));
    await expect(main(args)).rejects.toMatchObject({ code: 'PLAYTEST_OPERATIONAL_ERROR' });
    const { directory, manifest } = await evidence();
    expect(manifest.outcome).toBe('failed');
    expect(manifest.errorCode).toBe('PLAYTEST_OPERATIONAL_ERROR');
    const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
    const record = summary.records[0];
    const saved = JSON.parse(await readFile(record.reportPath, 'utf8'));
    for (const report of [record, saved]) {
      expect(report).toMatchObject({ outcome: 'completed', operationalFailure: true });
      expect(report.diagnostics['final-probe-drain']).toContain('closed');
    }
    expect((await stat(saved.tracePath)).isFile()).toBe(true);
    expect(manifest.artifacts?.some(path => path.endsWith('/trace.zip'))).toBe(true);
  });

  it('preserves the application stop when writing its companion report fails', async () => {
    vi.mocked(adapter.classify).mockReturnValue({ stop: true, reason: 'Product problem.' });
    const write = reports.writeStoryReports;
    vi.spyOn(reports, 'writeStoryReports').mockImplementationOnce(async input => {
      await write(input);
      throw new Error('Synthetic companion report failure');
    });
    await expect(main(args)).rejects.toMatchObject({ code: 'PLAYTEST_OPERATIONAL_ERROR' });
    const { directory, manifest } = await evidence();
    expect(manifest.outcome).toBe('failed');
    const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
    const record = summary.records[0];
    const saved = JSON.parse(await readFile(record.reportPath, 'utf8'));
    for (const report of [record, saved]) {
      expect(report).toMatchObject({
        outcome: 'app-error',
        reason: 'Product problem.',
        operationalFailure: true,
      });
      expect(report.diagnostics.report).toContain('Synthetic companion report failure');
    }
  });

  it('preserves both reports when an operational error occurs after the first story', async () => {
    vi.mocked(loadStories).mockResolvedValue([
      { ...story, id: 'first' },
      { ...story, id: 'second' },
    ]);
    vi.mocked(createPiDecisionSource)
      .mockImplementationOnce(() =>
        createScriptedDecisionSource([{ type: 'stop', reason: 'completed', summary: 'Done.' }])
      )
      .mockImplementationOnce(() => ({
        decide: async () => {
          throw new Error('Synthetic provider failure');
        },
      }));
    await expect(main(args)).rejects.toMatchObject({ code: 'PLAYTEST_OPERATIONAL_ERROR' });
    const { directory, manifest } = await evidence();
    expect(manifest.outcome).toBe('failed');
    expect(manifest.errorCode).toBe('PLAYTEST_OPERATIONAL_ERROR');
    expect(JSON.stringify(manifest)).not.toContain('Synthetic provider failure');
    const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
    expect(summary.records.map((record: { outcome: string }) => record.outcome)).toEqual([
      'completed',
      'operator-failure',
    ]);
    expect(summary.records[1].operationalFailure).toBe(true);
    for (const record of summary.records)
      expect(JSON.parse(await readFile(record.reportPath, 'utf8')).storyId).toBe(record.storyId);
    expect(manifest.artifacts?.filter(path => path.endsWith('/story.json'))).toHaveLength(2);
  });

  it.each([
    'stack',
    'preparation',
    'summary',
  ] as const)('finalizes and retains available evidence on %s failure', async stage => {
    if (stage === 'stack')
      vi.mocked(adapter.ensureStack).mockRejectedValueOnce(new Error('Stack unavailable'));
    if (stage === 'preparation')
      vi.mocked(adapter.prepare).mockRejectedValueOnce(new Error('Import failed'));
    if (stage === 'summary')
      vi.spyOn(reports, 'writeSummaryReports').mockRejectedValueOnce(
        new Error('Report rendering failed')
      );
    await expect(main(args)).rejects.toThrow();
    const { directory, manifest } = await evidence();
    expect(manifest.outcome).toBe('failed');
    expect(manifest.errorCode).toBe(
      stage === 'preparation' ? 'PLAYTEST_OPERATIONAL_ERROR' : 'Error'
    );
    const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
    expect(summary.records).toHaveLength(1);
    expect((await stat(summary.records[0].reportPath)).isFile()).toBe(true);
    expect(manifest.artifacts).toContain('summary.json');
  });

  it('retains partial diagnostics when adapter loading fails', async () => {
    await expect(main([...args, '--adapter', join(dataDirectory, 'missing.ts')])).rejects.toThrow(
      'Adapter module is missing'
    );
    const { manifest } = await evidence();
    expect(manifest.outcome).toBe('failed');
    expect(manifest.errorCode).toBe('Error');
    expect(manifest.artifacts).toEqual(['summary.json']);
  });

  it('retains the original operational error code from story loading', async () => {
    vi.mocked(loadStories).mockRejectedValueOnce(
      Object.assign(new Error('Synthetic import detail'), { code: 'SCRIPTED_IMPORT_FAILURE' })
    );
    await expect(main(args)).rejects.toMatchObject({ code: 'SCRIPTED_IMPORT_FAILURE' });
    const { manifest } = await evidence();
    expect(manifest.errorCode).toBe('SCRIPTED_IMPORT_FAILURE');
    expect(manifest.outcome).toBe('failed');
    expect(JSON.stringify(manifest)).not.toContain('Synthetic import detail');
  });

  it('rejects external output overrides within a finalized run', async () => {
    await expect(main([...args, '--run-dir', join(dataDirectory, 'elsewhere')])).rejects.toThrow(
      'output is managed'
    );
    const { manifest } = await evidence();
    expect(manifest.outcome).toBe('failed');
    expect(manifest.artifacts).toEqual([]);
    await expect(stat(join(dataDirectory, 'elsewhere'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function advancePreparationDeadline(input: {
  polling: boolean;
  acceptedStart: Promise<void>;
  entered: Promise<void>;
  dataDirectory: string;
  nextEntered: Promise<void>;
  nextDecision: { resolve(value: LearnerDecision): void };
}): Promise<void> {
  await (input.polling ? input.acceptedStart : input.entered);
  await vi.advanceTimersByTimeAsync(FRESH_CONTENT_PREPARATION_TIMEOUT_MS - Date.now());
  if (input.polling)
    await confirmImmediateCheckpoint(input.dataDirectory, input.nextEntered, input.nextDecision);
}

it.each([
  'product-failure',
  'deadline',
  'snapshot-read',
  'usage-read',
  'snapshot-write',
  'connection-close',
] as const)('retains failed generation identity, configuration, duration, workflow state and cost before cleanup with %s', async scenario => {
  const deadline = scenario !== 'product-failure';
  const polling = scenario === 'deadline';
  const entered = Promise.withResolvers<void>();
  const late = Promise.withResolvers<unknown>();
  const failureCode = deadline
    ? 'lesson_generation_preparation_timeout'
    : 'lesson_factual_support_failed';
  if (deadline) {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  }
  await mkdir(join(dataDirectory, 'stack'));
  const settings = getGlobalModelConfig();
  await writeFile(
    join(dataDirectory, 'stack/generation-settings.json'),
    JSON.stringify({
      appRevision: { commitSha: 'revision', dirty: true },
      settings,
    })
  );
  const snapshot = syntheticCourse();
  const runId = '22222222-2222-4222-8222-222222222222';
  const userId = '11111111-1111-4111-8111-111111111111';
  const usage = {
    id: 'usage',
    runId,
    nodeInstanceId: 'review',
    attemptNumber: 1,
    provider: 'openrouter',
    model: settings.lessonModel,
    providerCost: 0.12,
  };
  const sql = Object.assign(
    vi.fn(async () => [usage]),
    { end: vi.fn(async () => {}) }
  );
  vi.mocked(postgresModule.default).mockReturnValueOnce(
    sql as unknown as ReturnType<typeof postgresModule.default>
  );
  vi.spyOn(stack, 'stackStatus').mockResolvedValue({
    API_URL: 'http://127.0.0.1:55321',
    DB_URL: 'postgresql://postgres:test@127.0.0.1:55322/postgres',
    ANON_KEY: 'anon',
    SERVICE_ROLE_KEY: 'service',
    JWT_SECRET: 'secret',
  });
  const readRun = vi.spyOn(PostgresWorkflowStore.prototype, 'getRun').mockResolvedValue({
    id: runId,
    resolvedConfig: settings,
    status: polling ? 'running' : 'failed',
    error: { code: 'lesson_factual_support_failed', kind: 'permanent' },
  } as unknown as Awaited<ReturnType<PostgresWorkflowStore['getRun']>>);
  const readState = vi.spyOn(PostgresWorkflowStore.prototype, 'getRunState').mockResolvedValue({
    nodes: [{ definitionId: 'review-lesson', status: polling ? 'running' : 'failed' }],
  } as unknown as Awaited<ReturnType<PostgresWorkflowStore['getRunState']>>);
  if (polling) {
    readRun.mockImplementation(() => new Promise(() => {}));
    readState.mockImplementation(() => new Promise(() => {}));
    sql.mockImplementation(() => new Promise(() => {}));
  }
  const waitSource = {
    'product-failure': undefined,
    deadline: undefined,
    'snapshot-write': undefined,
    'snapshot-read': readRun,
    'usage-read': sql,
    'connection-close': sql.end,
  }[scenario];
  waitSource?.mockImplementation(() => {
    entered.resolve();
    return late.promise as Promise<never>;
  });
  let capturedManifest: RunManifest | undefined;
  const write = RunEvidenceRecorder.prototype.writeJson;
  vi.spyOn(RunEvidenceRecorder.prototype, 'writeJson').mockImplementation(function (
    this: RunEvidenceRecorder,
    name,
    contents,
    options
  ) {
    capturedManifest = this.manifest;
    if (scenario === 'snapshot-write' && name.endsWith('-workflow.json')) {
      entered.resolve();
      return late.promise.then(() => write.call(this, name, contents));
    }
    return write.call(this, name, contents, options);
  });
  const nextEntered = Promise.withResolvers<void>();
  const nextDecision = Promise.withResolvers<LearnerDecision>();
  if (polling) {
    vi.mocked(createPiDecisionSource).mockImplementation(() => ({
      decide: async () => {
        nextEntered.resolve();
        return nextDecision.promise;
      },
    }));
    vi.mocked(loadStories).mockResolvedValue([story, { ...story, id: `${story.id}-next` }]);
    vi.spyOn(chromium, 'launch').mockResolvedValue({ close: async () => {} } as unknown as Browser);
    vi.spyOn(operator, 'openOperatorSession').mockImplementation(async options => ({
      observe: async () => {
        await mkdir(options.runDir, { recursive: true });
        await writeFile(join(options.runDir, 'next.png'), 'synthetic capture');
        return {
          url: options.baseUrl,
          nodes: [],
          stepIndex: 0,
          screenshotPath: join(options.runDir, 'next.png'),
        };
      },
      act: vi.fn(),
      signals: async () => [],
      close: async () => ({ tracePath: join(options.runDir, 'next.zip') }),
    }));
  }
  const { promise: acceptedStart, resolve: notifyStart } = Promise.withResolvers<void>();
  let finishCancellation: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/token?')) return Response.json({ access_token: 'token' });
      if (url.endsWith('/lessons')) notifyStart();
      if (url.endsWith('/cancellation'))
        return new Promise<Response>(resolve => {
          finishCancellation = resolve;
        });
      return Response.json({
        success: true,
        created: true,
        job: {
          id: runId,
          projectId: snapshot.id,
          sectionId: 'lesson-water',
          status: polling ? 'running' : 'failed',
          errorCode: polling ? undefined : 'lesson_factual_support_failed',
          retrying: false,
          stage: 'verification',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
    })
  );
  if (deadline) {
    const writeSummary = reports.writeSummaryReports;
    vi.spyOn(reports, 'writeSummaryReports').mockImplementation(async input => {
      if (!finishCancellation) throw new Error('Cancellation request missing');
      const json = vi.fn(async () => ({ success: true }));
      finishCancellation({ ok: true, json } as unknown as Response);
      await vi.waitFor(() => expect(json).toHaveBeenCalled());
      return writeSummary(input);
    });
  }
  vi.mocked(adapter.prepare).mockImplementation(async selected => {
    if (selected.id !== story.id)
      return { credentials: { email: 'next@example.test', password: 'secret' } };
    await regenerateLesson({
      story: selected,
      viewport: 'desktop',
      isolated: await stack.stackStatus(),
      credentials: { email: 'test@example.test', password: 'secret' },
      userId,
      projectId: snapshot.id,
      sectionId: 'lesson-water',
      store: {
        loadProjectWithRevision: async () => ({
          snapshot,
          revision: 1,
          incarnationId: 'incarnation',
        }),
        patchProject: vi.fn(),
      },
    });
    throw new Error('Preparation unexpectedly succeeded');
  });
  const blocked = expect(main(args)).rejects.toMatchObject({ code: 'PLAYTEST_OPERATIONAL_ERROR' });
  if (deadline) {
    await advancePreparationDeadline({
      polling,
      acceptedStart,
      entered: entered.promise,
      dataDirectory,
      nextEntered: nextEntered.promise,
      nextDecision,
    });
  }
  await blocked;
  const { directory, manifest } = await vi.waitFor(() => evidence(true));
  const generation = manifest.measurements.find(measurement => measurement.kind === 'workflow');
  if (!generation) throw new Error('Generation measurement missing');
  const filename = `${generation.name}.json`;
  expect(manifest.artifacts).toContain(filename);
  if (!deadline) {
    expect(manifest.incompleteWrites).toEqual([]);
  }
  const record = await vi.waitFor(async () =>
    JSON.parse(await readFile(join(directory, filename), 'utf8'))
  );
  expect(record).toMatchObject({
    workflowId: runId,
    projectId: snapshot.id,
    sectionId: 'lesson-water',
    userId,
    appRevision: { commitSha: 'revision', dirty: true },
    generationSettings: settings,
    outcome: 'blocked',
    errorCode: failureCode,
    warnings: [],
  });
  if (deadline) expect(record.cancellation).toEqual({ status: 'confirmed' });
  expect(manifest.measurements).toHaveLength(2);
  expect(manifest.workflows).toHaveLength(1);
  expect(manifest.aiUsage).toEqual(!deadline || scenario === 'connection-close' ? [usage] : []);
  expect(manifest.workflows[0].runId).toBe(runId);
  await assertGenerationBoundary({
    polling,
    deadline,
    scenario,
    directory,
    filename,
    manifest,
    usage,
    readRun,
    readState,
    sql,
    capturedManifest,
    late,
  });
});

async function assertGenerationBoundary(input: {
  polling: boolean;
  deadline: boolean;
  scenario: string;
  directory: string;
  filename: string;
  manifest: RunManifest;
  usage: unknown;
  readRun: unknown;
  readState: unknown;
  sql: { end: unknown };
  capturedManifest?: RunManifest;
  late: { resolve(value: unknown): void };
}) {
  const {
    polling,
    deadline,
    scenario,
    directory,
    filename,
    manifest,
    usage,
    readRun,
    readState,
    sql,
    capturedManifest,
    late,
  } = input;
  if (polling) {
    expect(readRun).not.toHaveBeenCalled();
    expect(readState).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
    expect(manifest.artifacts ?? []).not.toContain(filename.replace('.json', '-workflow.json'));
    expect(manifest.artifacts ?? []).not.toContain(filename.replace('.json', '-usage.json'));
  } else if (!deadline) {
    const trace = JSON.parse(
      await readFile(join(directory, filename.replace('.json', '-workflow.json')), 'utf8')
    );
    expect(trace.run.error.code).toBe('lesson_factual_support_failed');
    expect(trace.state.nodes[0].definitionId).toBe('review-lesson');
    expect(sql.end).toHaveBeenCalled();
  }
  if (deadline) {
    expect(stack.stopStack).toHaveBeenCalled();
    if (polling) {
      const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
      expect(manifest.artifacts).toContain('summary.json');
      expect(manifest.artifacts?.some(path => path.endsWith('/story.json'))).toBe(true);
      expect(manifest.artifacts?.some(path => path.endsWith('/next.png'))).toBe(true);
      expect(summary.records.map((entry: { outcome: string }) => entry.outcome)).toEqual([
        'blocked-precondition',
        'completed',
      ]);
    }
    expect(manifest.incompleteWrites).toEqual(
      expect.arrayContaining(['manifest.json', 'history.jsonl'])
    );
    if (!polling) {
      expect(sql.end).toHaveBeenCalledWith({ timeout: 0 });
      const frozen = await readFile(join(directory, filename), 'utf8');
      const frozenManifest = structuredClone(capturedManifest);
      late.resolve(scenario === 'usage-read' ? [usage] : undefined);
      await Promise.resolve();
      await Promise.resolve();
      expect(await readFile(join(directory, filename), 'utf8')).toBe(frozen);
      expect((await evidence(true)).manifest.aiUsage).toEqual(manifest.aiUsage);
      expect(capturedManifest).toEqual(frozenManifest);
    }
  }
}

async function confirmImmediateCheckpoint(
  dataDirectory: string,
  entered: Promise<void>,
  decision: { resolve(value: LearnerDecision): void }
) {
  await entered;
  try {
    const root = join(dataDirectory, 'runs', 'playtest');
    const names = await readdir(root);
    const run = names.find(name => name !== 'history.jsonl');
    if (!run) throw new Error('Run directory missing');
    await vi.waitFor(async () => {
      const files = await readdir(join(root, run));
      const checkpoint = files.find(name => name.endsWith('-deadline.json'));
      if (!checkpoint) throw new Error('Immediate deadline checkpoint missing');
      expect(JSON.parse(await readFile(join(root, run, checkpoint), 'utf8'))).toMatchObject({
        outcome: 'blocked',
        errorCode: 'lesson_generation_preparation_timeout',
      });
    });
  } finally {
    decision.resolve({ type: 'stop', reason: 'completed', summary: 'The next story completed.' });
  }
}

it.each([
  'stack-stop',
  'artifact-index',
  'account-cleanup',
  'publication',
] as const)('persists final generation evidence and cleanup risk through %s failure', async stage => {
  const failure = Object.assign(new Error('Synthetic finalization failure'), {
    code: `${stage}-failed`,
  });
  if (stage === 'stack-stop') vi.mocked(stack.stopStack).mockRejectedValue(failure);
  if (stage === 'artifact-index') vi.mocked(filesystem.readdir).mockRejectedValueOnce(failure);
  if (stage === 'publication')
    vi.spyOn(RunEvidenceRecorder.prototype, 'writeJson').mockRejectedValueOnce(failure);
  vi.mocked(adapter.prepare).mockImplementation(async selected => {
    const deadline = createPreparationDeadline({
      userId: 'account',
      story: selected,
      viewport: 'desktop',
      projectId: 'project',
      sectionId: 'lesson',
      isolated: {} as stack.StackStatus,
    });
    deadline.evidence.outcome = 'current';
    deadline.finish();
    return {
      credentials: { email: 'test@example.test', password: 'secret' },
      cleanup: () =>
        deadline.step(
          'account-cleanup',
          async () => {
            if (stage === 'account-cleanup') throw failure;
          },
          'cleanup'
        ),
    };
  });
  await expect(main(args)).rejects.toThrow();
  const { directory, manifest } = await evidence(true);
  expect(manifest.outcome).toBe('failed');
  if (stage === 'publication') {
    const measurement = manifest.measurements.find(entry => entry.kind === 'workflow');
    if (!measurement) throw new Error('Generation measurement missing');
    const filename = `${measurement.name}.json`;
    expect(manifest.errorCode).toBe('publication-failed');
    expect(manifest.incompleteWrites).toContain(filename);
    expect(manifest.artifacts).toContain('summary.json');
    await expect(readFile(join(directory, filename))).rejects.toMatchObject({ code: 'ENOENT' });
    return;
  }
  const generation = manifest.measurements.find(entry => entry.kind === 'workflow');
  if (!generation) throw new Error('Generation measurement missing');
  const filename = `${generation.name}.json`;
  if (stage !== 'artifact-index') expect(manifest.artifacts).toContain(filename);
  const record = JSON.parse(await readFile(join(directory, filename), 'utf8'));
  expect(record.outcome).toBe('current');
  expect(record.preparation.possiblyLeakedResources).toEqual(
    stage === 'account-cleanup' ? [{ accountId: 'account', projectId: 'project' }] : []
  );
  expect(manifest.resourcesAtRisk).toEqual(
    stage === 'account-cleanup'
      ? [
          { kind: 'account', id: 'account' },
          { kind: 'project', id: 'project' },
        ]
      : []
  );
  if (stage !== 'artifact-index') expect(manifest.artifacts).toContain('summary.json');
  expect(stack.stopStack).toHaveBeenCalled();
});

it('retires a hanging expired artifact index and persists its eventual results without changing the blocked outcome', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const late = Promise.withResolvers<Awaited<ReturnType<typeof filesystem.readdir>>>();
  vi.mocked(filesystem.readdir).mockImplementationOnce(() => late.promise);
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.mocked(adapter.prepare).mockImplementation(async selected => {
    const deadline = createPreparationDeadline({
      userId: 'account',
      story: selected,
      viewport: 'desktop',
      projectId: 'project',
      sectionId: 'lesson',
      isolated: {} as stack.StackStatus,
    });
    await vi.advanceTimersByTimeAsync(FRESH_CONTENT_PREPARATION_TIMEOUT_MS);
    deadline.finish();
    throw deadline.signal.reason;
  });
  await expect(main(args)).rejects.toMatchObject({ code: 'PLAYTEST_OPERATIONAL_ERROR' });
  await vi.waitFor(() => expect(filesystem.readdir).toHaveBeenCalledTimes(1));
  const parent = join(dataDirectory, 'runs', 'playtest');
  const directories = await actual.readdir(parent);
  const directory = join(parent, directories.find(name => name !== 'history.jsonl') ?? 'missing');
  const generation = await vi.waitFor(async () => {
    const filenames = await actual.readdir(directory);
    const name = filenames.find(
      name => /^generation-[^.]+\.json$/.test(name) && !name.endsWith('-deadline.json')
    );
    if (!name) throw new Error('Final generation record pending');
    return JSON.parse(await actual.readFile(join(directory, name), 'utf8'));
  });
  expect(generation).toMatchObject({
    outcome: 'blocked',
    errorCode: 'lesson_generation_preparation_timeout',
  });
  const entries = await actual.readdir(directory, { recursive: true, withFileTypes: true });
  late.resolve(entries as unknown as Awaited<ReturnType<typeof filesystem.readdir>>);
  const { manifest } = await vi.waitFor(() => evidence(true));
  expect(manifest).toMatchObject({ outcome: 'failed', errorCode: 'PLAYTEST_OPERATIONAL_ERROR' });
  expect(manifest.artifacts).toContain('summary.json');
  expect(generation.outcome).toBe('blocked');
});
it.each([
  false,
  true,
])('indexes final publication artifacts after preparation timeout=%s', async expired => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const publication = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let filename = '';
  const write = RunEvidenceRecorder.prototype.writeJson;
  vi.spyOn(RunEvidenceRecorder.prototype, 'writeJson').mockImplementation(async function (
    this: RunEvidenceRecorder,
    name,
    contents,
    options
  ) {
    if (name === filename) {
      publication.resolve();
      await release.promise;
      await this.writeEvidence('publication-details.json', '{}');
    }
    return write.call(this, name, contents, options);
  });
  vi.mocked(adapter.prepare).mockImplementation(async selected => {
    const deadline = createPreparationDeadline({
      userId: 'account',
      story: selected,
      viewport: 'desktop',
      projectId: 'project',
      sectionId: 'lesson',
      isolated: {} as stack.StackStatus,
    });
    filename = `generation-${deadline.evidence.requestKey}.json`;
    if (expired) await vi.advanceTimersByTimeAsync(FRESH_CONTENT_PREPARATION_TIMEOUT_MS);
    else deadline.evidence.outcome = 'current';
    deadline.finish();
    if (expired) throw deadline.signal.reason;
    vi.useRealTimers();
    return { credentials: { email: 'test@example.test', password: 'secret' } };
  });
  const running = main(args);
  const finished = expired
    ? expect(running).rejects.toMatchObject({ code: 'PLAYTEST_OPERATIONAL_ERROR' })
    : expect(running).resolves.toMatchObject({
        records: [expect.objectContaining({ outcome: 'completed' })],
      });
  await publication.promise;
  release.resolve();
  await finished;
  const { directory, manifest } = await vi.waitFor(() => evidence(true));
  await vi.waitFor(() => readFile(join(directory, filename), 'utf8'));
  expect(manifest.artifacts).toEqual(
    expect.arrayContaining([filename, 'publication-details.json', 'summary.json'])
  );
  expect(manifest.artifacts).toEqual(
    [...new Set(manifest.artifacts)].sort((left, right) =>
      left < right ? -1 : Number(left > right)
    )
  );
});
