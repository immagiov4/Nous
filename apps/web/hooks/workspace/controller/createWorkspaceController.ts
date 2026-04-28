import { createAssessmentPlanningCommands } from './assessmentPlanning.ts';
import { createWorkspaceControllerContext } from './controllerContext.ts';
import { createLaboratoryCommands } from './laboratory.ts';
import { createProjectLifecycleCommands } from './projectLifecycle.ts';
import { createSectionCommands } from './sectionProgression.ts';
import type { CreateWorkspaceControllerArgs, WorkspaceControllerCommands } from './types.ts';

export const createWorkspaceController = (
  args: CreateWorkspaceControllerArgs
): WorkspaceControllerCommands => {
  const context = createWorkspaceControllerContext(args);
  const sectionCommands = createSectionCommands(context);
  const laboratoryCommands = createLaboratoryCommands(context);
  const assessmentCommands = createAssessmentPlanningCommands(context, {
    generateLaboratory: laboratoryCommands.generateLaboratory,
    openSection: sectionCommands.openSection,
  });
  const projectLifecycleCommands = createProjectLifecycleCommands(context, {
    openSection: sectionCommands.openSection,
    startAssessment: assessmentCommands.startAssessment,
  });

  return {
    ...laboratoryCommands,
    ...sectionCommands,
    ...projectLifecycleCommands,
    confirmPlanGeneration: assessmentCommands.confirmPlanGeneration,
    exportProject: context.projectLibrary.downloadProject,
    startHomeChat: assessmentCommands.startHomeChat,
    startLearnJourney: assessmentCommands.startLearnJourney,
    submitAssessment: assessmentCommands.submitAssessment,
  };
};
