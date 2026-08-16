import type {
  ArtifactDraftWorkflowSnapshot,
  ArtifactDraftWorkflowStage,
  ArtifactDraftWorkflowStatus,
} from '@shared/artifactDraftWorkflowContract.js';

import { findProjectLessonSection } from '../projects/projectLesson.js';
import type { ProjectSnapshot } from '../projects/types.js';
import type { LessonVisualModelConfig } from '../services/lessonVisualModelConfig.js';
import {
  ARTIFACT_DRAFT_SLOT_ID,
  ARTIFACT_DRAFT_WORKFLOW_ID,
  type ArtifactDraftWorkflowInput,
  ArtifactDraftWorkflowInputSchema,
  ArtifactDraftWorkflowResultSchema,
} from './artifactDraftWorkflow.js';
import type { WorkflowRegistry } from './definition.js';
import { ProjectLessonVisualSchema } from './lessonGenerationWorkflowSchemas.js';
import { WorkflowRuntimeUnavailableError } from './runtime/workflowRuntimeApi.js';
import type { WorkflowRun } from './types.js';
import { WorkflowRunNotFoundError } from './workflowErrors.js';
import type { WorkflowTransientEventPublisher } from './workflowObservability.js';
import type { WorkflowNodeRunState, WorkflowRunState } from './workflowReadModel.js';
import type { WorkflowRunCreator } from './workflowStart.js';
import { startWorkflowRun } from './workflowStart.js';

export type ArtifactDraftStartInput = Omit<ArtifactDraftWorkflowInput, 'sourceVisual'> & {
  readonly aiProvider?: unknown;
  readonly aiProviderOverrides?: unknown;
  readonly requestKey: string;
  readonly sourceVisualId?: string;
};

interface ArtifactDraftProjectReader {
  loadProject(userId: string, projectId: string): Promise<ProjectSnapshot | null>;
}

interface ArtifactDraftRunReader {
  getRun(input: { runId: string; userId: string }): Promise<WorkflowRun | null>;
  getRunState(input: { runId: string; userId: string }): Promise<WorkflowRunState | null>;
}

interface ArtifactDraftApiDependencies {
  readonly projectReader: ArtifactDraftProjectReader;
  readonly publishTransientEvent?: WorkflowTransientEventPublisher;
  readonly registry: WorkflowRegistry;
  readonly resolveVisualConfig: (input: {
    aiProvider?: unknown;
    aiProviderOverrides?: unknown;
  }) => Promise<LessonVisualModelConfig>;
  readonly runReader: ArtifactDraftRunReader;
  readonly runStore: WorkflowRunCreator;
}

export interface ArtifactDraftApi {
  get(input: { runId: string; userId: string }): Promise<ArtifactDraftWorkflowSnapshot | null>;
  start(input: ArtifactDraftStartInput): Promise<{
    created: boolean;
    job: ArtifactDraftWorkflowSnapshot;
  }>;
}

export class ArtifactDraftTargetNotFoundError extends Error {
  constructor() {
    super('The requested artifact draft target does not exist.');
    this.name = 'ArtifactDraftTargetNotFoundError';
  }
}

export class ArtifactDraftSourceNotFoundError extends Error {
  constructor() {
    super('The requested source artifact does not exist.');
    this.name = 'ArtifactDraftSourceNotFoundError';
  }
}

const rejectUnavailableRuntime = (): Promise<never> =>
  Promise.reject(new WorkflowRuntimeUnavailableError());

export const unavailableArtifactDraftApi: ArtifactDraftApi = {
  get: rejectUnavailableRuntime,
  start: rejectUnavailableRuntime,
};

const mapRunStatus = (status: WorkflowRun['status']): ArtifactDraftWorkflowStatus => {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled' || status === 'expired') return 'failed';
  if (status === 'queued') return 'queued';
  return 'running';
};

const mapNodeStage = (node: WorkflowNodeRunState): ArtifactDraftWorkflowStage => {
  if (node.definitionId === 'plan-artifact-draft') return 'planning';
  if (node.definitionId === 'adopt-artifact-draft-assets') return 'finalizing';
  return 'rendering';
};

const mapProgressStage = (
  state: WorkflowRunState,
  progressNode: WorkflowNodeRunState | undefined
): ArtifactDraftWorkflowStage => {
  if (state.run.status === 'completed') return 'finalizing';
  return progressNode ? mapNodeStage(progressNode) : 'planning';
};

const mapProgress = (
  state: WorkflowRunState
): Pick<ArtifactDraftWorkflowSnapshot, 'attempt' | 'retrying' | 'stage'> => {
  const current = [...state.nodes].reverse().find(node => node.status !== 'completed');
  const progressNode = current ?? state.nodes.at(-1);
  return {
    ...(progressNode && progressNode.attemptCount > 0
      ? { attempt: progressNode.attemptCount }
      : {}),
    retrying: current?.status === 'retrying',
    stage: mapProgressStage(state, progressNode),
  };
};

const parseRunInput = (run: WorkflowRun) => ArtifactDraftWorkflowInputSchema.parse(run.input);

const queuedSnapshot = (run: WorkflowRun): ArtifactDraftWorkflowSnapshot => {
  const input = parseRunInput(run);
  return {
    createdAt: run.createdAt,
    id: run.id,
    projectId: input.projectId,
    retrying: false,
    sectionId: input.sectionId,
    stage: 'planning',
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    status: mapRunStatus(run.status),
    updatedAt: run.updatedAt,
  };
};

const snapshot = (run: WorkflowRun, state: WorkflowRunState): ArtifactDraftWorkflowSnapshot => {
  const input = parseRunInput(run);
  const result =
    state.run.status === 'completed'
      ? ArtifactDraftWorkflowResultSchema.parse(run.output)
      : undefined;
  return {
    ...mapProgress(state),
    createdAt: state.run.createdAt,
    ...(state.run.error?.code ? { errorCode: state.run.error.code } : {}),
    id: run.id,
    projectId: input.projectId,
    ...(result ? { result } : {}),
    sectionId: input.sectionId,
    ...(state.run.startedAt ? { startedAt: state.run.startedAt } : {}),
    status: mapRunStatus(state.run.status),
    updatedAt: state.run.updatedAt,
  };
};

const artifactDraftDedupeKey = (input: ArtifactDraftStartInput): string =>
  JSON.stringify([ARTIFACT_DRAFT_WORKFLOW_ID, input.projectId, input.requestKey]);

const findStoredSourceVisual = (project: ProjectSnapshot, sectionId: string, visualId: string) => {
  const section = findProjectLessonSection(project, sectionId);
  if (!section || !Array.isArray(section.generatedVisuals)) return null;
  for (const candidate of section.generatedVisuals) {
    const parsed = ProjectLessonVisualSchema.safeParse(candidate);
    if (parsed.success && parsed.data.id === visualId) return parsed.data;
  }
  return null;
};

const artifactDraftRunId = (visualId: string): string | null => {
  const prefix = 'lesson-visual:';
  const suffix = `:${ARTIFACT_DRAFT_SLOT_ID}`;
  return visualId.startsWith(prefix) && visualId.endsWith(suffix)
    ? visualId.slice(prefix.length, -suffix.length)
    : null;
};

const findDraftSourceVisual = async (
  dependencies: ArtifactDraftApiDependencies,
  input: ArtifactDraftStartInput
) => {
  if (!input.sourceVisualId) return undefined;
  const runId = artifactDraftRunId(input.sourceVisualId);
  if (!runId) return undefined;
  const run = await dependencies.runReader.getRun({ runId, userId: input.userId });
  const sourceInput = run ? ArtifactDraftWorkflowInputSchema.safeParse(run.input) : null;
  if (
    !run ||
    !sourceInput?.success ||
    run.workflowId !== ARTIFACT_DRAFT_WORKFLOW_ID ||
    run.projectId !== input.projectId ||
    sourceInput.data.sectionId !== input.sectionId ||
    run.status !== 'completed'
  ) {
    return undefined;
  }
  const result = ArtifactDraftWorkflowResultSchema.safeParse(run.output);
  return result.success && result.data.visual?.id === input.sourceVisualId
    ? result.data.visual
    : undefined;
};

export const createArtifactDraftApi = (
  dependencies: ArtifactDraftApiDependencies
): ArtifactDraftApi => ({
  async get(input) {
    const state = await dependencies.runReader.getRunState(input);
    const run = state ? await dependencies.runReader.getRun(input) : null;
    if (!run || !state || run.workflowId !== ARTIFACT_DRAFT_WORKFLOW_ID) return null;
    return snapshot(run, state);
  },

  async start(input) {
    const project = await dependencies.projectReader.loadProject(input.userId, input.projectId);
    const section = project ? findProjectLessonSection(project, input.sectionId) : null;
    if (!project || !section) {
      throw new ArtifactDraftTargetNotFoundError();
    }

    const sourceVisual = input.sourceVisualId
      ? (findStoredSourceVisual(project, input.sectionId, input.sourceVisualId) ??
        (await findDraftSourceVisual(dependencies, input)))
      : undefined;
    if (input.sourceVisualId && !sourceVisual) throw new ArtifactDraftSourceNotFoundError();
    const workflowInput = ArtifactDraftWorkflowInputSchema.parse({
      ...input,
      requestedVisualKind: input.requestedVisualKind ?? sourceVisual?.render.kind,
      sourceVisual,
    });
    const visual = await dependencies.resolveVisualConfig(input);
    const started = await startWorkflowRun({
      configOverride: { visual },
      dedupeKey: artifactDraftDedupeKey(input),
      input: workflowInput,
      projectId: input.projectId,
      publishTransientEvent: dependencies.publishTransientEvent,
      registry: dependencies.registry,
      requestKey: input.requestKey,
      store: dependencies.runStore,
      userId: input.userId,
      workflowId: ARTIFACT_DRAFT_WORKFLOW_ID,
    });

    if (started.created) return { created: true, job: queuedSnapshot(started.run) };
    const request = { runId: started.run.id, userId: input.userId };
    const state = await dependencies.runReader.getRunState(request);
    const run = state ? await dependencies.runReader.getRun(request) : null;
    if (!run || !state || run.workflowId !== ARTIFACT_DRAFT_WORKFLOW_ID) {
      throw new WorkflowRunNotFoundError();
    }
    return { created: false, job: snapshot(run, state) };
  },
});
