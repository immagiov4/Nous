/* @refresh reset */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import AssessmentView from './components/assessment/AssessmentView';
import LibraryView from './components/library/LibraryView';
import LoadingScreen from './components/shared/LoadingScreen';
import CourseGenerationNotesDialog from './components/workspace/CourseGenerationNotesDialog.tsx';
import type { WorkspaceReaderShellProps } from './components/workspace/shell/types.ts';
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
import { DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE } from './services/audio/voiceProfile.ts';
import { selectActiveLaboratoryExercise } from './services/laboratory/state.ts';
import { MODEL_ASSESSMENT, MODEL_CONTEXT, MODEL_REASONING } from './services/openrouter/index.ts';
import {
  selectBlockingReasoning,
  selectIsLaboratoryBusy,
  selectLaboratoryMessage,
  selectLaboratoryReasoning,
} from './services/workspace/workflow.ts';
import { AppState } from './types';
import type {
  HomeChatMode,
  HomeChatToolPreferences,
  PdfTextIndex,
  ProjectSource,
} from './types.ts';
import {
  getLaboratorySourcePageLabel,
  getLessonSourcePageLabel,
} from './utils/context/sourceMaterial.ts';
import { Pressable } from './utils/motion/index.ts';

interface ConfirmationRequest {
  confirmLabel: string;
  message: string;
  onResolve: (confirmed: boolean) => void;
  title: string;
}

const defaultModelConfig = {
  lessonModel: MODEL_REASONING,
  assessmentModel: MODEL_ASSESSMENT,
  contextModel: MODEL_CONTEXT,
  ttsModel: DEFAULT_TTS_MODEL,
  ttsVoice: DEFAULT_TTS_VOICE,
};

const resolvePdfMappingWarning = (
  source: ProjectSource | null,
  documentIndex: PdfTextIndex | null
): string | null => {
  if (source?.kind !== 'pdf') {
    return null;
  }

  if (!documentIndex || documentIndex.chunks.length === 0) {
    return 'Non riesco a collegare questo percorso al testo del PDF. Le nuove lezioni potrebbero essere meno precise: prova a ricollegare una versione del PDF con testo selezionabile.';
  }

  const warnings = documentIndex.mappingWarnings?.filter(Boolean) || [];
  if (warnings.length > 0) {
    return `Mappatura PDF da controllare: ${warnings[0]}`;
  }

  return null;
};

const App = () => {
  const [assessmentComplete, setAssessmentComplete] = useState(false);
  const [confirmationRequest, setConfirmationRequest] = useState<ConfirmationRequest | null>(null);
  const [homeChatMode, setHomeChatMode] = useState<HomeChatMode>('new-course');
  const [notificationMessage, setNotificationMessage] = useState<string | null>(null);
  const [pendingHomeSourceFile, setPendingHomeSourceFile] = useState<File | null>(null);
  const pendingConfirmationResolveRef = useRef<((confirmed: boolean) => void) | null>(null);
  const notify = useCallback((message: string) => {
    setNotificationMessage(message);
  }, []);
  const requestConfirmation = useCallback(
    (request: Omit<ConfirmationRequest, 'onResolve'>): Promise<boolean> =>
      new Promise(resolve => {
        pendingConfirmationResolveRef.current?.(false);
        pendingConfirmationResolveRef.current = resolve;
        setConfirmationRequest({ ...request, onResolve: resolve });
      }),
    []
  );
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
    projectRepositoryMode,
    setProjectRepositoryMode,
    storageError,
    transferFolderToLan,
    transferProjectToLan,
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
  const previousAutoOpenProjectIdRef = useRef(currentProjectId);

  useEffect(() => {
    if (!notificationMessage) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setNotificationMessage(null);
    }, 5200);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [notificationMessage]);

  useEffect(
    () => () => {
      pendingConfirmationResolveRef.current?.(false);
      pendingConfirmationResolveRef.current = null;
    },
    []
  );

  const resolveConfirmation = (confirmed: boolean) => {
    const resolve = confirmationRequest?.onResolve || null;
    resolve?.(confirmed);
    if (pendingConfirmationResolveRef.current === resolve) {
      pendingConfirmationResolveRef.current = null;
    }
    setConfirmationRequest(null);
  };

  const confirmationDialog =
    confirmationRequest && typeof document !== 'undefined'
      ? createPortal(
          <div className="fixed inset-0 z-[140] flex items-center justify-center px-4 py-6">
            <button
              type="button"
              aria-label="Chiudi conferma"
              className="absolute inset-0 bg-black/50 backdrop-blur-sm"
              onClick={() => resolveConfirmation(false)}
            />
            <div
              className="relative w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
              role="dialog"
              aria-modal="true"
            >
              <h2 className="text-lg font-semibold text-gray-900 dark:text-zinc-100">
                {confirmationRequest.title}
              </h2>
              <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-zinc-300">
                {confirmationRequest.message}
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <Pressable
                  onClick={() => resolveConfirmation(false)}
                  className="rounded-full px-4 py-2 text-sm font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                >
                  Annulla
                </Pressable>
                <Pressable
                  onClick={() => resolveConfirmation(true)}
                  className="rounded-full bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700"
                >
                  {confirmationRequest.confirmLabel}
                </Pressable>
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  const appOverlays = (
    <>
      {notificationMessage ? (
        <div className="fixed bottom-5 left-1/2 z-[120] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 shadow-2xl dark:border-red-900/70 dark:bg-red-950 dark:text-red-200">
          <div className="flex items-start justify-between gap-3">
            <span>{notificationMessage}</span>
            <Pressable
              onClick={() => setNotificationMessage(null)}
              className="-mr-1 rounded-full px-2 text-red-700 transition-colors hover:bg-red-100 dark:text-red-200 dark:hover:bg-red-900/60"
              title="Chiudi"
            >
              Chiudi
            </Pressable>
          </div>
        </div>
      ) : null}
      {confirmationDialog}
    </>
  );

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

    const planHasGeneratedContent = learningPlan.sections.some(section => Boolean(section.content));
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
    if (previousAutoOpenProjectIdRef.current === currentProjectId) {
      return;
    }

    previousAutoOpenProjectIdRef.current = currentProjectId;
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
  const isContextLoading = isContextBusy;
  const isLaboratoryBusy = selectIsLaboratoryBusy(workflowState);
  const isLaboratoryGenerating = workflowState.generateLaboratory.status === 'pending';
  const isLaboratoryEvaluating = workflowState.evaluateLaboratory.status === 'pending';
  const laboratoryActivityMessage =
    selectLaboratoryMessage(workflowState) || 'Laboratorio in corso...';
  const laboratoryReasoningText = selectLaboratoryReasoning(workflowState);
  const isHomeChatLoading = workflowState.assessment.status === 'pending';
  const homeChatLoadingStatus = workflowState.assessment.message || 'Caricamento...';
  const loadingStatus = blockingMessage || 'Caricamento...';
  const loadingReasoningText = selectBlockingReasoning(workflowState);
  const activeSectionSourcePageRangeLabel = getLessonSourcePageLabel({
    activeSection,
    documentIndex: controller.documentIndex,
  });
  const activeLaboratoryExercise = selectActiveLaboratoryExercise(
    laboratory,
    activeLaboratoryExerciseId
  );
  const laboratoryTotalExerciseCount = laboratory?.exercises.length || 0;
  const laboratorySubmittedCount =
    laboratory?.exercises.filter(exercise => exercise.attachments.length > 0).length || 0;
  const laboratoryEvaluatedCount =
    laboratory?.exercises.filter(exercise => Boolean(exercise.evaluation)).length || 0;
  const activeLaboratorySourcePageRangeLabel = getLaboratorySourcePageLabel({
    activeExercise: activeLaboratoryExercise,
    documentIndex: controller.documentIndex,
  });
  const pdfMappingWarning = resolvePdfMappingWarning(domain.source, controller.documentIndex);
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
      pdfMappingWarning,
      storageError,
    },
    content: {
      activeSectionTitle: activeSection?.title || null,
      activeSectionAssetsById: readerRuntime.activeSectionAssetsById,
      activeSectionGeneratedVisualsById: readerRuntime.activeSectionGeneratedVisualsById,
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
      laboratoryReasoningText,
      laboratoryEvaluatedCount,
      laboratoryErrorMessage: laboratory?.errorMessage,
      laboratorySourcePageRangeLabel: activeLaboratorySourcePageRangeLabel,
      laboratorySubmittedCount,
      laboratoryStatus: laboratory?.status || null,
      laboratorySummary: laboratory?.summary || '',
      laboratoryTitle: laboratory?.title || 'Laboratorio',
      laboratoryTotalExerciseCount,
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
      sectionReasoningText: workflowState.loadSection.reasoning,
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
      onSetSettingsPanelExpandedSections: readerRuntime.setSettingsPanelExpandedSections,
      preferredModels: readerRuntime.preferredModels,
      settingsPanelExpandedSections: readerRuntime.settingsPanelExpandedSections,
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
  })();

  return (
    <>
      {screen}
      {appOverlays}
    </>
  );
};

export default App;
