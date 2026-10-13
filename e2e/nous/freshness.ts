import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as z from 'zod';
import type { GlobalModelConfig } from '../../apps/backend/src/config/modelConfig';
import type { PostgresProjectStore } from '../../apps/backend/src/projects/postgresProjectStore';
import { findProjectLessonSection } from '../../apps/backend/src/projects/projectLesson';
import { LessonGenerationWorkflowResultSchema } from '../../apps/backend/src/workflows/lessonGenerationWorkflowContract';
import { canonicalJson } from '../../apps/backend/src/workflows/schemaFingerprint';
import { pollWorkflow } from '../../apps/web/services/openrouter/workflowClientTransport';
import type { Story, Viewport } from '../../packages/playtest/src/types';
import type {
  LessonWorkflowSnapshot,
  LessonWorkflowWarning,
} from '../../packages/shared-types/lessonWorkflowContract';
import { withRunCleanup } from '../../scripts/run-evidence';
import { BACKEND_URL, dataRoot, type StackStatus } from './stack';

export interface FreshnessEvidence {
  userId: string;
  storyId: string;
  viewport: Viewport;
  requestKey: string;
  workflowId: string | null;
  workflowStatus?: LessonWorkflowSnapshot['status'];
  projectId: string;
  sectionId: string;
  appRevision?: { commitSha: string; dirty: boolean };
  generationSettings?: GlobalModelConfig;
  outcome: 'blocked' | 'current';
  errorCode?: string;
  warnings: LessonWorkflowWarning[];
  startedAt: string;
  durationMs: number;
  persistedRevision?: number;
  contentSha256?: string;
  visuals?: { generatedVisuals: unknown[]; imageRefs: unknown[]; visualPlanningDecision?: unknown };
}
const writer = new AsyncLocalStorage<(evidence: FreshnessEvidence) => Promise<void>>();
export function withFreshnessEvidence<T>(
  record: (evidence: FreshnessEvidence) => Promise<void>,
  operation: () => Promise<T>
): Promise<T> {
  return writer.run(record, operation);
}

class FreshnessBlockedError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions
  ) {
    super(`Current lesson preparation blocked (${code}). See the generation evidence.`, options);
    this.name = 'FreshnessBlockedError';
  }
}

const jobSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  sectionId: z.string().min(1),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  retrying: z.boolean(),
  stage: z.enum(['sources', 'structure', 'drafting', 'quiz', 'verification']),
  errorCode: z.string().optional(),
  failure: z
    .object({ code: z.string(), kind: z.enum(['corrective', 'operational', 'permanent']) })
    .optional(),
  result: LessonGenerationWorkflowResultSchema.optional(),
});
async function readJob(
  response: Response,
  requireCreated = false
): Promise<LessonWorkflowSnapshot> {
  const body = await response.json();
  if (!response.ok || body.success !== true)
    throw new FreshnessBlockedError(
      typeof body.code === 'string' ? body.code : 'lesson_workflow_request_failed'
    );
  if (requireCreated && body.created !== true)
    throw new FreshnessBlockedError('lesson_generation_not_created');
  return jobSchema.parse(body.job);
}

type RegenerationInput = {
  story: Story;
  viewport: Viewport;
  isolated: StackStatus;
  credentials: { email: string; password: string };
  userId: string;
  projectId: string;
  sectionId: string;
  store: Pick<PostgresProjectStore, 'loadProjectWithRevision' | 'patchProject'>;
};

function completedResult(job: LessonWorkflowSnapshot, evidence: FreshnessEvidence) {
  if (job.status !== 'completed')
    throw new FreshnessBlockedError(
      job.errorCode ?? job.failure?.code ?? 'lesson_generation_failed'
    );
  const result = job.result;
  evidence.warnings = result?.warnings ?? [];
  if (
    !result ||
    result.alreadyCompleted ||
    !result.content.trim() ||
    !result.contentBlocks.length ||
    result.projectId !== evidence.projectId ||
    result.sectionId !== evidence.sectionId
  )
    throw new FreshnessBlockedError('lesson_generation_output_incomplete');
  return result;
}

async function verifiedPersistence(
  input: RegenerationInput,
  previousRevision: number,
  job: LessonWorkflowSnapshot,
  result: NonNullable<LessonWorkflowSnapshot['result']>
) {
  const persisted = await input.store.loadProjectWithRevision(input.userId, input.projectId);
  const lesson = persisted && findProjectLessonSection(persisted.snapshot, input.sectionId);
  if (
    !persisted ||
    lesson?.lastGenerationRunId !== job.id ||
    persisted.revision <= previousRevision ||
    lesson.content !== result.content ||
    !isDeepStrictEqual(lesson.contentBlocks, result.contentBlocks) ||
    !isDeepStrictEqual(lesson.generatedVisuals ?? [], result.generatedVisuals) ||
    !isDeepStrictEqual(lesson.imageRefs ?? [], result.imageRefs) ||
    !isDeepStrictEqual(lesson.quiz ?? [], result.quiz) ||
    !isDeepStrictEqual(lesson.learningAids ?? [], result.learningAids) ||
    !isDeepStrictEqual(lesson.visualPlanningDecision, result.visualPlanningDecision)
  )
    throw new FreshnessBlockedError('lesson_generation_persistence_unverified');
  return persisted;
}

async function generate(
  input: RegenerationInput,
  evidence: FreshnessEvidence
): Promise<FreshnessEvidence> {
  const configuration = JSON.parse(
    await readFile(join(dataRoot(), 'stack', 'generation-settings.json'), 'utf8')
  );
  evidence.appRevision = configuration.appRevision;
  evidence.generationSettings = configuration.settings;
  const before = await input.store.loadProjectWithRevision(input.userId, input.projectId);
  if (!before || !findProjectLessonSection(before.snapshot, input.sectionId))
    throw new FreshnessBlockedError('lesson_generation_target_missing');
  const login = await fetch(`${input.isolated.API_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: input.isolated.ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(input.credentials),
  });
  if (!login.ok) throw new FreshnessBlockedError('lesson_generation_auth_failed');
  const { access_token: token } = z
    .object({ access_token: z.string().min(1) })
    .parse(await login.json());
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const initial = await readJob(
    await fetch(`${BACKEND_URL}/api/lesson-workflows/lessons`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        forceRegenerate: true,
        projectId: input.projectId,
        sectionId: input.sectionId,
        requestKey: evidence.requestKey,
      }),
    }),
    true
  );
  evidence.workflowId = initial.id;
  if (initial.projectId !== input.projectId || initial.sectionId !== input.sectionId)
    throw new FreshnessBlockedError('lesson_generation_identity_mismatch');
  const job = await pollWorkflow({
    initialState: initial,
    onState: job => {
      evidence.workflowStatus = job.status;
    },
    isTerminal: job => job.status === 'completed' || job.status === 'failed',
    readState: async job =>
      readJob(
        await fetch(`${BACKEND_URL}/api/lesson-workflows/runs/${encodeURIComponent(job.id)}`, {
          headers,
          cache: 'no-store',
        })
      ),
  });
  evidence.workflowStatus = job.status;
  if (
    job.id !== initial.id ||
    job.projectId !== input.projectId ||
    job.sectionId !== input.sectionId
  )
    throw new FreshnessBlockedError('lesson_generation_identity_mismatch');
  const result = completedResult(job, evidence);
  const persisted = await verifiedPersistence(input, before.revision, job, result);
  // Opening the imported course starts on the selected fresh lesson.
  await input.store.patchProject(
    input.userId,
    input.projectId,
    { activeSectionId: input.sectionId },
    { expectedRevision: persisted.revision }
  );
  evidence.persistedRevision = persisted.revision;
  evidence.contentSha256 = createHash('sha256')
    .update(canonicalJson(result.contentBlocks))
    .digest('hex');
  evidence.visuals = {
    generatedVisuals: result.generatedVisuals,
    imageRefs: result.imageRefs,
    ...(result.visualPlanningDecision === undefined
      ? {}
      : { visualPlanningDecision: result.visualPlanningDecision }),
  };
  evidence.outcome = 'current';
  return evidence;
}

/** Force the product workflow, then check its durable identity and exact persisted output. */
export async function regenerateLesson(input: RegenerationInput): Promise<FreshnessEvidence> {
  const started = performance.now();
  const evidence: FreshnessEvidence = {
    userId: input.userId,
    storyId: input.story.id,
    viewport: input.viewport,
    requestKey: crypto.randomUUID(),
    workflowId: null,
    projectId: input.projectId,
    sectionId: input.sectionId,
    outcome: 'blocked',
    warnings: [],
    startedAt: new Date().toISOString(),
    durationMs: 0,
  };
  return withRunCleanup(
    async () => {
      try {
        return await generate(input, evidence);
      } catch (error) {
        evidence.errorCode =
          error instanceof FreshnessBlockedError
            ? error.code
            : 'lesson_generation_preparation_failed';
        throw error instanceof FreshnessBlockedError
          ? error
          : new FreshnessBlockedError(evidence.errorCode, { cause: error });
      }
    },
    async () => {
      evidence.durationMs = performance.now() - started;
      await writer.getStore()?.(evidence);
    }
  );
}
