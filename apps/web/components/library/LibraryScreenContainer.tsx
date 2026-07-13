// fallow-ignore-file unused-files
import { useState } from 'react';
import type { useLibraryAssistantChat } from '../../hooks/library/useLibraryAssistantChat.ts';
import type { useProjectLibrary } from '../../hooks/library/useProjectLibrary.ts';
import type { useWorkspaceController } from '../../hooks/workspace/useWorkspaceController.ts';
import type { useWorkspaceFileActions } from '../../hooks/workspace/useWorkspaceFileActions.ts';
import type { useWorkspaceNavigation } from '../../hooks/workspace/useWorkspaceNavigation.ts';
import type { useWorkspaceReaderState } from '../../hooks/workspace/useWorkspaceReaderState.ts';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import { sortSourceFiles } from '../../services/projects/courseSources.ts';
import type { HomeChatMode, HomeChatToolPreferences } from '../../types.ts';
import LibraryView from './LibraryView.tsx';

type WorkspaceController = ReturnType<typeof useWorkspaceController>;
type WorkspaceReaderState = ReturnType<typeof useWorkspaceReaderState>;
type WorkspaceProjectLibrary = ReturnType<typeof useProjectLibrary>;
type WorkspaceLibraryAssistantChat = ReturnType<typeof useLibraryAssistantChat>;
type WorkspaceFileActions = ReturnType<typeof useWorkspaceFileActions>;
type WorkspaceNavigation = ReturnType<typeof useWorkspaceNavigation>;

interface LibraryScreenContainerProps {
  controller: WorkspaceController;
  readerState: WorkspaceReaderState;
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
  readerState,
  projectLibrary,
  libraryAssistantChat,
  fileActions,
  navigation,
  notify,
  requestConfirmation,
}: LibraryScreenContainerProps) => {
  const [assessmentComplete, setAssessmentComplete] = useState(false);
  const [homeChatMode, setHomeChatMode] = useState<HomeChatMode>('new-course');
  const [pendingHomeSourceFiles, setPendingHomeSourceFiles] = useState<File[]>([]);

  const {
    assessmentMessages,
    confirmPlanGeneration,
    isLibraryLoading,
    openingProjectId,
    savedProjects,
    startHomeChat,
    submitAssessment,
    storageError,
  } = controller;

  const handleHomeSourceFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    setPendingHomeSourceFiles(sortSourceFiles(Array.from(event.target.files || [])));
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
          selectedFiles: pendingHomeSourceFiles,
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
      setPendingHomeSourceFiles([]);
    }

    if (result.errorMessage) {
      notify(result.errorMessage);
    }
    if (result.sourceWarnings?.length) {
      notify(
        t('Alcune fonti non sono state usate: {sourceNames}. Il corso continua con le altre.', {
          sourceNames: result.sourceWarnings.map(warning => warning.name).join(', '),
        })
      );
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
      isDarkMode={readerState.readerChrome.isDarkMode}
      isExportingProject={fileActions.isExportingProject}
      isLibraryLoading={isLibraryLoading}
      isLibraryQueryLoading={libraryAssistantChat.isLoading}
      isNewCourseLoading={controller.workflowState.assessment.status === 'pending'}
      libraryAttachedContextRefs={libraryAssistantChat.attachedContextRefs}
      libraryArtifactPayloadsByToolCallId={libraryAssistantChat.artifactPayloadsByToolCallId}
      libraryFloatingArtifactPayloads={libraryAssistantChat.replacementDraftPayloads}
      libraryErrorMessage={libraryAssistantChat.error?.message || null}
      libraryMessages={libraryAssistantChat.messages}
      libraryTree={projectLibrary.libraryTree}
      libraryWebSearch={libraryAssistantChat.webSearch}
      libraryGenerateArtifacts={libraryAssistantChat.generateArtifacts}
      newCourseLoadingStatus={controller.workflowState.assessment.message || t('Caricamento...')}
      openingProjectId={openingProjectId}
      planFileInputId={fileActions.planFileInputId}
      projects={savedProjects}
      pendingHomeFileName={pendingHomeSourceFiles[0]?.name || null}
      pendingHomeFileNames={pendingHomeSourceFiles.map(file => file.name)}
      sourceFileInputId={fileActions.sourceFileInputId}
      storageError={storageError}
      onClearPendingHomeFile={() => setPendingHomeSourceFiles([])}
      onClearLibraryMessages={libraryAssistantChat.clearLibraryMessages}
      onContinueAssessment={() => setAssessmentComplete(false)}
      onConfirmGenerate={handleConfirmGenerate}
      onCreateFolder={projectLibrary.createFolder}
      onConfirmDeleteFolder={folderName =>
        requestConfirmation({
          title: t('Eliminare cartella'),
          message: t(
            'Eliminare la cartella "{folderName}"? I corsi e le sottocartelle verranno riportati al livello superiore.',
            { folderName }
          ),
          confirmLabel: t('Elimina'),
        })
      }
      onDeleteFolder={projectLibrary.deleteFolder}
      onDeleteProject={fileActions.handleDeleteProject}
      onExportProject={projectId => {
        void fileActions.handleExportProject(projectId);
      }}
      onExportLibraryBackup={projectLibrary.downloadLibraryBackup}
      onHomeChatModeChange={setHomeChatMode}
      onImportJsonClick={fileActions.handleImportJsonClick}
      onImportLibraryBackup={projectLibrary.importLibraryBackup}
      onLibraryAssistantSend={libraryAssistantChat.sendLibraryMessage}
      onLibraryArtifactNoteApprove={libraryAssistantChat.approveLearningArtifactNoteSave}
      onLibraryArtifactNoteReject={libraryAssistantChat.rejectLearningArtifactNoteSave}
      onLibraryArtifactDiscard={libraryAssistantChat.discardLearningArtifact}
      onLibraryArtifactRegenerate={libraryAssistantChat.regenerateLearningArtifact}
      onLibraryArtifactReplace={libraryAssistantChat.replaceLearningArtifact}
      onLibraryWebSearchChange={libraryAssistantChat.setWebSearch}
      onLibraryGenerateArtifactsChange={libraryAssistantChat.setGenerateArtifacts}
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
      onSendAssessmentMessage={handleNewCourseMessage}
      onSourceFileUpload={handleHomeSourceFileUpload}
      onToggleDarkMode={() =>
        readerState.readerChrome.setIsDarkMode(!readerState.readerChrome.isDarkMode)
      }
      onToggleLibraryContextRef={libraryAssistantChat.toggleAttachedContextRef}
      onUploadSourceClick={fileActions.handleUploadSourceClick}
    />
  );
};
