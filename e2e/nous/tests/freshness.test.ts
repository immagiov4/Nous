import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresAccountStore } from '../../../apps/backend/src/account/accountStore';
import { getGlobalModelConfig } from '../../../apps/backend/src/config/modelConfig';
import { PostgresProjectStore } from '../../../apps/backend/src/projects/postgresProjectStore';
import { buildProjectMeta } from '../../../apps/backend/src/projects/projectMeta';
import type { ProjectSnapshotWithRevision } from '../../../apps/backend/src/projects/types';
import { PostgresWorkflowStore } from '../../../apps/backend/src/workflows/persistence/postgresWorkflowStore';
import type { Story } from '../../../packages/playtest/src/types';
import {
  FRESH_CONTENT_PREPARATION_TIMEOUT_MS,
  type FreshnessEvidence,
  withFreshnessEvidence,
} from '../freshness';
import { prepare, syntheticCourse } from '../prepare';
import { BACKEND_URL, type StackStatus } from '../stack';

const status: StackStatus = {
  API_URL: 'http://127.0.0.1:55321',
  DB_URL: 'postgresql://postgres:test@127.0.0.1:55322/postgres',
  ANON_KEY: 'anon',
  SERVICE_ROLE_KEY: 'service',
  JWT_SECRET: 'secret',
};
const story: Story = {
  id: 'fresh',
  title: 'Read a lesson',
  kind: 'check',
  viewports: ['desktop'],
  requires: {
    course: 'fixture:course.json',
    freshness: 'current',
    lesson: 'lesson-water',
  },
  body: 'Read.',
  tags: [],
  budget: { steps: 1 },
  sourcePath: 'test.md',
};
let root: string;
let imported: ReturnType<typeof syntheticCourse>;
let persisted: ProjectSnapshotWithRevision | null;
let result: Record<string, unknown>;
let job: Record<string, unknown>;
let evidence: FreshnessEvidence[];
let fetcher: ReturnType<typeof vi.fn<(url: string, options?: RequestInit) => Promise<Response>>>;
let reload: ReturnType<typeof vi.spyOn>;
const userId = '11111111-1111-4111-8111-111111111111';
const workflowId = '22222222-2222-4222-8222-222222222222';

function freshSnapshot(): ProjectSnapshotWithRevision {
  const snapshot = structuredClone(imported);
  const lesson = snapshot.learningPlan?.modules?.[0].children?.[0];
  if (!lesson) throw new Error('Test lesson missing');
  Object.assign(lesson, result, { id: 'lesson-water', lastGenerationRunId: workflowId });
  return { snapshot, revision: 2, incarnationId: 'incarnation' };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nous-freshness-'));
  vi.stubEnv('NOUS_E2E_DATA', root);
  await mkdir(join(root, 'fixtures'));
  await mkdir(join(root, 'stack'));
  await writeFile(
    join(root, 'stack/generation-settings.json'),
    JSON.stringify({
      appRevision: { commitSha: 'revision', dirty: true },
      settings: getGlobalModelConfig(),
    })
  );
  imported = syntheticCourse();
  await writeFile(join(root, 'fixtures/course.json'), JSON.stringify(imported));
  result = {
    projectId: imported.id,
    sectionId: 'lesson-water',
    content: 'Fresh lesson',
    contentBlocks: [{ type: 'markdown', markdown: 'Fresh lesson' }],
    generatedVisuals: [],
    imageRefs: [],
    learningAids: [],
    quiz: [],
    warnings: [],
    projectRevision: 2,
  };
  job = {
    id: workflowId,
    projectId: imported.id,
    sectionId: 'lesson-water',
    status: 'completed',
    retrying: false,
    stage: 'verification',
    result,
  };
  persisted = freshSnapshot();
  evidence = [];
  vi.spyOn(PostgresAccountStore.prototype, 'finishSetup').mockResolvedValue();
  vi.spyOn(PostgresProjectStore.prototype, 'importProject').mockResolvedValue({
    snapshot: imported,
    meta: buildProjectMeta(imported),
  });
  reload = vi
    .spyOn(PostgresProjectStore.prototype, 'loadProjectWithRevision')
    .mockImplementation(async () =>
      reload.mock.calls.length % 2 === 1
        ? { snapshot: imported, revision: 1, incarnationId: 'incarnation' }
        : persisted
    );
  vi.spyOn(PostgresProjectStore.prototype, 'patchProject').mockResolvedValue(
    buildProjectMeta(imported)
  );
  vi.spyOn(PostgresProjectStore.prototype, 'listProjects').mockResolvedValue([
    { id: imported.id },
  ] as Awaited<ReturnType<PostgresProjectStore['listProjects']>>);
  vi.spyOn(PostgresProjectStore.prototype, 'deleteProject').mockResolvedValue();
  vi.spyOn(PostgresProjectStore.prototype, 'close').mockResolvedValue();
  fetcher = vi.fn(async (url: string) => {
    if (url.includes('/token?')) return Response.json({ access_token: 'authenticated-token' });
    if (url.startsWith(BACKEND_URL))
      return Response.json({
        success: true,
        created: true,
        job: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...job },
      });
    return Response.json({ id: userId });
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});
const run = (selection: Story = story) =>
  withFreshnessEvidence(
    async record => {
      evidence.push(structuredClone(record));
    },
    () => prepare(selection, 'desktop', status),
    async record => {
      const index = evidence.findIndex(existing => existing.requestKey === record.requestKey);
      evidence[index] = structuredClone(record);
    }
  );

describe('Nous freshness preparation', () => {
  it('imports any unchanged without authentication, generation or content reload', async () => {
    await run({ ...story, requires: { ...story.requires, freshness: 'any' } });
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      `${status.API_URL}/auth/v1/admin/users`,
    ]);
    expect(reload).not.toHaveBeenCalled();
    expect(evidence).toEqual([]);
    expect(vi.mocked(PostgresProjectStore.prototype.importProject).mock.calls[0][1]).toEqual(
      imported
    );
  });
  it('forces a distinct authenticated generation on every run and reloads its persisted output', async () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const respond = fetcher.getMockImplementation();
    if (!respond) throw new Error('Response implementation missing');
    fetcher.mockImplementation(async (...args: [string]) => {
      if (args[0].endsWith('/lessons')) clock++;
      return respond(...args);
    });
    const first = await run();
    await run();
    const calls = fetcher.mock.calls.filter(call => call[0].endsWith('/lessons'));
    expect(calls).toHaveLength(2);
    const requests = calls.map(call => JSON.parse((call[1] as RequestInit).body as string));
    expect(requests[0]).toMatchObject({
      forceRegenerate: true,
      projectId: imported.id,
      sectionId: 'lesson-water',
    });
    expect(requests[0].requestKey).not.toBe(requests[1].requestKey);
    expect((calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer authenticated-token',
    });
    expect(reload).toHaveBeenCalledTimes(4);
    expect(vi.mocked(PostgresProjectStore.prototype.patchProject)).toHaveBeenCalledWith(
      userId,
      imported.id,
      { activeSectionId: 'lesson-water' },
      { expectedRevision: 2 }
    );
    expect(first.inspectionSelector).toContain(workflowId);
    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toMatchObject({
      workflowId,
      appRevision: { commitSha: 'revision', dirty: true },
      generationSettings: getGlobalModelConfig(),
      projectId: imported.id,
      sectionId: 'lesson-water',
      outcome: 'current',
      warnings: [],
      durationMs: 1,
      contentSha256: expect.any(String),
      persistedRevision: 2,
      visuals: { generatedVisuals: [], imageRefs: [] },
    });
  });
  it.each([
    'stale-run',
    'stale-revision',
    'missing',
    'different-content',
    'different-blocks',
    'different-visuals',
  ])('blocks %s persistence and cleans the imported account', async defect => {
    if (defect === 'missing') persisted = null;
    else if (persisted) {
      const lesson = persisted.snapshot.learningPlan?.modules?.[0].children?.[0];
      if (!lesson) throw new Error('Test lesson missing');
      if (defect === 'stale-run') lesson.lastGenerationRunId = 'old-run';
      if (defect === 'stale-revision') persisted.revision = 1;
      if (defect === 'different-content') lesson.content = 'Old content';
      if (defect === 'different-blocks') lesson.contentBlocks = [];
      if (defect === 'different-visuals') lesson.generatedVisuals = [{ id: 'old' }];
    }
    await expect(run()).rejects.toThrow('lesson_generation_persistence_unverified');
    expect(evidence[0]).toMatchObject({
      outcome: 'blocked',
      workflowId,
      errorCode: 'lesson_generation_persistence_unverified',
    });
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe(`${status.API_URL}/auth/v1/admin/users/${userId}`);
  });
  it.each([
    'already-completed',
    'empty-blocks',
    'wrong-target',
    'missing-result',
  ])('blocks %s workflow output', async defect => {
    if (defect === 'already-completed') result.alreadyCompleted = true;
    if (defect === 'empty-blocks') result.contentBlocks = [];
    if (defect === 'wrong-target') result.sectionId = 'old-lesson';
    if (defect === 'missing-result') delete job.result;
    await expect(run()).rejects.toThrow('lesson_generation_output_incomplete');
    expect(evidence[0].outcome).toBe('blocked');
  });
  it.each([
    'lesson_factual_support_failed',
    'lesson_source_unavailable',
  ])('retains the product failure %s and cleans up', async code => {
    job.status = 'failed';
    job.errorCode = code;
    delete job.result;
    await expect(run()).rejects.toThrow(code);
    expect(evidence[0]).toMatchObject({
      outcome: 'blocked',
      workflowStatus: 'failed',
      errorCode: code,
      workflowId,
    });
    expect(PostgresProjectStore.prototype.deleteProject).toHaveBeenCalledWith(userId, imported.id);
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe(`${status.API_URL}/auth/v1/admin/users/${userId}`);
  });
  it('accepts persisted fresh text with an incomplete-visual warning and reports visual availability separately', async () => {
    result.warnings = [{ code: 'lesson_visual_generation_incomplete', stage: 'visuals' }];
    await run();
    expect(evidence[0]).toMatchObject({
      outcome: 'current',
      warnings: result.warnings,
      visuals: { generatedVisuals: [], imageRefs: [] },
    });
  });
  it('polls the durable job until completion', async () => {
    let reads = 0;
    fetcher.mockImplementation(async (url: string) => {
      if (url.includes('/token?')) return Response.json({ access_token: 'authenticated-token' });
      if (url.startsWith(BACKEND_URL)) {
        reads++;
        return Response.json({
          success: true,
          created: true,
          job: {
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ...job,
            status: reads === 1 ? 'running' : 'completed',
          },
        });
      }
      return Response.json({ id: userId });
    });
    await run();
    expect(
      fetcher.mock.calls.some(
        call => call[0] === `${BACKEND_URL}/api/lesson-workflows/runs/${workflowId}`
      )
    ).toBe(true);
    expect(evidence[0].outcome).toBe('current');
  });
  it('validates freshness and explicit targets before account creation', async () => {
    await expect(run({ ...story, requires: { freshness: 'yesterday' } })).rejects.toThrow();
    await expect(
      run({ ...story, requires: { freshness: 'current', course: 'fixture:course.json' } })
    ).rejects.toThrow('explicit');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it.each([
  ['authentication', 'lesson_generation_auth_failed'],
  ['cached-start', 'lesson_generation_not_created'],
  ['missing-target', 'lesson_generation_target_missing'],
  ['wrong-workflow-target', 'lesson_generation_identity_mismatch'],
  ['network', 'lesson_generation_preparation_failed'],
])('blocks %s preparation and cleans up before exposing a stale lesson', async (defect, code) => {
  const respond = fetcher.getMockImplementation();
  if (!respond) throw new Error('Response implementation missing');
  if (defect === 'missing-target') imported.learningPlan = null;
  if (defect === 'wrong-workflow-target') job.sectionId = 'old-lesson';
  fetcher.mockImplementation(async (...args: [string]) => {
    const [url] = args;
    if (defect === 'authentication' && url.includes('/token?'))
      return Response.json({}, { status: 401 });
    if (defect === 'network' && url.endsWith('/lessons'))
      throw new TypeError('Network unavailable');
    if (defect === 'network' && url.endsWith('/requests/resolve'))
      return Response.json({}, { status: 404 });
    const response = await respond(...args);
    if (defect === 'cached-start' && url.endsWith('/lessons')) {
      const body = await response.json();
      return Response.json({ ...body, created: false });
    }
    return response;
  });
  await expect(run()).rejects.toThrow(code);
  expect(evidence[0]).toMatchObject({ outcome: 'blocked', errorCode: code });
  expect(PostgresProjectStore.prototype.deleteProject).toHaveBeenCalledWith(userId, imported.id);
  if (defect === 'authentication' || defect === 'missing-target')
    expect(fetcher.mock.calls.some(call => call[0].startsWith(BACKEND_URL))).toBe(false);
});

it.each([
  'lost-response',
  'invalid-json',
  'invalid-envelope',
  'transient-start',
])('recovers accepted %s by the original request key before cleanup', async defect => {
  const respond = fetcher.getMockImplementation();
  if (!respond) throw new Error('Response implementation missing');
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith('/lessons')) {
      if (defect === 'lost-response') throw new TypeError('Response lost');
      if (defect === 'invalid-json') return new Response('{', { status: 202 });
      if (defect === 'invalid-envelope') return Response.json({ success: true }, { status: 202 });
      return new Response(null, { status: 500 });
    }
    return respond(url, options);
  });
  const prepared = await run();
  const start = fetcher.mock.calls.find(([url]) => url.endsWith('/lessons'));
  const recovery = fetcher.mock.calls.find(([url]) => url.endsWith('/requests/resolve'));
  expect(JSON.parse(recovery?.[1]?.body as string)).toEqual({
    requestKey: JSON.parse(start?.[1]?.body as string).requestKey,
  });
  expect(evidence[0]).toMatchObject({ workflowId, outcome: 'current' });
  expect(PostgresProjectStore.prototype.deleteProject).not.toHaveBeenCalled();
  await prepared.cleanup();
  expect(PostgresProjectStore.prototype.deleteProject).toHaveBeenCalled();
});

it.each([
  500,
  408,
  429,
  'invalid-json',
  'network',
])('retries transient polling %s until the persisted output is available', async defect => {
  const respond = fetcher.getMockImplementation();
  if (!respond) throw new Error('Response implementation missing');
  let reads = 0;
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith('/lessons')) {
      const response = await respond(url, options);
      const body = await response.json();
      return Response.json({ ...body, job: { ...body.job, status: 'running' } });
    }
    if (url.includes('/runs/') && ++reads === 1) {
      if (defect === 'network') throw new TypeError('Temporary disconnect');
      if (defect === 'invalid-json') return new Response('{', { status: 200 });
      return new Response(null, { status: defect as number });
    }
    return respond(url, options);
  });
  await run();
  expect(reads).toBe(2);
  expect(evidence[0]).toMatchObject({ workflowId, outcome: 'current' });
  expect(reload).toHaveBeenCalledTimes(2);
  expect(PostgresProjectStore.prototype.deleteProject).not.toHaveBeenCalled();
});

it('retains a recovered failed workflow in evidence before deleting the account', async () => {
  const respond = fetcher.getMockImplementation();
  if (!respond) throw new Error('Response implementation missing');
  job.status = 'failed';
  job.errorCode = 'lesson_factual_support_failed';
  delete job.result;
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith('/lessons')) throw new TypeError('Accepted start response lost');
    return respond(url, options);
  });
  await expect(run()).rejects.toThrow('lesson_factual_support_failed');
  expect(evidence[0]).toMatchObject({
    workflowId,
    workflowStatus: 'failed',
    errorCode: 'lesson_factual_support_failed',
  });
  expect(PostgresProjectStore.prototype.deleteProject).toHaveBeenCalledWith(userId, imported.id);
});

it('retries a transient request-key lookup and retains the accepted workflow', async () => {
  const respond = fetcher.getMockImplementation();
  if (!respond) throw new Error('Response implementation missing');
  let lookups = 0;
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith('/lessons')) throw new TypeError('Accepted start response lost');
    if (url.endsWith('/requests/resolve') && ++lookups === 1)
      return new Response(null, { status: 500 });
    return respond(url, options);
  });
  await run();
  expect(lookups).toBe(2);
  expect(evidence[0]).toMatchObject({ workflowId, outcome: 'current' });
});

it.each([
  'pending-poll',
  'running',
  'transient-poll',
  'cancellation-failed',
])('expires the overall preparation deadline for %s and records cancellation before cleanup', async scenario => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const respond = fetcher.getMockImplementation();
  if (!respond) throw new Error('Response implementation missing');
  const { promise: acceptedStart, resolve: notifyStart } = Promise.withResolvers<void>();
  let latePoll: ((response: Response) => void) | undefined;
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith('/lessons')) notifyStart();
    if (url.endsWith('/cancellation') && scenario === 'cancellation-failed')
      return new Response(null, { status: 500 });
    if (url.includes('/runs/') && !url.endsWith('/cancellation')) {
      if (scenario === 'pending-poll')
        return new Promise<Response>(resolve => {
          latePoll = resolve;
        });
      if (scenario === 'transient-poll') return new Response(null, { status: 500 });
    }
    const response = await respond(url, options);
    if (url.endsWith('/lessons') || (url.includes('/runs/') && !url.endsWith('/cancellation'))) {
      const body = await response.json();
      return Response.json({ ...body, job: { ...body.job, status: 'running' } });
    }
    return response;
  });
  const preparation = run();
  const blocked = expect(preparation).rejects.toThrow('lesson_generation_preparation_timeout');
  await acceptedStart;
  await vi.advanceTimersByTimeAsync(FRESH_CONTENT_PREPARATION_TIMEOUT_MS - Date.now() - 1);
  expect(evidence).toEqual([]);
  expect(PostgresProjectStore.prototype.deleteProject).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await blocked;
  expect(evidence[0]).toMatchObject({
    workflowId,
    outcome: 'blocked',
    errorCode: 'lesson_generation_preparation_timeout',
    cancellation:
      scenario === 'cancellation-failed'
        ? { status: 'failed', errorCode: 'lesson_generation_cancellation_failed' }
        : { status: 'confirmed' },
  });
  const cancellation = fetcher.mock.calls.find(([url]) => url.endsWith('/cancellation'));
  expect(cancellation?.[0]).toBe(`${BACKEND_URL}/api/workflows/runs/${workflowId}/cancellation`);
  expect(cancellation?.[1]?.headers).toMatchObject({ Authorization: 'Bearer authenticated-token' });
  expect(PostgresProjectStore.prototype.deleteProject).toHaveBeenCalledWith(userId, imported.id);
  const poll = fetcher.mock.calls.find(
    ([url]) => url.includes('/runs/') && !url.endsWith('/cancellation')
  );
  expect(poll?.[1]?.signal?.aborted).toBe(true);
  if (latePoll)
    latePoll(
      Response.json({
        success: true,
        job: { ...job, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      })
    );
  await Promise.resolve();
  expect(PostgresProjectStore.prototype.patchProject).not.toHaveBeenCalled();
});

it('recovers an accepted start id from the durable request key when its response outlives the deadline', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const lookup = vi
    .spyOn(PostgresWorkflowStore.prototype, 'getRunByRequestKey')
    .mockResolvedValue({ id: workflowId, projectId: imported.id } as Awaited<
      ReturnType<PostgresWorkflowStore['getRunByRequestKey']>
    >);
  const respond = fetcher.getMockImplementation();
  if (!respond) throw new Error('Response implementation missing');
  const { promise: acceptedStart, resolve: notifyStart } = Promise.withResolvers<void>();
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith('/lessons')) notifyStart();
    return url.endsWith('/lessons') ? new Promise<Response>(() => {}) : respond(url, options);
  });
  const blocked = expect(run()).rejects.toThrow('lesson_generation_preparation_timeout');
  await acceptedStart;
  await vi.advanceTimersByTimeAsync(FRESH_CONTENT_PREPARATION_TIMEOUT_MS - Date.now());
  await vi.waitFor(() => expect(evidence).toHaveLength(1));
  await blocked;
  expect(lookup).toHaveBeenCalledWith({
    userId,
    requestKey: evidence[0].requestKey,
    workflowId: 'lesson-generation',
  });
  expect(evidence[0]).toMatchObject({
    workflowId,
    errorCode: 'lesson_generation_preparation_timeout',
    cancellation: { status: 'confirmed' },
  });
  expect(
    fetcher.mock.calls.some(
      ([url]) => url === `${BACKEND_URL}/api/workflows/runs/${workflowId}/cancellation`
    )
  ).toBe(true);
});

it('clears the preparation deadline after success so later time cannot abort the finished request', async () => {
  vi.useFakeTimers();
  await run();
  await vi.advanceTimersByTimeAsync(FRESH_CONTENT_PREPARATION_TIMEOUT_MS);
  const start = fetcher.mock.calls.find(([url]) => url.endsWith('/lessons'));
  expect(start?.[1]?.signal?.aborted).toBe(false);
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/cancellation'))).toBe(false);
  expect(evidence[0].outcome).toBe('current');
});

it('does not await a hanging cancellation and freezes timeout evidence against a late confirmation', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const captured: FreshnessEvidence[] = [];
  const respond = fetcher.getMockImplementation();
  if (!respond) throw new Error('Response implementation missing');
  const { promise: acceptedStart, resolve: notifyStart } = Promise.withResolvers<void>();
  let finishCancellation: ((response: Response) => void) | undefined;
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith('/lessons')) notifyStart();
    if (url.endsWith('/cancellation'))
      return new Promise<Response>(resolve => {
        finishCancellation = resolve;
      });
    const response = await respond(url, options);
    if (url.endsWith('/lessons') || url.includes('/runs/')) {
      const body = await response.json();
      return Response.json({ ...body, job: { ...body.job, status: 'running' } });
    }
    return response;
  });
  const blocked = expect(
    withFreshnessEvidence(
      async record => {
        captured.push(record);
      },
      () => prepare(story, 'desktop', status)
    )
  ).rejects.toThrow('lesson_generation_preparation_timeout');
  await acceptedStart;
  await vi.advanceTimersByTimeAsync(FRESH_CONTENT_PREPARATION_TIMEOUT_MS);
  await blocked;
  expect(captured[0]).toMatchObject({
    workflowId,
    outcome: 'blocked',
    errorCode: 'lesson_generation_preparation_timeout',
    cancellation: { status: 'requested-unconfirmed' },
  });
  expect(PostgresProjectStore.prototype.deleteProject).toHaveBeenCalled();
  const finalEvidence = structuredClone(captured[0]);
  const json = vi.fn(async () => ({ success: true }));
  if (!finishCancellation) throw new Error('Cancellation was not issued');
  finishCancellation({ ok: true, json } as unknown as Response);
  await vi.waitFor(() => expect(json).toHaveBeenCalled());
  await Promise.resolve();
  expect(captured[0]).toEqual(finalEvidence);
});

it('does not await a hanging request-key fallback and cannot publish its late workflow id', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const captured: FreshnessEvidence[] = [];
  let finishLookup:
    | ((run: Awaited<ReturnType<PostgresWorkflowStore['getRunByRequestKey']>>) => void)
    | undefined;
  const lookup = vi.spyOn(PostgresWorkflowStore.prototype, 'getRunByRequestKey').mockImplementation(
    () =>
      new Promise(resolve => {
        finishLookup = resolve;
      })
  );
  const respond = fetcher.getMockImplementation();
  if (!respond) throw new Error('Response implementation missing');
  const { promise: acceptedStart, resolve: notifyStart } = Promise.withResolvers<void>();
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith('/lessons')) {
      notifyStart();
      return new Promise<Response>(() => {});
    }
    return respond(url, options);
  });
  const blocked = expect(
    withFreshnessEvidence(
      async record => {
        captured.push(record);
      },
      () => prepare(story, 'desktop', status)
    )
  ).rejects.toThrow('lesson_generation_preparation_timeout');
  await acceptedStart;
  await vi.advanceTimersByTimeAsync(FRESH_CONTENT_PREPARATION_TIMEOUT_MS);
  await blocked;
  expect(lookup).toHaveBeenCalled();
  expect(captured[0]).toMatchObject({
    workflowId: null,
    outcome: 'blocked',
    errorCode: 'lesson_generation_preparation_timeout',
    cancellation: { status: 'requested-unconfirmed' },
  });
  expect(PostgresProjectStore.prototype.deleteProject).toHaveBeenCalled();
  const finalEvidence = structuredClone(captured[0]);
  if (!finishLookup) throw new Error('Request-key lookup was not issued');
  finishLookup({ id: workflowId, projectId: imported.id } as Awaited<
    ReturnType<PostgresWorkflowStore['getRunByRequestKey']>
  >);
  await Promise.resolve();
  await Promise.resolve();
  expect(captured[0]).toEqual(finalEvidence);
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/cancellation'))).toBe(false);
});
