import { useCallback, useMemo } from 'react';
import type { WorkspaceReaderShellProps } from '../components/workspace/shell/types.ts';
import type { useWorkspaceController } from '../hooks/workspace/useWorkspaceController.ts';
import type { useWorkspaceReaderActions } from '../hooks/workspace/useWorkspaceReaderActions.ts';
import type { useWorkspaceReaderState } from '../hooks/workspace/useWorkspaceReaderState.ts';
import { translateUiMessage as t } from '../i18n/uiMessages.ts';
import { createExerciseAttachmentFromFile } from '../services/exercises/deliverables.ts';
import {
  getApplicationExerciseRepairLabel,
  planNeedsApplicationExerciseRepair,
  withUpdatedExerciseDeliverable,
} from '../services/exercises/plan.ts';
import { getExercisePrerequisiteGaps } from '../services/openrouter/exercises/brief.ts';
import type { ExerciseAttachment, LessonLearningAid } from '../types.ts';
import { getLessonSourcePageLabel } from '../utils/context/sourceMaterial.ts';
import { collectSectionLearningArtifactPayloads } from '../utils/learning/artifacts.ts';
import { findPathNodeById, flattenLessons } from '../utils/learning/pathNodes.ts';

type WorkspaceController = ReturnType<typeof useWorkspaceController>;
type WorkspaceReaderState = ReturnType<typeof useWorkspaceReaderState>;
type WorkspaceReaderActions = ReturnType<typeof useWorkspaceReaderActions>;

interface UseReaderShellPropsArgs {
  controller: WorkspaceController;
  handleAttachSourceFile: () => void;
  handleBackToLibrary: () => void;
  handleExportProject: (projectId?: string) => Promise<void>;
  notify: (message: string, kind?: 'error' | 'success') => void;
  pdfMappingWarning: string | null;
  readerActions: WorkspaceReaderActions;
  readerState: WorkspaceReaderState;
  syncState: 'saved' | 'saving' | 'error';
}

export const useReaderShellProps = ({
  controller,
  handleAttachSourceFile,
  handleBackToLibrary,
  handleExportProject,
  notify,
  pdfMappingWarning,
  readerActions,
  readerState,
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
  const activePathNode = useMemo(
    () => findPathNodeById(controller.learningPlan?.modules, controller.activeSectionId),
    [controller.activeSectionId, controller.learningPlan?.modules]
  );
  const activeExercise = activePathNode?.kind === 'exercise' ? activePathNode : null;
  const hasNextSection = useMemo(() => {
    if (!controller.learningPlan || !controller.activeSectionId) {
      return false;
    }

    const lessons = flattenLessons(controller.learningPlan.modules);
    const currentIndex = lessons.findIndex(lesson => lesson.id === controller.activeSectionId);
    return currentIndex >= 0 && currentIndex < lessons.length - 1;
  }, [controller.activeSectionId, controller.learningPlan]);
  const exercisePrerequisiteGaps = useMemo(
    () =>
      activeExercise ? getExercisePrerequisiteGaps(controller.learningPlan, activeExercise.id) : [],
    [activeExercise, controller.learningPlan]
  );
  const currentLessonArtifactPayloads = useMemo(
    () =>
      controller.activeSection
        ? collectSectionLearningArtifactPayloads({
            documentAssets: controller.documentAssets,
            projectId: controller.currentProjectId || 'current-project',
            projectTitle: controller.learningPlan?.title || t('Corso'),
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
  const isRepairingApplicationExercises =
    controller.workflowState.generateExercise.status === 'pending';
  const isEvaluatingExercise = controller.workflowState.evaluateExercise.status === 'pending';
  const loadingStatus = controller.blockingMessage || t('Caricamento...');
  const playerCurrentChunkIsLoading =
    readerState.ttsPlayer.audioState.chunks[readerState.ttsPlayer.audioState.currentChunkIndex]
      ?.isLoading || false;
  const handleRepairApplicationExercises = useCallback(() => {
    void controller
      .repairApplicationExercises()
      .then(result => {
        if (result.outcome === 'repaired') {
          notify(t('Pianificazione esercizi completata.'), 'success');
        }
      })
      .catch(error => {
        notify(
          error instanceof Error
            ? error.message
            : t('Non sono riuscito a pianificare gli esercizi.')
        );
      });
  }, [controller, notify]);
  const handleUpdateExerciseInternalText = useCallback(
    (exerciseId: string, text: string) => {
      void controller
        .updateApplicationExercise(exerciseId, exercise =>
          withUpdatedExerciseDeliverable(exercise, { internalText: text })
        )
        .catch(error => {
          notify(
            error instanceof Error ? error.message : t('Non sono riuscito a salvare la consegna.')
          );
        });
    },
    [controller, notify]
  );
  const handleRemoveExerciseAttachment = useCallback(
    (exerciseId: string, attachmentId: string) => {
      void controller
        .updateApplicationExercise(exerciseId, exercise =>
          withUpdatedExerciseDeliverable(exercise, {
            attachments: exercise.attachments.filter(attachment => attachment.id !== attachmentId),
          })
        )
        .catch(error => {
          notify(
            error instanceof Error ? error.message : t('Non sono riuscito a rimuovere il file.')
          );
        });
    },
    [controller, notify]
  );
  const handleAttachExerciseFiles = useCallback(
    (exerciseId: string, files: FileList | null) => {
      if (!files?.length) {
        return;
      }

      void (async () => {
        const attachments: ExerciseAttachment[] = [];
        for (const file of Array.from(files)) {
          attachments.push(await createExerciseAttachmentFromFile(file));
        }
        await controller.attachExerciseFiles(exerciseId, attachments);
      })().catch(error => {
        notify(
          error instanceof Error ? error.message : t('Non sono riuscito ad allegare il file.')
        );
      });
    },
    [controller, notify]
  );
  const handleRequestExerciseFeedback = useCallback(
    (exerciseId: string, internalText: string) => {
      void controller.evaluateApplicationExercise(exerciseId, internalText);
    },
    [controller]
  );
  const handleSaveLearningAids = useCallback(
    async (learningAids: LessonLearningAid[]) => {
      const activeSection = controller.activeSection;
      if (!activeSection) {
        return false;
      }

      const didPersist = await controller.patchSectionLessonContent(activeSection.id, {
        learningAids,
      });
      if (!didPersist) {
        return false;
      }

      controller.updateSection(activeSection.id, section => ({ ...section, learningAids }));
      return true;
    },
    [controller]
  );

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
        sourceKind: controller.source?.kind,
        storageError: controller.storageError,
      },
      content: {
        activeExercise,
        exercisePrerequisiteGaps,
        activeSectionTitle: controller.activeSection?.title || null,
        activeSectionAssetsById: readerState.activeSectionAssetsById,
        activeSectionGeneratedVisualsById: readerState.activeSectionGeneratedVisualsById,
        activeSectionImageRefsById: readerState.activeSectionImageRefsById,
        contentRef: readerState.contentRef,
        currentLessonArtifactPayloads,
        hasNextSection,
        isDarkMode: readerState.readerChrome.isDarkMode,
        isEvaluatingExercise,
        isFocusMode: readerState.readerChrome.isFocusMode,
        isLoading: isActiveSectionLoading,
        isMobileViewport: readerState.readerChrome.isMobileViewport,
        isQuizSubmitted: readerState.isQuizSubmitted,
        learningAids: controller.activeSection?.learningAids || [],
        lessonSources: controller.activeSection
          ? controller.researchDossiersBySectionId[controller.activeSection.id]?.sources || []
          : [],
        onAdvanceSection: () => {
          void readerActions.handleAdvanceSection();
        },
        onCompleteSection: () => {
          void readerActions.handleCompleteSection();
        },
        onAttachExerciseFiles: handleAttachExerciseFiles,
        onContentClick: readerState.readerContext.handleContentClick,
        onContentContextMenu: readerState.readerContext.handleContentContextMenu,
        onContentPointerDownCapture: readerState.readerContext.handleContentPointerDownCapture,
        onSaveLearningAids: handleSaveLearningAids,
        onRequestExerciseFeedback: handleRequestExerciseFeedback,
        onSelectQuizAnswer: readerState.handleSelectQuizAnswer,
        onRemoveExerciseAttachment: handleRemoveExerciseAttachment,
        onSetIsQuizSubmitted: readerState.setIsQuizSubmitted,
        onUpdateExerciseInternalText: handleUpdateExerciseInternalText,
        quiz: activeExercise ? [] : controller.quiz,
        quizAnswers: activeExercise ? [] : readerState.quizAnswers,
        scrollContainerRef: readerState.scrollContainerRef,
        sectionAnnotations: controller.activeSection?.annotations,
        sectionContent: activeExercise ? '' : controller.sectionContent,
        sectionContentBlocks: activeExercise ? undefined : controller.activeSection?.contentBlocks,
        exerciseFeedbackError: controller.workflowState.evaluateExercise.error,
        exerciseFeedbackStatus: controller.workflowState.evaluateExercise.message,
        sectionReasoningText: controller.workflowState.loadSection.reasoning,
        sectionProgress: controller.workflowState.loadSection.progress,
        sourcePageRangeLabel: activeSectionSourcePageRangeLabel,
        ttsTextPicker: {
          confirmationRects: readerState.ttsTextPicker.confirmationRects,
          hoveredChunkIndex: readerState.ttsTextPicker.hoveredChunkIndex,
          isActive: readerState.ttsTextPicker.isActive,
          overlayRects: readerState.ttsTextPicker.overlayRects,
        },
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
        learningAids: controller.activeSection?.learningAids || [],
        loadingStatus,
        musicUrl: controller.musicUrl,
        musicVolume: readerState.musicVolume,
        onBackToLibrary: handleBackToLibrary,
        onOpenSidebar: () => readerState.readerChrome.setIsMobileSidebarOpen(v => !v),
        onRegenerateActiveSection: readerActions.handleRegenerateActiveSection,
        onSaveLearningAids: handleSaveLearningAids,
        onSetCourseGenerationNotes: controller.setGenerationNotes,
        onSetDarkMode: readerState.readerChrome.setIsDarkMode,
        onSetFocusMode: readerState.readerChrome.setIsFocusMode,
        onSetIsMusicPlaying: readerState.setIsMusicPlaying,
        onSetLastAudioTab: readerState.setLastAudioTab,
        onSetMusicUrl: controller.setMusicUrl,
        onSetMusicVolume: readerState.setMusicVolume,
        onSetSettingsOpen: readerState.readerChrome.setIsSettingsOpen,
        onSetSettingsPanelExpandedSections: readerState.setSettingsPanelExpandedSections,
        settingsPanelExpandedSections: readerState.settingsPanelExpandedSections,
        syncState,
        tts: {
          availableVoices: readerState.ttsPlayer.availableVoices,
          chunkOptions: readerState.ttsPlayer.chunkOptions,
          currentChunkIndex: readerState.ttsPlayer.audioState.currentChunkIndex,
          currentTime: readerState.ttsPlayer.playerCurrentTime,
          currentVoice: readerState.ttsPlayer.audioState.currentVoice,
          duration: readerState.ttsPlayer.playerDuration,
          errorMessage: readerState.ttsPlayer.errorMessage,
          isLoading: playerCurrentChunkIsLoading,
          isPlaying: readerState.ttsPlayer.audioState.isPlaying,
          isTextPickerActive: readerState.ttsTextPicker.isActive,
          playbackRate: readerState.ttsPlayer.audioState.playbackRate,
          sectionContent: controller.sectionContent,
          ttsConnected: readerState.ttsPlayer.ttsConnected,
          onPlayPause: readerState.ttsPlayer.togglePlayPause,
          onSeek: readerState.ttsPlayer.handleSeek,
          onSelectChunk: readerState.ttsPlayer.handleSelectChunk,
          onSetTextPickerActive: readerState.ttsTextPicker.setIsActive,
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
        currentLessonArtifactPayloads,
        handleContextAnswerResizeStart: readerState.readerContext.handleContextAnswerResizeStart,
        isContextLoading: controller.isContextBusy,
        isDarkMode: readerState.readerChrome.isDarkMode,
        isMobileViewport: readerState.readerChrome.isMobileViewport,
        lessonCreationBlockReason: controller.isLessonGenerationActive
          ? 'lesson-generation'
          : controller.isGenerationActive ||
              controller.workflowState.loadSection.status === 'pending' ||
              controller.workflowState.generateExercise.status === 'pending'
            ? 'other-operation'
            : null,
        onAskContextQuestion: readerActions.handleContextQuestion,
        onAttachArtifactToAnnotation: readerActions.handleAttachArtifactToAnnotation,
        onCloseContextAnswer: readerState.readerContext.closeContextAnswer,
        onCloseContextMenu: readerState.readerContext.closeContextMenu,
        onCreateLesson: readerActions.handleCreateLesson,
        onDeleteAnnotation: readerActions.handleDeleteAnnotation,
        onDetachArtifactFromAnnotation: readerActions.handleDetachArtifactFromAnnotation,
        onHighlight: readerActions.handleHighlight,
        onSaveArtifactToLesson: readerActions.handleSaveArtifactToLesson,
        onReplaceArtifactInLesson: readerActions.handleReplaceArtifactInLesson,
        onSaveConversationNote: readerActions.handleSaveConversationNote,
        onSaveNote: readerActions.handleSaveNote,
        onUpdateConversationNote: readerActions.handleUpdateConversationNote,
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
        onRepairApplicationExercises: handleRepairApplicationExercises,
        onSelectExercise: readerActions.handleSelectExercise,
        onSelectSection: readerActions.handleSelectSection,
        onSetFocusMode: readerState.readerChrome.setIsFocusMode,
        onSetIsMobileSidebarOpen: readerState.readerChrome.setIsMobileSidebarOpen,
        shouldShowSidebar: readerState.readerChrome.shouldShowSidebar,
        sidebarGroups: readerState.sidebarGroups,
      },
    }),
    [
      activeSectionSourcePageRangeLabel,
      activeExercise,
      activePathNode,
      exercisePrerequisiteGaps,
      controller.activeSection,
      controller.activeSectionId,
      controller.generatingSectionId,
      controller.isBlocking,
      controller.isContextBusy,
      controller.isGenerationActive,
      controller.isLessonGenerationActive,
      controller.learningPlan,
      controller.musicUrl,
      controller.needsSourceFile,
      controller.quiz,
      controller.researchDossiersBySectionId,
      controller.sectionContent,
      controller.source,
      controller.setGenerationNotes,
      controller.setMusicUrl,
      controller.storageError,
      controller.workflowState.evaluateExercise.error,
      controller.workflowState.evaluateExercise.message,
      controller.workflowState.generateExercise.status,
      controller.workflowState.loadSection.status,
      controller.workflowState.loadSection.reasoning,
      controller.workflowState.loadSection.progress,
      currentLessonArtifactPayloads,
      handleAttachSourceFile,
      handleBackToLibrary,
      handleExportProject,
      handleSaveLearningAids,
      handleRepairApplicationExercises,
      handleAttachExerciseFiles,
      handleRemoveExerciseAttachment,
      handleRequestExerciseFeedback,
      handleUpdateExerciseInternalText,
      hasNextSection,
      isActiveSectionLoading,
      isRepairingApplicationExercises,
      isEvaluatingExercise,
      loadingStatus,
      pdfMappingWarning,
      playerCurrentChunkIsLoading,
      readerActions,
      readerState.activeSectionAssetsById,
      readerState.activeSectionGeneratedVisualsById,
      readerState.activeSectionImageRefsById,
      readerState.activeSidebarGroup,
      readerState.contentRef,
      readerState.handleSelectQuizAnswer,
      readerState.isMusicPlaying,
      readerState.isQuizSubmitted,
      readerState.lastAudioTab,
      readerState.musicVolume,
      readerState.quizAnswers,
      readerState.readerChrome,
      readerState.readerContext.closeContextAnswer,
      readerState.readerContext.closeContextMenu,
      readerState.readerContext.contextAnswer,
      readerState.readerContext.contextAnswerPanelRef,
      readerState.readerContext.contextAnswerResizePreviewRef,
      readerState.readerContext.contextAnswerSize,
      readerState.readerContext.contextMenu,
      readerState.readerContext.contextMenuRef,
      readerState.readerContext.handleContentClick,
      readerState.readerContext.handleContentContextMenu,
      readerState.readerContext.handleContentPointerDownCapture,
      readerState.readerContext.handleContextAnswerResizeStart,
      readerState.scrollContainerRef,
      readerState.setIsMusicPlaying,
      readerState.setIsQuizSubmitted,
      readerState.setLastAudioTab,
      readerState.setMusicVolume,
      readerState.setSettingsPanelExpandedSections,
      readerState.settingsPanelExpandedSections,
      readerState.sidebarGroups,
      readerState.ttsPlayer.audioState.currentChunkIndex,
      readerState.ttsPlayer.audioState.currentVoice,
      readerState.ttsPlayer.audioState.isPlaying,
      readerState.ttsPlayer.audioState.playbackRate,
      readerState.ttsPlayer.availableVoices,
      readerState.ttsPlayer.chunkOptions,
      readerState.ttsPlayer.errorMessage,
      readerState.ttsPlayer.handleSeek,
      readerState.ttsPlayer.handleSelectChunk,
      readerState.ttsPlayer.handleSkipChunk,
      readerState.ttsPlayer.handleSpeedChange,
      readerState.ttsPlayer.handleVoiceChange,
      readerState.ttsPlayer.playerCurrentTime,
      readerState.ttsPlayer.playerDuration,
      readerState.ttsPlayer.togglePlayPause,
      readerState.ttsPlayer.ttsConnected,
      readerState.ttsTextPicker.confirmationRects,
      readerState.ttsTextPicker.hoveredChunkIndex,
      readerState.ttsTextPicker.isActive,
      readerState.ttsTextPicker.overlayRects,
      readerState.ttsTextPicker.setIsActive,
      syncState,
    ]
  );
};
