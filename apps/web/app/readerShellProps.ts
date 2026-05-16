// fallow-ignore-file unused-files
import type { WorkspaceReaderShellProps } from '../components/workspace/shell/types.ts';
import type { useWorkspaceController } from '../hooks/workspace/useWorkspaceController.ts';
import type { useWorkspaceReaderActions } from '../hooks/workspace/useWorkspaceReaderActions.ts';
import type { useWorkspaceReaderRuntime } from '../hooks/workspace/useWorkspaceReaderRuntime.ts';
import {
  getApplicationExerciseRepairLabel,
  planNeedsApplicationExerciseRepair,
} from '../services/learning/applicationExercises.ts';
import type { OpenRouterModelDefaults } from '../types.ts';
import { getLessonSourcePageLabel } from '../utils/context/sourceMaterial.ts';
import { findPathNodeById, flattenLessons } from '../utils/learning/pathNodes.ts';

type WorkspaceController = ReturnType<typeof useWorkspaceController>;
type WorkspaceReaderRuntime = ReturnType<typeof useWorkspaceReaderRuntime>;
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
  readerRuntime: WorkspaceReaderRuntime;
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
  readerRuntime,
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
    controller.workflowState.generateLaboratory.status === 'pending';
  const loadingStatus = controller.blockingMessage || 'Caricamento...';
  const playerCurrentChunkIsLoading =
    readerRuntime.ttsPlayer.audioState.chunks[readerRuntime.ttsPlayer.audioState.currentChunkIndex]
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
      activeSectionAssetsById: readerRuntime.activeSectionAssetsById,
      activeSectionGeneratedVisualsById: readerRuntime.activeSectionGeneratedVisualsById,
      activeSectionImageRefsById: readerRuntime.activeSectionImageRefsById,
      contentRef: readerRuntime.contentRef,
      currentLessonArtifactPayloads: undefined,
      hasNextSection,
      isDarkMode: readerRuntime.readerChrome.isDarkMode,
      isFocusMode: readerRuntime.readerChrome.isFocusMode,
      isLoading: isActiveSectionLoading,
      isMobileViewport: readerRuntime.readerChrome.isMobileViewport,
      isQuizSubmitted: readerRuntime.isQuizSubmitted,
      onAdvanceSection: () => {
        void readerActions.handleAdvanceSection();
      },
      onCompleteSection: () => {
        void readerActions.handleCompleteSection();
      },
      onAttachExerciseFiles: () => {},
      onContentClick: readerRuntime.readerContext.handleContentClick,
      onContentContextMenu: readerRuntime.readerContext.handleContentContextMenu,
      onContentPointerDownCapture: readerRuntime.readerContext.handleContentPointerDownCapture,
      onSelectQuizAnswer: readerRuntime.handleSelectQuizAnswer,
      onRemoveExerciseAttachment: () => {},
      onSetIsQuizSubmitted: readerRuntime.setIsQuizSubmitted,
      onUpdateExerciseInternalText: () => {},
      quiz: activeExercise ? [] : controller.quiz,
      quizAnswers: activeExercise ? [] : readerRuntime.quizAnswers,
      scrollContainerRef: readerRuntime.scrollContainerRef,
      sectionAnnotations: controller.activeSection?.annotations,
      sectionContent: activeExercise ? '' : controller.sectionContent,
      sectionReasoningText: controller.workflowState.loadSection.reasoning,
      sourcePageRangeLabel: activeSectionSourcePageRangeLabel,
    },
    header: {
      activeSectionId: activePathNode?.id ?? null,
      activeSectionTitle: activePathNode?.title ?? null,
      activeSidebarGroup: readerRuntime.activeSidebarGroup,
      hasActiveSection: Boolean(controller.activeSection),
      courseGenerationNotes: controller.learningPlan?.generationNotes ?? '',
      isDarkMode: readerRuntime.readerChrome.isDarkMode,
      isFocusMode: readerRuntime.readerChrome.isFocusMode,
      isLoading: controller.isBlocking,
      isMobileViewport: readerRuntime.readerChrome.isMobileViewport,
      isMobileSidebarOpen: readerRuntime.readerChrome.isMobileSidebarOpen,
      isMusicPlaying: readerRuntime.isMusicPlaying,
      isSettingsOpen: readerRuntime.readerChrome.isSettingsOpen,
      lastAudioTab: readerRuntime.lastAudioTab,
      learningPlanTitle: controller.learningPlan?.title || 'Percorso di Studio',
      loadingStatus,
      modelDefaults,
      musicUrl: controller.musicUrl,
      musicVolume: readerRuntime.musicVolume,
      onBackToLibrary: handleBackToLibrary,
      onOpenSidebar: () => readerRuntime.readerChrome.setIsMobileSidebarOpen(v => !v),
      onRegenerateActiveSection: readerActions.handleRegenerateActiveSection,
      onSetCourseGenerationNotes: controller.setGenerationNotes,
      onSetDarkMode: readerRuntime.readerChrome.setIsDarkMode,
      onSetFocusMode: readerRuntime.readerChrome.setIsFocusMode,
      onSetIsMusicPlaying: readerRuntime.setIsMusicPlaying,
      onSetLastAudioTab: readerRuntime.setLastAudioTab,
      onSetMusicUrl: controller.setMusicUrl,
      onSetMusicVolume: readerRuntime.setMusicVolume,
      onSetPreferredOpenRouterModel: readerRuntime.setPreferredOpenRouterModel,
      onSetSettingsOpen: readerRuntime.readerChrome.setIsSettingsOpen,
      onSetSettingsPanelExpandedSections: readerRuntime.setSettingsPanelExpandedSections,
      preferredModels: readerRuntime.preferredModels,
      settingsPanelExpandedSections: readerRuntime.settingsPanelExpandedSections,
      syncState,
      tts: {
        availableVoices: readerRuntime.ttsPlayer.availableVoices,
        currentTime: readerRuntime.ttsPlayer.playerCurrentTime,
        currentVoice: readerRuntime.ttsPlayer.audioState.currentVoice,
        duration: readerRuntime.ttsPlayer.playerDuration,
        isLoading: playerCurrentChunkIsLoading,
        isPlaying: readerRuntime.ttsPlayer.audioState.isPlaying,
        playbackRate: readerRuntime.ttsPlayer.audioState.playbackRate,
        sectionContent: controller.sectionContent,
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
      currentLessonArtifactPayloads: undefined,
      handleContextAnswerResizeStart: readerRuntime.readerContext.handleContextAnswerResizeStart,
      isContextLoading: controller.isContextBusy,
      isDarkMode: readerRuntime.readerChrome.isDarkMode,
      isMobileViewport: readerRuntime.readerChrome.isMobileViewport,
      onAskContextQuestion: readerActions.handleContextQuestion,
      onAttachArtifactToAnnotation: readerActions.handleAttachArtifactToAnnotation,
      onCloseContextAnswer: readerRuntime.readerContext.closeContextAnswer,
      onCloseContextMenu: readerRuntime.readerContext.closeContextMenu,
      onCreateLesson: readerActions.handleCreateLesson,
      onDeleteAnnotation: readerActions.handleDeleteAnnotation,
      onDetachArtifactFromAnnotation: readerActions.handleDetachArtifactFromAnnotation,
      onHighlight: readerActions.handleHighlight,
      onSaveArtifactToLesson: readerActions.handleSaveArtifactToLesson,
      onSaveConversationNote: readerActions.handleSaveConversationNote,
      onSaveNote: readerActions.handleSaveNote,
      onUpdateConversationNote: readerActions.handleUpdateConversationNote,
      preferredModels: readerRuntime.preferredModels,
    },
    shouldUseDesktopSidebar: readerRuntime.readerChrome.shouldUseDesktopSidebar,
    sidebar: {
      activeSectionId: controller.activeSectionId,
      canRepairApplicationExercises: planNeedsApplicationExerciseRepair(controller.learningPlan),
      expandedModuleId: readerRuntime.readerChrome.expandedModuleId,
      generatingSectionId: controller.generatingSectionId ?? null,
      isRepairingApplicationExercises,
      isLoading: controller.isBlocking,
      isMobileViewport: readerRuntime.readerChrome.isMobileViewport,
      learningPlanTitle: controller.learningPlan?.title || 'Percorso di Studio',
      repairApplicationExercisesLabel: getApplicationExerciseRepairLabel(controller.learningPlan),
      onBackToLibrary: handleBackToLibrary,
      onExportProject: () => {
        void handleExportProject();
      },
      onModuleToggle: readerRuntime.readerChrome.handleModuleToggle,
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
      onSetFocusMode: readerRuntime.readerChrome.setIsFocusMode,
      onSetIsMobileSidebarOpen: readerRuntime.readerChrome.setIsMobileSidebarOpen,
      shouldShowSidebar: readerRuntime.readerChrome.shouldShowSidebar,
      sidebarGroups: readerRuntime.sidebarGroups,
    },
  };
};
