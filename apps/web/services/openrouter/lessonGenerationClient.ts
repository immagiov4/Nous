import type {
  LessonWorkflowResult,
  LessonWorkflowSnapshot,
  LessonWorkflowStage,
} from '@shared/lessonWorkflowContract';

import type { LessonNode, PdfDocumentAssets, ResearchLessonDossier } from '../../types.ts';
import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { logBackendFailureCorrelationId } from '../feedback/browserDiagnostics.ts';
import { getBackendUrl } from './config.ts';
import {
  acquireWorkflowRequestKey,
  assertWorkflowPollResponse,
  clearWorkflowRequestKey,
  isDefinitiveWorkflowStartRejection,
  isWorkflowSnapshotEnvelope,
  logMalformedWorkflowSnapshotCorrelationId,
  pollWorkflow,
  readWorkflowJson,
  readWorkflowPollJson,
  readWorkflowRequestKey,
  resolveWorkflowFailureMessage,
} from './workflowClientTransport.ts';

const LESSON_GENERATION_ERROR = 'La generazione della lezione non è riuscita. Riprova.';
const LESSON_GENERATION_TIMEOUT_ERROR =
  'La generazione della lezione ha superato il tempo disponibile. Riprova.';
const LESSON_GENERATION_BUSY_STATUS = 409;
const LESSON_TERMINAL_PHASE_MESSAGES: Readonly<Record<string, string>> = {
  lesson_document_sources_failed:
    'Non è stato possibile elaborare le immagini delle fonti PDF. Riprova.',
  lesson_draft_failed: 'Non è stato possibile creare la bozza della lezione. Riprova.',
  lesson_finalization_failed:
    'Non è stato possibile completare il salvataggio della lezione. Riprova.',
  lesson_learning_aids_failed: 'Non è stato possibile preparare gli aiuti didattici. Riprova.',
  lesson_normalization_failed:
    'Non è stato possibile preparare il contenuto finale della lezione. Riprova.',
  lesson_persistence_failed: 'Non è stato possibile salvare la lezione. Riprova.',
  lesson_preparation_failed:
    'Non è stato possibile preparare la generazione della lezione. Riprova.',
  lesson_research_failed: 'La ricerca per la lezione non è riuscita. Riprova.',
  lesson_review_failed: 'La verifica della lezione non è riuscita. Riprova.',
  lesson_source_coverage_failed:
    'Non è stato possibile verificare la copertura delle fonti. Riprova.',
  lesson_youtube_research_failed: 'La ricerca nei video non è riuscita. Riprova.',
  sublesson_planning_failed:
    'Non è stato possibile preparare la lezione di approfondimento. Riprova.',
  sublesson_source_mapping_failed:
    'Non è stato possibile preparare le fonti della lezione di approfondimento. Riprova.',
};
const LESSON_REQUEST_KEY_PREFIX = 'nous:lesson-workflow-request:';
const LESSON_WORKFLOW_FAILURE_KINDS: ReadonlySet<string> = new Set([
  'corrective',
  'operational',
  'permanent',
]);
const LESSON_WORKFLOW_STAGES: ReadonlySet<string> = new Set([
  'sources',
  'structure',
  'drafting',
  'quiz',
  'verification',
]);
const LESSON_WORKFLOW_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'queued',
  'running',
]);
export const LESSON_SOURCE_UNAVAILABLE_MESSAGE =
  'Il materiale sorgente originale non e disponibile. Ricollegalo per generare o rigenerare le lezioni.' as const;

export class LessonSourceUnavailableError extends Error {
  constructor() {
    super(LESSON_SOURCE_UNAVAILABLE_MESSAGE);
    this.name = 'LessonSourceUnavailableError';
  }
}

export class LessonGenerationBusyError extends Error {
  constructor(readonly activeSectionId?: string) {
    super('È già in corso la generazione di un’altra lezione di questo corso.');
    this.name = 'LessonGenerationBusyError';
  }
}

export type DurableLessonResult = Omit<
  LessonWorkflowResult,
  | 'contentBlocks'
  | 'documentAssets'
  | 'generatedVisuals'
  | 'imageRefs'
  | 'learningAids'
  | 'quiz'
  | 'researchDossier'
  | 'visualPlanningDecision'
> & {
  contentBlocks: NonNullable<LessonNode['contentBlocks']>;
  documentAssets?: PdfDocumentAssets | null;
  generatedVisuals: NonNullable<LessonNode['generatedVisuals']>;
  imageRefs: NonNullable<LessonNode['imageRefs']>;
  learningAids: NonNullable<LessonNode['learningAids']>;
  quiz: NonNullable<LessonNode['quiz']>;
  researchDossier?: ResearchLessonDossier;
  visualPlanningDecision?: LessonNode['visualPlanningDecision'];
};

export interface DurableSublessonFocus {
  annotationNote?: string;
  contextAfter?: string;
  contextBefore?: string;
  instructions: string;
  selectedText: string;
}

const getLessonRequestKeyStorageKey = (projectId: string, requestIdentity: string): string =>
  `${LESSON_REQUEST_KEY_PREFIX}${projectId}:${requestIdentity}`;

export const hasDurableLessonRequest = (projectId: string, sectionId: string): boolean =>
  readWorkflowRequestKey(getLessonRequestKeyStorageKey(projectId, sectionId)) !== null;

const parseCompletedResult = (
  job: LessonWorkflowSnapshot,
  projectId: string,
  sectionId: string
): DurableLessonResult => {
  const lesson = job.result;
  if (
    lesson?.projectId !== projectId ||
    lesson.sectionId !== sectionId ||
    typeof lesson.content !== 'string' ||
    !lesson.content.trim() ||
    !Array.isArray(lesson.contentBlocks)
  ) {
    throw new TypeError(LESSON_GENERATION_ERROR);
  }
  return {
    content: lesson.content,
    contentBlocks: lesson.contentBlocks as NonNullable<LessonNode['contentBlocks']>,
    generatedVisuals: (Array.isArray(lesson.generatedVisuals)
      ? lesson.generatedVisuals
      : []) as NonNullable<LessonNode['generatedVisuals']>,
    imageRefs: (Array.isArray(lesson.imageRefs) ? lesson.imageRefs : []) as NonNullable<
      LessonNode['imageRefs']
    >,
    learningAids: (Array.isArray(lesson.learningAids) ? lesson.learningAids : []) as NonNullable<
      LessonNode['learningAids']
    >,
    projectId,
    ...(typeof lesson.projectRevision === 'number'
      ? { projectRevision: lesson.projectRevision }
      : {}),
    quiz: (Array.isArray(lesson.quiz) ? lesson.quiz : []) as NonNullable<LessonNode['quiz']>,
    sectionId,
    warnings: lesson.warnings,
    ...(lesson.alreadyCompleted ? { alreadyCompleted: true } : {}),
    ...(lesson.documentAssets !== undefined
      ? { documentAssets: lesson.documentAssets as PdfDocumentAssets | null }
      : {}),
    ...(lesson.researchDossier
      ? { researchDossier: lesson.researchDossier as unknown as ResearchLessonDossier }
      : {}),
    ...(lesson.visualPlanningDecision != null
      ? {
          visualPlanningDecision: lesson.visualPlanningDecision as NonNullable<
            LessonNode['visualPlanningDecision']
          >,
        }
      : {}),
  };
};

const isLessonWorkflowSnapshot = (value: unknown): value is LessonWorkflowSnapshot => {
  if (!isWorkflowSnapshotEnvelope(value)) return false;
  const failure = value.failure;
  return (
    typeof value.retrying === 'boolean' &&
    typeof value.sectionId === 'string' &&
    Boolean(value.sectionId.trim()) &&
    LESSON_WORKFLOW_STAGES.has(value.stage) &&
    LESSON_WORKFLOW_STATUSES.has(value.status) &&
    (failure === undefined ||
      (typeof failure === 'object' &&
        failure !== null &&
        !Array.isArray(failure) &&
        'code' in failure &&
        typeof failure.code === 'string' &&
        Boolean(failure.code.trim()) &&
        'kind' in failure &&
        typeof failure.kind === 'string' &&
        LESSON_WORKFLOW_FAILURE_KINDS.has(failure.kind)))
  );
};

const readWorkflowJob = (
  payload: unknown,
  requireSuccess = true
): LessonWorkflowSnapshot | null => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const response = payload as Record<string, unknown>;
  if (requireSuccess && response.success !== true) return null;
  if (isLessonWorkflowSnapshot(response.job)) return response.job;
  logMalformedWorkflowSnapshotCorrelationId(response.job);
  return null;
};

const waitForTerminalRun = async (
  initialJob: LessonWorkflowSnapshot,
  onProgressStage?: (stage: LessonWorkflowStage) => void,
  onWorkflowSnapshot?: (snapshot: LessonWorkflowSnapshot) => void
): Promise<LessonWorkflowSnapshot> => {
  let reportedStage: LessonWorkflowStage | null = null;
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
        `${getBackendUrl()}/api/lesson-workflows/runs/${encodeURIComponent(currentJob.id)}`,
        { cache: 'no-store' }
      );
      assertWorkflowPollResponse(response, LESSON_GENERATION_ERROR);
      const job = readWorkflowJob(await readWorkflowPollJson(response, LESSON_GENERATION_ERROR));
      if (
        job?.id !== currentJob.id ||
        job.projectId !== currentJob.projectId ||
        job.sectionId !== currentJob.sectionId
      ) {
        throw new Error(LESSON_GENERATION_ERROR);
      }
      return job;
    },
  });
};

const throwForTerminalFailure = (job: LessonWorkflowSnapshot): never => {
  logBackendFailureCorrelationId(job.correlationId);
  if (job.errorCode === 'lesson_source_unavailable') {
    throw new LessonSourceUnavailableError();
  }
  const fallbackMessage =
    job.errorCode === 'workflow_step_timeout'
      ? LESSON_GENERATION_TIMEOUT_ERROR
      : (job.errorCode && LESSON_TERMINAL_PHASE_MESSAGES[job.errorCode]) || LESSON_GENERATION_ERROR;
  throw new Error(resolveWorkflowFailureMessage(job.errorCode, fallbackMessage));
};

interface DurableLessonRequest {
  endpoint: 'lessons' | 'sublessons';
  expectedSectionId?: string;
  onProgressStage?: (stage: LessonWorkflowStage) => void;
  onWorkflowSnapshot?: (snapshot: LessonWorkflowSnapshot) => void;
  payload: Record<string, unknown>;
  projectId: string;
  requestIdentity: string;
  supersededRequestIdentity?: string;
}

const runDurableLessonRequest = async ({
  endpoint,
  expectedSectionId,
  onProgressStage,
  onWorkflowSnapshot,
  payload: requestPayload,
  projectId,
  requestIdentity,
  supersededRequestIdentity,
}: DurableLessonRequest): Promise<DurableLessonResult> => {
  const request = acquireWorkflowRequestKey(
    getLessonRequestKeyStorageKey(projectId, requestIdentity)
  );
  if (supersededRequestIdentity) {
    clearWorkflowRequestKey(getLessonRequestKeyStorageKey(projectId, supersededRequestIdentity));
  }
  const response = await fetchWithSupabaseAuth(
    `${getBackendUrl()}/api/lesson-workflows/${endpoint}`,
    {
      body: JSON.stringify({ ...requestPayload, projectId, requestKey: request.requestKey }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    },
    { expectedStatuses: [LESSON_GENERATION_BUSY_STATUS] }
  );
  if (
    response.status !== LESSON_GENERATION_BUSY_STATUS &&
    isDefinitiveWorkflowStartRejection(response)
  ) {
    request.clear();
  }
  const payload = await readWorkflowJson(response);
  const busyJob =
    response.status === LESSON_GENERATION_BUSY_STATUS ? readWorkflowJob(payload, false) : null;
  const reattachedBusyJob =
    busyJob &&
    busyJob.projectId === projectId &&
    expectedSectionId !== undefined &&
    busyJob.sectionId === expectedSectionId
      ? busyJob
      : null;
  if (busyJob && !reattachedBusyJob) {
    request.clear();
    throw new LessonGenerationBusyError(busyJob.sectionId);
  }
  if (response.status === LESSON_GENERATION_BUSY_STATUS) {
    logBackendFailureCorrelationId(response.headers.get('x-request-id'));
  }
  const job = reattachedBusyJob ?? readWorkflowJob(payload);
  if (
    (!response.ok && !reattachedBusyJob) ||
    job?.projectId !== projectId ||
    (expectedSectionId !== undefined && job.sectionId !== expectedSectionId)
  ) {
    if (response.status === LESSON_GENERATION_BUSY_STATUS) request.clear();
    throw new Error(LESSON_GENERATION_ERROR);
  }

  const terminalJob = await waitForTerminalRun(job, onProgressStage, onWorkflowSnapshot);
  request.clear();
  if (terminalJob.status !== 'completed') throwForTerminalFailure(terminalJob);
  try {
    return parseCompletedResult(terminalJob, projectId, expectedSectionId ?? terminalJob.sectionId);
  } catch (error) {
    logBackendFailureCorrelationId(terminalJob.correlationId);
    throw error;
  }
};

export const generateDurableLesson = async ({
  forceRegenerate = false,
  onProgressStage,
  onWorkflowSnapshot,
  parentSectionId,
  projectId,
  sectionId,
}: {
  forceRegenerate?: boolean;
  onProgressStage?: (stage: LessonWorkflowStage) => void;
  onWorkflowSnapshot?: (snapshot: LessonWorkflowSnapshot) => void;
  parentSectionId?: string;
  projectId: string;
  sectionId: string;
}): Promise<DurableLessonResult> =>
  runDurableLessonRequest({
    endpoint: 'lessons',
    expectedSectionId: sectionId,
    onProgressStage,
    onWorkflowSnapshot,
    payload: { forceRegenerate, sectionId },
    projectId,
    requestIdentity: sectionId,
    ...(parentSectionId ? { supersededRequestIdentity: `sublesson:${parentSectionId}` } : {}),
  });

export const generateDurableSublesson = async ({
  annotationNote,
  contextAfter,
  contextBefore,
  instructions,
  onProgressStage,
  onWorkflowSnapshot,
  parentSectionId,
  projectId,
  selectedText,
}: DurableSublessonFocus & {
  onProgressStage?: (stage: LessonWorkflowStage) => void;
  onWorkflowSnapshot?: (snapshot: LessonWorkflowSnapshot) => void;
  parentSectionId: string;
  projectId: string;
}): Promise<DurableLessonResult> =>
  runDurableLessonRequest({
    endpoint: 'sublessons',
    onProgressStage,
    onWorkflowSnapshot,
    payload: {
      annotationNote,
      contextAfter,
      contextBefore,
      instructions,
      parentSectionId,
      selectedText,
    },
    projectId,
    requestIdentity: `sublesson:${parentSectionId}`,
  });
