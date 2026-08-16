import type {
  CourseWorkflowSnapshot,
  CourseWorkflowStage,
  CourseWorkflowStatus,
} from '@shared/courseWorkflowContract.js';

import type { ProjectSnapshot } from '../projects/types.js';
import type { CourseGenerationStarter } from './courseGenerationStart.js';
import { COURSE_GENERATION_WORKFLOW_ID } from './courseGenerationWorkflow.js';
import {
  CourseGenerationWorkflowInputSchema,
  CourseGenerationWorkflowResultSchema,
} from './courseGenerationWorkflowContract.js';
import { WorkflowRuntimeUnavailableError } from './runtime/workflowRuntimeApi.js';
import type { WorkflowRun } from './types.js';
import { WorkflowRunNotFoundError } from './workflowErrors.js';
import type { WorkflowNodeRunState, WorkflowRunState } from './workflowReadModel.js';

const SOURCE_STAGE_NODES = new Set(['prepare-course', 'gather-course-research']);
const STRUCTURE_STAGE_NODES = new Set([
  'draft-course-plan',
  'draft-archive-course',
  'draft-source-course',
  'plan-learn-course',
  'plan-source-set-course',
]);
const DRAFTING_STAGE_NODES = new Set([
  'verify-course-plan',
  'refine-course-plan',
  'refine-archive-course',
  'refine-source-course',
]);
const VERIFICATION_STAGE_NODES = new Set([
  'validate-course-plan',
  'finalize-course-sources',
  'persist-course',
  'publish-course-project-revision',
  'return-generated-course',
]);

type CourseGenerationStartRequest = Parameters<CourseGenerationStarter['start']>[0];

interface CourseGenerationProjectReader {
  loadProject(userId: string, projectId: string): Promise<ProjectSnapshot | null>;
}

interface CourseGenerationRunReader {
  getActiveRun(input: {
    projectId: string;
    userId: string;
    workflowId: string;
  }): Promise<WorkflowRun | null>;
  getRun(input: { runId: string; userId: string }): Promise<WorkflowRun | null>;
  getRunState(input: { runId: string; userId: string }): Promise<WorkflowRunState | null>;
}

interface CourseGenerationApiDependencies {
  readonly projectReader: CourseGenerationProjectReader;
  readonly runReader: CourseGenerationRunReader;
  readonly starter: CourseGenerationStarter;
}

export interface CourseGenerationApi {
  get(input: { runId: string; userId: string }): Promise<CourseWorkflowSnapshot | null>;
  getActive(input: { projectId: string; userId: string }): Promise<CourseWorkflowSnapshot | null>;
  start(input: CourseGenerationStartRequest): Promise<{
    created: boolean;
    job: CourseWorkflowSnapshot;
  }>;
}

export class CourseGenerationTargetNotFoundError extends Error {
  constructor() {
    super('The requested course generation target does not exist.');
    this.name = 'CourseGenerationTargetNotFoundError';
  }
}

const rejectUnavailableRuntime = (): Promise<never> =>
  Promise.reject(new WorkflowRuntimeUnavailableError());

export const unavailableCourseGenerationApi: CourseGenerationApi = {
  get: rejectUnavailableRuntime,
  getActive: rejectUnavailableRuntime,
  start: rejectUnavailableRuntime,
};

const mapRunStatus = (status: WorkflowRun['status']): CourseWorkflowStatus => {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled' || status === 'expired') return 'failed';
  if (status === 'queued') return 'queued';
  return 'running';
};

const mapNodeStage = (node: WorkflowNodeRunState): CourseWorkflowStage | null => {
  if (VERIFICATION_STAGE_NODES.has(node.definitionId)) return 'verification';
  if (node.definitionId === 'place-application-exercises') return 'quiz';
  if (DRAFTING_STAGE_NODES.has(node.definitionId)) return 'drafting';
  if (STRUCTURE_STAGE_NODES.has(node.definitionId)) return 'structure';
  if (SOURCE_STAGE_NODES.has(node.definitionId)) return 'sources';
  return null;
};

const mapProgress = (
  state: WorkflowRunState
): Pick<CourseWorkflowSnapshot, 'attempt' | 'retrying' | 'stage'> => {
  if (state.run.status === 'completed') {
    return { retrying: false, stage: 'ready' };
  }
  const mappedNodes = state.nodes.flatMap(node => {
    const stage = mapNodeStage(node);
    return stage ? [{ node, stage }] : [];
  });
  const current = [...mappedNodes].reverse().find(({ node }) => node.status !== 'completed');
  const progressNode = current?.node ?? mappedNodes.at(-1)?.node;
  return {
    ...(progressNode && progressNode.attemptCount > 0
      ? { attempt: progressNode.attemptCount }
      : {}),
    retrying: current?.node.status === 'retrying',
    stage: current?.stage ?? mappedNodes.at(-1)?.stage ?? 'sources',
  };
};

const parseRunInput = (run: WorkflowRun) => CourseGenerationWorkflowInputSchema.parse(run.input);

const createQueuedSnapshot = (run: WorkflowRun): CourseWorkflowSnapshot => {
  const input = parseRunInput(run);
  return {
    createdAt: run.createdAt,
    id: run.id,
    mode: input.mode,
    projectId: input.projectId,
    retrying: false,
    stage: 'sources',
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    status: mapRunStatus(run.status),
    updatedAt: run.updatedAt,
  };
};

const createSnapshot = (run: WorkflowRun, state: WorkflowRunState): CourseWorkflowSnapshot => {
  const input = parseRunInput(run);
  const result =
    state.run.status === 'completed'
      ? CourseGenerationWorkflowResultSchema.parse(run.output)
      : undefined;
  return {
    ...mapProgress(state),
    createdAt: state.run.createdAt,
    ...(state.run.error?.code ? { errorCode: state.run.error.code } : {}),
    id: run.id,
    mode: input.mode,
    projectId: input.projectId,
    ...(result ? { result } : {}),
    ...(state.run.startedAt ? { startedAt: state.run.startedAt } : {}),
    status: mapRunStatus(state.run.status),
    updatedAt: state.run.updatedAt,
  };
};

export const createCourseGenerationApi = (
  dependencies: CourseGenerationApiDependencies
): CourseGenerationApi => ({
  async get(input) {
    const state = await dependencies.runReader.getRunState(input);
    const run = state ? await dependencies.runReader.getRun(input) : null;
    if (!run || !state || run.workflowId !== COURSE_GENERATION_WORKFLOW_ID) return null;
    return createSnapshot(run, state);
  },

  async getActive(input) {
    const run = await dependencies.runReader.getActiveRun({
      ...input,
      workflowId: COURSE_GENERATION_WORKFLOW_ID,
    });
    if (!run) return null;
    const state = await dependencies.runReader.getRunState({
      runId: run.id,
      userId: input.userId,
    });
    if (!state || run.workflowId !== COURSE_GENERATION_WORKFLOW_ID) return null;
    return createSnapshot(run, state);
  },

  async start(input) {
    const project = await dependencies.projectReader.loadProject(input.userId, input.projectId);
    if (!project) throw new CourseGenerationTargetNotFoundError();

    const started = await dependencies.starter.start(input);
    if (started.created) {
      return { created: true, job: createQueuedSnapshot(started.run) };
    }
    const request = { runId: started.run.id, userId: input.userId };
    const state = await dependencies.runReader.getRunState(request);
    const run = state ? await dependencies.runReader.getRun(request) : null;
    if (!run || !state || run.workflowId !== COURSE_GENERATION_WORKFLOW_ID) {
      throw new WorkflowRunNotFoundError();
    }
    return { created: false, job: createSnapshot(run, state) };
  },
});
