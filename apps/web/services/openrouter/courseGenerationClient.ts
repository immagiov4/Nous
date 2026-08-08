import type {
  CourseWorkflowResult,
  CourseWorkflowSnapshot,
  CourseWorkflowStage,
} from '@shared/courseWorkflowContract';
import type {
  PdfMappingRepairResult,
  PdfMappingRepairSnapshot,
} from '@shared/pdfMappingRepairContract';

import type { Message } from '../../types.ts';
import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from './config.ts';
import {
  acquireWorkflowRequestKey,
  assertWorkflowPollResponse,
  clearWorkflowRequestKey,
  isDefinitiveWorkflowStartRejection,
  isWorkflowSnapshotEnvelope,
  pollWorkflow,
  readWorkflowJson,
  readWorkflowPollJson,
  readWorkflowRequestKey,
  resolveWorkflowFailureMessage,
  retryTransientWorkflowRequest,
} from './workflowClientTransport.ts';

const COURSE_GENERATION_ERROR = 'La generazione del corso non è riuscita. Riprova.';
const COURSE_GENERATION_TIMEOUT_ERROR =
  'La generazione del corso ha superato il tempo disponibile. Riprova.';
const COURSE_REQUEST_KEY_PREFIX = 'nous:course-workflow-request:';
const PDF_MAPPING_REPAIR_ERROR = 'La mappatura del PDF non è riuscita.';
const PDF_MAPPING_REPAIR_REQUEST_KEY_PREFIX = 'nous:pdf-mapping-repair-request:';
const COURSE_WORKFLOW_STAGES: ReadonlySet<string> = new Set([
  'sources',
  'structure',
  'drafting',
  'quiz',
  'verification',
  'ready',
]);
const COURSE_WORKFLOW_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'queued',
  'running',
]);
const PDF_MAPPING_REPAIR_STAGES: ReadonlySet<string> = new Set([
  'preparing',
  'mapping',
  'saving',
  'ready',
]);
const PDF_MAPPING_REPAIR_STATUSES = COURSE_WORKFLOW_STATUSES;

interface CourseWorkflowCallbacks {
  onProgressStage?: (stage: CourseWorkflowStage) => void;
  onWorkflowSnapshot?: (snapshot: CourseWorkflowSnapshot) => void;
}

interface GenerateDurableCourseInput extends CourseWorkflowCallbacks {
  assessmentHistory: readonly Message[];
  mode: 'document' | 'learn';
  projectId: string;
}

interface ResumeActiveDurableCourseInput extends CourseWorkflowCallbacks {
  projectId: string;
}

interface RepairDurablePdfMappingInput {
  projectId: string;
  signal?: AbortSignal;
}

const parseCompletedResult = (
  job: CourseWorkflowSnapshot,
  projectId: string
): CourseWorkflowResult => {
  const result = job.result;
  if (
    result?.projectId !== projectId ||
    typeof result.firstSectionId !== 'string' ||
    !result.firstSectionId.trim() ||
    !Number.isInteger(result.projectRevision) ||
    result.projectRevision < 0
  ) {
    throw new TypeError(COURSE_GENERATION_ERROR);
  }
  return result;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCourseWorkflowSnapshot = (value: unknown): value is CourseWorkflowSnapshot =>
  isWorkflowSnapshotEnvelope(value) &&
  typeof value.retrying === 'boolean' &&
  (value.mode === 'document' || value.mode === 'learn') &&
  COURSE_WORKFLOW_STAGES.has(value.stage) &&
  COURSE_WORKFLOW_STATUSES.has(value.status);

const isPdfMappingRepairSnapshot = (value: unknown): value is PdfMappingRepairSnapshot =>
  isWorkflowSnapshotEnvelope(value) &&
  PDF_MAPPING_REPAIR_STAGES.has(value.stage) &&
  PDF_MAPPING_REPAIR_STATUSES.has(value.status);

const readWorkflowJob = <Snapshot>(
  payload: unknown,
  isSnapshot: (value: unknown) => value is Snapshot
): Snapshot | null => {
  if (!isRecord(payload) || payload.success !== true) return null;
  return isSnapshot(payload.job) ? payload.job : null;
};

const waitForTerminalRun = async (
  initialJob: CourseWorkflowSnapshot,
  { onProgressStage, onWorkflowSnapshot }: CourseWorkflowCallbacks
): Promise<CourseWorkflowSnapshot> => {
  let reportedStage: CourseWorkflowStage | null = null;
  return pollWorkflow({
    initialState: initialJob,
    isTerminal: job => job.status !== 'queued' && job.status !== 'running',
    onState: job => {
      onWorkflowSnapshot?.(job);
      if (job.stage === reportedStage) return;
      onProgressStage?.(job.stage);
      reportedStage = job.stage;
    },
    readState: async currentJob => {
      const response = await fetchWithSupabaseAuth(
        `${getBackendUrl()}/api/course-workflows/runs/${encodeURIComponent(currentJob.id)}`,
        { cache: 'no-store' }
      );
      assertWorkflowPollResponse(response, COURSE_GENERATION_ERROR);
      const job = readWorkflowJob(
        await readWorkflowPollJson(response, COURSE_GENERATION_ERROR),
        isCourseWorkflowSnapshot
      );
      if (
        job?.id !== currentJob.id ||
        job.projectId !== currentJob.projectId ||
        job.mode !== currentJob.mode
      ) {
        throw new Error(COURSE_GENERATION_ERROR);
      }
      return job;
    },
  });
};

const readCompletedResult = (
  job: CourseWorkflowSnapshot,
  projectId: string
): CourseWorkflowResult => {
  if (job.status !== 'completed') {
    const fallbackMessage =
      job.errorCode === 'workflow_step_timeout'
        ? COURSE_GENERATION_TIMEOUT_ERROR
        : COURSE_GENERATION_ERROR;
    throw new Error(resolveWorkflowFailureMessage(job.errorCode, fallbackMessage));
  }
  return parseCompletedResult(job, projectId);
};

export const generateDurableCourse = async ({
  assessmentHistory,
  mode,
  onProgressStage,
  onWorkflowSnapshot,
  projectId,
}: GenerateDurableCourseInput): Promise<CourseWorkflowResult> => {
  const request = acquireWorkflowRequestKey(`${COURSE_REQUEST_KEY_PREFIX}${projectId}`);
  const response = await fetchWithSupabaseAuth(`${getBackendUrl()}/api/course-workflows/courses`, {
    body: JSON.stringify({
      assessmentHistory,
      mode,
      projectId,
      requestKey: request.requestKey,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  if (isDefinitiveWorkflowStartRejection(response)) request.clear();
  const job = readWorkflowJob(await readWorkflowJson(response), isCourseWorkflowSnapshot);
  if (!response.ok || job?.projectId !== projectId || job.mode !== mode) {
    throw new Error(COURSE_GENERATION_ERROR);
  }

  const terminalJob = await waitForTerminalRun(job, {
    onProgressStage,
    onWorkflowSnapshot,
  });
  request.clear();
  return readCompletedResult(terminalJob, projectId);
};

export const resumeActiveDurableCourse = async ({
  onProgressStage,
  onWorkflowSnapshot,
  projectId,
}: ResumeActiveDurableCourseInput): Promise<CourseWorkflowResult | null> => {
  const requestKeyStorageKey = `${COURSE_REQUEST_KEY_PREFIX}${projectId}`;
  const requestKey = readWorkflowRequestKey(requestKeyStorageKey);
  const job = await retryTransientWorkflowRequest(async () => {
    const response = await fetchWithSupabaseAuth(
      `${getBackendUrl()}/api/course-workflows/courses/${encodeURIComponent(projectId)}/active`,
      { cache: 'no-store' }
    );
    if (response.status === 404) return null;
    assertWorkflowPollResponse(response, COURSE_GENERATION_ERROR);
    const activeJob = readWorkflowJob(
      await readWorkflowPollJson(response, COURSE_GENERATION_ERROR),
      isCourseWorkflowSnapshot
    );
    if (activeJob?.projectId !== projectId) {
      throw new Error(COURSE_GENERATION_ERROR);
    }
    return activeJob;
  });
  if (!job) {
    if (requestKey !== null) clearWorkflowRequestKey(requestKeyStorageKey, requestKey);
    return null;
  }
  const terminalJob = await waitForTerminalRun(job, {
    onProgressStage,
    onWorkflowSnapshot,
  });
  if (requestKey !== null) clearWorkflowRequestKey(requestKeyStorageKey, requestKey);
  return readCompletedResult(terminalJob, projectId);
};

const parsePdfMappingRepairResult = (
  result: unknown,
  projectId: string
): PdfMappingRepairResult => {
  const projectRevision = isRecord(result) ? result.projectRevision : undefined;
  if (
    !isRecord(result) ||
    result.projectId !== projectId ||
    !Number.isInteger(projectRevision) ||
    Number(projectRevision) < 0 ||
    typeof result.repaired !== 'boolean'
  ) {
    throw new TypeError(PDF_MAPPING_REPAIR_ERROR);
  }
  return { projectId, projectRevision: Number(projectRevision), repaired: result.repaired };
};

const waitForPdfMappingRepair = async (
  initialJob: PdfMappingRepairSnapshot,
  signal?: AbortSignal
): Promise<PdfMappingRepairSnapshot> =>
  pollWorkflow({
    initialState: initialJob,
    isTerminal: job => job.status !== 'queued' && job.status !== 'running',
    readState: async currentJob => {
      const response = await fetchWithSupabaseAuth(
        `${getBackendUrl()}/api/course-workflows/pdf-mapping-repairs/${encodeURIComponent(currentJob.id)}`,
        { cache: 'no-store', signal }
      );
      assertWorkflowPollResponse(response, PDF_MAPPING_REPAIR_ERROR);
      const job = readWorkflowJob(
        await readWorkflowPollJson(response, PDF_MAPPING_REPAIR_ERROR),
        isPdfMappingRepairSnapshot
      );
      if (job?.id !== currentJob.id || job.projectId !== currentJob.projectId) {
        throw new Error(PDF_MAPPING_REPAIR_ERROR);
      }
      return job;
    },
    signal,
  });

export const repairDurablePdfMapping = async ({
  projectId,
  signal,
}: RepairDurablePdfMappingInput): Promise<PdfMappingRepairResult> => {
  const request = acquireWorkflowRequestKey(`${PDF_MAPPING_REPAIR_REQUEST_KEY_PREFIX}${projectId}`);
  const response = await fetchWithSupabaseAuth(
    `${getBackendUrl()}/api/course-workflows/pdf-mapping-repairs`,
    {
      body: JSON.stringify({ projectId, requestKey: request.requestKey }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal,
    }
  );
  if (isDefinitiveWorkflowStartRejection(response)) request.clear();
  const payload = await readWorkflowJson(response);
  if (!response.ok) {
    throw new Error(PDF_MAPPING_REPAIR_ERROR);
  }
  if (!isRecord(payload) || payload.success !== true) {
    throw new Error(PDF_MAPPING_REPAIR_ERROR);
  }
  if (payload.result !== undefined) {
    request.clear();
    return parsePdfMappingRepairResult(payload.result, projectId);
  }
  const job = isPdfMappingRepairSnapshot(payload.job) ? payload.job : null;
  if (job?.projectId !== projectId) {
    throw new Error(PDF_MAPPING_REPAIR_ERROR);
  }

  const terminalJob = await waitForPdfMappingRepair(job, signal);
  request.clear();
  if (terminalJob.status !== 'completed') {
    throw new Error(PDF_MAPPING_REPAIR_ERROR);
  }
  const result = parsePdfMappingRepairResult(terminalJob.result, projectId);
  return result;
};
