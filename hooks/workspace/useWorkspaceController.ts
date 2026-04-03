import {
  selectBlockingMessage,
  selectIsBlocking,
  selectIsContextBusy,
} from '../../services/workspace/workflow.ts';
import { createWorkspaceController as createWorkspaceControllerImpl } from './controller/createWorkspaceController.ts';
import { useWorkspaceControllerState } from './controller/state.ts';
import type { UseWorkspaceControllerArgs } from './controller/types.ts';

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
} from './controller/types.ts';
export { createWorkspaceController } from './controller/createWorkspaceController.ts';

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
