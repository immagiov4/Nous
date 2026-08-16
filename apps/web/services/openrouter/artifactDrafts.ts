import type { ArtifactDraftWorkflowSnapshot } from '@shared/artifactDraftWorkflowContract';
import type {
  LearningArtifactRenderPayload,
  LearningArtifactSummary,
  LearningSection,
  LessonGeneratedVisualKind,
  ProjectId,
  StoredLessonVisual,
} from '../../types.ts';
import { buildGeneratedVisualLearningArtifactPayload } from '../../utils/learning/artifacts.ts';
import {
  getStoredLessonVisualCode,
  getStoredLessonVisualKind,
  isProjectLessonVisual,
} from '../../utils/visuals/storedLessonVisual.ts';
import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { logBackendFailureCorrelationId } from '../feedback/browserDiagnostics.ts';
import { getBackendUrl } from './config.ts';
import {
  acquireWorkflowRequestKey,
  assertWorkflowPollResponse,
  isDefinitiveWorkflowStartRejection,
  isWorkflowSnapshotEnvelope,
  logMalformedWorkflowSnapshotCorrelationId,
  pollWorkflow,
  readWorkflowJson,
  readWorkflowPollJson,
  resolveWorkflowFailureMessage,
} from './workflowClientTransport.ts';

interface GenerateLessonArtifactDraftInput {
  contextAfter?: string;
  contextBefore?: string;
  generationNotes?: string;
  lesson: LearningSection;
  mode?: 'new' | 'replacement-draft';
  projectId: ProjectId;
  projectTitle: string;
  prompt: string;
  requestKey: string;
  requestedVisualKind?: LessonGeneratedVisualKind;
  revisionInstructions?: string;
  selectedText?: string;
  sourceArtifact?: LearningArtifactRenderPayload;
  sourceArtifactId?: string;
}

export interface GeneratedLessonArtifactDraft {
  artifactId: string;
  payload: LearningArtifactRenderPayload & { visual: StoredLessonVisual };
  visual: StoredLessonVisual;
}

const ARTIFACT_DRAFT_ERROR = 'La generazione dell’artefatto visuale non è riuscita. Riprova.';
const ARTIFACT_DRAFT_REQUEST_KEY_PREFIX = 'nous:artifact-draft-request:';
const EMBEDDED_DATA_URL_PATTERN = /(?:^|[\s"'=(])data:[^,\s"']*,/iu;
const ARTIFACT_DRAFT_STAGES: ReadonlySet<string> = new Set(['finalizing', 'planning', 'rendering']);
const ARTIFACT_DRAFT_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'queued',
  'running',
]);

const describeSourceArtifact = (sourceArtifact: LearningArtifactRenderPayload): string => {
  const lines = ['Artefatto sorgente da modificare:', `Titolo: ${sourceArtifact.summary.title}`];
  if (!('visual' in sourceArtifact)) return lines.join('\n');

  const kind = getStoredLessonVisualKind(sourceArtifact.visual);
  const code = getStoredLessonVisualCode(sourceArtifact.visual);
  lines.push(`Tipo: ${kind}`);
  if (kind === 'image' || !code || EMBEDDED_DATA_URL_PATTERN.test(code)) {
    lines.push(
      `Descrizione attuale: ${sourceArtifact.visual.altText || sourceArtifact.visual.title || sourceArtifact.summary.title}`
    );
  } else {
    lines.push(`Codice attuale:\n${code}`);
  }
  return lines.join('\n');
};

const buildDraftLessonMarkdown = ({
  contextAfter,
  contextBefore,
  lesson,
  mode,
  prompt,
  revisionInstructions,
  selectedText,
  sourceArtifact,
}: Pick<
  GenerateLessonArtifactDraftInput,
  | 'contextAfter'
  | 'contextBefore'
  | 'lesson'
  | 'mode'
  | 'prompt'
  | 'revisionInstructions'
  | 'selectedText'
  | 'sourceArtifact'
>): string =>
  [
    `Richiesta visuale dell'utente:\n${prompt.trim()}`,
    mode === 'replacement-draft'
      ? 'Modalita: crea una bozza modificata dell artefatto sorgente, non una variante indipendente.'
      : undefined,
    revisionInstructions?.trim()
      ? `Istruzioni di revisione obbligatorie:\n${revisionInstructions.trim()}`
      : undefined,
    sourceArtifact ? describeSourceArtifact(sourceArtifact) : undefined,
    selectedText?.trim() ? `Passaggio selezionato:\n${selectedText.trim()}` : undefined,
    contextBefore?.trim() ? `Contesto precedente:\n${contextBefore.trim()}` : undefined,
    lesson.content?.trim() ? `Lezione:\n${lesson.content.trim()}` : undefined,
    contextAfter?.trim() ? `Contesto successivo:\n${contextAfter.trim()}` : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readWorkflowJob = (payload: unknown): ArtifactDraftWorkflowSnapshot | null => {
  if (!isRecord(payload) || payload.success !== true) return null;
  const job = payload.job;
  if (
    !isWorkflowSnapshotEnvelope(job) ||
    typeof job.retrying !== 'boolean' ||
    typeof job.sectionId !== 'string' ||
    !job.sectionId.trim() ||
    !ARTIFACT_DRAFT_STAGES.has(job.stage) ||
    !ARTIFACT_DRAFT_STATUSES.has(job.status) ||
    (job.result !== undefined && (!isRecord(job.result) || !('visual' in job.result)))
  ) {
    logMalformedWorkflowSnapshotCorrelationId(job);
    return null;
  }
  return job as unknown as ArtifactDraftWorkflowSnapshot;
};

const waitForArtifactDraft = (
  initialJob: ArtifactDraftWorkflowSnapshot
): Promise<ArtifactDraftWorkflowSnapshot> =>
  pollWorkflow({
    initialState: initialJob,
    isTerminal: job => job.status !== 'queued' && job.status !== 'running',
    readState: async currentJob => {
      const response = await fetchWithSupabaseAuth(
        `${getBackendUrl()}/api/artifact-drafts/runs/${encodeURIComponent(currentJob.id)}`,
        { cache: 'no-store' }
      );
      assertWorkflowPollResponse(response, ARTIFACT_DRAFT_ERROR);
      const job = readWorkflowJob(await readWorkflowPollJson(response, ARTIFACT_DRAFT_ERROR));
      if (
        job?.id !== currentJob.id ||
        job.projectId !== currentJob.projectId ||
        job.sectionId !== currentJob.sectionId
      ) {
        throw new Error(ARTIFACT_DRAFT_ERROR);
      }
      return job;
    },
  });

const generateDurableArtifactDraft = async (input: {
  generationNotes?: string;
  lessonMarkdown: string;
  projectId: string;
  requestText: string;
  requestedVisualKind?: LessonGeneratedVisualKind;
  requestIdentity: string;
  sectionDescription: string;
  sectionId: string;
  sectionTitle: string;
  sourceVisualId?: string;
}): Promise<StoredLessonVisual | null> => {
  const request = acquireWorkflowRequestKey(
    `${ARTIFACT_DRAFT_REQUEST_KEY_PREFIX}${input.projectId}:${input.requestIdentity}`
  );
  const response = await fetchWithSupabaseAuth(`${getBackendUrl()}/api/artifact-drafts`, {
    body: JSON.stringify({
      generationNotes: input.generationNotes,
      lessonMarkdown: input.lessonMarkdown,
      projectId: input.projectId,
      requestText: input.requestText,
      requestedVisualKind: input.requestedVisualKind,
      requestKey: request.requestKey,
      sectionDescription: input.sectionDescription,
      sectionId: input.sectionId,
      sectionTitle: input.sectionTitle,
      sourceVisualId: input.sourceVisualId,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  if (isDefinitiveWorkflowStartRejection(response)) request.clear();
  const job = readWorkflowJob(await readWorkflowJson(response));
  if (!response.ok || job?.projectId !== input.projectId || job.sectionId !== input.sectionId) {
    throw new Error(ARTIFACT_DRAFT_ERROR);
  }

  const terminalJob = await waitForArtifactDraft(job);
  request.clear();
  if (terminalJob.status !== 'completed' || !terminalJob.result) {
    logBackendFailureCorrelationId(terminalJob.correlationId);
    throw new Error(resolveWorkflowFailureMessage(terminalJob.errorCode, ARTIFACT_DRAFT_ERROR));
  }
  return terminalJob.result.visual;
};

export const generateLessonArtifactDraft = async ({
  contextAfter,
  contextBefore,
  generationNotes,
  lesson,
  mode = 'new',
  projectId,
  projectTitle,
  prompt,
  requestKey,
  requestedVisualKind,
  revisionInstructions,
  selectedText,
  sourceArtifact,
  sourceArtifactId,
}: GenerateLessonArtifactDraftInput): Promise<GeneratedLessonArtifactDraft | null> => {
  const lessonMarkdown = buildDraftLessonMarkdown({
    contextAfter,
    contextBefore,
    lesson,
    mode,
    prompt,
    revisionInstructions,
    selectedText,
    sourceArtifact,
  });
  const sourceVisual = sourceArtifact && 'visual' in sourceArtifact ? sourceArtifact.visual : null;
  const resolvedVisualKind =
    requestedVisualKind ??
    (mode === 'replacement-draft' && sourceVisual
      ? getStoredLessonVisualKind(sourceVisual)
      : undefined);

  const visual = await generateDurableArtifactDraft({
    generationNotes,
    lessonMarkdown,
    projectId,
    requestText: prompt.trim(),
    requestedVisualKind: resolvedVisualKind,
    requestIdentity: requestKey,
    sectionDescription: lesson.description,
    sectionId: lesson.id,
    sectionTitle: lesson.title,
    sourceVisualId:
      mode === 'replacement-draft' && sourceVisual && isProjectLessonVisual(sourceVisual)
        ? sourceVisual.id
        : undefined,
  });

  if (!visual) return null;
  const payload = buildGeneratedVisualLearningArtifactPayload({
    lesson,
    projectId,
    projectTitle,
    visual,
  }) as LearningArtifactRenderPayload & {
    summary: LearningArtifactSummary & { kind: 'generated-visual' };
    visual: StoredLessonVisual;
  };
  const replacementOfArtifactId =
    mode === 'replacement-draft' ? sourceArtifactId || sourceArtifact?.summary.id : undefined;
  const renderPayload: LearningArtifactRenderPayload & { visual: StoredLessonVisual } =
    replacementOfArtifactId
      ? {
          ...payload,
          summary: {
            ...payload.summary,
            replacementOfArtifactId,
          },
          visual,
        }
      : payload;

  return {
    artifactId: renderPayload.summary.id,
    payload: renderPayload,
    visual,
  };
};
