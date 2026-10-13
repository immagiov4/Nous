import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';

import { SQL } from 'bun';
import { loadCurrentModelPrices } from '../apps/backend/src/account/accountUsage.js';
import { requireOpenRouterApiKey } from '../apps/backend/src/config/chatConfig.js';
import {
  type GlobalModelConfig,
  resolveTextModelConfig,
} from '../apps/backend/src/config/modelConfig.js';
import { createApp } from '../apps/backend/src/index.js';
import { PostgresProjectStore } from '../apps/backend/src/projects/postgresProjectStore.js';
import { findProjectLessonSection } from '../apps/backend/src/projects/projectLesson.js';
import { verifyProjectSourceBytes } from '../apps/backend/src/projects/projectSourceStorage.js';
import { setProjectStoreForTesting } from '../apps/backend/src/projects/projectStore.js';
import type {
  LearningPlanNodeSnapshot,
  ProjectSnapshot,
} from '../apps/backend/src/projects/types.js';
import {
  CODEX_IMAGE_TURN_SETTINGS,
  closeManagedCodexAccountClient,
} from '../apps/backend/src/services/codexAppServer.js';
import { LESSON_EVIDENCE_REASONING_EFFORT } from '../apps/backend/src/services/lessonEvidenceVerification.js';
import { LESSON_REVIEW_REASONING_EFFORT } from '../apps/backend/src/services/lessonGenerationVerification.js';
import { resolveLessonVisualModelConfig } from '../apps/backend/src/services/lessonVisualModelConfig.js';
import { PostgresWorkflowStore } from '../apps/backend/src/workflows/persistence/postgresWorkflowStore.js';
import {
  createWorkflowRuntimeComposition,
  type WorkflowRuntimeComposition,
} from '../apps/backend/src/workflows/runtime/workflowRuntimeComposition.js';
import type { WorkflowAiUsageRecord } from '../apps/backend/src/workflows/workflowAiMetering.js';
import type { WorkflowPublicRunState } from '../apps/backend/src/workflows/workflowReadModel.js';
import { LessonSceneSchema } from '../packages/shared-types/lessonScene.js';
import {
  configureWorkflowProviderModels,
  parseWorkflowProviderArgs,
  validateOpenRouterWorkflowModels,
  type WorkflowCase,
} from './real-workflow-provider-config.js';
import {
  type RunEvidenceRecorder,
  resolveRunEvidenceTextSlot,
  withRunCleanup,
  withRunEvidence,
} from './run-evidence.js';

const COST_ACKNOWLEDGEMENT = 'I_ACCEPT_REAL_PROVIDER_COSTS';
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

type WorkflowTrace = Pick<WorkflowPublicRunState, 'nodes' | 'run'>;
type WorkflowGenerationSlot = 'course' | 'lesson' | 'artifact';

interface StoredWorkflowConfigRow {
  readonly resolved_config: unknown;
}

interface WorkflowDatabaseOccupancyRow {
  readonly deletion_count: number;
  readonly run_count: number;
  readonly project_count: number;
}

interface WorkflowAiUsageRow {
  readonly id: string;
  readonly node_instance_id: string;
  readonly attempt_number: number;
  readonly provider_cost: string | null;
  readonly reported_after_interruption: boolean;
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

const createMemoryStorage = () => {
  const objects = new Map<string, Uint8Array>();
  return {
    async delete(path: string) {
      objects.delete(path);
    },
    async download(path: string, expected: { byteSize: number; hash: string }) {
      const bytes = objects.get(path);
      if (!bytes) throw new Error(`Temporary workflow object is missing: ${path}`);
      verifyProjectSourceBytes(bytes, expected);
      return bytes.slice();
    },
    async downloadRange(
      path: string,
      expectedByteSize: number,
      start: number,
      endExclusive: number
    ) {
      const bytes = objects.get(path);
      assert.ok(bytes, `Temporary workflow object is missing: ${path}`);
      assert.equal(bytes.byteLength, expectedByteSize);
      return bytes.slice(start, endExclusive);
    },
    async upload(path: string, bytes: Uint8Array) {
      objects.set(path, bytes.slice());
    },
  };
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
  timeoutMs,
}: {
  baseUrl: string;
  label: string;
  path: string;
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
      if (job.status !== 'completed') {
        throw Object.assign(
          new Error(`${label} failed with ${job.errorCode || 'an unknown workflow error'}.`),
          job.errorCode ? { code: job.errorCode } : {}
        );
      }
      return job;
    }
    await Bun.sleep(DEFAULT_POLL_INTERVAL_MS);
  }
  throw new Error(`${label} did not finish within ${timeoutMs} ms.`);
};

const runWorkflow = async ({
  evidence,
  baseUrl,
  body,
  label,
  startPath,
  statusPath,
  timeoutMs,
}: {
  evidence: RunEvidenceRecorder;
  baseUrl: string;
  body: Record<string, unknown>;
  label: string;
  startPath: string;
  statusPath: (runId: string) => string;
  timeoutMs: number;
}): Promise<{ job: WorkflowJob; runId: string }> => {
  let runId: string | undefined;
  return withRunCleanup(
    async () => {
      const result = await evidence.measure({ name: label, kind: 'workflow' }, async () => {
        const response = await requestJson(baseUrl, startPath, body);
        if (response.status !== 200 && response.status !== 202) {
          throw new Error(`${label} start route returned ${response.status}.`);
        }
        const queued = requireJob(response.body, startPath);
        runId = queued.id;
        evidence.manifest.workflows.push({ name: label, runId });
        return {
          job: await waitForWorkflow({ baseUrl, label, path: statusPath(runId), timeoutMs }),
          runId,
        };
      });
      await evidence.writeJson(`${label}-result.json`, result.job);
      return result;
    },
    async () => {
      if (runId) {
        const workflow = evidence.manifest.workflows.find(entry => entry.runId === runId);
        assert.ok(workflow);
        const trace = await loadTrace(baseUrl, runId);
        await evidence.recordWorkflowState(workflow, trace);
      }
    }
  );
};

const assertStoredModels = async (
  sql: SQL,
  expected: readonly { runId: string; slot: WorkflowGenerationSlot }[],
  config: GlobalModelConfig
): Promise<void> => {
  for (const { runId, slot } of expected) {
    const [row] = await sql<StoredWorkflowConfigRow[]>`
      select resolved_config from public.workflow_runs where id = ${runId}
    `;
    assert.ok(row && isRecord(row.resolved_config));
    const stored = row.resolved_config;
    if (slot !== 'artifact') {
      assert.ok(isRecord(stored.models));
      assert.equal(stored.models.aiProvider, config.aiProvider);
      assert.deepEqual(
        resolveTextModelConfig(stored.models as unknown as GlobalModelConfig, slot),
        resolveTextModelConfig(config, slot)
      );
      assert.deepEqual(stored.models.codexFastModelSlots, config.codexFastModelSlots);
    } else {
      assert.ok(isRecord(stored.visual));
      assert.deepEqual(stored.visual.artifact, resolveLessonVisualModelConfig(config).artifact);
    }
  }
};

const readStoredAiUsage = async (sql: SQL, runId: string): Promise<WorkflowAiUsageRecord[]> => {
  const rows = await sql<WorkflowAiUsageRow[]>`
    select
      id, node_instance_id, attempt_number, provider_cost, reported_after_interruption,
      run_id, provider, model, input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens
    from public.workflow_ai_usage
    where run_id = ${runId}
    order by run_id, created_at, id
  `;
  return rows.map(row => ({
    id: row.id,
    runId: row.run_id,
    nodeInstanceId: row.node_instance_id,
    attemptNumber: row.attempt_number,
    provider: row.provider,
    model: row.model,
    ...(row.input_tokens === null ? {} : { inputTokens: row.input_tokens }),
    ...(row.output_tokens === null ? {} : { outputTokens: row.output_tokens }),
    ...(row.reasoning_tokens === null ? {} : { reasoningTokens: row.reasoning_tokens }),
    ...(row.cache_read_tokens === null ? {} : { cacheReadTokens: row.cache_read_tokens }),
    ...(row.cache_write_tokens === null ? {} : { cacheWriteTokens: row.cache_write_tokens }),
    ...(row.provider_cost === null ? {} : { providerCost: Number(row.provider_cost) }),
    ...(row.reported_after_interruption ? { reportedAfterInterruption: true as const } : {}),
  }));
};

const assertStoredAiUsage = (
  rows: readonly WorkflowAiUsageRecord[],
  expected: readonly { runId: string; slot: WorkflowGenerationSlot }[],
  config: GlobalModelConfig
): void => {
  for (const { runId, slot } of expected) {
    const runRows = rows.filter(row => row.runId === runId);
    const expectedModel = resolveTextModelConfig(config, slot).model;
    const matchingRows = runRows.filter(
      row => row.provider === config.aiProvider && row.model === expectedModel
    );
    assert.ok(
      matchingRows.some(row => (row.inputTokens ?? 0) > 0 && (row.outputTokens ?? 0) > 0),
      `Workflow ${runId} did not store positive ${config.aiProvider} usage for ${expectedModel}.`
    );
    for (const row of runRows) {
      const tokenCounts = [
        row.inputTokens,
        row.outputTokens,
        row.reasoningTokens,
        row.cacheReadTokens,
        row.cacheWriteTokens,
      ];
      assert.ok(
        tokenCounts.every(value => value === undefined || (Number.isInteger(value) && value >= 0)),
        `Workflow ${runId} stored an invalid token count.`
      );
    }
  }
};

const assertWorkflowDatabaseIsEmpty = async (sql: SQL): Promise<void> => {
  const [row] = await sql<WorkflowDatabaseOccupancyRow[]>`
    select
      (select count(*)::integer from public.workflow_runs) as run_count,
      (select count(*)::integer from public.project_asset_deletions) as deletion_count,
      (select count(*)::integer from public.projects) as project_count
  `;
  if (row?.run_count !== 0 || row?.deletion_count !== 0 || row?.project_count !== 0) {
    throw new Error(
      'The selected disposable database must have empty workflow, project and asset-deletion tables.'
    );
  }
};

const runCourse = async (
  evidence: RunEvidenceRecorder,
  baseUrl: string,
  projectId: string,
  timeoutMs: number,
  scenarioCase: WorkflowCase
) => {
  const { job, runId } = await runWorkflow({
    evidence,
    baseUrl,
    body: {
      assessmentHistory: [
        {
          role: 'user',
          text:
            scenarioCase === 'simple'
              ? 'Crea un corso breve sui fondamenti dei sistemi distribuiti: un modulo e otto lezioni.'
              : 'Crea un corso dal PDF fornito: esattamente due lezioni, una su eventi e messaggi, una su ordinamento causale. Usa soltanto il materiale allegato.',
        },
      ],
      mode: scenarioCase === 'simple' ? 'learn' : 'document',
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
  evidence: RunEvidenceRecorder,
  {
    baseUrl,
    projectId,
    sectionId,
    timeoutMs,
    label,
  }: {
    baseUrl: string;
    projectId: string;
    sectionId: string;
    timeoutMs: number;
    label: string;
  }
) => {
  const { job, runId } = await runWorkflow({
    evidence,
    baseUrl,
    body: { forceRegenerate: false, projectId, requestKey: randomUUID(), sectionId },
    label,
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
  evidence,
  baseUrl,
  lessonMarkdown,
  projectId,
  section,
  sectionId,
  timeoutMs,
  label,
}: {
  evidence: RunEvidenceRecorder;
  baseUrl: string;
  lessonMarkdown: string;
  projectId: string;
  section: LearningPlanNodeSnapshot;
  sectionId: string;
  timeoutMs: number;
  label: string;
}): Promise<string> => {
  const { job, runId } = await runWorkflow({
    evidence,
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
    label,
    startPath: '/api/artifact-drafts',
    statusPath: workflowRunId => `/api/artifact-drafts/runs/${workflowRunId}`,
    timeoutMs,
  });
  const visual = job.result?.visual;
  assert.ok(isRecord(visual));
  const render = visual.render;
  assert.ok(isRecord(render));
  assert.equal(render.kind, 'scene');
  LessonSceneSchema.parse(render.scene);
  return runId;
};

const runSpeech = async (evidence: RunEvidenceRecorder, baseUrl: string): Promise<void> => {
  const input = {
    text: 'In un sistema distribuito, ogni processo osserva eventi locali e scambia messaggi con gli altri processi.',
  };
  await evidence.writeJson('tts-request.json', input);
  await evidence.measure({ name: 'tts', kind: 'call' }, async () => {
    const response = await fetch(new URL('/api/tts', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200, 'The TTS route must return audio.');
    const contentType = response.headers.get('content-type');
    assert.ok(contentType?.startsWith('audio/'), 'The TTS response must have an audio media type.');
    const audio = new Uint8Array(await response.arrayBuffer());
    assert.ok(audio.byteLength > 0, 'The TTS response must contain audio bytes.');
    await evidence.writeEvidence('tts-audio.bin', audio);
    await evidence.writeJson('tts-result.json', {
      contentType,
      byteLength: audio.byteLength,
      generationId: response.headers.get('x-generation-id'),
      usage: 'The TTS route exposes no token usage or provider cost.',
    });
  });
};

const runProviderScenario = async ({
  evidence,
  baseUrl,
  projectId,
  projectStore,
  sql,
  timeoutMs,
  userId,
  config,
  scenarioCase,
}: {
  evidence: RunEvidenceRecorder;
  baseUrl: string;
  projectId: string;
  projectStore: PostgresProjectStore;
  sql: SQL;
  timeoutMs: number;
  userId: string;
  config: GlobalModelConfig;
  scenarioCase: WorkflowCase;
}): Promise<void> => {
  const course = await runCourse(evidence, baseUrl, projectId, timeoutMs, scenarioCase);
  const plan = await projectStore.loadProject(userId, projectId);
  assert.ok(plan);
  const sections =
    plan.learningPlan?.modules?.flatMap(module => module.children ?? []) ??
    plan.learningPlan?.sections ??
    [];
  const lessons = sections.filter(section => section.kind !== 'exercise');
  if (scenarioCase === 'realistic')
    assert.equal(lessons.length, 2, 'The PDF course must contain two lessons.');
  const sectionIds =
    scenarioCase === 'simple'
      ? [course.sectionId]
      : lessons.map(section => {
          assert.equal(typeof section.id, 'string');
          return section.id as string;
        });
  const expected: { runId: string; slot: WorkflowGenerationSlot }[] = [
    { runId: course.runId, slot: 'course' },
  ];
  for (const [index, sectionId] of sectionIds.entries()) {
    const suffix = scenarioCase === 'simple' ? '' : `-${index + 1}`;
    const lesson = await runLesson(evidence, {
      baseUrl,
      projectId,
      sectionId,
      timeoutMs,
      label: `lesson${suffix}`,
    });
    const savedProject = await projectStore.loadProject(userId, projectId);
    const section = savedProject ? findProjectLessonSection(savedProject, sectionId) : null;
    assert.ok(section);
    const artifactRunId = await runArtifact({
      evidence,
      baseUrl,
      lessonMarkdown: lesson.content,
      projectId,
      section,
      sectionId,
      timeoutMs,
      label: `artifact${suffix}`,
    });
    expected.push(
      { runId: lesson.runId, slot: 'lesson' },
      { runId: artifactRunId, slot: 'artifact' }
    );
  }
  await assertStoredModels(sql, expected, config);
  const usage = (
    await Promise.all(expected.map(({ runId }) => readStoredAiUsage(sql, runId)))
  ).flat();
  assertStoredAiUsage(usage, expected, config);
  if (config.aiProvider === 'openrouter') await runSpeech(evidence, baseUrl);
};

const runRealProviderFlow = async (
  evidence: RunEvidenceRecorder,
  config: GlobalModelConfig,
  scenarioCase: WorkflowCase
): Promise<void> => {
  if (process.env.RUN_REAL_WORKFLOW_PROVIDER_TESTS !== COST_ACKNOWLEDGEMENT) {
    throw new Error(
      `Set RUN_REAL_WORKFLOW_PROVIDER_TESTS=${COST_ACKNOWLEDGEMENT} to acknowledge provider costs.`
    );
  }
  if (config.aiProvider === 'openrouter') requireOpenRouterApiKey();
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
  const projectStore = new PostgresProjectStore(databaseUrl, undefined, objectStorage);
  const evidenceStore = new PostgresWorkflowStore({
    databaseUrl,
    projectAssetStorage: objectStorage,
  });
  let runtime: WorkflowRuntimeComposition | undefined;
  let server: Server | undefined;

  process.env.AUTH_MODE = 'local-bypass';
  if (config.aiProvider === 'codex') process.env.CODEX_APP_SERVER_ENABLED = 'true';
  process.env.DATABASE_URL = databaseUrl;
  process.env.LOCAL_AUTH_BYPASS = 'true';
  process.env.LOCAL_DEV_PROFILE = 'true';
  process.env.LOCAL_USER_ID = userId;
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.WORKFLOW_RUNTIME_STEP_CONCURRENCY = String(stepConcurrency);

  await withRunCleanup(
    async () => {
      await assertWorkflowDatabaseIsEmpty(sql);
      await sql`
      insert into auth.users (id, aud, role, created_at, updated_at)
      values (${userId}, 'authenticated', 'authenticated', now(), now())
    `;
      const timestamp = new Date().toISOString();
      const userProfile = {
        context: 'Studio autonomo con esempi concreti',
        experienceLevel: 'base',
        goals: 'Comprendere i concetti fondamentali dei sistemi distribuiti',
        language: 'Italiano',
        learningStyle: 'spiegazioni progressive ed esempi',
        topic: 'Fondamenti dei sistemi distribuiti',
      };
      const snapshot: ProjectSnapshot = {
        createdAt: timestamp,
        id: projectId,
        isLearnMode: scenarioCase === 'simple',
        lastOpenedAt: timestamp,
        learningPlan: null,
        source:
          scenarioCase === 'simple'
            ? null
            : {
                kind: 'pdf',
                file: {
                  name: 'distributed-systems.pdf',
                  mimeType: 'application/pdf',
                  data: (
                    await readFile(
                      new URL(
                        '../apps/backend/tests/fixtures/distributed-systems.pdf',
                        import.meta.url
                      )
                    )
                  ).toString('base64'),
                },
              },
        sourceKind: scenarioCase === 'simple' ? 'learn-mode' : 'document',
        state: 'PLANNING',
        syllabus: [],
        title: 'Test provider reali',
        updatedAt: timestamp,
        userProfile,
        version: '4.1',
      };
      await evidence.writeJson('project-input.json', snapshot);
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
        evidence,
        baseUrl,
        projectId,
        projectStore,
        sql,
        timeoutMs: runTimeoutMs,
        userId,
        config,
        scenarioCase,
      });
      console.log(
        `[real-provider] ${config.aiProvider}/${scenarioCase}: course, lessons and artifacts completed through durable routes${config.aiProvider === 'openrouter' ? '; TTS returned audio' : ''}.`
      );
    },
    async () => {
      const cleanupFailures: unknown[] = [];
      const reportCleanupFailure = (operation: string, error: unknown): void => {
        cleanupFailures.push(error);
        console.error(`[real-provider] ${operation} failed`, error);
      };
      if (server) {
        await closeServer(server).catch(error => reportCleanupFailure('HTTP server close', error));
      }
      if (runtime)
        await runtime.close().catch(error => reportCleanupFailure('runtime close', error));
      await closeManagedCodexAccountClient().catch(error =>
        reportCleanupFailure('Codex close', error)
      );
      try {
        for (const workflow of evidence.manifest.workflows) {
          const state = await evidenceStore.getRunState({ runId: workflow.runId, userId });
          assert.ok(state, `Missing final workflow state for ${workflow.runId}.`);
          await evidence.recordWorkflowState(workflow, state);
          evidence.manifest.aiUsage.push(...(await readStoredAiUsage(sql, workflow.runId)));
        }
      } catch (error) {
        reportCleanupFailure('final workflow evidence collection', error);
      } finally {
        setProjectStoreForTesting(null);
        await evidenceStore
          .close()
          .catch(error => reportCleanupFailure('evidence store close', error));
        await projectStore
          .close()
          .catch(error => reportCleanupFailure('project store close', error));
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
      if (cleanupFailures.length) {
        throw new AggregateError(cleanupFailures, 'Real workflow cleanup failed.');
      }
    }
  );
};

const resolvedSlots = (config: GlobalModelConfig) => {
  return {
    course: resolveRunEvidenceTextSlot(config, 'course'),
    research: resolveRunEvidenceTextSlot(config, 'research'),
    lesson: resolveRunEvidenceTextSlot(config, 'lesson'),
    lessonReview: resolveRunEvidenceTextSlot(config, 'lesson', LESSON_REVIEW_REASONING_EFFORT),
    lessonVerification: resolveRunEvidenceTextSlot(
      config,
      'lesson',
      LESSON_EVIDENCE_REASONING_EFFORT
    ),
    artifact: resolveRunEvidenceTextSlot(config, 'artifact'),
    artifactInteractive: resolveRunEvidenceTextSlot(config, 'artifactInteractive'),
    scene: resolveRunEvidenceTextSlot(config, 'scene'),
    sceneIcon: resolveRunEvidenceTextSlot(config, 'sceneIcon'),
    ...(config.aiProvider === 'openrouter'
      ? { tts: { model: config.ttsModel, serviceTier: 'normal' } }
      : {}),
    image: {
      model: resolveLessonVisualModelConfig(config).image.model,
      ...(config.aiProvider === 'codex' ? CODEX_IMAGE_TURN_SETTINGS : { serviceTier: 'normal' }),
    },
  };
};

const options = parseWorkflowProviderArgs(process.argv.slice(2));
const config = await configureWorkflowProviderModels(options.provider);
const slots = resolvedSlots(config);
const catalogue =
  options.provider === 'openrouter'
    ? {
        freeRequests: 1,
        checkedModelIds: validateOpenRouterWorkflowModels(
          Object.entries(slots)
            .filter(([name]) => name !== 'image' && name !== 'tts')
            .map(([, slot]) => slot.model),
          await loadCurrentModelPrices()
        ),
      }
    : { freeRequests: 0, checkedModelIds: [] };
if (options.dryRun) {
  console.log(
    JSON.stringify(
      {
        provider: options.provider,
        case: options.case,
        mode: 'dry-run',
        paidProviderCalls: 0,
        database: 'loopback-only, empty disposable database',
        catalogue,
        slots,
        flows:
          options.provider === 'openrouter'
            ? ['course', 'lesson', 'artifact', 'tts']
            : ['course', 'lesson', 'artifact'],
        lessonCount: options.case === 'simple' ? 1 : 2,
      },
      null,
      2
    )
  );
} else {
  await withRunEvidence(
    {
      scenario: 'workflow-providers',
      captureModelExchanges: true,
      provider: options.provider,
      case: options.case,
      slots,
    },
    async recorder => {
      console.log(`Real workflow evidence: ${recorder.directory}`);
      await recorder.writeJson('selection.json', { ...options, catalogue });
      await runRealProviderFlow(recorder, config, options.case);
    }
  );
}
