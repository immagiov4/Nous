import {
  selectBlockingMessage,
  selectIsBlocking,
  selectIsContextBusy,
} from '../services/workspaceWorkflow.ts';
import { createWorkspaceController as createWorkspaceControllerImpl } from './workspace-controller/createWorkspaceController.ts';
import { useWorkspaceControllerState } from './workspace-controller/state.ts';
import type { UseWorkspaceControllerArgs } from './workspace-controller/types.ts';

export type {
  CompleteSectionOutcome,
  CreateLessonOutcome,
  CreateWorkspaceControllerArgs,
  OpenSectionOptions,
  OpenSectionOutcome,
  UseWorkspaceControllerArgs,
  WorkspaceChatSession,
  WorkspaceControllerCommands,
  WorkspaceDomainControllerAdapter,
  WorkspaceProjectLibraryAdapter,
} from './workspace-controller/types.ts';
export { createWorkspaceController } from './workspace-controller/createWorkspaceController.ts';

export const useWorkspaceController = ({
  domain,
  gemini,
  projectLibrary,
  stopAudio,
}: UseWorkspaceControllerArgs) => {
  const controllerState = useWorkspaceControllerState();
  const commands = createWorkspaceControllerImpl({
    domain,
    gemini,
    projectLibrary,
    state: controllerState.stateAdapter,
    stopAudio,
  });

  return {
    ...commands,
    ...domain,
    assessmentMessages: controllerState.assessmentMessages,
    blockingMessage: selectBlockingMessage(controllerState.workflowState),
    currentProjectId: projectLibrary.currentProjectId,
    isBlocking: selectIsBlocking(controllerState.workflowState),
    isContextBusy: selectIsContextBusy(controllerState.workflowState),
    isLibraryLoading: projectLibrary.isLibraryLoading,
    openingProjectId: controllerState.openingProjectId,
    savedProjects: projectLibrary.savedProjects,
    screenState: controllerState.screenState,
    storageError: projectLibrary.storageError,
    workflowState: controllerState.workflowState,
  };
};
