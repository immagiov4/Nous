import {
  selectBlockingMessage,
  selectIsBlocking,
  selectIsContextBusy,
} from '../../services/workspace/workflow.ts';
import { createWorkspaceController as createWorkspaceControllerImpl } from './controller/createWorkspaceController.ts';
import { useWorkspaceControllerState } from './controller/state.ts';
import type { UseWorkspaceControllerArgs } from './controller/types.ts';

export { createWorkspaceController } from './controller/createWorkspaceController.ts';
export type {
  UseWorkspaceControllerArgs,
  WorkspaceDomainControllerAdapter,
  WorkspaceProjectLibraryAdapter,
} from './controller/types.ts';

export const useWorkspaceController = ({
  domain,
  openRouter,
  projectLibrary,
  stopAudio,
}: UseWorkspaceControllerArgs) => {
  const controllerState = useWorkspaceControllerState();
  const commands = createWorkspaceControllerImpl({
    domain,
    openRouter,
    projectLibrary,
    state: controllerState.stateAdapter,
    stopAudio,
  });
  const generatingSectionId = controllerState.stateAdapter.getGeneratingSectionId(
    projectLibrary.currentProjectId
  );

  return {
    ...commands,
    ...domain,
    applyPersistedProjectRevision: projectLibrary.applyPersistedProjectRevision,
    assessmentMessages: controllerState.assessmentMessages,
    courseProposal: controllerState.courseProposal,
    blockingMessage: selectBlockingMessage(controllerState.workflowState),
    currentProjectId: projectLibrary.currentProjectId,
    getCurrentProjectId: projectLibrary.getCurrentProjectId,
    generatingSectionId,
    isBlocking: selectIsBlocking(controllerState.workflowState),
    isContextBusy: selectIsContextBusy(controllerState.workflowState),
    isGenerationActive: controllerState.stateAdapter.isGenerationActive(
      projectLibrary.currentProjectId
    ),
    isLessonGenerationActive: controllerState.stateAdapter.isLessonGenerationActive(
      projectLibrary.currentProjectId
    ),
    isLibraryLoading: projectLibrary.isLibraryLoading,
    loadStoredProjectSource: projectLibrary.loadStoredProjectSource,
    loadStoredProjectSources: projectLibrary.loadStoredProjectSources,
    loadStoredProjectSourceById: projectLibrary.loadStoredProjectSourceById,
    needsSourceFile:
      domain.needsSourceFile ||
      controllerState.stateAdapter.hasMissingSource(projectLibrary.currentProjectId),
    openingProjectId: controllerState.openingProjectId,
    patchSectionLessonContent: projectLibrary.patchSectionLessonContent,
    patchSectionAnnotations: projectLibrary.patchSectionAnnotations,
    savedProjects: projectLibrary.savedProjects,
    screenState: controllerState.screenState,
    storageError: projectLibrary.storageError,
    workflowState: controllerState.workflowState,
  };
};
