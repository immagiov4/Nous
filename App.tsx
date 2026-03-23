import { AppState } from './types';
import AssessmentView from './components/AssessmentView';
import LibraryView from './components/LibraryView';
import LoadingScreen from './components/LoadingScreen';
import WorkspaceReaderShell from './components/WorkspaceReaderShell.tsx';
import type { WorkspaceReaderShellProps } from './components/workspace-reader-shell/types.ts';
import { useProjectLibrary } from './hooks/useProjectLibrary.ts';
import { useWorkspaceAssessmentScreen } from './hooks/useWorkspaceAssessmentScreen.ts';
import { useWorkspaceController } from './hooks/useWorkspaceController.ts';
import { useWorkspaceDomain } from './hooks/useWorkspaceDomain.ts';
import { useWorkspaceFileActions } from './hooks/useWorkspaceFileActions.ts';
import { useWorkspaceNavigation } from './hooks/useWorkspaceNavigation.ts';
import { useWorkspaceReaderActions } from './hooks/useWorkspaceReaderActions.ts';
import { useWorkspaceReaderRuntime } from './hooks/useWorkspaceReaderRuntime.ts';
import { useUiPreferencesPersistence } from './hooks/useUiPreferencesPersistence.ts';
import { MODEL_ASSESSMENT, MODEL_CONTEXT, MODEL_REASONING } from './services/geminiService.ts';

const notify = (message: string) => {
  window.alert(message);
};

const defaultModelConfig = {
  lessonModel: MODEL_REASONING,
  assessmentModel: MODEL_ASSESSMENT,
  contextModel: MODEL_CONTEXT,
};

const App = () => {
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
    sectionContent,
    setMusicUrl,
    startLearnJourney,
    storageError,
    submitAssessment,
    updateActiveSectionContent,
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
    isMobileViewport: readerRuntime.readerChrome.isMobileViewport,
    learningPlan,
    notify,
    openContextAnswer: readerRuntime.readerContext.openContextAnswer,
    openSection,
    regenerateActiveSection,
    sectionContent,
    setIsMobileSidebarOpen: readerRuntime.readerChrome.setIsMobileSidebarOpen,
    updateActiveSectionContent,
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

  const isLoading = isBlocking;
  const isContextLoading = isContextBusy;
  const loadingStatus = blockingMessage || 'Caricamento...';
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
      isAudioSyncLinked: readerRuntime.ttsPlayer.isAudioSyncLinked,
      onPlayPause: readerRuntime.ttsPlayer.togglePlayPause,
      onSeek: readerRuntime.ttsPlayer.handleSeek,
      onSkipChunk: readerRuntime.ttsPlayer.handleSkipChunk,
      onSpeedChange: readerRuntime.ttsPlayer.handleSpeedChange,
      onToggleAudioSyncLink: readerRuntime.ttsPlayer.handleToggleAudioSyncLink,
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
      isAutoTrackEnabled: readerRuntime.ttsPlayer.isAutoTrackEnabled,
      isDarkMode: readerRuntime.readerChrome.isDarkMode,
      isFocusMode: readerRuntime.readerChrome.isFocusMode,
      isLoading,
      isMobileViewport: readerRuntime.readerChrome.isMobileViewport,
      isQuizSubmitted: readerRuntime.isQuizSubmitted,
      onCompleteSection: () => {
        void readerActions.handleCompleteSection();
      },
      onContentContextMenu: readerRuntime.readerContext.handleContentContextMenu,
      onSelectQuizAnswer: readerRuntime.handleSelectQuizAnswer,
      onSetIsQuizSubmitted: readerRuntime.setIsQuizSubmitted,
      quiz,
      quizAnswers: readerRuntime.quizAnswers,
      scrollContainerRef: readerRuntime.scrollContainerRef,
      sectionContent,
    },
    header: {
      activeSection,
      activeSidebarGroup: readerRuntime.activeSidebarGroup,
      audioState: readerRuntime.ttsPlayer.audioState,
      isDarkMode: readerRuntime.readerChrome.isDarkMode,
      isFocusMode: readerRuntime.readerChrome.isFocusMode,
      isHeaderHovered: readerRuntime.readerChrome.isHeaderHovered,
      isLoading,
      isMobileViewport: readerRuntime.readerChrome.isMobileViewport,
      isMusicPlaying: readerRuntime.isMusicPlaying,
      isRulerActive: readerRuntime.ttsPlayer.isRulerActive,
      isSettingsOpen: readerRuntime.readerChrome.isSettingsOpen,
      learningPlanTitle: learningPlan?.title || 'Percorso di Studio',
      loadingStatus,
      modelDefaults: defaultModelConfig,
      musicUrl,
      musicVolume: readerRuntime.musicVolume,
      onBackToLibrary: handleBackToLibrary,
      onOpenSidebar: () => readerRuntime.readerChrome.setIsMobileSidebarOpen(true),
      onRegenerateActiveSection: readerActions.handleRegenerateActiveSection,
      onSetDarkMode: readerRuntime.readerChrome.setIsDarkMode,
      onSetFocusMode: readerRuntime.readerChrome.setIsFocusMode,
      onSetIsMusicPlaying: readerRuntime.setIsMusicPlaying,
      onSetMusicUrl: setMusicUrl,
      onSetMusicVolume: readerRuntime.setMusicVolume,
      onSetPreferredOpenRouterModel: readerRuntime.setPreferredOpenRouterModel,
      onSetSettingsOpen: readerRuntime.readerChrome.setIsSettingsOpen,
      onSetTeleprompterSpeed: readerRuntime.readerChrome.setTeleprompterSpeed,
      onToggleRuler: readerRuntime.ttsPlayer.handleToggleRuler,
      preferredModels: readerRuntime.preferredModels,
      teleprompterSpeed: readerRuntime.readerChrome.teleprompterSpeed,
    },
    overlays: {
      contextAnswer: readerRuntime.readerContext.contextAnswer,
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
      onHighlight: readerActions.handleHighlight,
    },
    ruler: {
      calibrationOffset: readerRuntime.ttsPlayer.calibrationOffset,
      contentRef: readerRuntime.contentRef,
      isHeaderHovered: readerRuntime.readerChrome.isHeaderHovered,
      isPlaying: readerRuntime.ttsPlayer.audioState.isPlaying,
      isRulerActive: readerRuntime.ttsPlayer.isRulerActive,
      scrollContainerRef: readerRuntime.scrollContainerRef,
      teleprompterSpeed: readerRuntime.readerChrome.teleprompterSpeed,
      visualProgress: readerRuntime.ttsPlayer.visualProgress,
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
        isDarkMode={readerRuntime.readerChrome.isDarkMode}
        isLibraryLoading={isLibraryLoading}
        isWorking={isLoading}
        loadingStatus={loadingStatus}
        modelDefaults={defaultModelConfig}
        openingProjectId={openingProjectId}
        planFileInputId={planFileInputId}
        preferredModels={readerRuntime.preferredModels}
        projects={savedProjects}
        sourceFileInputId={sourceFileInputId}
        storageError={storageError}
        onDeleteProject={handleDeleteProject}
        onExportProject={projectId => {
          void handleExportProject(projectId);
        }}
        onImportJsonClick={handleImportJsonClick}
        onOpenProject={projectId => {
          void handleOpenProject(projectId, { source: 'library' });
        }}
        onPlanUpload={event => {
          void handlePlanUpload(event);
        }}
        onSetPreferredOpenRouterModel={readerRuntime.setPreferredOpenRouterModel}
        onSourceFileUpload={event => {
          void handleFileUpload(event);
        }}
        onStartLearnJourney={() => {
          void assessmentScreen.handleStartLearnJourney();
        }}
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
