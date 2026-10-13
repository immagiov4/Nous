import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import postgres from 'postgres';
import * as z from 'zod';
import type { GlobalModelConfig } from '../../apps/backend/src/config/modelConfig';
import type { PostgresProjectStore } from '../../apps/backend/src/projects/postgresProjectStore';
import { createProjectAssetStorage } from '../../apps/backend/src/projects/projectAsset';
import { findProjectLessonSection } from '../../apps/backend/src/projects/projectLesson';
import { LESSON_GENERATION_WORKFLOW_ID } from '../../apps/backend/src/workflows/lessonGenerationStart';
import { LessonGenerationWorkflowResultSchema } from '../../apps/backend/src/workflows/lessonGenerationWorkflowContract';
import { PostgresWorkflowStore } from '../../apps/backend/src/workflows/persistence/postgresWorkflowStore';
import { canonicalJson } from '../../apps/backend/src/workflows/schemaFingerprint';
import {
  assertWorkflowPollResponse,
  isDefinitiveWorkflowStartRejection,
  pollWorkflow,
  readWorkflowPollJson,
  resolveWorkflowRequestByKey,
} from '../../apps/web/services/openrouter/workflowClientTransport';
import type { Story, Viewport } from '../../packages/playtest/src/types';
import type {
  LessonWorkflowSnapshot,
  LessonWorkflowWarning,
} from '../../packages/shared-types/lessonWorkflowContract';
import { withRunCleanup } from '../../scripts/run-evidence';
import {
  PREPARATION_TIMEOUT_CODE,
  PreparationDeadline,
  type PreparationStep,
} from './preparationDeadline';
import { BACKEND_URL, dataRoot, type StackStatus } from './stack';

export {
  FRESH_CONTENT_PREPARATION_TIMEOUT_MS,
  PREPARATION_TIMEOUT_CODE,
} from './preparationDeadline';

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
  cancellation?: { status: 'requested-unconfirmed' | 'confirmed' | 'failed'; errorCode?: string };
  warnings: LessonWorkflowWarning[];
  startedAt: string;
  durationMs: number;
  preparation?: {
    steps: PreparationStep[];
    possiblyLeakedResources: { accountId: string; projectId: string }[];
  };
  persistedRevision?: number;
  contentSha256?: string;
  visuals?: { generatedVisuals: unknown[]; imageRefs: unknown[]; visualPlanningDecision?: unknown };
}
type EvidenceScope = {
  record: (evidence: FreshnessEvidence, deadline: PreparationDeadline) => Promise<void>;
  records: Map<FreshnessEvidence, PreparationDeadline>;
  cancellation: AbortController;
  finalized: boolean;
};
const writer = new AsyncLocalStorage<EvidenceScope>();
export function withFreshnessEvidence<T>(
  record: (evidence: FreshnessEvidence, deadline: PreparationDeadline) => Promise<void>,
  operation: () => Promise<T>,
  refresh?: (
    evidence: FreshnessEvidence,
    deadline: PreparationDeadline,
    signal: AbortSignal
  ) => Promise<void>,
  finishRun?: (deadlines: PreparationDeadline[]) => Promise<void>
): Promise<T> {
  const scope: EvidenceScope = {
    record,
    records: new Map(),
    cancellation: new AbortController(),
    finalized: false,
  };
  return writer.run(scope, () =>
    withRunCleanup(operation, async () => {
      await finishRun?.([...scope.records.values()]);
      scope.finalized = true;
      scope.cancellation.abort();
      for (const [evidence, deadline] of scope.records) {
        if (deadline.signal.aborted) deadline.freeze();
        await deadline.settle(
          'final-generation-write',
          signal => refresh?.(structuredClone(evidence), deadline, signal) ?? Promise.resolve(),
          'write'
        );
        if (!deadline.signal.aborted) deadline.freeze();
      }
    })
  );
}

class FreshnessBlockedError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions
  ) {
    super(
      code === PREPARATION_TIMEOUT_CODE
        ? 'Current lesson preparation blocked: the generation deadline expired (lesson_generation_preparation_timeout). See the generation evidence.'
        : `Current lesson preparation blocked (${code}). See the generation evidence.`,
      options
    );
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
  if (requireCreated && !z.boolean().parse(body.created))
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
  deadline?: PreparationDeadline;
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
  evidence: FreshnessEvidence,
  context: { signal: AbortSignal; headers?: Record<string, string> }
): Promise<FreshnessEvidence> {
  const configuration = JSON.parse(
    await readFile(join(dataRoot(), 'stack', 'generation-settings.json'), 'utf8')
  );
  context.signal.throwIfAborted();
  evidence.appRevision = configuration.appRevision;
  evidence.generationSettings = configuration.settings;
  const before = await input.store.loadProjectWithRevision(input.userId, input.projectId);
  context.signal.throwIfAborted();
  if (!before || !findProjectLessonSection(before.snapshot, input.sectionId))
    throw new FreshnessBlockedError('lesson_generation_target_missing');
  const login = await fetch(`${input.isolated.API_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: input.isolated.ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(input.credentials),
    signal: context.signal,
  });
  if (!login.ok) throw new FreshnessBlockedError('lesson_generation_auth_failed');
  const { access_token: token } = z
    .object({ access_token: z.string().min(1) })
    .parse(await login.json());
  context.signal.throwIfAborted();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  context.headers = headers;
  let initial: LessonWorkflowSnapshot;
  let startResponse: Response | undefined;
  try {
    startResponse = await fetch(`${BACKEND_URL}/api/lesson-workflows/lessons`, {
      method: 'POST',
      headers,
      signal: context.signal,
      body: JSON.stringify({
        forceRegenerate: true,
        projectId: input.projectId,
        sectionId: input.sectionId,
        requestKey: evidence.requestKey,
      }),
    });
    initial = await readJob(startResponse, true);
  } catch (error) {
    context.signal.throwIfAborted();
    if (
      (error instanceof FreshnessBlockedError && error.code === 'lesson_generation_not_created') ||
      (startResponse && isDefinitiveWorkflowStartRejection(startResponse))
    )
      throw error;
    const recovered = await resolveWorkflowRequestByKey({
      request: () =>
        fetch(`${BACKEND_URL}/api/lesson-workflows/requests/resolve`, {
          method: 'POST',
          headers,
          signal: context.signal,
          body: JSON.stringify({ requestKey: evidence.requestKey }),
        }),
      readJob: body => {
        const parsed = z.object({ success: z.literal(true), job: jobSchema }).safeParse(body);
        return parsed.success ? parsed.data.job : null;
      },
      errorMessage: 'lesson_workflow_request_failed',
      signal: context.signal,
    });
    if (!recovered) throw error;
    initial = recovered;
  }
  context.signal.throwIfAborted();
  evidence.workflowId = initial.id;
  if (initial.projectId !== input.projectId || initial.sectionId !== input.sectionId)
    throw new FreshnessBlockedError('lesson_generation_identity_mismatch');
  const job = await pollWorkflow({
    initialState: initial,
    signal: context.signal,
    onState: job => {
      if (!context.signal.aborted) evidence.workflowStatus = job.status;
    },
    isTerminal: job => job.status === 'completed' || job.status === 'failed',
    readState: async (job, signal) => {
      const response = await fetch(
        `${BACKEND_URL}/api/lesson-workflows/runs/${encodeURIComponent(job.id)}`,
        { headers, cache: 'no-store', signal }
      );
      assertWorkflowPollResponse(response, 'lesson_workflow_request_failed');
      const body = z
        .object({ success: z.literal(true), job: jobSchema })
        .parse(await readWorkflowPollJson(response, 'lesson_workflow_request_failed'));
      if (
        body.job.id !== initial.id ||
        body.job.projectId !== input.projectId ||
        body.job.sectionId !== input.sectionId
      )
        throw new FreshnessBlockedError('lesson_generation_identity_mismatch');
      return body.job;
    },
  });
  context.signal.throwIfAborted();
  evidence.workflowStatus = job.status;
  if (
    job.id !== initial.id ||
    job.projectId !== input.projectId ||
    job.sectionId !== input.sectionId
  )
    throw new FreshnessBlockedError('lesson_generation_identity_mismatch');
  const result = completedResult(job, evidence);
  const persisted = await verifiedPersistence(input, before.revision, job, result);
  context.signal.throwIfAborted();
  // Opening the imported course starts on the selected fresh lesson.
  await input.store.patchProject(
    input.userId,
    input.projectId,
    { activeSectionId: input.sectionId },
    { expectedRevision: persisted.revision }
  );
  context.signal.throwIfAborted();
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

/** Cancellation and request-key recovery cannot extend the approved preparation deadline. */
async function cancelTimedOutGeneration(
  input: RegenerationInput,
  evidence: FreshnessEvidence,
  context: { headers?: Record<string, string>; signal: AbortSignal; scope?: EvidenceScope }
): Promise<void> {
  const { headers, signal, scope } = context;
  if (!headers) return;
  evidence.cancellation = { status: 'requested-unconfirmed' };
  const failed = () => {
    if (!scope?.finalized)
      evidence.cancellation = {
        status: 'failed',
        errorCode: 'lesson_generation_cancellation_failed',
      };
  };
  try {
    let workflowId = evidence.workflowId;
    if (!workflowId) {
      const sql = postgres(input.isolated.DB_URL);
      // Zero closes the owned connection immediately; it does not add another wait budget.
      const close = () => {
        void sql.end({ timeout: 0 }).catch(failed);
      };
      signal.addEventListener('abort', close, { once: true });
      try {
        const store = new PostgresWorkflowStore({
          sqlClient: sql,
          projectAssetStorage: createProjectAssetStorage({
            supabaseUrl: input.isolated.API_URL,
            serviceRoleKey: input.isolated.SERVICE_ROLE_KEY,
          }),
        });
        const run = await store.getRunByRequestKey({
          userId: input.userId,
          requestKey: evidence.requestKey,
          workflowId: LESSON_GENERATION_WORKFLOW_ID,
        });
        if (run?.projectId === input.projectId) {
          workflowId = run.id;
          if (!scope?.finalized) evidence.workflowId = run.id;
        }
      } finally {
        signal.removeEventListener('abort', close);
        close();
      }
    }
    if (!workflowId || signal.aborted) return;
    const response = await fetch(
      `${BACKEND_URL}/api/workflows/runs/${encodeURIComponent(workflowId)}/cancellation`,
      { method: 'POST', headers, body: JSON.stringify({}), signal }
    );
    if (!response.ok || (await response.json()).success !== true)
      throw new Error('Cancellation request failed');
    if (!scope?.finalized) evidence.cancellation = { status: 'confirmed' };
  } catch {
    failed();
  }
}

/** Allocate the owned preparation evidence before settings, generation or cleanup can wait. */
export function createPreparationDeadline(input: {
  userId: string;
  story: Story;
  viewport: Viewport;
  projectId: string;
  sectionId: string;
  isolated: StackStatus;
}): PreparationDeadline {
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
  const deadline = new PreparationDeadline(
    evidence,
    input.isolated,
    new FreshnessBlockedError(PREPARATION_TIMEOUT_CODE)
  );
  const scope = writer.getStore();
  scope?.records.set(evidence, deadline);
  if (scope)
    deadline.signal.addEventListener(
      'abort',
      () => {
        void deadline
          .settle('deadline-evidence', () => scope.record(evidence, deadline), 'write')
          .catch(() => {});
      },
      { once: true }
    );
  return deadline;
}

function preparationFailure(error: unknown, deadline: PreparationDeadline): FreshnessBlockedError {
  if (deadline.signal.aborted) return deadline.signal.reason;
  return error instanceof FreshnessBlockedError
    ? error
    : new FreshnessBlockedError('lesson_generation_preparation_failed', { cause: error });
}

async function recordFailedPreparation(
  scope: EvidenceScope,
  deadline: PreparationDeadline,
  failure: FreshnessBlockedError
): Promise<void> {
  if (scope.finalized) return;
  try {
    await deadline.settle(
      'blocked-generation-evidence',
      () => scope.record(deadline.evidence, deadline),
      'write'
    );
  } catch (recordError) {
    throw new FreshnessBlockedError(failure.code, {
      cause: new AggregateError(
        [failure, recordError],
        'Generation failed and evidence collection failed.',
        { cause: failure }
      ),
    });
  }
}

/** Force the product workflow, then check its durable identity and exact persisted output. */
export async function regenerateLesson(input: RegenerationInput): Promise<FreshnessEvidence> {
  const deadline = input.deadline ?? createPreparationDeadline(input);
  const evidence = deadline.evidence;
  const context: { signal: AbortSignal; headers?: Record<string, string> } = {
    signal: deadline.signal,
  };
  const scope = writer.getStore();
  const cancellation = scope?.cancellation ?? new AbortController();
  const cancel = () => {
    void cancelTimedOutGeneration(input, evidence, {
      headers: context.headers,
      signal: cancellation.signal,
      scope,
    });
  };
  deadline.signal.addEventListener('abort', cancel, { once: true });
  let recordingStarted = false;
  try {
    await deadline.step('lesson-generation', () => generate(input, evidence, context));
    evidence.durationMs = deadline.elapsedMs;
    if (scope && !scope.finalized) {
      recordingStarted = true;
      await deadline.step('generation-evidence', () => scope.record(evidence, deadline));
    }
    return evidence;
  } catch (error) {
    const failure = preparationFailure(error, deadline);
    evidence.outcome = 'blocked';
    evidence.errorCode = failure.code;
    if (scope && !recordingStarted && !deadline.signal.aborted)
      await recordFailedPreparation(scope, deadline, failure);
    throw preparationFailure(failure, deadline);
  } finally {
    deadline.signal.removeEventListener('abort', cancel);
    if (!input.deadline) deadline.finish();
    if (!scope) cancellation.abort();
  }
}
