import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresProjectStore } from '../../../apps/backend/src/projects/postgresProjectStore';
import {
  buildProjectMeta,
  normalizeProjectSnapshot,
} from '../../../apps/backend/src/projects/projectMeta';
import type { PlaytestAdapter } from '../../../packages/playtest/src/adapter';
import type { LearnerDecision } from '../../../packages/playtest/src/learner/loop';
import { createPiDecisionSource } from '../../../packages/playtest/src/learner/piDecisionSource';
import { createScriptedDecisionSource } from '../../../packages/playtest/src/learner/scriptedDecisionSource';
import * as operator from '../../../packages/playtest/src/operator/session';
import * as reports from '../../../packages/playtest/src/report/writeReports';
import { loadStories } from '../../../packages/playtest/src/stories';
import type { Story } from '../../../packages/playtest/src/types';
import type { RunManifest } from '../../../scripts/run-evidence';
import adapter from '../adapter';
import { importFixture } from '../fixtures';
import { syntheticCourse } from '../prepare';
import { main } from '../run';

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

let server: Server;
let dataDirectory: string;
const args = ['--provider', 'scripted', '--model', 'deterministic', '--concurrency', '1'];
const story: Story = {
  id: 'scripted',
  title: 'Scripted run',
  kind: 'check',
  viewports: ['desktop'],
  requires: {},
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
  dataDirectory = await mkdtemp(join(tmpdir(), 'nous-playtest-evidence-'));
  vi.stubEnv('NOUS_E2E_DATA', dataDirectory);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(loadStories).mockResolvedValue([story]);
  vi.mocked(adapter.ensureStack).mockResolvedValue();
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
  await rm(dataDirectory, { recursive: true, force: true });
});

async function evidence() {
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
  expect(manifest.measurements).toEqual([
    expect.objectContaining({
      name: 'playtest',
      kind: 'case',
      outcome: manifest.outcome,
      durationMs: expect.any(Number),
    }),
  ]);
  return { directory, manifest };
}

describe('Nous playtest evidence entrypoint', () => {
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
