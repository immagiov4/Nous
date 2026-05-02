// fallow-ignore-file unused-files
import { useState } from 'react';
import { defaultModelConfig } from '../../app/modelDefaults.ts';
import type { useLibraryAssistantChat } from '../../hooks/library/useLibraryAssistantChat.ts';
import type { useProjectLibrary } from '../../hooks/library/useProjectLibrary.ts';
import type { useWorkspaceController } from '../../hooks/workspace/useWorkspaceController.ts';
import type { useWorkspaceFileActions } from '../../hooks/workspace/useWorkspaceFileActions.ts';
import type { useWorkspaceNavigation } from '../../hooks/workspace/useWorkspaceNavigation.ts';
import type { useWorkspaceReaderRuntime } from '../../hooks/workspace/useWorkspaceReaderRuntime.ts';
import type { HomeChatMode, HomeChatToolPreferences } from '../../types.ts';
import LibraryView from './LibraryView.tsx';

type WorkspaceController = ReturnType<typeof useWorkspaceController>;
type WorkspaceReaderRuntime = ReturnType<typeof useWorkspaceReaderRuntime>;
type WorkspaceProjectLibrary = ReturnType<typeof useProjectLibrary>;
type WorkspaceLibraryAssistantChat = ReturnType<typeof useLibraryAssistantChat>;
type WorkspaceFileActions = ReturnType<typeof useWorkspaceFileActions>;
type WorkspaceNavigation = ReturnType<typeof useWorkspaceNavigation>;

interface LibraryScreenContainerProps {
  controller: WorkspaceController;
  readerRuntime: WorkspaceReaderRuntime;
  projectLibrary: WorkspaceProjectLibrary;
  libraryAssistantChat: WorkspaceLibraryAssistantChat;
  fileActions: WorkspaceFileActions;
  navigation: WorkspaceNavigation;
  notify: (message: string) => void;
  requestConfirmation: (request: {
    title: string;
    message: string;
    confirmLabel: string;
  }) => Promise<boolean>;
}

// fallow-ignore-next-line unused-exports — used by App.tsx
export const LibraryScreenContainer = ({
  controller,
  readerRuntime,
  projectLibrary,
  libraryAssistantChat,
  fileActions,
  navigation,
  notify,
  requestConfirmation,
}: LibraryScreenContainerProps) => {
  const [assessmentComplete, setAssessmentComplete] = useState(false);
  const [homeChatMode, setHomeChatMode] = useState<HomeChatMode>('new-course');
  const [pendingHomeSourceFile, setPendingHomeSourceFile] = useState<File | null>(null);

  const {
    assessmentMessages,
    confirmPlanGeneration,
    isLibraryLoading,
    openingProjectId,
    savedProjects,
    startHomeChat,
    submitAssessment,
    storageError,
    transferFolderToLan,
    transferProjectToLan,
    projectRepositoryMode,
    setProjectRepositoryMode,
  } = controller;

  const handleHomeSourceFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0] || null;
    setPendingHomeSourceFile(selectedFile);
    if (event.target) {
      event.target.value = '';
    }
  };

  const handleNewCourseMessage = async (message: string) => {
    const toolPreferences: HomeChatToolPreferences = {
      addingAssessmentDetails: assessmentComplete,
      mode: 'new-course',
      newCourse: true,
    };
    if (assessmentComplete) {
      setAssessmentComplete(false);
    }
    const result = assessmentMessages.length
      ? await submitAssessment(message, toolPreferences)
      : await startHomeChat({
          input: message,
          selectedFile: pendingHomeSourceFile,
          toolPreferences,
        });

    if (result.outcome === 'assessment-complete') {
      setAssessmentComplete(true);
    } else if (result.outcome === 'continued') {
      setAssessmentComplete(false);
    } else if (result.outcome === 'imported') {
      setAssessmentComplete(false);
    }

    if (result.outcome !== 'failed' && result.outcome !== 'noop') {
      setPendingHomeSourceFile(null);
    }

    if (result.errorMessage) {
      notify(result.errorMessage);
    }
  };

  const handleConfirmGenerate = async () => {
    setAssessmentComplete(false);
    const result = await confirmPlanGeneration();
    if (result.errorMessage) {
      notify(result.errorMessage);
    }
  };

  return (
    <LibraryView
      assessmentComplete={assessmentComplete}
      assessmentMessages={assessmentMessages}
      homeChatMode={homeChatMode}
      isDarkMode={readerRuntime.readerChrome.isDarkMode}
      isLibraryLoading={isLibraryLoading}
      isLibraryQueryLoading={libraryAssistantChat.isLoading}
      isNewCourseLoading={controller.workflowState.assessment.status === 'pending'}
      libraryAttachedContextRefs={libraryAssistantChat.attachedContextRefs}
      libraryErrorMessage={libraryAssistantChat.error?.message || null}
      libraryMessages={libraryAssistantChat.messages}
      libraryScopeSummary={libraryAssistantChat.scopeSummary}
      libraryTree={projectLibrary.libraryTree}
      libraryWebSearch={libraryAssistantChat.webSearch}
      modelDefaults={defaultModelConfig}
      newCourseLoadingStatus={controller.workflowState.assessment.message || 'Caricamento...'}
      openingProjectId={openingProjectId}
      planFileInputId={fileActions.planFileInputId}
      preferredModels={readerRuntime.preferredModels}
      projects={savedProjects}
      pendingHomeFileName={pendingHomeSourceFile?.name || null}
      sourceFileInputId={fileActions.sourceFileInputId}
      storageError={storageError}
      onClearPendingHomeFile={() => setPendingHomeSourceFile(null)}
      onClearLibraryMessages={libraryAssistantChat.clearLibraryMessages}
      onContinueAssessment={() => setAssessmentComplete(false)}
      onConfirmGenerate={handleConfirmGenerate}
      onCreateFolder={projectLibrary.createFolder}
      onConfirmDeleteFolder={folderName =>
        requestConfirmation({
          title: 'Eliminare cartella',
          message: `Eliminare la cartella "${folderName}"? I corsi e le sottocartelle verranno riportati al livello superiore.`,
          confirmLabel: 'Elimina',
        })
      }
      onDeleteFolder={projectLibrary.deleteFolder}
      onDeleteProject={fileActions.handleDeleteProject}
      onExportProject={projectId => {
        void fileActions.handleExportProject(projectId);
      }}
      onHomeChatModeChange={setHomeChatMode}
      onImportJsonClick={fileActions.handleImportJsonClick}
      onLibraryAssistantSend={libraryAssistantChat.sendLibraryMessage}
      onLibraryWebSearchChange={libraryAssistantChat.setWebSearch}
      onMoveFolder={projectLibrary.moveFolder}
      onMoveProjects={projectLibrary.moveProjects}
      onOpenProject={projectId => {
        void navigation.handleOpenProject(projectId, { source: 'library' });
      }}
      onPlanUpload={event => {
        void fileActions.handlePlanUpload(event);
      }}
      onRemoveLibraryContextRef={libraryAssistantChat.removeAttachedContextRef}
      onRenameFolder={projectLibrary.renameFolder}
      onTransferFolderToLan={transferFolderToLan}
      onTransferProjectToLan={transferProjectToLan}
      onSendAssessmentMessage={handleNewCourseMessage}
      onSetPreferredOpenRouterModel={readerRuntime.setPreferredOpenRouterModel}
      onSetProjectRepositoryMode={setProjectRepositoryMode}
      onSourceFileUpload={handleHomeSourceFileUpload}
      onToggleDarkMode={() =>
        readerRuntime.readerChrome.setIsDarkMode(!readerRuntime.readerChrome.isDarkMode)
      }
      onToggleLibraryContextRef={libraryAssistantChat.toggleAttachedContextRef}
      onUploadSourceClick={fileActions.handleUploadSourceClick}
      projectRepositoryMode={projectRepositoryMode}
    />
  );
};
