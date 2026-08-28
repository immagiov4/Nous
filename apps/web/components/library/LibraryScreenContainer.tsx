import { useCallback, useEffect, useRef, useState } from 'react';
import type { useLibraryAssistantChat } from '../../hooks/library/useLibraryAssistantChat.ts';
import type { useProjectLibrary } from '../../hooks/library/useProjectLibrary.ts';
import type { useWorkspaceController } from '../../hooks/workspace/useWorkspaceController.ts';
import type { useWorkspaceFileActions } from '../../hooks/workspace/useWorkspaceFileActions.ts';
import type { useWorkspaceNavigation } from '../../hooks/workspace/useWorkspaceNavigation.ts';
import type { useWorkspaceReaderState } from '../../hooks/workspace/useWorkspaceReaderState.ts';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import { pushNousDebugTrace } from '../../services/core/debugTrace.ts';
import { getErrorMessage } from '../../services/core/errorMessage.ts';
import { setFeedbackProductContext } from '../../services/feedback/browserDiagnostics.ts';
import { sortSourceFiles } from '../../services/projects/courseSources.ts';
import { formatSourceWarningSummary } from '../../services/projects/sourceWarningSummary.ts';
import type { HomeChatMode, HomeChatToolPreferences } from '../../types.ts';
import { type NewHomePage, NewHomeView } from '../newHome/NewHomeView.tsx';

type WorkspaceController = ReturnType<typeof useWorkspaceController>;
type WorkspaceReaderState = ReturnType<typeof useWorkspaceReaderState>;
type WorkspaceProjectLibrary = ReturnType<typeof useProjectLibrary>;
type WorkspaceLibraryAssistantChat = ReturnType<typeof useLibraryAssistantChat>;
type WorkspaceFileActions = ReturnType<typeof useWorkspaceFileActions>;
type WorkspaceNavigation = ReturnType<typeof useWorkspaceNavigation>;

interface LibraryScreenContainerProps {
  readonly controller: WorkspaceController;
  readonly readerState: WorkspaceReaderState;
  readonly projectLibrary: WorkspaceProjectLibrary;
  readonly libraryAssistantChat: WorkspaceLibraryAssistantChat;
  readonly fileActions: WorkspaceFileActions;
  readonly navigation: WorkspaceNavigation;
  readonly notify: (message: string) => void;
  readonly requestConfirmation: (request: {
    title: string;
    message: string;
    confirmLabel: string;
  }) => Promise<boolean>;
}

const isLibraryQueryPath = (pathname: string): boolean =>
  pathname === '/' ||
  pathname === '/library' ||
  pathname.startsWith('/newhome') ||
  pathname.startsWith('/library/');

interface RenameProjectAndSyncLoadedPlanArgs {
  getCurrentLearningPlan: () => WorkspaceController['learningPlan'];
  getCurrentProjectId: () => string | null;
  projectId: string;
  renameProject: WorkspaceProjectLibrary['renameProject'];
  setLearningPlan: WorkspaceController['setLearningPlan'];
  title: string;
}

export const renameProjectAndSyncLoadedPlan = async ({
  getCurrentLearningPlan,
  getCurrentProjectId,
  projectId,
  renameProject,
  setLearningPlan,
  title,
}: RenameProjectAndSyncLoadedPlanArgs) => {
  const renamedProject = await renameProject(projectId, title);
  const learningPlan = getCurrentLearningPlan();
  if (getCurrentProjectId() === projectId && learningPlan) {
    setLearningPlan({ ...learningPlan, title });
  }
  return renamedProject;
};

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
  const learningPlanRef = useRef(controller.learningPlan);
  useEffect(() => {
    learningPlanRef.current = controller.learningPlan;
  }, [controller.learningPlan]);
  const [isAddingAssessmentDetails, setIsAddingAssessmentDetails] = useState(false);
  const [homeChatMode, setHomeChatMode] = useState<HomeChatMode>(() =>
    typeof globalThis.window !== 'undefined' &&
    isLibraryQueryPath(globalThis.window.location.pathname)
      ? 'library-query'
      : 'new-course'
  );
  const [pendingHomeSourceFiles, setPendingHomeSourceFiles] = useState<File[]>([]);
  const newCourseRequestTokenRef = useRef(0);

  const {
    assessmentMessages,
    cancelAssessment,
    confirmPlanGeneration,
    isLibraryLoading,
    openingProjectId,
    savedProjects,
    startHomeChat,
    submitAssessment,
  } = controller;
  const assessmentComplete = Boolean(controller.courseProposal) && !isAddingAssessmentDetails;
  const isNewCourseLoading = controller.workflowState.assessment.status === 'pending';
  const isAnyHomeChatLoading = libraryAssistantChat.isLoading || isNewCourseLoading;
  const isAssessmentActive = assessmentMessages.length > 0 || isNewCourseLoading;
  const visibleHomeChatMode = assessmentMessages.length > 0 ? 'new-course' : homeChatMode;
  const { consumeCourseAssessmentRequest, courseAssessmentRequest } = libraryAssistantChat;
  const currentProjectRevision = savedProjects.find(
    project => project.id === controller.currentProjectId
  )?.revision;
  const handleHomeChatModeChange = useCallback(
    (mode: HomeChatMode) => {
      if (isAnyHomeChatLoading) return;
      setHomeChatMode(mode);
    },
    [isAnyHomeChatLoading]
  );

  const handleHomeSourceFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (isAnyHomeChatLoading) {
      event.target.value = '';
      return;
    }
    const selectedFiles = sortSourceFiles(Array.from(event.target.files || []));
    setPendingHomeSourceFiles(selectedFiles);
    if (selectedFiles.length > 0) {
      setHomeChatMode('new-course');
    }
    if (event.target) {
      event.target.value = '';
    }
  };

  const handleNewCourseMessage = useCallback(
    async (message: string) => {
      const requestToken = ++newCourseRequestTokenRef.current;
      const toolPreferences: HomeChatToolPreferences = {
        addingAssessmentDetails: isAddingAssessmentDetails,
        mode: 'new-course',
        newCourse: true,
      };
      setIsAddingAssessmentDetails(false);
      const result = assessmentMessages.length
        ? await submitAssessment(message, toolPreferences)
        : await startHomeChat({
            input: message,
            selectedFiles: pendingHomeSourceFiles,
            toolPreferences,
          });

      if (requestToken !== newCourseRequestTokenRef.current) return;

      if (result.outcome === 'abandoned') {
        setHomeChatMode('library-query');
      }

      if (result.outcome !== 'failed' && result.outcome !== 'noop') {
        setPendingHomeSourceFiles([]);
      }

      if (result.errorMessage) {
        notify(result.errorMessage);
      }
      if (result.sourceWarnings?.length) {
        notify(
          formatSourceWarningSummary(result.sourceWarnings, {
            continues: !result.errorMessage,
          })
        );
      }
    },
    [
      assessmentMessages.length,
      isAddingAssessmentDetails,
      notify,
      pendingHomeSourceFiles,
      startHomeChat,
      submitAssessment,
    ]
  );

  const cancelNewCourse = useCallback(async () => {
    newCourseRequestTokenRef.current += 1;
    try {
      await cancelAssessment();
      setIsAddingAssessmentDetails(false);
      setPendingHomeSourceFiles([]);
      setHomeChatMode('library-query');
      return true;
    } catch (error) {
      setHomeChatMode('new-course');
      pushNousDebugTrace('assessment:cancellation-failed', {
        errorMessage: getErrorMessage(error),
      });
      notify(t('Operazione non riuscita. Riprova.'));
      return false;
    }
  }, [cancelAssessment, notify]);

  useEffect(() => {
    if (!courseAssessmentRequest) {
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) {
        return;
      }
      consumeCourseAssessmentRequest();
      setIsAddingAssessmentDetails(false);
      setHomeChatMode('new-course');
      void handleNewCourseMessage(courseAssessmentRequest.topic);
    });

    return () => {
      cancelled = true;
    };
  }, [consumeCourseAssessmentRequest, courseAssessmentRequest, handleNewCourseMessage]);

  const handleConfirmGenerate = async () => {
    setIsAddingAssessmentDetails(false);
    const result = await confirmPlanGeneration();
    if (result.errorMessage) {
      notify(result.errorMessage);
    }
  };

  const handleRenameProject = async (projectId: string, title: string) => {
    return renameProjectAndSyncLoadedPlan({
      getCurrentLearningPlan: () => learningPlanRef.current,
      getCurrentProjectId: projectLibrary.getCurrentProjectId,
      projectId,
      renameProject: projectLibrary.renameProject,
      setLearningPlan: controller.setLearningPlan,
      title,
    });
  };

  const handlePageChange = useCallback(
    (page: NewHomePage) => {
      setFeedbackProductContext({
        ...(controller.currentProjectId
          ? {
              project: {
                id: controller.currentProjectId,
                ...(currentProjectRevision === undefined
                  ? {}
                  : { revision: currentProjectRevision }),
              },
            }
          : {}),
        ...(controller.activeSection ? { section: { id: controller.activeSection.id } } : {}),
        surface: isAssessmentActive ? 'assessment' : page,
      });
    },
    [
      controller.activeSection,
      controller.currentProjectId,
      currentProjectRevision,
      isAssessmentActive,
    ]
  );

  return (
    <>
      <input
        id={fileActions.sourceFileInputId}
        type="file"
        multiple
        className="hidden"
        onChange={event => {
          void handleHomeSourceFileUpload(event);
        }}
      />
      <NewHomeView
        chatProps={{
          assessmentComplete,
          assessmentMessages,
          homeChatMode: visibleHomeChatMode,
          isDarkMode: readerState.readerChrome.isDarkMode,
          isLibraryLoading,
          isLibraryModeLoading: libraryAssistantChat.isLoading,
          isNewCourseLoading,
          libraryAttachedContextRefs: libraryAssistantChat.attachedContextRefs,
          libraryArtifactPayloadsByToolCallId: libraryAssistantChat.artifactPayloadsByToolCallId,
          libraryFloatingArtifactPayloads: libraryAssistantChat.replacementDraftPayloads,
          libraryErrorMessage: libraryAssistantChat.error?.message || null,
          libraryMessages: libraryAssistantChat.messages,
          libraryTree: projectLibrary.libraryTree,
          libraryWebSearch: libraryAssistantChat.webSearch,
          libraryGenerateArtifacts: libraryAssistantChat.generateArtifacts,
          newCourseLoadingStatus:
            controller.workflowState.assessment.message || t('Caricamento...'),
          pendingFileName: pendingHomeSourceFiles[0]?.name || null,
          pendingFileNames: pendingHomeSourceFiles.map(file => file.name),
          onClearPendingFile: () => setPendingHomeSourceFiles([]),
          onClearLibraryMessages: libraryAssistantChat.clearLibraryMessages,
          onCancelNewCourse: cancelNewCourse,
          onContinueAssessment: () => setIsAddingAssessmentDetails(true),
          onConfirmGenerate: handleConfirmGenerate,
          onHomeChatModeChange: handleHomeChatModeChange,
          onLibraryMessageSend: libraryAssistantChat.sendLibraryMessage,
          onLibraryArtifactNoteApprove: libraryAssistantChat.approveLearningArtifactNoteSave,
          onLibraryArtifactNoteReject: libraryAssistantChat.rejectLearningArtifactNoteSave,
          onLibraryArtifactDiscard: libraryAssistantChat.discardLearningArtifact,
          onLibraryArtifactRegenerate: libraryAssistantChat.regenerateLearningArtifact,
          onLibraryArtifactReplace: libraryAssistantChat.replaceLearningArtifact,
          onLibraryWebSearchChange: libraryAssistantChat.setWebSearch,
          onLibraryGenerateArtifactsChange: libraryAssistantChat.setGenerateArtifacts,
          onSendAssessmentMessage: handleNewCourseMessage,
          onToggleLibraryContextRef: libraryAssistantChat.toggleAttachedContextRef,
          onUploadSourceClick: fileActions.handleUploadSourceClick,
        }}
        isDarkMode={readerState.readerChrome.isDarkMode}
        isExportingProject={fileActions.isExportingProject}
        isImportingProject={fileActions.isImportingProject}
        isLibraryLoading={isLibraryLoading}
        libraryFolders={projectLibrary.libraryFolders}
        libraryTree={projectLibrary.libraryTree}
        loadProjectCover={projectLibrary.loadStoredProjectCover}
        loadProjectSource={projectLibrary.loadStoredProjectSource}
        loadProjectsById={projectLibrary.loadProjectsById}
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
        onExportLibraryBackup={projectLibrary.downloadLibraryBackup}
        onExportProject={fileActions.handleExportProject}
        onImportLibraryBackup={projectLibrary.importLibraryBackup}
        onImportProjectFile={fileActions.handlePlanUpload}
        onOpenProject={projectId => {
          void navigation.handleOpenProject(projectId, { source: 'library' });
        }}
        onPageChange={handlePageChange}
        openingProjectId={openingProjectId}
        onRenameFolder={projectLibrary.renameFolder}
        onRenameProject={handleRenameProject}
        onSetProjectFavorite={projectLibrary.setProjectFavorite}
        onToggleDarkMode={() =>
          readerState.readerChrome.setIsDarkMode(!readerState.readerChrome.isDarkMode)
        }
        projects={savedProjects}
        saveProjectCover={projectLibrary.saveStoredProjectCover}
      />
    </>
  );
};
