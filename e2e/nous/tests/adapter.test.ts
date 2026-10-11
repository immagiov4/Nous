import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresProjectStore } from '../../../apps/backend/src/projects/postgresProjectStore';
import { openOperatorSession } from '../../../packages/playtest/src/operator/session';
import { runPlaytest } from '../../../packages/playtest/src/runner';
import { loadPersonas, loadStories } from '../../../packages/playtest/src/stories';
import type { Story } from '../../../packages/playtest/src/types';
import adapter from '../adapter';
import { prepare, syntheticCourse } from '../prepare';
import {
  assertIsolatedStatus,
  dataRoot,
  REPO_ROOT,
  runStackStage,
  STACK_READINESS_POLL_INTERVAL_MS,
  STACK_SHUTDOWN_GRACE_MS,
  STACK_STAGE_READINESS_LIMIT_MS,
  type StackStatus,
  startServer,
  stopStack,
  waitForReadiness,
} from '../stack';

let temporaryRoot: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});
const status: StackStatus = {
  API_URL: 'http://127.0.0.1:55321',
  DB_URL: 'postgresql://postgres:test@127.0.0.1:55322/postgres',
  ANON_KEY: 'synthetic-anon',
  SERVICE_ROLE_KEY: 'synthetic-service',
  JWT_SECRET: 'synthetic-secret',
};
const story: Story = {
  id: 'test',
  kind: 'check',
  title: 'Test',
  body: 'Test',
  viewports: ['desktop'],
  requires: {},
  tags: [],
  budget: { steps: 1 },
  sourcePath: 'test.md',
};
vi.mock('../../../packages/playtest/src/inspector/judge', () => ({
  createPiVisualJudge: () => ({ judge: async () => [] }),
}));

const savedStackConfig =
  '# Saved configuration may differ from the current repository\nproject_id="nous-playtest"\n[api]\nport=55321\n[db]\nport=55322\nshadow_port=55320\n[studio]\nport=55323\n[inbucket]\nport=55324\n[auth.email.smtp]\nenabled=false\n';

async function createShutdownFixture(name = 'backend'): Promise<string> {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'nous-stop-'));
  vi.stubEnv('NOUS_E2E_DATA', temporaryRoot);
  await mkdir(join(temporaryRoot, 'stack', 'supabase'), { recursive: true });
  await writeFile(join(temporaryRoot, 'stack', 'supabase', 'config.toml'), savedStackConfig);
  const pidPath = join(temporaryRoot, 'stack', `${name}-pid.json`);
  await writeFile(
    pidPath,
    JSON.stringify({ pid: process.pid, repoRoot: REPO_ROOT, identity: 'owned-process' })
  );
  return pidPath;
}

describe('Nous adapter', () => {
  it('rejects in-repository data paths whose segment merely starts with two dots', () => {
    vi.stubEnv('NOUS_E2E_DATA', join(REPO_ROOT, '..playtest'));
    expect(dataRoot).toThrow('outside');
    vi.stubEnv('NOUS_E2E_DATA', join(REPO_ROOT, '..', 'external-playtest'));
    expect(dataRoot()).toBe(join(REPO_ROOT, '..', 'external-playtest'));
  });

  it('accepts saved isolated configuration on shutdown but refuses a recycled process identity', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'nous-stop-identity-'));
    await mkdir(join(temporaryRoot, 'stack', 'supabase'), { recursive: true });
    await writeFile(join(temporaryRoot, 'stack', 'supabase', 'config.toml'), savedStackConfig);
    await writeFile(
      join(temporaryRoot, 'stack', 'frontend-pid.json'),
      JSON.stringify({
        pid: process.pid,
        repoRoot: REPO_ROOT,
        identity: 'different-process-birth-time',
      })
    );
    const failure = await promisify(execFile)(
      'bun',
      ['run', join(REPO_ROOT, 'e2e/nous/stack.ts'), '--stop'],
      { env: { ...process.env, NOUS_E2E_DATA: temporaryRoot }, windowsHide: true }
    ).catch(error => error as { code: number; stderr: string });
    expect('code' in failure && failure.code).toBe(1);
    expect(failure.stderr).toContain('process identity changed');
    expect(() => process.kill(process.pid, 0)).not.toThrow();
    expect(
      JSON.parse(await readFile(join(temporaryRoot, 'stack', 'frontend-pid.json'), 'utf8')).pid
    ).toBe(process.pid);
  });

  it('waits for the whole POSIX group before removing its PID and stopping Supabase', async () => {
    const pidPath = await createShutdownFixture();
    let groupExists = true;
    let elapsed = 0;
    const identity = vi.fn(async () => 'owned-process');
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals | number | undefined) => {
      expect(identity).toHaveBeenCalledExactlyOnceWith(process.pid);
      if (signal === 0 && !groupExists) throw Object.assign(new Error('Exited'), { code: 'ESRCH' });
      return true;
    });
    const wait = vi.fn(async (milliseconds: number) => {
      expect(JSON.parse(await readFile(pidPath, 'utf8')).pid).toBe(process.pid);
      expect(stopSupabase).not.toHaveBeenCalled();
      elapsed += milliseconds;
      // The leader may exit before its descendants; group existence is authoritative.
      groupExists = false;
    });
    const stopSupabase = vi.fn(async () => {
      expect(groupExists).toBe(false);
      await expect(readFile(pidPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    await stopStack({
      platform: 'linux',
      identity,
      kill,
      clock: { now: () => elapsed, wait },
      stopSupabase,
    });
    expect(kill.mock.calls).toEqual([
      [-process.pid, 'SIGTERM'],
      [-process.pid, 0],
      [-process.pid, 0],
    ]);
    expect(elapsed).toBeLessThan(STACK_SHUTDOWN_GRACE_MS);
    expect(stopSupabase).toHaveBeenCalledOnce();
  });

  it('sends SIGKILL at the approved grace deadline before deleting the PID and stopping Supabase', async () => {
    const pidPath = await createShutdownFixture();
    let elapsed = 0;
    let forced = false;
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals | number | undefined) => {
      if (signal === 'SIGKILL') {
        expect(elapsed).toBe(STACK_SHUTDOWN_GRACE_MS);
        forced = true;
      }
      return true;
    });
    const wait = vi.fn(async (milliseconds: number) => {
      expect(forced).toBe(false);
      expect(stopSupabase).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(pidPath, 'utf8')).pid).toBe(process.pid);
      elapsed += milliseconds;
    });
    const stopSupabase = vi.fn(async () => {
      expect(forced).toBe(true);
      await expect(readFile(pidPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    await stopStack({
      platform: 'linux',
      identity: async () => 'owned-process',
      kill,
      clock: { now: () => elapsed, wait },
      stopSupabase,
    });
    expect(kill.mock.calls[0]).toEqual([-process.pid, 'SIGTERM']);
    expect(kill.mock.calls.at(-1)).toEqual([-process.pid, 'SIGKILL']);
    expect(wait).toHaveBeenCalledTimes(STACK_SHUTDOWN_GRACE_MS / STACK_READINESS_POLL_INTERVAL_MS);
    expect(stopSupabase).toHaveBeenCalledOnce();
  });

  it('retains the PID and keeps Supabase running if signaling the owned group fails', async () => {
    const pidPath = await createShutdownFixture();
    const error = Object.assign(new Error('Denied'), { code: 'EPERM' });
    const kill = vi.fn(() => {
      throw error;
    });
    const stopSupabase = vi.fn();
    await expect(
      stopStack({ platform: 'linux', identity: async () => 'owned-process', kill, stopSupabase })
    ).rejects.toBe(error);
    expect(JSON.parse(await readFile(pidPath, 'utf8')).pid).toBe(process.pid);
    expect(stopSupabase).not.toHaveBeenCalled();
  });

  it('paces successive HTTP readiness requests by the approved interval', async () => {
    const paused = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null));
    vi.stubGlobal('fetch', fetcher);
    const wait = vi.fn(async () => {
      paused.resolve();
      await resume.promise;
    });
    const readiness = waitForReadiness({
      url: 'http://synthetic.test/health',
      exited: new Promise<never>(() => {}),
      wait,
    });
    await paused.promise;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledExactlyOnceWith(
      STACK_READINESS_POLL_INTERVAL_MS,
      expect.any(AbortSignal)
    );
    resume.resolve();
    await readiness;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('fails immediately on child exit while waiting between readiness requests', async () => {
    const paused = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<never>();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    let waitSignal: AbortSignal | undefined;
    const wait = vi.fn(async (_milliseconds: number, signal?: AbortSignal) => {
      waitSignal = signal;
      paused.resolve();
      await resume.promise;
    });
    const failure = new Error('Child exited');
    const result = waitForReadiness({
      url: 'http://synthetic.test/health',
      exited: exited.promise,
      wait,
    }).catch(error => error);
    await paused.promise;
    exited.reject(failure);
    expect(await result).toBe(failure);
    expect(waitSignal?.aborted).toBe(true);
    resume.resolve();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('retains the stage deadline while readiness is waiting between requests', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'nous-paced-limit-'));
    vi.stubEnv('NOUS_E2E_DATA', temporaryRoot);
    await mkdir(join(temporaryRoot, 'stack'));
    await writeFile(join(temporaryRoot, 'stack', 'backend.log'), 'Synthetic stalled readiness');
    vi.useFakeTimers();
    const paused = Promise.withResolvers<void>();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const wait = (_milliseconds: number, signal?: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        paused.resolve();
      });
    const result = runStackStage({
      name: 'backend',
      work: signal =>
        waitForReadiness({
          url: 'http://synthetic.test/health',
          exited: new Promise<never>(() => {}),
          signal,
          wait,
        }),
    }).catch(error => error as Error);
    await paused.promise;
    await vi.advanceTimersByTimeAsync(STACK_STAGE_READINESS_LIMIT_MS);
    expect((await result).message).toContain('stage limit expired');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    'Supabase',
    'backend',
    'frontend',
  ])('expires the %s stage at its approved limit with redacted output', async name => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'nous-stage-limit-'));
    vi.stubEnv('NOUS_E2E_DATA', temporaryRoot);
    await mkdir(join(temporaryRoot, 'stack'));
    await writeFile(
      join(temporaryRoot, 'stack', `${name.toLowerCase()}.log`),
      'Synthetic stage stalled: private-stage-secret\n'
    );
    vi.useFakeTimers();
    let aborted = false;
    let settled = false;
    const stage = runStackStage({
      name,
      env: { TEST_SECRET: 'private-stage-secret' },
      work: signal =>
        new Promise<never>(() => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    });
    const result = stage.catch(error => {
      settled = true;
      return error as Error;
    });
    await vi.advanceTimersByTimeAsync(STACK_STAGE_READINESS_LIMIT_MS - 1);
    expect(settled).toBe(false);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await result;
    expect(error.message).toBe(
      `Playtest ${name} readiness failed: stage limit expired.\nSynthetic stage stalled: [redacted]`
    );
    expect(aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the stage deadline after successful readiness', async () => {
    vi.useFakeTimers();
    expect(await runStackStage({ name: 'backend', work: async () => 'healthy' })).toBe('healthy');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('starts a cold child from HTTP readiness even without a ready log marker', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'nous-startup-'));
    vi.stubEnv('NOUS_E2E_DATA', temporaryRoot);
    await mkdir(join(temporaryRoot, 'stack'));
    const reservation = createServer();
    await new Promise<void>(ready => reservation.listen(0, '127.0.0.1', ready));
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('No test TCP address');
    await new Promise<void>(ready => reservation.close(() => ready()));
    const url = `http://127.0.0.1:${address.port}`;
    const pid = await startServer(
      'fixture',
      [
        '-e',
        `require('node:http').createServer((_request,response)=>response.end('healthy')).listen(${address.port},'127.0.0.1')`,
      ],
      url,
      process.env
    );
    try {
      expect(await (await fetch(url)).text()).toBe('healthy');
      expect(
        JSON.parse(await readFile(join(temporaryRoot, 'stack', 'fixture-pid.json'), 'utf8'))
      ).toMatchObject({ pid, repoRoot: REPO_ROOT, identity: expect.any(String) });
    } finally {
      process.kill(pid);
    }
  });

  it('rejects early child exit with its stage and redacted last output', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'nous-startup-exit-'));
    vi.stubEnv('NOUS_E2E_DATA', temporaryRoot);
    await mkdir(join(temporaryRoot, 'stack'));
    await expect(
      startServer(
        'frontend',
        ['-e', "console.error('Synthetic Vite failure', process.env.TEST_SECRET); process.exit(1)"],
        'http://127.0.0.1:0',
        { ...process.env, TEST_SECRET: 'private-synthetic-secret' }
      )
    ).rejects.toThrow(
      'Playtest frontend readiness failed: process exited (1).\nSynthetic Vite failure [redacted]'
    );
  });
  it('stops on backend 5xx with its correlation ID, including proxied requests', () => {
    for (const origin of ['http://127.0.0.1:3301', adapter.baseUrl()]) {
      expect(
        adapter.classify({
          kind: 'response',
          url: `${origin}/api/projects`,
          status: 502,
          headers: { 'x-request-id': 'request-test' },
        })
      ).toEqual({ stop: true, reason: 'Backend HTTP 502.', correlationId: 'request-test' });
    }
    expect(
      adapter.classify({
        kind: 'response',
        url: 'https://example.test/api/projects',
        status: 502,
        headers: {},
      })
    ).toEqual({ stop: false });
    expect(
      adapter.classify({
        kind: 'response',
        url: `${adapter.baseUrl()}/asset.png`,
        status: 502,
        headers: {},
      })
    ).toEqual({ stop: false });
    expect(adapter.classify({ kind: 'console', level: 'error', text: 'test' })).toEqual({
      stop: false,
    });
  });

  it('loads the four stories and their mission persona', async () => {
    const stories = await loadStories(fileURLToPath(new URL('../stories', import.meta.url)));
    expect(stories.map(story => story.id)).toEqual([
      'esame-diritto-privato',
      'home-chat-ask',
      'lesson-read-and-select',
      'library-open-course',
    ]);
    const personas = await loadPersonas(fileURLToPath(new URL('../personas', import.meta.url)));
    expect(personas.get('giulia')?.affects?.length).toBeGreaterThan(0);
    expect(stories.find(story => story.id === 'library-open-course')?.viewports).toEqual([
      'desktop',
      'mobile',
    ]);
  });

  it('keeps thresholds unset and reference screens empty', () => {
    expect(adapter.thresholds()).toEqual({});
    expect(adapter.styleReference()).toEqual([]);
  });

  it('describes the learner purpose without exposing routes or component identifiers', () => {
    const description = adapter.appDescription();
    for (const internal of [
      '/admin/youtube-lab',
      '/admin',
      '/dev/diagnostic',
      '/dev/first-run',
      'DiagnosticDemo',
      'AdminPanel',
      'AppContent',
      'className',
    ])
      expect(description).not.toContain(internal);
    expect(description.trim().split('\n')).toHaveLength(1);
  });

  it('rejects default and remote database addresses before creating an account', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(() =>
      assertIsolatedStatus({
        ...status,
        DB_URL: 'postgresql://postgres:test@127.0.0.1:54322/postgres',
      })
    ).toThrow('isolated');
    await expect(
      prepare(story, 'desktop', { ...status, API_URL: 'https://example.test:55321' })
    ).rejects.toThrow('isolated');
    expect(fetcher).not.toHaveBeenCalled();
    vi.stubEnv('NOUS_E2E_DATA', REPO_ROOT);
    expect(dataRoot).toThrow('outside');
  });

  it('creates distinct confirmed accounts and seeds a readable synthetic lesson', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: crypto.randomUUID() }));
    vi.stubGlobal('fetch', fetcher);
    const save = vi
      .spyOn(PostgresProjectStore.prototype, 'saveProject')
      .mockResolvedValue({} as Awaited<ReturnType<PostgresProjectStore['saveProject']>>);
    const close = vi.spyOn(PostgresProjectStore.prototype, 'close').mockResolvedValue();
    const seeded = { ...story, requires: { course: 'synthetic-short' } };
    const first = await prepare(seeded, 'desktop', status);
    const second = await prepare(seeded, 'mobile', status);
    expect(first.credentials.email).not.toBe(second.credentials.email);
    expect(first.credentials.password).not.toBe(second.credentials.password);
    for (const call of fetcher.mock.calls) {
      expect(
        JSON.parse((call as unknown as [string, RequestInit])[1].body as string).email_confirm
      ).toBe(true);
    }
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0][1].activeSectionId).toBe('lesson-water');
    expect(save.mock.calls[0][1].learningPlan?.modules?.[0].children?.[0].content).toBe(
      syntheticCourse().learningPlan?.modules?.[0].children?.[0].content
    );
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('seeds the private-law mission with a matching lesson and cleans up projects before its account', async () => {
    const userId = crypto.randomUUID();
    const fetcher = vi.fn(async () => Response.json({ id: userId }));
    vi.stubGlobal('fetch', fetcher);
    const save = vi
      .spyOn(PostgresProjectStore.prototype, 'saveProject')
      .mockResolvedValue({} as Awaited<ReturnType<PostgresProjectStore['saveProject']>>);
    vi.spyOn(PostgresProjectStore.prototype, 'listProjects').mockResolvedValue([
      { id: 'synthetic-project' },
    ] as Awaited<ReturnType<PostgresProjectStore['listProjects']>>);
    const deleted = vi.spyOn(PostgresProjectStore.prototype, 'deleteProject').mockResolvedValue();
    vi.spyOn(PostgresProjectStore.prototype, 'close').mockResolvedValue();
    const stories = await loadStories(fileURLToPath(new URL('../stories', import.meta.url)));
    const mission = stories.find(story => story.id === 'esame-diritto-privato');
    if (!mission) throw new Error('Bundled mission is missing');
    const prepared = await prepare(mission, 'mobile', status);
    expect(save.mock.calls[0][1]).toMatchObject({
      activeSectionId: 'lesson-contract',
      learningPlan: {
        modules: [
          {
            id: 'module-law',
            children: [{ id: 'lesson-contract', contentBlocks: expect.any(Array) }],
          },
        ],
      },
    });
    await prepared.cleanup();
    expect(deleted).toHaveBeenCalledExactlyOnceWith(userId, 'synthetic-project');
    expect(fetcher.mock.calls.at(-1)).toEqual([
      `${status.API_URL}/auth/v1/admin/users/${userId}`,
      expect.objectContaining({ method: 'DELETE' }),
    ]);
    expect(deleted.mock.invocationCallOrder[0]).toBeLessThan(
      fetcher.mock.invocationCallOrder.at(-1) as number
    );
  });

  it('cleans up a created synthetic account when course preparation fails', async () => {
    const userId = crypto.randomUUID();
    const fetcher = vi.fn(async () => Response.json({ id: userId }));
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(PostgresProjectStore.prototype, 'saveProject').mockRejectedValue(
      new Error('Synthetic seed failure')
    );
    vi.spyOn(PostgresProjectStore.prototype, 'listProjects').mockResolvedValue([]);
    vi.spyOn(PostgresProjectStore.prototype, 'close').mockResolvedValue();
    await expect(
      prepare({ ...story, requires: { course: 'synthetic-short' } }, 'desktop', status)
    ).rejects.toThrow('Synthetic seed failure');
    expect(fetcher.mock.calls.at(-1)).toEqual([
      `${status.API_URL}/auth/v1/admin/users/${userId}`,
      expect.objectContaining({ method: 'DELETE' }),
    ]);
  });

  it('imports JSON fixtures through the product import method and rejects traversal', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'nous-adapter-'));
    vi.stubEnv('NOUS_E2E_DATA', temporaryRoot);
    await mkdir(join(temporaryRoot, 'fixtures'));
    const snapshot = syntheticCourse();
    await writeFile(join(temporaryRoot, 'fixtures', 'synthetic.json'), JSON.stringify(snapshot));
    await writeFile(join(temporaryRoot, 'outside.json'), '{}');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ id: crypto.randomUUID() }))
    );
    const importProject = vi
      .spyOn(PostgresProjectStore.prototype, 'importProject')
      .mockResolvedValue({} as Awaited<ReturnType<PostgresProjectStore['importProject']>>);
    vi.spyOn(PostgresProjectStore.prototype, 'close').mockResolvedValue();
    await prepare({ ...story, requires: { course: 'fixture:synthetic.json' } }, 'desktop', status);
    expect(importProject.mock.calls[0][1]).toEqual(snapshot);
    await writeFile(join(temporaryRoot, 'fixtures', '..synthetic.json'), JSON.stringify(snapshot));
    await prepare(
      { ...story, requires: { course: 'fixture:..synthetic.json' } },
      'desktop',
      status
    );
    expect(importProject.mock.calls[1][1]).toEqual(snapshot);
    const archive = Buffer.from('synthetic archive bytes');
    await writeFile(join(temporaryRoot, 'fixtures', 'synthetic.zip'), archive);
    const importArchive = vi
      .spyOn(PostgresProjectStore.prototype, 'importProjectArchive')
      .mockResolvedValue({} as Awaited<ReturnType<PostgresProjectStore['importProjectArchive']>>);
    await prepare({ ...story, requires: { course: 'fixture:synthetic.zip' } }, 'mobile', status);
    expect(importArchive.mock.calls[0][1]).toEqual(archive);
    expect(importArchive.mock.calls[0][2]).toMatch(/^[a-f0-9-]+$/);
    await expect(
      prepare({ ...story, requires: { course: 'fixture:../outside.json' } }, 'desktop', status)
    ).rejects.toThrow('within');
    await expect(
      prepare({ ...story, requires: { course: 'fixture:missing.json' } }, 'desktop', status)
    ).rejects.toThrow('missing');
    await expect(
      prepare({ ...story, requires: { freshness: 'current' } }, 'desktop', status)
    ).rejects.toThrow('Unsupported');
  });

  it('passes only the family matrix to the inspector', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'nous-taxonomy-'));
    vi.stubEnv('NOUS_E2E_DATA', temporaryRoot);
    await mkdir(join(temporaryRoot, 'complaint-mining'));
    await writeFile(
      join(temporaryRoot, 'complaint-mining/TAXONOMY.md'),
      '# Taxonomy\n\n## Family matrix for the checker prompt\n\n| Family | Classes |\n| F01 | D01 |\n\n## Class table\n\nPrivate complaint excerpt\n'
    );
    expect(adapter.taxonomy()).toBe('| Family | Classes |\n| F01 | D01 |');
  });

  it('samples one persona state per session and retains it in the report', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'nous-affect-'));
    const affects = ['curiosa', 'stanca'];
    const prompts: string[] = [];
    const summary = await runPlaytest({
      adapter: {
        ...adapter,
        ensureStack: async () => {},
        prepare: async () => ({
          credentials: { email: 'synthetic@example.test', password: 'synthetic' },
        }),
        baseUrl: () => 'data:text/html,<p>Contenuto sintetico</p>',
        taxonomy: () => '',
      },
      stories: [{ ...story, persona: 'person', budget: { steps: 2 } }],
      personas: new Map([
        ['person', { id: 'person', body: 'Profilo sintetico.', affects, sourcePath: 'person.md' }],
      ]),
      concurrency: 1,
      headed: false,
      model: 'fake',
      provider: 'fake',
      runDir: temporaryRoot,
      sourceFactory: () => ({
        async decide(input) {
          prompts.push(input.systemPrompt);
          return input.history.length
            ? { type: 'stop', reason: 'completed', summary: 'Done' }
            : { type: 'diary', entry: 'Observed' };
        },
      }),
    });
    expect(summary.records[0].outcome).toBe('completed');
    expect(affects).toContain(summary.records[0].affect);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe(prompts[1]);
    expect(prompts[0]).toContain(`sessione: ${summary.records[0].affect}.`);
  });

  it('allows a fresh observation and recovers from an unsupported keyboard key', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'nous-observe-'));
    const summary = await runPlaytest({
      adapter: {
        ...adapter,
        ensureStack: async () => {},
        prepare: async () => ({
          credentials: { email: 'synthetic@example.test', password: 'synthetic' },
        }),
        baseUrl: () => 'data:text/html,<label>Answer<input></label><p>Contenuto sintetico</p>',
        taxonomy: () => '',
      },
      stories: [{ ...story, budget: { steps: 3 } }],
      personas: new Map(),
      concurrency: 1,
      headed: false,
      model: 'fake',
      provider: 'fake',
      runDir: temporaryRoot,
      sourceFactory: () => ({
        async decide(input) {
          if (!input.history.length)
            return {
              type: 'act',
              action: { type: 'press', key: 'invalid-key' },
              expectation: 'Invalid action is returned to the learner.',
            };
          if (input.history.length === 1) {
            expect(input.history[0].result?.status).toBe('not-actionable');
            return {
              type: 'act',
              action: { type: 'observe' },
              expectation: 'A fresh view without changing the page.',
            };
          }
          expect(input.history[1].result?.status).toBe('ok');
          expect(input.observation.stepIndex).toBe(2);
          expect(input.observation.nodes.find(node => node.name === 'Answer')).toBeDefined();
          return { type: 'stop', reason: 'completed', summary: 'Recovered' };
        },
      }),
    });
    expect(summary.records[0].outcome).toBe('completed');
  });

  it.each([
    'during',
    'between',
  ])('keeps image, nodes and probes together when navigation happens %s capture', async phase => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'nous-navigation-'));
    const browser = await chromium.launch({ headless: true });
    const session = await openOperatorSession({
      browser,
      baseUrl: 'data:text/html,<p>Before navigation</p>',
      viewport: 'desktop',
      credentials: { email: 'synthetic@example.test', password: 'synthetic' },
      runDir: temporaryRoot,
    });
    try {
      const page = browser.contexts()[0].pages()[0];
      const screenshot = page.screenshot.bind(page);
      let navigated = false;
      vi.spyOn(page, 'screenshot').mockImplementation(async options => {
        if (!navigated) {
          navigated = true;
          const before = await screenshot(options);
          await page.goto(
            `data:text/html,${encodeURIComponent('<button>After navigation</button><span style="display:inline-block;width:20px;white-space:nowrap;overflow:hidden">New document clipped text</span>')}`
          );
          if (phase === 'during')
            throw new Error('Execution context was destroyed, most likely because of a navigation');
          return before;
        }
        return screenshot(options);
      });
      const observation = await session.observe();
      expect(observation.nodes.some(node => node.name === 'After navigation')).toBe(true);
      expect(page.screenshot).toHaveBeenCalledTimes(2);
      expect(observation.nodes.some(node => node.name === 'Before navigation')).toBe(false);
      const signals = await session.signals();
      expect(signals).toContainEqual(
        expect.objectContaining({ kind: 'clipped-text', text: 'New document clipped text' })
      );
      expect(observation.stepIndex).toBe(0);
    } finally {
      await session.close();
      await browser.close();
    }
  });
});
