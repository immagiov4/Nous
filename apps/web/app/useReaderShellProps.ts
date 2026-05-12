// fallow-ignore-file unused-files
import { useMemo } from 'react';
import type { WorkspaceReaderShellProps } from '../components/workspace/shell/types.ts';
import type { useWorkspaceController } from '../hooks/workspace/useWorkspaceController.ts';
import type { useWorkspaceReaderActions } from '../hooks/workspace/useWorkspaceReaderActions.ts';
import type { useWorkspaceReaderRuntime } from '../hooks/workspace/useWorkspaceReaderRuntime.ts';
import type { OpenRouterModelDefaults } from '../types.ts';
import { getLessonSourcePageLabel } from '../utils/context/sourceMaterial.ts';
import { collectSectionLearningArtifactPayloads } from '../utils/learning/artifacts.ts';

type WorkspaceController = ReturnType<typeof useWorkspaceController>;
type WorkspaceReaderRuntime = ReturnType<typeof useWorkspaceReaderRuntime>;
type WorkspaceReaderActions = ReturnType<typeof useWorkspaceReaderActions>;

interface UseReaderShellPropsArgs {
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

// fallow-ignore-next-line unused-exports — used by ReadingScreenContainer
export const useReaderShellProps = ({
  controller,
  handleAttachSourceFile,
  handleBackToLibrary,
  handleExportProject,
  modelDefaults,
  pdfMappingWarning,
  readerActions,
  readerRuntime,
  syncState,
}: UseReaderShellPropsArgs): WorkspaceReaderShellProps => {
  const activeSectionSourcePageRangeLabel = useMemo(
    () =>
      getLessonSourcePageLabel({
        activeSection: controller.activeSection,
        documentIndex: controller.documentIndex,
      }),
    [controller.activeSection, controller.documentIndex]
  );
  const currentLessonArtifactPayloads = useMemo(
    () =>
      controller.activeSection
        ? collectSectionLearningArtifactPayloads({
            documentAssets: controller.documentAssets,
            projectId: controller.currentProjectId || 'current-project',
            projectTitle: controller.learningPlan?.title || 'Corso',
            section: controller.activeSection,
          })
        : [],
    [
      controller.activeSection,
      controller.currentProjectId,
      controller.documentAssets,
      controller.learningPlan?.title,
    ]
  );
  const isActiveSectionLoading =
    controller.generatingSectionId !== null &&
    controller.generatingSectionId === controller.activeSectionId;
  const loadingStatus = controller.blockingMessage || 'Caricamento...';
  const playerCurrentChunkIsLoading =
    readerRuntime.ttsPlayer.audioState.chunks[readerRuntime.ttsPlayer.audioState.currentChunkIndex]
      ?.isLoading || false;

  return useMemo(
    () => ({
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
        activeSectionTitle: controller.activeSection?.title || null,
        activeSectionAssetsById: readerRuntime.activeSectionAssetsById,
        activeSectionGeneratedVisualsById: readerRuntime.activeSectionGeneratedVisualsById,
        activeSectionImageRefsById: readerRuntime.activeSectionImageRefsById,
        contentRef: readerRuntime.contentRef,
        currentLessonArtifactPayloads,
        isDarkMode: readerRuntime.readerChrome.isDarkMode,
        isFocusMode: readerRuntime.readerChrome.isFocusMode,
        isLoading: isActiveSectionLoading,
        isMobileViewport: readerRuntime.readerChrome.isMobileViewport,
        isQuizSubmitted: readerRuntime.isQuizSubmitted,
        onCompleteSection: () => {
          void readerActions.handleCompleteSection();
        },
        onContentClick: readerRuntime.readerContext.handleContentClick,
        onContentContextMenu: readerRuntime.readerContext.handleContentContextMenu,
        onContentPointerDownCapture: readerRuntime.readerContext.handleContentPointerDownCapture,
        onSelectQuizAnswer: readerRuntime.handleSelectQuizAnswer,
        onSetIsQuizSubmitted: readerRuntime.setIsQuizSubmitted,
        quiz: controller.quiz,
        quizAnswers: readerRuntime.quizAnswers,
        scrollContainerRef: readerRuntime.scrollContainerRef,
        sectionAnnotations: controller.activeSection?.annotations,
        sectionContent: controller.sectionContent,
        sectionReasoningText: controller.workflowState.loadSection.reasoning,
        sourcePageRangeLabel: activeSectionSourcePageRangeLabel,
      },
      header: {
        activeSectionId: controller.activeSection?.id ?? null,
        activeSectionTitle: controller.activeSection?.title ?? null,
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
        currentLessonArtifactPayloads,
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
        expandedModuleId: readerRuntime.readerChrome.expandedModuleId,
        generatingSectionId: controller.generatingSectionId ?? null,
        isLoading: controller.isBlocking,
        isMobileViewport: readerRuntime.readerChrome.isMobileViewport,
        learningPlanTitle: controller.learningPlan?.title || 'Percorso di Studio',
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
    }),
    [
      activeSectionSourcePageRangeLabel,
      controller.activeSection,
      controller.activeSectionId,
      controller.generatingSectionId,
      controller.isBlocking,
      controller.isContextBusy,
      controller.learningPlan,
      controller.musicUrl,
      controller.needsSourceFile,
      controller.quiz,
      controller.sectionContent,
      controller.setGenerationNotes,
      controller.setMusicUrl,
      controller.storageError,
      controller.workflowState.loadSection.reasoning,
      currentLessonArtifactPayloads,
      handleAttachSourceFile,
      handleBackToLibrary,
      handleExportProject,
      isActiveSectionLoading,
      loadingStatus,
      modelDefaults,
      pdfMappingWarning,
      playerCurrentChunkIsLoading,
      readerActions.handleAttachArtifactToAnnotation,
      readerActions.handleCompleteSection,
      readerActions.handleContextQuestion,
      readerActions.handleCreateLesson,
      readerActions.handleDeleteAnnotation,
      readerActions.handleDetachArtifactFromAnnotation,
      readerActions.handleHighlight,
      readerActions.handleRegenerateActiveSection,
      readerActions.handleSaveArtifactToLesson,
      readerActions.handleSaveConversationNote,
      readerActions.handleSaveNote,
      readerActions.handleSelectSection,
      readerActions.handleUpdateConversationNote,
      readerRuntime.activeSectionAssetsById,
      readerRuntime.activeSectionGeneratedVisualsById,
      readerRuntime.activeSectionImageRefsById,
      readerRuntime.activeSidebarGroup,
      readerRuntime.contentRef,
      readerRuntime.handleSelectQuizAnswer,
      readerRuntime.isMusicPlaying,
      readerRuntime.isQuizSubmitted,
      readerRuntime.lastAudioTab,
      readerRuntime.musicVolume,
      readerRuntime.preferredModels,
      readerRuntime.quizAnswers,
      readerRuntime.readerChrome.expandedModuleId,
      readerRuntime.readerChrome.handleModuleToggle,
      readerRuntime.readerChrome.isDarkMode,
      readerRuntime.readerChrome.isFocusMode,
      readerRuntime.readerChrome.isMobileSidebarOpen,
      readerRuntime.readerChrome.isMobileViewport,
      readerRuntime.readerChrome.isSettingsOpen,
      readerRuntime.readerChrome.setIsDarkMode,
      readerRuntime.readerChrome.setIsFocusMode,
      readerRuntime.readerChrome.setIsMobileSidebarOpen,
      readerRuntime.readerChrome.setIsSettingsOpen,
      readerRuntime.readerChrome.shouldShowSidebar,
      readerRuntime.readerChrome.shouldUseDesktopSidebar,
      readerRuntime.readerContext.closeContextAnswer,
      readerRuntime.readerContext.closeContextMenu,
      readerRuntime.readerContext.contextAnswer,
      readerRuntime.readerContext.contextAnswerPanelRef,
      readerRuntime.readerContext.contextAnswerResizePreviewRef,
      readerRuntime.readerContext.contextAnswerSize,
      readerRuntime.readerContext.contextMenu,
      readerRuntime.readerContext.contextMenuRef,
      readerRuntime.readerContext.handleContentClick,
      readerRuntime.readerContext.handleContentContextMenu,
      readerRuntime.readerContext.handleContentPointerDownCapture,
      readerRuntime.readerContext.handleContextAnswerResizeStart,
      readerRuntime.scrollContainerRef,
      readerRuntime.setIsMusicPlaying,
      readerRuntime.setIsQuizSubmitted,
      readerRuntime.setLastAudioTab,
      readerRuntime.setMusicVolume,
      readerRuntime.setPreferredOpenRouterModel,
      readerRuntime.setSettingsPanelExpandedSections,
      readerRuntime.settingsPanelExpandedSections,
      readerRuntime.sidebarGroups,
      readerRuntime.ttsPlayer.audioState.currentVoice,
      readerRuntime.ttsPlayer.audioState.isPlaying,
      readerRuntime.ttsPlayer.audioState.playbackRate,
      readerRuntime.ttsPlayer.availableVoices,
      readerRuntime.ttsPlayer.handleSeek,
      readerRuntime.ttsPlayer.handleSkipChunk,
      readerRuntime.ttsPlayer.handleSpeedChange,
      readerRuntime.ttsPlayer.handleVoiceChange,
      readerRuntime.ttsPlayer.playerCurrentTime,
      readerRuntime.ttsPlayer.playerDuration,
      readerRuntime.ttsPlayer.togglePlayPause,
      readerRuntime.ttsPlayer.ttsConnected,
      syncState,
    ]
  );
};
