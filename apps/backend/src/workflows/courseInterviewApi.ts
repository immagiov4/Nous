import {
  COURSE_INTERVIEW_ENDED_EVENT,
  COURSE_INTERVIEW_EVENT_SCHEMA_VERSION,
  COURSE_INTERVIEW_GENERATION_STARTED_EVENT,
  COURSE_INTERVIEW_MESSAGE_EVENT,
  COURSE_INTERVIEW_PROPOSAL_READY_EVENT,
  COURSE_INTERVIEW_WORKFLOW_ID,
  CourseInterviewGenerationStartedEventSchema,
  CourseInterviewMessageEventSchema,
  CourseInterviewProposalReadyEventSchema,
  CourseInterviewResultSchema,
  type CourseInterviewRun,
  CourseInterviewRunSchema,
} from '@shared/courseInterviewContract.js';

import type { ProjectSnapshot } from '../projects/types.js';
import type { CourseInterviewStarter } from './courseInterviewStart.js';
import { CourseInterviewWorkflowInputSchema } from './courseInterviewWorkflow.js';
import { WorkflowRuntimeUnavailableError } from './runtime/workflowRuntimeApi.js';
import type { JsonValue, WorkflowRun } from './types.js';
import type { WorkflowPublishedEventState, WorkflowRunState } from './workflowReadModel.js';

type CourseInterviewStartRequest = Parameters<CourseInterviewStarter['start']>[0];

interface CourseInterviewProjectReader {
  loadProject(userId: string, projectId: string): Promise<ProjectSnapshot | null>;
}

interface CourseInterviewRunReader {
  getActiveRun(input: {
    projectId: string;
    userId: string;
    workflowId: string;
  }): Promise<WorkflowRun | null>;
}

interface CourseInterviewApiDependencies {
  readonly projectReader: CourseInterviewProjectReader;
  readonly runReader: CourseInterviewRunReader;
  readonly starter: CourseInterviewStarter;
}

export interface CourseInterviewApi {
  getActive(input: { projectId: string; userId: string }): Promise<CourseInterviewRun | null>;
  start(input: CourseInterviewStartRequest): Promise<{
    created: boolean;
    run: CourseInterviewRun;
  }>;
}

export class CourseInterviewTargetNotFoundError extends Error {
  constructor() {
    super('The requested course interview target does not exist.');
    this.name = 'CourseInterviewTargetNotFoundError';
  }
}

const rejectUnavailableRuntime = (): Promise<never> =>
  Promise.reject(new WorkflowRuntimeUnavailableError());

export const unavailableCourseInterviewApi: CourseInterviewApi = {
  getActive: rejectUnavailableRuntime,
  start: rejectUnavailableRuntime,
};

const mapRun = (run: WorkflowRun): CourseInterviewRun => {
  const input = CourseInterviewWorkflowInputSchema.parse(run.input);
  return CourseInterviewRunSchema.parse({
    createdAt: run.createdAt,
    id: run.id,
    projectId: input.projectId,
    status: run.status,
    updatedAt: run.updatedAt,
  });
};

const publishedEventSchemas = {
  [COURSE_INTERVIEW_ENDED_EVENT]: CourseInterviewResultSchema,
  [COURSE_INTERVIEW_GENERATION_STARTED_EVENT]: CourseInterviewGenerationStartedEventSchema,
  [COURSE_INTERVIEW_MESSAGE_EVENT]: CourseInterviewMessageEventSchema,
  [COURSE_INTERVIEW_PROPOSAL_READY_EVENT]: CourseInterviewProposalReadyEventSchema,
} as const;

/** Projects only the durable interview events that are safe and useful to the client. */
export const projectCourseInterviewEvents = (
  state: WorkflowRunState
): readonly WorkflowPublishedEventState[] =>
  state.events.flatMap(event => {
    if (event.schemaVersion !== COURSE_INTERVIEW_EVENT_SCHEMA_VERSION) return [];
    const schema = publishedEventSchemas[event.eventType as keyof typeof publishedEventSchemas];
    if (!schema) return [];
    const parsed = schema.safeParse(event.payload);
    if (!parsed.success) return [];
    return [{ ...event, payload: parsed.data as JsonValue }];
  });

export const createCourseInterviewApi = (
  dependencies: CourseInterviewApiDependencies
): CourseInterviewApi => ({
  async getActive(input) {
    const run = await dependencies.runReader.getActiveRun({
      ...input,
      workflowId: COURSE_INTERVIEW_WORKFLOW_ID,
    });
    return run?.workflowId === COURSE_INTERVIEW_WORKFLOW_ID ? mapRun(run) : null;
  },

  async start(input) {
    const project = await dependencies.projectReader.loadProject(input.userId, input.projectId);
    if (project?.state !== 'ASSESSMENT' || project.learningPlan) {
      throw new CourseInterviewTargetNotFoundError();
    }
    const started = await dependencies.starter.start(input);
    return { created: started.created, run: mapRun(started.run) };
  },
});
