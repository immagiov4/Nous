import { patchProjectInTransaction } from '../projects/projectTransaction.js';
import type { ProjectStore } from '../projects/types.js';
import {
  type CourseGenerationResolvedStartDependencies,
  startCourseGenerationWithModels,
} from './courseGenerationStart.js';
import { COURSE_GENERATION_WORKFLOW_ID } from './courseGenerationWorkflow.js';
import { createCourseInterviewModel } from './courseInterviewModel.js';
import type { CourseInterviewWorkflowServices } from './courseInterviewWorkflow.js';
import type { WorkflowRun } from './types.js';

const COURSE_INTERVIEW_PROJECT_STATE = 'ASSESSMENT';

type CourseInterviewRunStore = CourseGenerationResolvedStartDependencies['store'] & {
  getActiveRun(input: {
    projectId: string;
    userId: string;
    workflowId: string;
  }): Promise<WorkflowRun | null>;
};

interface ProductionCourseInterviewDependencies
  extends Omit<CourseGenerationResolvedStartDependencies, 'store'> {
  readonly patchProject?: typeof patchProjectInTransaction;
  readonly projectStore: Pick<ProjectStore, 'deleteProject' | 'loadProject' | 'patchProject'>;
  readonly runStore: CourseInterviewRunStore;
}

export const createProductionCourseInterviewServices = (
  dependencies: ProductionCourseInterviewDependencies
): CourseInterviewWorkflowServices => {
  const model = createCourseInterviewModel();
  const patchProject = dependencies.patchProject ?? patchProjectInTransaction;
  return {
    assessTurn: input => model.assessTurn(input),
    async discardUnclaimedDraftProject(input) {
      input.signal.throwIfAborted();
      const activeGeneration = await dependencies.runStore.getActiveRun({
        projectId: input.projectId,
        userId: input.userId,
        workflowId: COURSE_GENERATION_WORKFLOW_ID,
      });
      if (activeGeneration) return;

      const project = await dependencies.projectStore.loadProject(input.userId, input.projectId);
      if (!project || project.learningPlan || project.lastCourseGenerationRunId) return;
      input.signal.throwIfAborted();
      await dependencies.projectStore.deleteProject(input.userId, input.projectId);
    },
    async saveCourseProfile(input) {
      await patchProject(input.transaction, {
        buildPatch: () => ({
          isLearnMode: input.mode === 'learn',
          state: COURSE_INTERVIEW_PROJECT_STATE,
          userProfile: input.profile,
        }),
        projectId: input.projectId,
        updatedAt: new Date().toISOString(),
        userId: input.userId,
      });
    },
    async saveCourseProfileBeforeCheckpoint(input) {
      input.signal.throwIfAborted();
      await dependencies.projectStore.patchProject(input.userId, input.projectId, {
        isLearnMode: input.mode === 'learn',
        state: COURSE_INTERVIEW_PROJECT_STATE,
        userProfile: input.profile,
      });
    },
    async startCourseGeneration(input) {
      input.signal.throwIfAborted();
      const started = await startCourseGenerationWithModels(
        {
          publishTransientEvent: dependencies.publishTransientEvent,
          registry: dependencies.registry,
          store: dependencies.runStore,
        },
        {
          assessmentHistory: [...input.assessmentHistory],
          mode: input.mode,
          models: input.models,
          projectId: input.projectId,
          requestKey: input.idempotencyKey,
          userId: input.userId,
        }
      );
      return { runId: started.run.id };
    },
  };
};
