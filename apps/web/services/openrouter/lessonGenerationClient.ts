import type {
  DurableLessonGenerationResult,
  GenerationJobResponse,
  GenerationJobWire,
  LessonGenerationJobStage,
} from '@shared/generationJobContract';

import type { LessonNode, PdfDocumentAssets, ResearchLessonDossier } from '../../types.ts';
import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from './config.ts';

const LESSON_GENERATION_ERROR = 'La generazione della lezione non è riuscita. Riprova.';
const LESSON_GENERATION_TIMEOUT_ERROR =
  'La generazione della lezione ha superato il tempo disponibile. Riprova.';
const LESSON_REGENERATION_REQUEST_KEY_PREFIX = 'nous:lesson-regeneration-request:';

export class LessonGenerationBusyError extends Error {
  constructor(readonly activeSectionId?: string) {
    super('È già in corso la generazione di un’altra lezione di questo corso.');
    this.name = 'LessonGenerationBusyError';
  }
}

export type DurableLessonResult = Omit<
  DurableLessonGenerationResult,
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

const readSectionId = (job: GenerationJobWire): string | undefined => {
  const payload = job.payload;
  if (!payload || typeof payload !== 'object') return undefined;
  const sectionId = (payload as Record<string, unknown>).sectionId;
  return typeof sectionId === 'string' ? sectionId : undefined;
};

const parseCompletedResult = (
  job: GenerationJobWire,
  projectId: string,
  sectionId: string
): DurableLessonResult => {
  const result = job.result;
  if (!result || typeof result !== 'object') throw new TypeError(LESSON_GENERATION_ERROR);
  const lesson = result as Partial<DurableLessonGenerationResult>;
  if (
    lesson.projectId !== projectId ||
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

const readJobResponse = async (response: Response): Promise<GenerationJobResponse> =>
  (await response.json().catch(() => ({ success: false }))) as GenerationJobResponse;

const regenerationStorageKey = (projectId: string, sectionId: string): string =>
  `${LESSON_REGENERATION_REQUEST_KEY_PREFIX}${projectId}:${sectionId}`;

const readOrCreateRegenerationRequestKey = (projectId: string, sectionId: string): string => {
  const storageKey = regenerationStorageKey(projectId, sectionId);
  try {
    const existing = globalThis.sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const created = globalThis.crypto.randomUUID();
    globalThis.sessionStorage.setItem(storageKey, created);
    return created;
  } catch {
    return globalThis.crypto.randomUUID();
  }
};

const clearRegenerationRequestKey = (projectId: string, sectionId: string): void => {
  try {
    globalThis.sessionStorage.removeItem(regenerationStorageKey(projectId, sectionId));
  } catch {
    // Session storage is optional; the backend dedupe key still covers the current request.
  }
};

const reportLessonStage = (
  stage: GenerationJobWire['stage'],
  onProgressStage?: (stage: LessonGenerationJobStage) => void
): void => {
  if (
    stage === 'sources' ||
    stage === 'structure' ||
    stage === 'drafting' ||
    stage === 'quiz' ||
    stage === 'verification'
  ) {
    onProgressStage?.(stage);
  }
};

const waitForTerminalJob = async (
  job: GenerationJobWire,
  onProgressStage?: (stage: LessonGenerationJobStage) => void
): Promise<GenerationJobResponse> => {
  let currentJob = job;
  while (currentJob.status === 'queued' || currentJob.status === 'running') {
    reportLessonStage(currentJob.stage, onProgressStage);
    const response = await fetchWithSupabaseAuth(
      `${getBackendUrl()}/api/generation-jobs/${encodeURIComponent(currentJob.id)}/wait?afterStage=${encodeURIComponent(currentJob.stage)}`,
      { cache: 'no-store' }
    );
    if (!response.ok) throw new Error(LESSON_GENERATION_ERROR);
    const payload = await readJobResponse(response);
    if (!payload.job) throw new Error(LESSON_GENERATION_ERROR);
    currentJob = payload.job;
  }
  reportLessonStage(currentJob.stage, onProgressStage);
  return { job: currentJob, success: true };
};

const readLatestLessonJob = async (
  projectId: string,
  sectionId: string
): Promise<GenerationJobWire | null> => {
  const response = await fetchWithSupabaseAuth(
    `${getBackendUrl()}/api/generation-jobs/lessons/${encodeURIComponent(projectId)}/${encodeURIComponent(sectionId)}/latest`,
    { cache: 'no-store' }
  );
  if (response.status === 404) return null;
  const payload = await readJobResponse(response);
  if (!response.ok || !payload.job) throw new Error(LESSON_GENERATION_ERROR);
  return payload.job;
};

const throwForTerminalFailure = (job: GenerationJobWire | undefined): never => {
  throw new Error(
    job?.errorCode === 'generation_timeout'
      ? LESSON_GENERATION_TIMEOUT_ERROR
      : LESSON_GENERATION_ERROR
  );
};

export const generateDurableLesson = async ({
  forceRegenerate = false,
  onProgressStage,
  projectId,
  sectionId,
}: {
  forceRegenerate?: boolean;
  onProgressStage?: (stage: LessonGenerationJobStage) => void;
  projectId: string;
  sectionId: string;
}): Promise<DurableLessonResult> => {
  if (!forceRegenerate) {
    const latestJob = await readLatestLessonJob(projectId, sectionId);
    if (latestJob) {
      const latestPayload = await waitForTerminalJob(latestJob, onProgressStage);
      if (latestPayload.job?.status === 'completed') {
        return parseCompletedResult(latestPayload.job, projectId, sectionId);
      }
      if (
        latestPayload.job?.status === 'failed' &&
        latestPayload.job.errorCode !== 'backend_restarted'
      ) {
        throwForTerminalFailure(latestPayload.job);
      }
    }
  }
  const regenerationRequestKey = forceRegenerate
    ? readOrCreateRegenerationRequestKey(projectId, sectionId)
    : undefined;
  const queuedResponse = await fetchWithSupabaseAuth(
    `${getBackendUrl()}/api/generation-jobs/lessons`,
    {
      body: JSON.stringify({
        forceRegenerate,
        projectId,
        ...(regenerationRequestKey ? { requestKey: regenerationRequestKey } : {}),
        sectionId,
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    }
  );
  let payload = await readJobResponse(queuedResponse);
  if (queuedResponse.status === 409 && payload.job) {
    if (forceRegenerate) clearRegenerationRequestKey(projectId, sectionId);
    throw new LessonGenerationBusyError(readSectionId(payload.job));
  }
  if (!queuedResponse.ok || !payload.job) throw new Error(LESSON_GENERATION_ERROR);

  payload = await waitForTerminalJob(payload.job, onProgressStage);

  const terminalJob = payload.job;
  if (!terminalJob) throw new Error(LESSON_GENERATION_ERROR);
  if (terminalJob.status !== 'completed') {
    if (forceRegenerate && terminalJob?.status === 'failed') {
      clearRegenerationRequestKey(projectId, sectionId);
    }
    throwForTerminalFailure(terminalJob);
  }
  if (forceRegenerate) clearRegenerationRequestKey(projectId, sectionId);
  return parseCompletedResult(terminalJob, projectId, sectionId);
};
