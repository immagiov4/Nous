import { AppState } from './types';
import AssessmentView from './components/assessment/AssessmentView';
import LibraryView from './components/library/LibraryView';
import LoadingScreen from './components/shared/LoadingScreen';
import WorkspaceReaderShell from './components/workspace/WorkspaceReaderShell.tsx';
import type { WorkspaceReaderShellProps } from './components/workspace/shell/types.ts';
import { useProjectLibrary } from './hooks/library/useProjectLibrary.ts';
import { useWorkspaceAssessmentScreen } from './hooks/workspace/useWorkspaceAssessmentScreen.ts';
import { useWorkspaceController } from './hooks/workspace/useWorkspaceController.ts';
import { useWorkspaceDomain } from './hooks/workspace/useWorkspaceDomain.ts';
import { useWorkspaceFileActions } from './hooks/workspace/useWorkspaceFileActions.ts';
import { useWorkspaceNavigation } from './hooks/workspace/useWorkspaceNavigation.ts';
import { useWorkspaceReaderActions } from './hooks/workspace/useWorkspaceReaderActions.ts';
import { useWorkspaceReaderRuntime } from './hooks/workspace/useWorkspaceReaderRuntime.ts';
import { useUiPreferencesPersistence } from './hooks/workspace/useUiPreferencesPersistence.ts';
import { MODEL_ASSESSMENT, MODEL_CONTEXT, MODEL_REASONING } from './services/openrouter/index.ts';
import { useEffect, useState } from 'react';
import type { HomeChatToolPreferences } from './types.ts';
import { getLessonSourcePageLabel } from './utils/context/sourceMaterial.ts';

const notify = (message: string) => {
  window.alert(message);
};

const defaultModelConfig = {
  lessonModel: MODEL_REASONING,
  assessmentModel: MODEL_ASSESSMENT,
  contextModel: MODEL_CONTEXT,
};

const App = () => {
  const [assessmentComplete, setAssessmentComplete] = useState(false);
  const [pendingHomeSourceFile, setPendingHomeSourceFile] = useState<File | null>(null);
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
    isContextBusy,
    isLibraryLoading,
    learningPlan,
    musicUrl,
    needsSourceFile,
    openingProjectId,
    openProject,
    openSection,
    quiz,
    regenerateActiveSection,
    savedProjects,
    screenState,
    startHomeChat,
    sectionContent,
    setMusicUrl,
    startLearnJourney,
    storageError,
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
  const isContextLoading = isContextBusy;
  const isHomeChatLoading = workflowState.assessment.status === 'pending';
  const homeChatLoadingStatus = workflowState.assessment.message || 'Caricamento...';
  const loadingStatus = blockingMessage || 'Caricamento...';
  const activeSectionSourcePageRangeLabel = getLessonSourcePageLabel({
    activeSection,
    documentIndex: controller.documentIndex,
  });
  const handleHomeSourceFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0] || null;
    setPendingHomeSourceFile(selectedFile);
    if (event.target) {
      event.target.value = '';
    }
  };

  const handleHomeChatSubmit = async (
    message: string,
    options?: { toolPreferences?: HomeChatToolPreferences }
  ) => {
    const result = assessmentMessages.length
      ? await submitAssessment(message, options?.toolPreferences)
      : await startHomeChat({
          input: message,
          selectedFile: pendingHomeSourceFile,
          toolPreferences: options?.toolPreferences,
        });

    if (result.outcome === 'assessment-complete') {
      setAssessmentComplete(true);
    } else if (result.outcome === 'continued') {
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
  const playerCurrentChunkIsLoading =
    readerRuntime.ttsPlayer.audioState.chunks[readerRuntime.ttsPlayer.audioState.currentChunkIndex]
      ?.isLoading || false;
  const readerShellProps = {
    audioPlayer: {
      audioDockOffset: readerRuntime.readerChrome.audioDockOffset,
      audioState: readerRuntime.ttsPlayer.audioState,
      availableVoices: readerRuntime.ttsPlayer.availableVoices,
      currentTime: readerRuntime.ttsPlayer.playerCurrentTime,
      duration: readerRuntime.ttsPlayer.playerDuration,
      onPlayPause: readerRuntime.ttsPlayer.togglePlayPause,
      onSeek: readerRuntime.ttsPlayer.handleSeek,
      onSkipChunk: readerRuntime.ttsPlayer.handleSkipChunk,
      onSpeedChange: readerRuntime.ttsPlayer.handleSpeedChange,
      onVoiceChange: readerRuntime.ttsPlayer.handleVoiceChange,
      playerCurrentChunkIsLoading,
      sectionContent,
      ttsConnected: readerRuntime.ttsPlayer.ttsConnected,
    },
    banners: {
      needsSourceFile,
      onAttachSourceFile: handleAttachSourceFile,
      onBackToLibrary: handleBackToLibrary,
      onExportProject: () => {
        void handleExportProject();
      },
      storageError,
    },
    content: {
      activeSectionAssetsById: readerRuntime.activeSectionAssetsById,
      activeSectionImageRefsById: readerRuntime.activeSectionImageRefsById,
      contentRef: readerRuntime.contentRef,
      isDarkMode: readerRuntime.readerChrome.isDarkMode,
      isFocusMode: readerRuntime.readerChrome.isFocusMode,
      isLoading,
      isMobileViewport: readerRuntime.readerChrome.isMobileViewport,
      isQuizSubmitted: readerRuntime.isQuizSubmitted,
      onCompleteSection: () => {
        void readerActions.handleCompleteSection();
      },
      onContentClick: readerRuntime.readerContext.handleContentClick,
      onContentContextMenu: readerRuntime.readerContext.handleContentContextMenu,
      onContentPointerDownCapture:
        readerRuntime.readerContext.handleContentPointerDownCapture,
      onSelectQuizAnswer: readerRuntime.handleSelectQuizAnswer,
      onSetIsQuizSubmitted: readerRuntime.setIsQuizSubmitted,
      quiz,
      quizAnswers: readerRuntime.quizAnswers,
      scrollContainerRef: readerRuntime.scrollContainerRef,
      sectionAnnotations: activeSection?.annotations,
      sectionContent,
      sourcePageRangeLabel: activeSectionSourcePageRangeLabel,
    },
    header: {
      activeSection,
      activeSidebarGroup: readerRuntime.activeSidebarGroup,
      isDarkMode: readerRuntime.readerChrome.isDarkMode,
      isFocusMode: readerRuntime.readerChrome.isFocusMode,
      isLoading,
      isMobileViewport: readerRuntime.readerChrome.isMobileViewport,
      isMobileSidebarOpen: readerRuntime.readerChrome.isMobileSidebarOpen,
      isMusicPlaying: readerRuntime.isMusicPlaying,
      isSettingsOpen: readerRuntime.readerChrome.isSettingsOpen,
      learningPlanTitle: learningPlan?.title || 'Percorso di Studio',
      loadingStatus,
      modelDefaults: defaultModelConfig,
      musicUrl,
      musicVolume: readerRuntime.musicVolume,
      onBackToLibrary: handleBackToLibrary,
      onOpenSidebar: () => readerRuntime.readerChrome.setIsMobileSidebarOpen(v => !v),
      onRegenerateActiveSection: readerActions.handleRegenerateActiveSection,
      onSetDarkMode: readerRuntime.readerChrome.setIsDarkMode,
      onSetFocusMode: readerRuntime.readerChrome.setIsFocusMode,
      onSetIsMusicPlaying: readerRuntime.setIsMusicPlaying,
      onSetMusicUrl: setMusicUrl,
      onSetMusicVolume: readerRuntime.setMusicVolume,
      onSetPreferredOpenRouterModel: readerRuntime.setPreferredOpenRouterModel,
      onSetSettingsOpen: readerRuntime.readerChrome.setIsSettingsOpen,
      preferredModels: readerRuntime.preferredModels,
    },
    overlays: {
      contextAnswer: readerRuntime.readerContext.contextAnswer,
      contextAnswerPanelRef: readerRuntime.readerContext.contextAnswerPanelRef,
      contextAnswerResizePreviewRef: readerRuntime.readerContext.contextAnswerResizePreviewRef,
      contextAnswerSize: readerRuntime.readerContext.contextAnswerSize,
      contextMenu: readerRuntime.readerContext.contextMenu,
      contextMenuRef: readerRuntime.readerContext.contextMenuRef,
      handleContextAnswerResizeStart: readerRuntime.readerContext.handleContextAnswerResizeStart,
      isContextLoading,
      isDarkMode: readerRuntime.readerChrome.isDarkMode,
      isMobileViewport: readerRuntime.readerChrome.isMobileViewport,
      onAskContextQuestion: readerActions.handleContextQuestion,
      onCloseContextAnswer: readerRuntime.readerContext.closeContextAnswer,
      onCloseContextMenu: readerRuntime.readerContext.closeContextMenu,
      onCreateLesson: readerActions.handleCreateLesson,
      onDeleteAnnotation: readerActions.handleDeleteAnnotation,
      onHighlight: readerActions.handleHighlight,
      onSaveConversationNote: readerActions.handleSaveConversationNote,
      onUpdateConversationNote: readerActions.handleUpdateConversationNote,
      onSaveNote: readerActions.handleSaveNote,
    },
    shouldUseDesktopSidebar: readerRuntime.readerChrome.shouldUseDesktopSidebar,
    sidebar: {
      activeSectionId,
      expandedModuleId: readerRuntime.readerChrome.expandedModuleId,
      isLoading,
      isMobileViewport: readerRuntime.readerChrome.isMobileViewport,
      learningPlanTitle: learningPlan?.title || 'Percorso di Studio',
      onBackToLibrary: handleBackToLibrary,
      onExportProject: () => {
        void handleExportProject();
      },
      onModuleToggle: readerRuntime.readerChrome.handleModuleToggle,
      onSelectSection: readerActions.handleSelectSection,
      onSetFocusMode: readerRuntime.readerChrome.setIsFocusMode,
      onSetIsMobileSidebarOpen: readerRuntime.readerChrome.setIsMobileSidebarOpen,
      shouldShowSidebar: readerRuntime.readerChrome.shouldShowSidebar,
      sidebarGroups: readerRuntime.sidebarGroups,
    },
  } satisfies WorkspaceReaderShellProps;

  if (screenState === AppState.LIBRARY) {
    return (
      <LibraryView
        assessmentComplete={assessmentComplete}
        assessmentMessages={assessmentMessages}
        isDarkMode={readerRuntime.readerChrome.isDarkMode}
        isLibraryLoading={isLibraryLoading}
        isWorking={isHomeChatLoading}
        loadingStatus={homeChatLoadingStatus}
        modelDefaults={defaultModelConfig}
        openingProjectId={openingProjectId}
        planFileInputId={planFileInputId}
        preferredModels={readerRuntime.preferredModels}
        projects={savedProjects}
        pendingHomeFileName={pendingHomeSourceFile?.name || null}
        sourceFileInputId={sourceFileInputId}
        storageError={storageError}
        onClearPendingHomeFile={() => setPendingHomeSourceFile(null)}
        onConfirmGenerate={handleConfirmGenerate}
        onDeleteProject={handleDeleteProject}
        onExportProject={projectId => {
          void handleExportProject(projectId);
        }}
        onHomeChatSubmit={handleHomeChatSubmit}
        onImportJsonClick={handleImportJsonClick}
        onOpenProject={projectId => {
          void handleOpenProject(projectId, { source: 'library' });
        }}
        onPlanUpload={event => {
          void handlePlanUpload(event);
        }}
        onSetPreferredOpenRouterModel={readerRuntime.setPreferredOpenRouterModel}
        onSourceFileUpload={handleHomeSourceFileUpload}
        onToggleDarkMode={() =>
          readerRuntime.readerChrome.setIsDarkMode(!readerRuntime.readerChrome.isDarkMode)
        }
        onUploadSourceClick={handleUploadSourceClick}
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
        subMessage="Strutturazione semantica del piano di studi..."
      />
    );
  }

  if (screenState === AppState.PLANNING) {
    return (
      <LoadingScreen
        message="Analisi Volume in Corso..."
        subMessage={loadingStatus || 'Costruzione piano...'}
      />
    );
  }

  return (
    <>
      <input id={sourceFileInputId} type="file" className="hidden" onChange={handleFileUpload} />
      <WorkspaceReaderShell {...readerShellProps} />
    </>
  );
};

export default App;
