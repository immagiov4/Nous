import type {
  LessonWorkflowSnapshot,
  LessonWorkflowStage,
  LessonWorkflowStatus,
} from '@shared/lessonWorkflowContract.js';

import { findProjectLessonSection } from '../projects/projectLesson.js';
import type { ProjectSnapshot } from '../projects/types.js';
import type { LessonGenerationStarter } from './lessonGenerationStart.js';
import { LESSON_GENERATION_WORKFLOW_ID } from './lessonGenerationStart.js';
import {
  LessonGenerationRequestSchema,
  LessonGenerationWorkflowResultSchema,
} from './lessonGenerationWorkflowContract.js';
import { WorkflowRuntimeUnavailableError } from './runtime/workflowRuntimeApi.js';
import type { WorkflowRun } from './types.js';
import { WorkflowRunNotFoundError } from './workflowErrors.js';
import type { WorkflowNodeRunState, WorkflowRunState } from './workflowReadModel.js';

const SOURCE_STAGE_NODES = new Set([
  'compact-sublesson-request',
  'finalize-sublesson',
  'prepare-lesson',
  'return-existing-lesson',
  'stage-document-sources',
]);
const STRUCTURE_STAGE_NODES = new Set([
  'assess-source-coverage',
  'plan-sublesson',
  'research-lesson',
  'research-youtube',
  'unwrap-generation-context',
]);
const VERIFICATION_STAGE_NODES = new Set([
  'generate-learning-aids',
  'normalize-lesson',
  'persist-lesson',
  'render-visuals',
  'return-generated-lesson',
]);

type LessonGenerationStartRequest = Parameters<LessonGenerationStarter['start']>[0];
type ExistingLessonGenerationStartRequest = Omit<LessonGenerationStartRequest, 'kind'>;
type SublessonGenerationStartRequest = Omit<
  Extract<LessonGenerationStartRequest, { kind: 'sublesson' }>,
  'forceRegenerate' | 'kind' | 'sectionId'
>;

interface LessonGenerationProjectReader {
  loadProject(userId: string, projectId: string): Promise<ProjectSnapshot | null>;
}

interface LessonGenerationRunReader {
  getRun(input: { runId: string; userId: string }): Promise<WorkflowRun | null>;
  getRunState(input: { runId: string; userId: string }): Promise<WorkflowRunState | null>;
}

interface LessonGenerationApiDependencies {
  readonly createSectionId: () => string;
  readonly projectReader: LessonGenerationProjectReader;
  readonly runReader: LessonGenerationRunReader;
  readonly starter: LessonGenerationStarter;
}

export interface LessonGenerationApi {
  get(input: { runId: string; userId: string }): Promise<LessonWorkflowSnapshot | null>;
  start(input: ExistingLessonGenerationStartRequest): Promise<{
    busy: boolean;
    created: boolean;
    job: LessonWorkflowSnapshot;
  }>;
  startSublesson(input: SublessonGenerationStartRequest): Promise<{
    busy: boolean;
    created: boolean;
    job: LessonWorkflowSnapshot;
  }>;
}

export class LessonGenerationTargetNotFoundError extends Error {
  constructor() {
    super('The requested lesson generation target does not exist.');
    this.name = 'LessonGenerationTargetNotFoundError';
  }
}

const rejectUnavailableRuntime = (): Promise<never> =>
  Promise.reject(new WorkflowRuntimeUnavailableError());

export const unavailableLessonGenerationApi: LessonGenerationApi = {
  get: rejectUnavailableRuntime,
  start: rejectUnavailableRuntime,
  startSublesson: rejectUnavailableRuntime,
};

const mapRunStatus = (status: WorkflowRun['status']): LessonWorkflowStatus => {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled' || status === 'expired') return 'failed';
  if (status === 'queued') return 'queued';
  return 'running';
};

const isStartedNode = (node: WorkflowNodeRunState): boolean => node.status !== 'queued';

const mapNodeStage = (node: WorkflowNodeRunState): LessonWorkflowStage | null => {
  if (node.definitionId === 'review-lesson') {
    return isStartedNode(node) ? 'verification' : 'quiz';
  }
  if (VERIFICATION_STAGE_NODES.has(node.definitionId)) return 'verification';
  if (node.definitionId === 'draft-lesson') return 'drafting';
  if (STRUCTURE_STAGE_NODES.has(node.definitionId)) return 'structure';
  if (SOURCE_STAGE_NODES.has(node.definitionId)) return 'sources';
  return null;
};

const mapProgress = (
  state: WorkflowRunState
): Pick<LessonWorkflowSnapshot, 'attempt' | 'failure' | 'retrying' | 'stage'> => {
  const mappedNodes = state.nodes.flatMap(node => {
    const stage = mapNodeStage(node);
    return stage ? [{ node, stage }] : [];
  });
  const current = [...mappedNodes].reverse().find(({ node }) => node.status !== 'completed');
  const progressNode = current?.node ?? mappedNodes.at(-1)?.node;
  const retrying = Boolean(
    current &&
      (current.node.status === 'retrying' ||
        (current.node.status === 'running' && current.node.attemptCount > 1)) &&
      current.node.error
  );
  const failure = retrying ? current?.node.error : state.run.error;
  return {
    ...(progressNode && progressNode.attemptCount > 0
      ? { attempt: progressNode.attemptCount }
      : {}),
    ...(failure ? { failure: { code: failure.code, kind: failure.kind } } : {}),
    retrying,
    stage:
      state.run.status === 'completed'
        ? 'verification'
        : (current?.stage ?? mappedNodes.at(-1)?.stage ?? 'sources'),
  };
};

const parseRunInput = (run: WorkflowRun) => LessonGenerationRequestSchema.parse(run.input);

const createQueuedSnapshot = (
  run: WorkflowRun,
  stage: LessonWorkflowStage
): LessonWorkflowSnapshot => {
  const input = parseRunInput(run);
  return {
    createdAt: run.createdAt,
    id: run.id,
    projectId: input.projectId,
    retrying: false,
    sectionId: input.sectionId,
    stage,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    status: mapRunStatus(run.status),
    updatedAt: run.updatedAt,
  };
};

const createSnapshot = (run: WorkflowRun, state: WorkflowRunState): LessonWorkflowSnapshot => {
  const input = parseRunInput(run);
  const result =
    state.run.status === 'completed'
      ? LessonGenerationWorkflowResultSchema.parse(run.output)
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

export const createLessonGenerationApi = (
  dependencies: LessonGenerationApiDependencies
): LessonGenerationApi => {
  const startValidated = async (
    input: LessonGenerationStartRequest
  ): Promise<{ busy: boolean; created: boolean; job: LessonWorkflowSnapshot }> => {
    const started = await dependencies.starter.start(input);
    let job: LessonWorkflowSnapshot;
    if (started.created) {
      job = createQueuedSnapshot(started.run, input.kind === 'sublesson' ? 'structure' : 'sources');
    } else {
      const request = { runId: started.run.id, userId: input.userId };
      const state = await dependencies.runReader.getRunState(request);
      const run = state ? await dependencies.runReader.getRun(request) : null;
      if (!run || !state || run.workflowId !== LESSON_GENERATION_WORKFLOW_ID) {
        throw new WorkflowRunNotFoundError();
      }
      job = createSnapshot(run, state);
    }
    return {
      busy: !started.created && started.run.requestKey !== input.requestKey,
      created: started.created,
      job,
    };
  };

  return {
    async get(input) {
      const state = await dependencies.runReader.getRunState(input);
      const run = state ? await dependencies.runReader.getRun(input) : null;
      if (!run || !state || run.workflowId !== LESSON_GENERATION_WORKFLOW_ID) return null;
      return createSnapshot(run, state);
    },

    async start(input) {
      const project = await dependencies.projectReader.loadProject(input.userId, input.projectId);
      if (!project || !findProjectLessonSection(project, input.sectionId)) {
        throw new LessonGenerationTargetNotFoundError();
      }
      return startValidated({ ...input, kind: 'existing' });
    },

    async startSublesson(input) {
      const project = await dependencies.projectReader.loadProject(input.userId, input.projectId);
      if (!project || !findProjectLessonSection(project, input.parentSectionId)) {
        throw new LessonGenerationTargetNotFoundError();
      }
      return startValidated({
        ...input,
        forceRegenerate: false,
        idempotencyInput: {
          focus: input.focus,
          kind: 'sublesson',
          parentSectionId: input.parentSectionId,
          projectId: input.projectId,
          userId: input.userId,
        },
        kind: 'sublesson',
        sectionId: dependencies.createSectionId(),
      });
    },
  };
};
