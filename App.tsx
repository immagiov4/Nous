import { useEffect, useRef, useState } from 'react';
import AssessmentView from './components/assessment/AssessmentView';
import LibraryView from './components/library/LibraryView';
import LoadingScreen from './components/shared/LoadingScreen';
import type { WorkspaceReaderShellProps } from './components/workspace/shell/types.ts';
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
import { selectActiveLaboratoryExercise } from './services/laboratory/state.ts';
import { MODEL_ASSESSMENT, MODEL_CONTEXT, MODEL_REASONING } from './services/openrouter/index.ts';
import { selectIsLaboratoryBusy, selectLaboratoryMessage } from './services/workspace/workflow.ts';
import { AppState } from './types';
import type { HomeChatMode, HomeChatToolPreferences } from './types.ts';
import {
  getLaboratorySourcePageLabel,
  getLessonSourcePageLabel,
} from './utils/context/sourceMaterial.ts';

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
  const [homeChatMode, setHomeChatMode] = useState<HomeChatMode>('new-course');
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
  const libraryAssistantChat = useLibraryAssistantChat({
    folders: projectLibrary.libraryFolders,
    loadProjectsById: projectLibrary.loadProjectsById,
    preferredContextModel: readerRuntime.preferredModels.preferredContextModel,
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
    activeLaboratoryExerciseId,
    addLaboratoryTextAttachment,
    assessmentMessages,
    askContextQuestion,
    attachLaboratoryFiles,
    blockingMessage,
    completeActiveSection,
    confirmPlanGeneration,
    createLessonFromSelection,
    currentProjectId,
    deleteProject,
    evaluateActiveLaboratoryExercise,
    exportProject,
    generateLaboratory,
    goToLibrary,
    handleSourceUpload,
    importProjectFile,
    isBlocking,
    isContextBusy,
    isLibraryLoading,
    laboratory,
    learningPlan,
    musicUrl,
    needsSourceFile,
    openingProjectId,
    openLaboratoryExercise,
    openProject,
    openSection,
    quiz,
    regenerateActiveLaboratoryExercise,
    regenerateActiveSection,
    removeLaboratoryAttachment,
    savedProjects,
    screenState,
    startHomeChat,
    sectionContent,
    setGenerationNotes,
    setMusicUrl,
    startLearnJourney,
    storageError,
    submitAssessment,
    updateLaboratoryAttachmentMetadata,
    updateLaboratoryTextAttachment,
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

  const [isNotesDialogOpen, setIsNotesDialogOpen] = useState(false);
  const notesDialogAckedPlanIdsRef = useRef<Set<string>>(new Set());
  const autoOpenAttemptedSectionIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (screenState !== AppState.READING || !learningPlan || !activeSection || isBlocking) {
      return;
    }
    if (activeSection.content) {
      return;
    }
    if (autoOpenAttemptedSectionIdsRef.current.has(activeSection.id)) {
      return;
    }

    const planHasGeneratedContent = learningPlan.sections.some(
      section => Boolean(section.content)
    );
    const notes = learningPlan.generationNotes?.trim() || '';
    const ackKey = currentProjectId || learningPlan.title;
    const shouldShowDialog =
      !planHasGeneratedContent &&
      !notes &&
      !notesDialogAckedPlanIdsRef.current.has(ackKey) &&
      !isNotesDialogOpen;

    if (shouldShowDialog) {
      setIsNotesDialogOpen(true);
      return;
    }

    autoOpenAttemptedSectionIdsRef.current.add(activeSection.id);
    void openSection(activeSection);
  }, [
    activeSection,
    currentProjectId,
    isBlocking,
    isNotesDialogOpen,
    learningPlan,
    openSection,
    screenState,
  ]);

  useEffect(() => {
    autoOpenAttemptedSectionIdsRef.current = new Set();
  }, [currentProjectId]);

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
  const isLaboratoryBusy = selectIsLaboratoryBusy(workflowState);
  const isLaboratoryGenerating = workflowState.generateLaboratory.status === 'pending';
  const isLaboratoryEvaluating = workflowState.evaluateLaboratory.status === 'pending';
  const laboratoryActivityMessage =
    selectLaboratoryMessage(workflowState) || 'Laboratorio in corso...';
  const isHomeChatLoading = workflowState.assessment.status === 'pending';
  const homeChatLoadingStatus = workflowState.assessment.message || 'Caricamento...';
  const loadingStatus = blockingMessage || 'Caricamento...';
  const activeSectionSourcePageRangeLabel = getLessonSourcePageLabel({
    activeSection,
    documentIndex: controller.documentIndex,
  });
  const activeLaboratoryExercise = selectActiveLaboratoryExercise(
    laboratory,
    activeLaboratoryExerciseId
  );
  const activeLaboratorySourcePageRangeLabel = getLaboratorySourcePageLabel({
    activeExercise: activeLaboratoryExercise,
    documentIndex: controller.documentIndex,
  });
  const isLaboratoryView = !activeSectionId && Boolean(laboratory);
  const headerIsLoading = isLoading || (isLaboratoryView && isLaboratoryBusy);
  const headerLoadingStatus = isLoading ? loadingStatus : laboratoryActivityMessage;
  const handleHomeSourceFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0] || null;
    setPendingHomeSourceFile(selectedFile);
    if (event.target) {
      event.target.value = '';
    }
  };

  const handleNewCourseMessage = async (message: string) => {
    const toolPreferences: HomeChatToolPreferences = {
      mode: 'new-course',
      newCourse: true,
    };
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
      isLaboratoryEvaluating,
      isLaboratoryGenerating,
      isLaboratoryView,
      isMobileViewport: readerRuntime.readerChrome.isMobileViewport,
      isQuizSubmitted: readerRuntime.isQuizSubmitted,
      activeLaboratoryExercise,
      laboratoryActivityMessage,
      laboratoryErrorMessage: laboratory?.errorMessage,
      laboratorySourcePageRangeLabel: activeLaboratorySourcePageRangeLabel,
      laboratoryStatus: laboratory?.status || null,
      laboratorySummary: laboratory?.summary || '',
      laboratoryTitle: laboratory?.title || 'Laboratorio',
      onAddLaboratoryTextAttachment: () => {
        void addLaboratoryTextAttachment().then(result => {
          if (result.errorMessage) {
            notify(result.errorMessage);
          }
        });
      },
      onAttachLaboratoryFiles: files => {
        if (!files?.length) {
          return;
        }

        void attachLaboratoryFiles(files).then(result => {
          if (result.errorMessage) {
            notify(result.errorMessage);
          }
        });
      },
      onCompleteSection: () => {
        void readerActions.handleCompleteSection();
      },
      onContentClick: readerRuntime.readerContext.handleContentClick,
      onContentContextMenu: readerRuntime.readerContext.handleContentContextMenu,
      onContentPointerDownCapture: readerRuntime.readerContext.handleContentPointerDownCapture,
      onEvaluateActiveLaboratoryExercise: () => {
        void evaluateActiveLaboratoryExercise().then(result => {
          if (result.errorMessage) {
            notify(result.errorMessage);
          }
        });
      },
      onGenerateLaboratory: () => {
        void generateLaboratory({ openFirstExercise: true }).then(result => {
          if (result.errorMessage) {
            notify(result.errorMessage);
          }
        });
      },
      onRemoveLaboratoryAttachment: attachmentId => {
        void removeLaboratoryAttachment(attachmentId).then(result => {
          if (result.errorMessage) {
            notify(result.errorMessage);
          }
        });
      },
      onSelectQuizAnswer: readerRuntime.handleSelectQuizAnswer,
      onSetIsQuizSubmitted: readerRuntime.setIsQuizSubmitted,
      onUpdateLaboratoryAttachmentMetadata: (attachmentId, updates) => {
        void updateLaboratoryAttachmentMetadata(attachmentId, updates);
      },
      onUpdateLaboratoryTextAttachment: (attachmentId, updates) => {
        void updateLaboratoryTextAttachment(attachmentId, updates);
      },
      quiz,
      quizAnswers: readerRuntime.quizAnswers,
      scrollContainerRef: readerRuntime.scrollContainerRef,
      sectionAnnotations: activeSection?.annotations,
      sectionContent,
      sourcePageRangeLabel: activeSectionSourcePageRangeLabel,
    },
    header: {
      activeLaboratoryExercise,
      activeSection,
      activeSidebarGroup: readerRuntime.activeSidebarGroup,
      courseGenerationNotes: learningPlan?.generationNotes ?? '',
      isDarkMode: readerRuntime.readerChrome.isDarkMode,
      isFocusMode: readerRuntime.readerChrome.isFocusMode,
      isLoading: headerIsLoading,
      isLaboratoryView,
      isMobileViewport: readerRuntime.readerChrome.isMobileViewport,
      isMobileSidebarOpen: readerRuntime.readerChrome.isMobileSidebarOpen,
      isMusicPlaying: readerRuntime.isMusicPlaying,
      isSettingsOpen: readerRuntime.readerChrome.isSettingsOpen,
      laboratoryTitle: laboratory?.title || 'Laboratorio',
      learningPlanTitle: learningPlan?.title || 'Percorso di Studio',
      loadingStatus: headerLoadingStatus,
      modelDefaults: defaultModelConfig,
      musicUrl,
      musicVolume: readerRuntime.musicVolume,
      onBackToLibrary: handleBackToLibrary,
      onOpenSidebar: () => readerRuntime.readerChrome.setIsMobileSidebarOpen(v => !v),
      onRegenerateActiveLaboratoryExercise: () => {
        void regenerateActiveLaboratoryExercise().then(result => {
          if (result.errorMessage) {
            notify(result.errorMessage);
          }
        });
      },
      onRegenerateActiveSection: readerActions.handleRegenerateActiveSection,
      onSetDarkMode: readerRuntime.readerChrome.setIsDarkMode,
      onSetCourseGenerationNotes: setGenerationNotes,
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
      preferredModels: readerRuntime.preferredModels,
      onSaveConversationNote: readerActions.handleSaveConversationNote,
      onUpdateConversationNote: readerActions.handleUpdateConversationNote,
      onSaveNote: readerActions.handleSaveNote,
    },
    shouldUseDesktopSidebar: readerRuntime.readerChrome.shouldUseDesktopSidebar,
    sidebar: {
      activeLaboratoryExerciseId,
      activeSectionId,
      expandedModuleId: readerRuntime.readerChrome.expandedModuleId,
      isLoading,
      isMobileViewport: readerRuntime.readerChrome.isMobileViewport,
      laboratoryExercises: laboratory?.exercises || [],
      laboratoryStatus: laboratory?.status || null,
      laboratoryTitle: laboratory?.title || 'Laboratorio',
      learningPlanTitle: learningPlan?.title || 'Percorso di Studio',
      onBackToLibrary: handleBackToLibrary,
      onExportProject: () => {
        void handleExportProject();
      },
      onGenerateLaboratory: () => {
        void generateLaboratory({ openFirstExercise: true }).then(result => {
          if (result.errorMessage) {
            notify(result.errorMessage);
          }
        });
      },
      onRegenerateLaboratoryIndex: () => {
        void generateLaboratory({ force: true, openFirstExercise: !activeSectionId }).then(
          result => {
            if (result.errorMessage) {
              notify(result.errorMessage);
            }
          }
        );
      },
      onModuleToggle: readerRuntime.readerChrome.handleModuleToggle,
      onSelectLaboratoryExercise: exerciseId => {
        void openLaboratoryExercise(exerciseId).then(outcome => {
          if (outcome === 'missing') {
            notify('Questo esercizio di laboratorio non e piu disponibile.');
          }
        });
      },
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
        onConfirmGenerate={handleConfirmGenerate}
        onCreateFolder={projectLibrary.createFolder}
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
        onSendAssessmentMessage={handleNewCourseMessage}
        onSetPreferredOpenRouterModel={readerRuntime.setPreferredOpenRouterModel}
        onSourceFileUpload={handleHomeSourceFileUpload}
        onToggleDarkMode={() =>
          readerRuntime.readerChrome.setIsDarkMode(!readerRuntime.readerChrome.isDarkMode)
        }
        onToggleLibraryContextRef={libraryAssistantChat.toggleAttachedContextRef}
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
      {isNotesDialogOpen && learningPlan ? (
        <CourseGenerationNotesDialog
          courseTitle={learningPlan.title || 'Percorso di Studio'}
          initialValue={learningPlan.generationNotes ?? ''}
          onSaveAndContinue={notes => {
            setGenerationNotes(notes);
            notesDialogAckedPlanIdsRef.current.add(currentProjectId || learningPlan.title);
            setIsNotesDialogOpen(false);
          }}
          onSkip={() => {
            notesDialogAckedPlanIdsRef.current.add(currentProjectId || learningPlan.title);
            setIsNotesDialogOpen(false);
          }}
        />
      ) : null}
    </>
  );
};

export default App;
