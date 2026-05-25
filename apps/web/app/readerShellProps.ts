// fallow-ignore-file unused-files
import type { WorkspaceReaderShellProps } from '../components/workspace/shell/types.ts';
import type { useWorkspaceController } from '../hooks/workspace/useWorkspaceController.ts';
import type { useWorkspaceReaderActions } from '../hooks/workspace/useWorkspaceReaderActions.ts';
import type { useWorkspaceReaderState } from '../hooks/workspace/useWorkspaceReaderState.ts';
import {
  getApplicationExerciseRepairLabel,
  planNeedsApplicationExerciseRepair,
} from '../services/exercises/plan.ts';
import type { OpenRouterModelDefaults } from '../types.ts';
import { getLessonSourcePageLabel } from '../utils/context/sourceMaterial.ts';
import { findPathNodeById, flattenLessons } from '../utils/learning/pathNodes.ts';

type WorkspaceController = ReturnType<typeof useWorkspaceController>;
type WorkspaceReaderState = ReturnType<typeof useWorkspaceReaderState>;
type WorkspaceReaderActions = ReturnType<typeof useWorkspaceReaderActions>;

interface BuildReaderShellPropsArgs {
  controller: WorkspaceController;
  handleAttachSourceFile: () => void;
  handleBackToLibrary: () => void;
  handleExportProject: (projectId?: string) => Promise<void>;
  modelDefaults: OpenRouterModelDefaults;
  notify: (message: string, kind?: 'error' | 'success') => void;
  pdfMappingWarning: string | null;
  readerActions: WorkspaceReaderActions;
  readerState: WorkspaceReaderState;
  syncState: 'saved' | 'saving' | 'error';
}

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
  readerState,
  syncState,
}: BuildReaderShellPropsArgs): WorkspaceReaderShellProps => {
  const activeSectionSourcePageRangeLabel = getLessonSourcePageLabel({
    activeSection: controller.activeSection,
    documentIndex: controller.documentIndex,
  });
  const activePathNode = findPathNodeById(
    controller.learningPlan?.modules,
    controller.activeSectionId
  );
  const activeExercise = activePathNode?.kind === 'exercise' ? activePathNode : null;
  const hasNextSection = (() => {
    if (!controller.learningPlan || !controller.activeSectionId) {
      return false;
    }

    const lessons = flattenLessons(controller.learningPlan.modules);
    const currentIndex = lessons.findIndex(lesson => lesson.id === controller.activeSectionId);
    return currentIndex >= 0 && currentIndex < lessons.length - 1;
  })();
  const isActiveSectionLoading =
    controller.generatingSectionId !== null &&
    controller.generatingSectionId === controller.activeSectionId;
  const isRepairingApplicationExercises =
    controller.workflowState.generateExercise.status === 'pending';
  const loadingStatus = controller.blockingMessage || 'Caricamento...';
  const playerCurrentChunkIsLoading =
    readerState.ttsPlayer.audioState.chunks[readerState.ttsPlayer.audioState.currentChunkIndex]
      ?.isLoading || false;

  return {
    banners: {
      needsSourceFile: controller.needsSourceFile,
      onAttachSourceFile: handleAttachSourceFile,
      onBackToLibrary: handleBackToLibrary,
      onExportProject: () => {
        void handleExportProject();
      },
      pdfMappingWarning,
      storageError: controller.storageError,
    },
    content: {
      activeExercise,
      exercisePrerequisiteGaps: [],
      activeSectionTitle: controller.activeSection?.title || null,
      activeSectionAssetsById: readerState.activeSectionAssetsById,
      activeSectionGeneratedVisualsById: readerState.activeSectionGeneratedVisualsById,
      activeSectionImageRefsById: readerState.activeSectionImageRefsById,
      contentRef: readerState.contentRef,
      currentLessonArtifactPayloads: undefined,
      hasNextSection,
      isDarkMode: readerState.readerChrome.isDarkMode,
      isFocusMode: readerState.readerChrome.isFocusMode,
      isLoading: isActiveSectionLoading,
      isMobileViewport: readerState.readerChrome.isMobileViewport,
      isQuizSubmitted: readerState.isQuizSubmitted,
      onAdvanceSection: () => {
        void readerActions.handleAdvanceSection();
      },
      onCompleteSection: () => {
        void readerActions.handleCompleteSection();
      },
      onAttachExerciseFiles: () => {},
      onContentClick: readerState.readerContext.handleContentClick,
      onContentContextMenu: readerState.readerContext.handleContentContextMenu,
      onContentPointerDownCapture: readerState.readerContext.handleContentPointerDownCapture,
      onSelectQuizAnswer: readerState.handleSelectQuizAnswer,
      onRemoveExerciseAttachment: () => {},
      onSetIsQuizSubmitted: readerState.setIsQuizSubmitted,
      onUpdateExerciseInternalText: () => {},
      quiz: activeExercise ? [] : controller.quiz,
      quizAnswers: activeExercise ? [] : readerState.quizAnswers,
      scrollContainerRef: readerState.scrollContainerRef,
      sectionAnnotations: controller.activeSection?.annotations,
      sectionContent: activeExercise ? '' : controller.sectionContent,
      sectionReasoningText: controller.workflowState.loadSection.reasoning,
      sourcePageRangeLabel: activeSectionSourcePageRangeLabel,
    },
    header: {
      activeSectionId: activePathNode?.id ?? null,
      activeSectionTitle: activePathNode?.title ?? null,
      activeSidebarGroup: readerState.activeSidebarGroup,
      hasActiveSection: Boolean(controller.activeSection),
      courseGenerationNotes: controller.learningPlan?.generationNotes ?? '',
      isDarkMode: readerState.readerChrome.isDarkMode,
      isFocusMode: readerState.readerChrome.isFocusMode,
      isLoading: controller.isBlocking,
      isMobileViewport: readerState.readerChrome.isMobileViewport,
      isMobileSidebarOpen: readerState.readerChrome.isMobileSidebarOpen,
      isMusicPlaying: readerState.isMusicPlaying,
      isSettingsOpen: readerState.readerChrome.isSettingsOpen,
      lastAudioTab: readerState.lastAudioTab,
      learningPlanTitle: controller.learningPlan?.title || 'Percorso di Studio',
      loadingStatus,
      modelDefaults,
      musicUrl: controller.musicUrl,
      musicVolume: readerState.musicVolume,
      onBackToLibrary: handleBackToLibrary,
      onOpenSidebar: () => readerState.readerChrome.setIsMobileSidebarOpen(v => !v),
      onRegenerateActiveSection: readerActions.handleRegenerateActiveSection,
      onSetCourseGenerationNotes: controller.setGenerationNotes,
      onSetDarkMode: readerState.readerChrome.setIsDarkMode,
      onSetFocusMode: readerState.readerChrome.setIsFocusMode,
      onSetIsMusicPlaying: readerState.setIsMusicPlaying,
      onSetLastAudioTab: readerState.setLastAudioTab,
      onSetMusicUrl: controller.setMusicUrl,
      onSetMusicVolume: readerState.setMusicVolume,
      onSetPreferredOpenRouterModel: readerState.setPreferredOpenRouterModel,
      onSetSettingsOpen: readerState.readerChrome.setIsSettingsOpen,
      onSetSettingsPanelExpandedSections: readerState.setSettingsPanelExpandedSections,
      preferredModels: readerState.preferredModels,
      settingsPanelExpandedSections: readerState.settingsPanelExpandedSections,
      syncState,
      tts: {
        availableVoices: readerState.ttsPlayer.availableVoices,
        currentTime: readerState.ttsPlayer.playerCurrentTime,
        currentVoice: readerState.ttsPlayer.audioState.currentVoice,
        duration: readerState.ttsPlayer.playerDuration,
        isLoading: playerCurrentChunkIsLoading,
        isPlaying: readerState.ttsPlayer.audioState.isPlaying,
        playbackRate: readerState.ttsPlayer.audioState.playbackRate,
        sectionContent: controller.sectionContent,
        ttsConnected: readerState.ttsPlayer.ttsConnected,
        onPlayPause: readerState.ttsPlayer.togglePlayPause,
        onSeek: readerState.ttsPlayer.handleSeek,
        onSkipChunk: readerState.ttsPlayer.handleSkipChunk,
        onSpeedChange: readerState.ttsPlayer.handleSpeedChange,
        onVoiceChange: readerState.ttsPlayer.handleVoiceChange,
      },
    },
    overlays: {
      contextAnswer: readerState.readerContext.contextAnswer,
      contextAnswerPanelRef: readerState.readerContext.contextAnswerPanelRef,
      contextAnswerResizePreviewRef: readerState.readerContext.contextAnswerResizePreviewRef,
      contextAnswerSize: readerState.readerContext.contextAnswerSize,
      contextMenu: readerState.readerContext.contextMenu,
      contextMenuRef: readerState.readerContext.contextMenuRef,
      currentLessonArtifactPayloads: undefined,
      handleContextAnswerResizeStart: readerState.readerContext.handleContextAnswerResizeStart,
      isContextLoading: controller.isContextBusy,
      isDarkMode: readerState.readerChrome.isDarkMode,
      isMobileViewport: readerState.readerChrome.isMobileViewport,
      onAskContextQuestion: readerActions.handleContextQuestion,
      onAttachArtifactToAnnotation: readerActions.handleAttachArtifactToAnnotation,
      onCloseContextAnswer: readerState.readerContext.closeContextAnswer,
      onCloseContextMenu: readerState.readerContext.closeContextMenu,
      onCreateLesson: readerActions.handleCreateLesson,
      onDeleteAnnotation: readerActions.handleDeleteAnnotation,
      onDetachArtifactFromAnnotation: readerActions.handleDetachArtifactFromAnnotation,
      onHighlight: readerActions.handleHighlight,
      onSaveArtifactToLesson: readerActions.handleSaveArtifactToLesson,
      onSaveConversationNote: readerActions.handleSaveConversationNote,
      onSaveNote: readerActions.handleSaveNote,
      onUpdateConversationNote: readerActions.handleUpdateConversationNote,
      preferredModels: readerState.preferredModels,
    },
    shouldUseDesktopSidebar: readerState.readerChrome.shouldUseDesktopSidebar,
    sidebar: {
      activeSectionId: controller.activeSectionId,
      canRepairApplicationExercises: planNeedsApplicationExerciseRepair(controller.learningPlan),
      expandedModuleId: readerState.readerChrome.expandedModuleId,
      generatingSectionId: controller.generatingSectionId ?? null,
      isRepairingApplicationExercises,
      isLoading: controller.isBlocking,
      isMobileViewport: readerState.readerChrome.isMobileViewport,
      learningPlanTitle: controller.learningPlan?.title || 'Percorso di Studio',
      repairApplicationExercisesLabel: getApplicationExerciseRepairLabel(controller.learningPlan),
      onBackToLibrary: handleBackToLibrary,
      onExportProject: () => {
        void handleExportProject();
      },
      onModuleToggle: readerState.readerChrome.handleModuleToggle,
      onRepairApplicationExercises: () => {
        void controller
          .repairApplicationExercises()
          .then(result => {
            if (result.outcome === 'repaired') {
              notify('Pianificazione esercizi completata.', 'success');
            }
          })
          .catch(error => {
            notify(
              error instanceof Error
                ? error.message
                : 'Non sono riuscito a pianificare gli esercizi.'
            );
          });
      },
      onSelectExercise: readerActions.handleSelectExercise,
      onSelectSection: readerActions.handleSelectSection,
      onSetFocusMode: readerState.readerChrome.setIsFocusMode,
      onSetIsMobileSidebarOpen: readerState.readerChrome.setIsMobileSidebarOpen,
      shouldShowSidebar: readerState.readerChrome.shouldShowSidebar,
      sidebarGroups: readerState.sidebarGroups,
    },
  };
};
