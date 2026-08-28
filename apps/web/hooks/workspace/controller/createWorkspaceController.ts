import { createAssessmentPlanningCommands } from './assessmentPlanning.ts';
import { createWorkspaceControllerContext } from './controllerContext.ts';
import { createProjectLifecycleCommands } from './projectLifecycle.ts';
import { createSectionCommands } from './sectionProgression.ts';
import type { CreateWorkspaceControllerArgs, WorkspaceControllerCommands } from './types.ts';

export const createWorkspaceController = (
  args: CreateWorkspaceControllerArgs
): WorkspaceControllerCommands => {
  const context = createWorkspaceControllerContext(args);
  const { resumeRetainedSublesson, ...sectionCommands } = createSectionCommands(context);
  const assessmentCommands = createAssessmentPlanningCommands(context, {
    openSection: sectionCommands.openSection,
  });
  const projectLifecycleCommands = createProjectLifecycleCommands(context, {
    beginHomeChatWorkspaceOpen: assessmentCommands.beginHomeChatWorkspaceOpen,
    openSection: sectionCommands.openSection,
    resumeRetainedSublesson,
    resumePlanGeneration: assessmentCommands.resumePlanGeneration,
    startAssessment: assessmentCommands.startAssessment,
    startLearnAssessment: assessmentCommands.startLearnAssessment,
    settleHomeChatWorkspaceOpen: assessmentCommands.settleHomeChatWorkspaceOpen,
  });

  return {
    ...sectionCommands,
    ...projectLifecycleCommands,
    cancelAssessment: assessmentCommands.cancelAssessment,
    confirmPlanGeneration: assessmentCommands.confirmPlanGeneration,
    exportProject: context.projectLibrary.downloadProject,
    startHomeChat: assessmentCommands.startHomeChat,
    submitAssessment: assessmentCommands.submitAssessment,
  };
};
