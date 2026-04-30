/* @refresh reset */
import { useEffect, useState } from 'react';
import { defaultModelConfig } from './app/modelDefaults.ts';
import { resolvePdfMappingWarning } from './app/pdfMappingWarning.ts';
import { buildReaderShellProps } from './app/readerShellProps.ts';
import { useAppDialogs } from './app/useAppDialogs.tsx';
import { useInitialSectionAutoOpen } from './app/useInitialSectionAutoOpen.ts';
import AssessmentView from './components/assessment/AssessmentView';
import LibraryView from './components/library/LibraryView';
import LoadingScreen from './components/shared/LoadingScreen';
import CourseGenerationNotesDialog from './components/workspace/CourseGenerationNotesDialog.tsx';
import WorkspaceReaderShell from './components/workspace/WorkspaceReaderShell.tsx';
import { useLibraryAssistantChat } from './hooks/library/useLibraryAssistantChat.ts';
import { useProjectLibrary } from './hooks/library/useProjectLibrary.ts';
import { useUiPreferencesPersistence } from './hooks/workspace/useUiPreferencesPersistence.ts';
import { useWorkspaceAssessmentScreen } from './hooks/workspace/useWorkspaceAssessmentScreen.ts';
import { useWorkspaceController } from './hooks/workspace/useWorkspaceController.ts';
import { useWorkspaceDomain } from './hooks/workspace/useWorkspaceDomain.ts';
import { useWorkspaceFileActions } from './hooks/workspace/useWorkspaceFileActions.ts';
import { useWorkspaceNavigation } from './hooks/workspace/useWorkspaceNavigation.ts';
import { useWorkspaceReaderActions } from './hooks/workspace/useWorkspaceReaderActions.ts';
import { useWorkspaceReaderRuntime } from './hooks/workspace/useWorkspaceReaderRuntime.ts';
import { selectBlockingReasoning } from './services/workspace/workflow.ts';
import { AppState } from './types';
import type { HomeChatMode, HomeChatToolPreferences } from './types.ts';

const App = () => {
  const [assessmentComplete, setAssessmentComplete] = useState(false);
  const [homeChatMode, setHomeChatMode] = useState<HomeChatMode>('new-course');
  const [pendingHomeSourceFile, setPendingHomeSourceFile] = useState<File | null>(null);
  const { appOverlays, notify, requestConfirmation } = useAppDialogs();
  const domain = useWorkspaceDomain();
  const readerRuntime = useWorkspaceReaderRuntime({
    activeSection: domain.activeSection,
    activeSectionId: domain.activeSectionId,
    documentAssets: domain.documentAssets,
    learningPlan: domain.learningPlan,
    quiz: domain.quiz,
    sectionContent: domain.sectionContent,
    syllabus: domain.syllabus,
  });

  useUiPreferencesPersistence({
    uiPreferences: readerRuntime.uiPreferences,
    applyUiPreferences: readerRuntime.applyUiPreferences,
  });

  const projectLibrary = useProjectLibrary({
    domainState: domain.domainState,
  });
  const libraryAssistantChat = useLibraryAssistantChat({
    folders: projectLibrary.libraryFolders,
    loadProjectsById: projectLibrary.loadProjectsById,
    preferredContextModel: readerRuntime.preferredModels.preferredContextModel,
    projectRepositoryMode: projectLibrary.projectRepositoryMode,
    projects: projectLibrary.savedProjects,
    tree: projectLibrary.libraryTree,
  });

  const controller = useWorkspaceController({
    domain,
    projectLibrary,
    stopAudio: readerRuntime.ttsPlayer.stopAudio,
  });

  const {
    activeSection,
    activeSectionId,
    assessmentMessages,
    askContextQuestion,
    blockingMessage,
    completeActiveSection,
    confirmPlanGeneration,
    createLessonFromSelection,
    currentProjectId,
    deleteProject,
    exportProject,
    goToLibrary,
    handleSourceUpload,
    importProjectFile,
    isBlocking,
    isLibraryLoading,
    learningPlan,
    openingProjectId,
    openProject,
    openSection,
    regenerateActiveSection,
    savedProjects,
    screenState,
    startHomeChat,
    sectionContent,
    setGenerationNotes,
    startLearnJourney,
    projectRepositoryMode,
    setProjectRepositoryMode,
    storageError,
    transferFolderToLan,
    transferProjectToLan,
    submitAssessment,
    updateSection,
    workflowState,
  } = controller;

  const assessmentScreen = useWorkspaceAssessmentScreen({
    assessmentMessages,
    notify,
    screenState,
    startLearnJourney,
    submitAssessment,
  });

  const { acknowledgeGenerationNotesDialog, isNotesDialogOpen } = useInitialSectionAutoOpen({
    activeSection,
    currentProjectId,
    isBlocking,
    learningPlan,
    openSection,
    screenState,
  });

  const readerActions = useWorkspaceReaderActions({
    activeSectionId,
    askContextQuestion,
    closeContextMenu: readerRuntime.readerContext.closeContextMenu,
    completeActiveSection,
    contextMenu: readerRuntime.readerContext.contextMenu,
    createLessonFromSelection,
    documentIndex: controller.documentIndex,
    isMobileViewport: readerRuntime.readerChrome.isMobileViewport,
    learningPlan,
    notify,
    openContextAnswer: readerRuntime.readerContext.openContextAnswer,
    openSection,
    regenerateActiveSection,
    sectionContent,
    setIsMobileSidebarOpen: readerRuntime.readerChrome.setIsMobileSidebarOpen,
    source: controller.source,
    updateSection,
  });

  const {
    handleAttachSourceFile,
    handleDeleteProject,
    handleExportProject,
    handleFileUpload,
    handleImportJsonClick,
    handlePlanUpload,
    handleUploadSourceClick,
    planFileInputId,
    sourceFileInputId,
  } = useWorkspaceFileActions({
    confirmProjectDelete: projectTitle =>
      requestConfirmation({
        title: 'Eliminare corso',
        message: `Eliminare "${projectTitle}" dalla libreria locale?`,
        confirmLabel: 'Elimina',
      }),
    deleteProject,
    exportProject,
    handleSourceUpload,
    importProjectFile,
    notifyError: notify,
    savedProjects,
  });

  const { handleBackToLibrary, handleOpenProject } = useWorkspaceNavigation({
    currentProjectId,
    isLibraryLoading,
    notifyError: notify,
    onGoToLibrary: goToLibrary,
    onOpenProject: openProject,
    openingProjectId,
    screenState,
    setIsFocusMode: readerRuntime.readerChrome.setIsFocusMode,
    setIsMobileSidebarOpen: readerRuntime.readerChrome.setIsMobileSidebarOpen,
  });

  useEffect(() => {
    if (screenState !== AppState.READING) {
      readerRuntime.readerContext.closeContextMenu();
    }
  }, [screenState, readerRuntime.readerContext.closeContextMenu]);

  useEffect(() => {
    if (screenState === AppState.LIBRARY || typeof window === 'undefined') {
      return;
    }

    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [screenState]);

  const isLoading = isBlocking;
  const isHomeChatLoading = workflowState.assessment.status === 'pending';
  const homeChatLoadingStatus = workflowState.assessment.message || 'Caricamento...';
  const loadingStatus = blockingMessage || 'Caricamento...';
  const loadingReasoningText = selectBlockingReasoning(workflowState);
  const pdfMappingWarning = resolvePdfMappingWarning(domain.source, controller.documentIndex);
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
  const readerShellProps = buildReaderShellProps({
    controller,
    handleAttachSourceFile,
    handleBackToLibrary,
    handleExportProject,
    modelDefaults: defaultModelConfig,
    notify,
    pdfMappingWarning,
    readerActions,
    readerRuntime,
  });

  const screen = (() => {
    if (screenState === AppState.LIBRARY) {
      return (
        <LibraryView
          assessmentComplete={assessmentComplete}
          assessmentMessages={assessmentMessages}
          homeChatMode={homeChatMode}
          isDarkMode={readerRuntime.readerChrome.isDarkMode}
          isLibraryLoading={isLibraryLoading}
          isLibraryQueryLoading={libraryAssistantChat.isLoading}
          isNewCourseLoading={isHomeChatLoading}
          libraryAttachedContextRefs={libraryAssistantChat.attachedContextRefs}
          libraryErrorMessage={libraryAssistantChat.error?.message || null}
          libraryMessages={libraryAssistantChat.messages}
          libraryScopeSummary={libraryAssistantChat.scopeSummary}
          libraryTree={projectLibrary.libraryTree}
          libraryWebSearch={libraryAssistantChat.webSearch}
          modelDefaults={defaultModelConfig}
          newCourseLoadingStatus={homeChatLoadingStatus}
          openingProjectId={openingProjectId}
          planFileInputId={planFileInputId}
          preferredModels={readerRuntime.preferredModels}
          projects={savedProjects}
          pendingHomeFileName={pendingHomeSourceFile?.name || null}
          sourceFileInputId={sourceFileInputId}
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
          onDeleteProject={handleDeleteProject}
          onExportProject={projectId => {
            void handleExportProject(projectId);
          }}
          onHomeChatModeChange={setHomeChatMode}
          onImportJsonClick={handleImportJsonClick}
          onLibraryAssistantSend={libraryAssistantChat.sendLibraryMessage}
          onLibraryWebSearchChange={libraryAssistantChat.setWebSearch}
          onMoveFolder={projectLibrary.moveFolder}
          onMoveProjects={projectLibrary.moveProjects}
          onOpenProject={projectId => {
            void handleOpenProject(projectId, { source: 'library' });
          }}
          onPlanUpload={event => {
            void handlePlanUpload(event);
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
          onUploadSourceClick={handleUploadSourceClick}
          projectRepositoryMode={projectRepositoryMode}
        />
      );
    }

    if (screenState === AppState.ASSESSMENT) {
      return (
        <AssessmentView
          assessmentInputId={assessmentScreen.assessmentInputId}
          assessmentInputRef={assessmentScreen.assessmentInputRef}
          currentAssessmentInput={assessmentScreen.currentAssessmentInput}
          isDarkMode={readerRuntime.readerChrome.isDarkMode}
          isLoading={isLoading}
          loadingStatus={loadingStatus}
          messages={assessmentMessages}
          messagesEndRef={assessmentScreen.messagesEndRef}
          modelDefaults={defaultModelConfig}
          onBackToLibrary={handleBackToLibrary}
          onInputChange={assessmentScreen.setCurrentAssessmentInput}
          onSetPreferredOpenRouterModel={readerRuntime.setPreferredOpenRouterModel}
          onSubmit={assessmentScreen.handleAssessmentSubmit}
          preferredModels={readerRuntime.preferredModels}
        />
      );
    }

    // Anteprima dell'UI di caricamento per il debug (aggiungi #preview-loading all'URL)
    if (typeof window !== 'undefined' && window.location.hash === '#preview-loading') {
      return (
        <LoadingScreen
          message="Analisi Volume in Corso..."
          isDarkMode={readerRuntime.readerChrome.isDarkMode}
          subMessage="Strutturazione semantica del piano di studi..."
        />
      );
    }

    if (screenState === AppState.PLANNING) {
      return (
        <LoadingScreen
          message="Analisi Volume in Corso..."
          isDarkMode={readerRuntime.readerChrome.isDarkMode}
          reasoningText={loadingReasoningText}
          subMessage={loadingStatus || 'Costruzione piano...'}
        />
      );
    }

    return (
      <>
        <input id={sourceFileInputId} type="file" className="hidden" onChange={handleFileUpload} />
        <WorkspaceReaderShell {...readerShellProps} />
        {isNotesDialogOpen && learningPlan ? (
          <CourseGenerationNotesDialog
            courseTitle={learningPlan.title || 'Percorso di Studio'}
            initialValue={learningPlan.generationNotes ?? ''}
            onSaveAndContinue={notes => {
              setGenerationNotes(notes);
              acknowledgeGenerationNotesDialog();
            }}
            onSkip={acknowledgeGenerationNotesDialog}
          />
        ) : null}
      </>
    );
  })();

  return (
    <>
      {screen}
      {appOverlays}
    </>
  );
};

export default App;
