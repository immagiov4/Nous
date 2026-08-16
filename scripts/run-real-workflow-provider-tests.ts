import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import { SQL } from 'bun';

import {
  patchGlobalModelConfig,
  resolveCodexServiceTierForSlot,
  resolveTextModelConfig,
} from '../apps/backend/src/config/modelConfig.js';
import { createApp } from '../apps/backend/src/index.js';
import { PostgresProjectStore } from '../apps/backend/src/projects/postgresProjectStore.js';
import type { ProjectAssetObjectStorage } from '../apps/backend/src/projects/projectAsset.js';
import { findProjectLessonSection } from '../apps/backend/src/projects/projectLesson.js';
import { verifyProjectSourceBytes } from '../apps/backend/src/projects/projectSourceStorage.js';
import { setProjectStoreForTesting } from '../apps/backend/src/projects/projectStore.js';
import type {
  LearningPlanNodeSnapshot,
  ProjectSnapshot,
} from '../apps/backend/src/projects/types.js';
import { closeManagedCodexAccountClient } from '../apps/backend/src/services/codexAppServer.js';
import { resolveLessonVisualModelConfig } from '../apps/backend/src/services/lessonVisualModelConfig.js';
import {
  createWorkflowRuntimeComposition,
  type WorkflowRuntimeComposition,
} from '../apps/backend/src/workflows/runtime/workflowRuntimeComposition.js';

const COST_ACKNOWLEDGEMENT = 'I_ACCEPT_REAL_PROVIDER_COSTS';
const COURSE_MODEL = 'gpt-5.6-luna';
const LESSON_MODEL = 'gpt-5.6-luna';
const ARTIFACT_MODEL = 'gpt-5.6-sol';
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RUN_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_STEP_CONCURRENCY = 2;
const MAX_STEP_CONCURRENCY = 4;
const SQL_CLOSE_TIMEOUT_SECONDS = 5;
const SQL_CONNECTION_LIMIT = 2;
const LOCAL_DATABASE_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const TERMINAL_STATUSES = new Set(['completed', 'failed']);

interface WorkflowJob {
  readonly errorCode?: string;
  readonly id: string;
  readonly result?: Record<string, unknown>;
  readonly stage?: string;
  readonly status: string;
}

interface WorkflowTrace {
  readonly nodes?: Array<{
    readonly attemptCount?: number;
    readonly definitionId?: string;
    readonly status?: string;
  }>;
  readonly run?: { readonly status?: string };
}

interface StoredWorkflowConfigRow {
  readonly resolved_config: unknown;
}

interface WorkflowDatabaseOccupancyRow {
  readonly deletion_count: number;
  readonly run_count: number;
}

interface WorkflowAiUsageRow {
  readonly cache_read_tokens: number | null;
  readonly cache_write_tokens: number | null;
  readonly input_tokens: number | null;
  readonly model: string;
  readonly output_tokens: number | null;
  readonly provider: string;
  readonly reasoning_tokens: number | null;
  readonly run_id: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readPositiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const requireLocalDatabaseUrl = (): string => {
  const databaseUrl = process.env.REAL_WORKFLOW_PROVIDER_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('REAL_WORKFLOW_PROVIDER_DATABASE_URL is required.');
  }
  const parsed = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('REAL_WORKFLOW_PROVIDER_DATABASE_URL must be a PostgreSQL URL.');
  }
  if (!LOCAL_DATABASE_HOSTS.has(parsed.hostname)) {
    throw new Error('Real provider workflow tests only accept a loopback PostgreSQL database.');
  }
  return databaseUrl;
};

const createMemoryStorage = (): ProjectAssetObjectStorage => {
  const objects = new Map<string, Uint8Array>();
  return {
    async delete(path) {
      objects.delete(path);
    },
    async download(path, expected) {
      const bytes = objects.get(path);
      if (!bytes) throw new Error(`Temporary workflow object is missing: ${path}`);
      verifyProjectSourceBytes(bytes, expected);
      return bytes.slice();
    },
    async upload(path, bytes) {
      objects.set(path, bytes.slice());
    },
  };
};

const configureEconomicalCodexModels = () => {
  const config = patchGlobalModelConfig({
    aiProvider: 'codex',
    aiProviderOverrides: {},
    artifactInteractiveReasoningEffort: 'low',
    artifactReasoningEffort: 'low',
    codexArtifactInteractiveModel: ARTIFACT_MODEL,
    codexArtifactModel: ARTIFACT_MODEL,
    codexCourseModel: COURSE_MODEL,
    codexFastModelSlots: [],
    codexLessonModel: LESSON_MODEL,
    codexResearchModel: COURSE_MODEL,
    courseReasoningEffort: 'low',
    lessonReasoningEffort: 'low',
  });
  assert.deepEqual(resolveTextModelConfig(config, 'course').model, COURSE_MODEL);
  assert.deepEqual(resolveTextModelConfig(config, 'lesson').model, LESSON_MODEL);
  assert.equal(resolveCodexServiceTierForSlot(config, 'course'), undefined);
  assert.equal(resolveCodexServiceTierForSlot(config, 'lesson'), undefined);
  assert.equal(resolveCodexServiceTierForSlot(config, 'artifact'), undefined);
  const visual = resolveLessonVisualModelConfig(config);
  assert.deepEqual(visual.artifact, {
    model: ARTIFACT_MODEL,
    provider: 'codex',
    reasoningEffort: 'low',
  });
  return config;
};

const requireJob = (body: unknown, route: string): WorkflowJob => {
  if (!isRecord(body) || body.success !== true || !isRecord(body.job)) {
    throw new Error(`${route} returned an invalid response: ${JSON.stringify(body)}`);
  }
  const { id, status } = body.job;
  if (typeof id !== 'string' || typeof status !== 'string') {
    throw new TypeError(`${route} did not return a workflow identity.`);
  }
  return body.job as unknown as WorkflowJob;
};

const requestJson = async (
  baseUrl: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ body: unknown; status: number }> => {
  const response = await fetch(
    new URL(path, baseUrl),
    body
      ? {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      : undefined
  );
  return { body: await response.json(), status: response.status };
};

const listen = (app: ReturnType<typeof createApp>): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });

const reportCleanupFailure = (operation: string, error: unknown): void => {
  process.exitCode = 1;
  console.error(`[real-provider] ${operation} failed`, error);
};

const loadTrace = async (baseUrl: string, runId: string) => {
  const response = await requestJson(baseUrl, `/api/workflows/runs/${runId}`);
  if (response.status !== 200 || !isRecord(response.body) || !isRecord(response.body.state)) {
    throw new Error(`Unable to read the durable trace for ${runId}.`);
  }
  return response.body.state as WorkflowTrace;
};

const waitForWorkflow = async ({
  baseUrl,
  label,
  path,
  runId,
  timeoutMs,
}: {
  baseUrl: string;
  label: string;
  path: string;
  runId: string;
  timeoutMs: number;
}): Promise<WorkflowJob> => {
  const startedAt = Date.now();
  let previousProgress = '';
  while (Date.now() - startedAt < timeoutMs) {
    const response = await requestJson(baseUrl, path);
    if (response.status !== 200) {
      throw new Error(`${label} status route returned ${response.status}.`);
    }
    const job = requireJob(response.body, path);
    const progress = [job.status, job.stage].filter(Boolean).join('/');
    if (progress !== previousProgress) {
      console.log(`[real-provider] ${label}: ${progress}`);
      previousProgress = progress;
    }
    if (TERMINAL_STATUSES.has(job.status)) {
      const trace = await loadTrace(baseUrl, runId);
      console.log(
        JSON.stringify(
          {
            durationMs: Date.now() - startedAt,
            label,
            nodes: trace.nodes?.map(node => ({
              attempts: node.attemptCount,
              id: node.definitionId,
              status: node.status,
            })),
            runId,
            status: trace.run?.status,
          },
          null,
          2
        )
      );
      if (job.status !== 'completed') {
        throw new Error(`${label} failed with ${job.errorCode || 'an unknown workflow error'}.`);
      }
      return job;
    }
    await Bun.sleep(DEFAULT_POLL_INTERVAL_MS);
  }
  throw new Error(`${label} did not finish within ${timeoutMs} ms.`);
};

const runWorkflow = async ({
  baseUrl,
  body,
  label,
  startPath,
  statusPath,
  timeoutMs,
}: {
  baseUrl: string;
  body: Record<string, unknown>;
  label: string;
  startPath: string;
  statusPath: (runId: string) => string;
  timeoutMs: number;
}): Promise<{ job: WorkflowJob; runId: string }> => {
  const response = await requestJson(baseUrl, startPath, body);
  if (response.status !== 200 && response.status !== 202) {
    throw new Error(`${label} start route returned ${response.status}.`);
  }
  const queued = requireJob(response.body, startPath);
  return {
    job: await waitForWorkflow({
      baseUrl,
      label,
      path: statusPath(queued.id),
      runId: queued.id,
      timeoutMs,
    }),
    runId: queued.id,
  };
};

const assertStoredModels = async (
  sql: SQL,
  runIds: { artifact: string; course: string; lesson: string }
): Promise<void> => {
  const rows = await sql<StoredWorkflowConfigRow[]>`
    select resolved_config
    from public.workflow_runs
    where id in (${runIds.course}, ${runIds.lesson}, ${runIds.artifact})
  `;
  assert.equal(rows.length, 3);
  const configs = rows.map(row => row.resolved_config).filter(isRecord);
  assert.equal(configs.length, 3);
  for (const config of configs) {
    const models = config.models;
    if (isRecord(models)) {
      assert.equal(models.codexCourseModel, COURSE_MODEL);
      assert.equal(models.codexLessonModel, LESSON_MODEL);
      assert.equal(models.codexArtifactModel, ARTIFACT_MODEL);
      assert.deepEqual(models.codexFastModelSlots, []);
      continue;
    }
    const visual = config.visual;
    assert.ok(isRecord(visual) && isRecord(visual.artifact));
    assert.deepEqual(visual.artifact, {
      model: ARTIFACT_MODEL,
      provider: 'codex',
      reasoningEffort: 'low',
    });
  }
};

const assertStoredAiUsage = async (
  sql: SQL,
  runIds: { artifact: string; course: string; lesson: string }
): Promise<void> => {
  const rows = await sql<WorkflowAiUsageRow[]>`
    select
      run_id, provider, model, input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens
    from public.workflow_ai_usage
    where run_id in (${runIds.course}, ${runIds.lesson}, ${runIds.artifact})
    order by run_id, created_at, id
  `;
  const expectedModels = [
    [runIds.course, COURSE_MODEL],
    [runIds.lesson, LESSON_MODEL],
    [runIds.artifact, ARTIFACT_MODEL],
  ] as const;
  for (const [runId, expectedModel] of expectedModels) {
    const runRows = rows.filter(row => row.run_id === runId);
    assert.ok(runRows.length > 0, `No AI usage was stored for workflow ${runId}.`);
    const matchingRows = runRows.filter(
      row => row.provider === 'codex' && row.model === expectedModel
    );
    assert.ok(
      matchingRows.length > 0,
      `Workflow ${runId} did not store Codex usage for ${expectedModel}.`
    );
    assert.ok(
      matchingRows.some(row => (row.input_tokens ?? 0) > 0 && (row.output_tokens ?? 0) > 0),
      `Workflow ${runId} did not store positive Codex input and output usage.`
    );
    for (const row of runRows) {
      const tokenCounts = [
        row.input_tokens,
        row.output_tokens,
        row.reasoning_tokens,
        row.cache_read_tokens,
        row.cache_write_tokens,
      ];
      assert.ok(
        tokenCounts.every(value => value === null || (Number.isInteger(value) && value >= 0)),
        `Workflow ${runId} stored an invalid token count.`
      );
    }
  }
};

const assertWorkflowDatabaseIsEmpty = async (sql: SQL): Promise<void> => {
  const [row] = await sql<WorkflowDatabaseOccupancyRow[]>`
    select
      (select count(*)::integer from public.workflow_runs) as run_count,
      (select count(*)::integer from public.project_asset_deletions) as deletion_count
  `;
  if (row?.run_count !== 0 || row?.deletion_count !== 0) {
    throw new Error('The selected database must not contain workflow runtime data.');
  }
};

const runCourse = async (baseUrl: string, projectId: string, timeoutMs: number) => {
  const { job, runId } = await runWorkflow({
    baseUrl,
    body: {
      assessmentHistory: [
        {
          role: 'user',
          text: 'Crea un corso breve sui fondamenti dei sistemi distribuiti: un modulo e otto lezioni.',
        },
      ],
      mode: 'learn',
      projectId,
      requestKey: randomUUID(),
    },
    label: 'course',
    startPath: '/api/course-workflows/courses',
    statusPath: runId => `/api/course-workflows/runs/${runId}`,
    timeoutMs,
  });
  const sectionId = job.result?.firstSectionId;
  if (typeof sectionId !== 'string') {
    throw new TypeError('Course generation did not return its first lesson identifier.');
  }
  return { runId, sectionId };
};

const runLesson = async (
  baseUrl: string,
  projectId: string,
  sectionId: string,
  timeoutMs: number
) => {
  const { job, runId } = await runWorkflow({
    baseUrl,
    body: { forceRegenerate: false, projectId, requestKey: randomUUID(), sectionId },
    label: 'lesson',
    startPath: '/api/lesson-workflows/lessons',
    statusPath: workflowRunId => `/api/lesson-workflows/runs/${workflowRunId}`,
    timeoutMs,
  });
  const content = job.result?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Lesson generation returned empty content.');
  }
  return { content, runId };
};

const runArtifact = async ({
  baseUrl,
  lessonMarkdown,
  projectId,
  section,
  sectionId,
  timeoutMs,
}: {
  baseUrl: string;
  lessonMarkdown: string;
  projectId: string;
  section: LearningPlanNodeSnapshot;
  sectionId: string;
  timeoutMs: number;
}): Promise<string> => {
  const { job, runId } = await runWorkflow({
    baseUrl,
    body: {
      lessonMarkdown,
      projectId,
      requestedVisualKind: 'svg',
      requestKey: randomUUID(),
      requestText:
        'Crea un diagramma didattico chiaro che distingua eventi locali, messaggi e assenza di orologio globale.',
      sectionDescription: typeof section.description === 'string' ? section.description : '',
      sectionId,
      sectionTitle: typeof section.title === 'string' ? section.title : 'Lezione',
    },
    label: 'artifact',
    startPath: '/api/artifact-drafts',
    statusPath: workflowRunId => `/api/artifact-drafts/runs/${workflowRunId}`,
    timeoutMs,
  });
  const visual = job.result?.visual;
  assert.ok(isRecord(visual));
  const render = visual.render;
  assert.ok(isRecord(render));
  assert.equal(render.kind, 'svg');
  assert.ok(typeof render.code === 'string' && render.code.trim().length > 0);
  return runId;
};

const runProviderScenario = async ({
  baseUrl,
  projectId,
  projectStore,
  sql,
  timeoutMs,
  userId,
}: {
  baseUrl: string;
  projectId: string;
  projectStore: PostgresProjectStore;
  sql: SQL;
  timeoutMs: number;
  userId: string;
}): Promise<void> => {
  const course = await runCourse(baseUrl, projectId, timeoutMs);
  const lesson = await runLesson(baseUrl, projectId, course.sectionId, timeoutMs);
  const savedProject = await projectStore.loadProject(userId, projectId);
  const section = savedProject ? findProjectLessonSection(savedProject, course.sectionId) : null;
  assert.ok(section);
  const artifactRunId = await runArtifact({
    baseUrl,
    lessonMarkdown: lesson.content,
    projectId,
    section,
    sectionId: course.sectionId,
    timeoutMs,
  });
  await assertStoredModels(sql, {
    artifact: artifactRunId,
    course: course.runId,
    lesson: lesson.runId,
  });
  await assertStoredAiUsage(sql, {
    artifact: artifactRunId,
    course: course.runId,
    lesson: lesson.runId,
  });
};

const runRealProviderFlow = async (): Promise<void> => {
  if (process.env.RUN_REAL_WORKFLOW_PROVIDER_TESTS !== COST_ACKNOWLEDGEMENT) {
    throw new Error(
      `Set RUN_REAL_WORKFLOW_PROVIDER_TESTS=${COST_ACKNOWLEDGEMENT} to acknowledge provider costs.`
    );
  }
  const databaseUrl = requireLocalDatabaseUrl();
  const runTimeoutMs = readPositiveInteger(
    process.env.REAL_WORKFLOW_PROVIDER_TIMEOUT_MS,
    DEFAULT_RUN_TIMEOUT_MS
  );
  const stepConcurrency = Math.min(
    readPositiveInteger(process.env.REAL_WORKFLOW_PROVIDER_CONCURRENCY, DEFAULT_STEP_CONCURRENCY),
    MAX_STEP_CONCURRENCY
  );
  const userId = randomUUID();
  const projectId = `real-provider-${randomUUID()}`;
  const objectStorage = createMemoryStorage();
  const sql = new SQL(databaseUrl, { max: SQL_CONNECTION_LIMIT });
  const projectStore = new PostgresProjectStore(databaseUrl);
  let runtime: WorkflowRuntimeComposition | undefined;
  let server: Server | undefined;

  process.env.AUTH_MODE = 'local-bypass';
  process.env.CODEX_APP_SERVER_ENABLED = 'true';
  process.env.DATABASE_URL = databaseUrl;
  process.env.LOCAL_AUTH_BYPASS = 'true';
  process.env.LOCAL_DEV_PROFILE = 'true';
  process.env.LOCAL_USER_ID = userId;
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.WORKFLOW_RUNTIME_STEP_CONCURRENCY = String(stepConcurrency);
  configureEconomicalCodexModels();

  try {
    await assertWorkflowDatabaseIsEmpty(sql);
    await sql`
      insert into auth.users (id, aud, role, created_at, updated_at)
      values (${userId}, 'authenticated', 'authenticated', now(), now())
    `;
    const timestamp = new Date().toISOString();
    const snapshot: ProjectSnapshot = {
      createdAt: timestamp,
      id: projectId,
      isLearnMode: true,
      lastOpenedAt: timestamp,
      learningPlan: null,
      source: null,
      sourceKind: 'learn-mode',
      state: 'PLANNING',
      syllabus: [],
      title: 'Test provider reali',
      updatedAt: timestamp,
      userProfile: {
        context: 'Studio autonomo con esempi concreti',
        experienceLevel: 'base',
        goals: 'Comprendere i concetti fondamentali dei sistemi distribuiti',
        language: 'Italiano',
        learningStyle: 'spiegazioni progressive ed esempi',
        topic: 'Fondamenti dei sistemi distribuiti',
      },
      version: '4.1',
    };
    await projectStore.saveProject(userId, snapshot);
    setProjectStoreForTesting(projectStore);

    runtime = createWorkflowRuntimeComposition({ projectAssetStorage: objectStorage });
    const app = createApp({
      artifactDraftApi: runtime.artifactDraftApi,
      courseGenerationApi: runtime.courseGenerationApi,
      lessonGenerationApi: runtime.lessonGenerationApi,
      lessonVisualRetryStarter: runtime.lessonVisualRetryStarter,
      projectAssetReader: runtime.projectAssetReader,
      workflowRuntimeApi: runtime.api,
    });
    await runtime.start();
    server = await listen(app);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to resolve the temporary backend address.');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await runProviderScenario({
      baseUrl,
      projectId,
      projectStore,
      sql,
      timeoutMs: runTimeoutMs,
      userId,
    });
    console.log('[real-provider] course, lesson and artifact completed through durable routes.');
  } finally {
    if (server) {
      await closeServer(server).catch(error => reportCleanupFailure('HTTP server close', error));
    }
    if (runtime) await runtime.close().catch(error => reportCleanupFailure('runtime close', error));
    await closeManagedCodexAccountClient().catch(error =>
      reportCleanupFailure('Codex close', error)
    );
    setProjectStoreForTesting(null);
    await projectStore.close().catch(error => reportCleanupFailure('project store close', error));
    await sql`delete from public.project_assets where user_id = ${userId}`.catch(error =>
      reportCleanupFailure('asset metadata cleanup', error)
    );
    await sql`delete from auth.users where id = ${userId}`.catch(error =>
      reportCleanupFailure('user cleanup', error)
    );
    await sql
      .close({ timeout: SQL_CLOSE_TIMEOUT_SECONDS })
      .catch(error => reportCleanupFailure('SQL close', error));
  }
};

const dryRun = (): void => {
  const config = configureEconomicalCodexModels();
  console.log(
    JSON.stringify(
      {
        artifact: resolveLessonVisualModelConfig(config).artifact,
        course: {
          ...resolveTextModelConfig(config, 'course'),
          serviceTier: resolveCodexServiceTierForSlot(config, 'course') ?? 'normal',
        },
        database: 'loopback-only',
        lesson: {
          ...resolveTextModelConfig(config, 'lesson'),
          serviceTier: resolveCodexServiceTierForSlot(config, 'lesson') ?? 'normal',
        },
        mode: 'dry-run',
        providerCalls: 0,
      },
      null,
      2
    )
  );
};

const args = new Set(Bun.argv.slice(2));
if (args.has('--dry-run')) {
  dryRun();
} else if (args.has('--run')) {
  await runRealProviderFlow();
} else {
  throw new Error('Choose --dry-run or --run explicitly. No provider request was made.');
}
