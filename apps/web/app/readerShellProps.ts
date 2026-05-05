// fallow-ignore-file unused-files
import type { WorkspaceReaderShellProps } from '../components/workspace/shell/types.ts';
import type { useWorkspaceController } from '../hooks/workspace/useWorkspaceController.ts';
import type { useWorkspaceReaderActions } from '../hooks/workspace/useWorkspaceReaderActions.ts';
import type { useWorkspaceReaderRuntime } from '../hooks/workspace/useWorkspaceReaderRuntime.ts';
import { selectActiveLaboratoryExercise } from '../services/laboratory/state.ts';
import {
  selectIsLaboratoryBusy,
  selectLaboratoryMessage,
  selectLaboratoryReasoning,
} from '../services/workspace/workflow.ts';
import type { OpenRouterModelDefaults } from '../types.ts';
import {
  getLaboratorySourcePageLabel,
  getLessonSourcePageLabel,
} from '../utils/context/sourceMaterial.ts';

type WorkspaceController = ReturnType<typeof useWorkspaceController>;
type WorkspaceReaderRuntime = ReturnType<typeof useWorkspaceReaderRuntime>;
type WorkspaceReaderActions = ReturnType<typeof useWorkspaceReaderActions>;

interface ErrorResult {
  errorMessage?: string;
}

interface BuildReaderShellPropsArgs {
  controller: WorkspaceController;
  handleAttachSourceFile: () => void;
  handleBackToLibrary: () => void;
  handleExportProject: (projectId?: string) => Promise<void>;
  modelDefaults: OpenRouterModelDefaults;
  notify: (message: string) => void;
  pdfMappingWarning: string | null;
  readerActions: WorkspaceReaderActions;
  readerRuntime: WorkspaceReaderRuntime;
  syncState: 'saved' | 'saving' | 'error';
}

const notifyIfErrored = (result: ErrorResult, notify: (message: string) => void) => {
  if (result.errorMessage) {
    notify(result.errorMessage);
  }
};

// fallow-ignore-next-line unused-exports — used by App.tsx
export const buildReaderShellProps = ({
  controller,
  handleAttachSourceFile,
  handleBackToLibrary,
  handleExportProject,
  modelDefaults,
  notify,
  pdfMappingWarning,
  readerActions,
  readerRuntime,
  syncState,
}: BuildReaderShellPropsArgs): WorkspaceReaderShellProps => {
  const {
    activeLaboratoryExerciseId,
    activeSection,
    activeSectionId,
    addLaboratoryTextAttachment,
    attachLaboratoryFiles,
    completeActiveSection: _completeActiveSection,
    documentIndex,
    evaluateActiveLaboratoryExercise,
    generateLaboratory,
    isBlocking,
    isContextBusy,
    laboratory,
    learningPlan,
    musicUrl,
    needsSourceFile,
    openLaboratoryExercise,
    quiz,
    regenerateActiveLaboratoryExercise,
    removeLaboratoryAttachment,
    sectionContent,
    setGenerationNotes,
    setMusicUrl,
    storageError,
    updateLaboratoryAttachmentMetadata,
    updateLaboratoryTextAttachment,
    workflowState,
  } = controller;

  const isLaboratoryBusy = selectIsLaboratoryBusy(workflowState);
  const isLaboratoryGenerating = workflowState.generateLaboratory.status === 'pending';
  const isLaboratoryEvaluating = workflowState.evaluateLaboratory.status === 'pending';
  const laboratoryActivityMessage =
    selectLaboratoryMessage(workflowState) || 'Laboratorio in corso...';
  const laboratoryReasoningText = selectLaboratoryReasoning(workflowState);
  const activeSectionSourcePageRangeLabel = getLessonSourcePageLabel({
    activeSection,
    documentIndex,
  });
  const activeLaboratoryExercise = selectActiveLaboratoryExercise(
    laboratory,
    activeLaboratoryExerciseId
  );
  const activeLaboratorySourcePageRangeLabel = getLaboratorySourcePageLabel({
    activeExercise: activeLaboratoryExercise,
    documentIndex,
  });
  const isLaboratoryView = !activeSectionId && Boolean(laboratory);
  const isActiveSectionLoading =
    controller.generatingSectionId !== null && controller.generatingSectionId === activeSectionId;
  const loadingStatus = controller.blockingMessage || 'Caricamento...';
  const headerIsLoading = isBlocking || (isLaboratoryView && isLaboratoryBusy);
  const headerLoadingStatus = isBlocking ? loadingStatus : laboratoryActivityMessage;
  const playerCurrentChunkIsLoading =
    readerRuntime.ttsPlayer.audioState.chunks[readerRuntime.ttsPlayer.audioState.currentChunkIndex]
      ?.isLoading || false;

  return {
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
      isLoading: isActiveSectionLoading,
      isLaboratoryEvaluating,
      isLaboratoryGenerating,
      isLaboratoryView,
      isMobileViewport: readerRuntime.readerChrome.isMobileViewport,
      isQuizSubmitted: readerRuntime.isQuizSubmitted,
      activeLaboratoryExercise,
      laboratoryActivityMessage,
      laboratoryReasoningText,
      laboratoryErrorMessage: laboratory?.errorMessage,
      laboratorySourcePageRangeLabel: activeLaboratorySourcePageRangeLabel,
      laboratoryStatus: laboratory?.status || null,
      laboratorySummary: laboratory?.summary || '',
      laboratoryTitle: laboratory?.title || 'Laboratorio',
      onAddLaboratoryTextAttachment: () => {
        void addLaboratoryTextAttachment().then(result => notifyIfErrored(result, notify));
      },
      onAttachLaboratoryFiles: files => {
        if (!files?.length) {
          return;
        }

        void attachLaboratoryFiles(files).then(result => notifyIfErrored(result, notify));
      },
      onCompleteSection: () => {
        void readerActions.handleCompleteSection();
      },
      onContentClick: readerRuntime.readerContext.handleContentClick,
      onContentContextMenu: readerRuntime.readerContext.handleContentContextMenu,
      onContentPointerDownCapture: readerRuntime.readerContext.handleContentPointerDownCapture,
      onEvaluateActiveLaboratoryExercise: () => {
        void evaluateActiveLaboratoryExercise().then(result => notifyIfErrored(result, notify));
      },
      onGenerateLaboratory: () => {
        void generateLaboratory({ openFirstExercise: true }).then(result =>
          notifyIfErrored(result, notify)
        );
      },
      onRemoveLaboratoryAttachment: attachmentId => {
        void removeLaboratoryAttachment(attachmentId).then(result =>
          notifyIfErrored(result, notify)
        );
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
      activeSectionId: activeSection?.id ?? null,
      activeSectionTitle: activeSection?.title ?? null,
      activeSidebarGroup: readerRuntime.activeSidebarGroup,
      hasActiveSection: Boolean(activeSection),
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
      modelDefaults,
      musicUrl,
      musicVolume: readerRuntime.musicVolume,
      onBackToLibrary: handleBackToLibrary,
      onOpenSidebar: () => readerRuntime.readerChrome.setIsMobileSidebarOpen(v => !v),
      onRegenerateActiveLaboratoryExercise: () => {
        void regenerateActiveLaboratoryExercise().then(result => notifyIfErrored(result, notify));
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
      lastAudioTab: readerRuntime.lastAudioTab,
      onSetLastAudioTab: readerRuntime.setLastAudioTab,
      syncState,
      tts: {
        availableVoices: readerRuntime.ttsPlayer.availableVoices,
        currentTime: readerRuntime.ttsPlayer.playerCurrentTime,
        currentVoice: readerRuntime.ttsPlayer.audioState.currentVoice,
        duration: readerRuntime.ttsPlayer.playerDuration,
        isPlaying: readerRuntime.ttsPlayer.audioState.isPlaying,
        isLoading: playerCurrentChunkIsLoading,
        playbackRate: readerRuntime.ttsPlayer.audioState.playbackRate,
        sectionContent,
        ttsConnected: readerRuntime.ttsPlayer.ttsConnected,
        onPlayPause: readerRuntime.ttsPlayer.togglePlayPause,
        onSeek: readerRuntime.ttsPlayer.handleSeek,
        onSkipChunk: readerRuntime.ttsPlayer.handleSkipChunk,
        onSpeedChange: readerRuntime.ttsPlayer.handleSpeedChange,
        onVoiceChange: readerRuntime.ttsPlayer.handleVoiceChange,
      },
    },
    overlays: {
      contextAnswer: readerRuntime.readerContext.contextAnswer,
      contextAnswerPanelRef: readerRuntime.readerContext.contextAnswerPanelRef,
      contextAnswerResizePreviewRef: readerRuntime.readerContext.contextAnswerResizePreviewRef,
      contextAnswerSize: readerRuntime.readerContext.contextAnswerSize,
      contextMenu: readerRuntime.readerContext.contextMenu,
      contextMenuRef: readerRuntime.readerContext.contextMenuRef,
      handleContextAnswerResizeStart: readerRuntime.readerContext.handleContextAnswerResizeStart,
      isContextLoading: isContextBusy,
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
      generatingSectionId: controller.generatingSectionId ?? null,
      isLoading: isBlocking,
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
        void generateLaboratory({ openFirstExercise: true }).then(result =>
          notifyIfErrored(result, notify)
        );
      },
      onRegenerateLaboratoryIndex: () => {
        void generateLaboratory({ force: true, openFirstExercise: !activeSectionId }).then(result =>
          notifyIfErrored(result, notify)
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
  };
};
