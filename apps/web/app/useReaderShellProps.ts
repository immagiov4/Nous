import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LibraryNavigationTarget } from '../components/shared/LibraryToolReferences.tsx';
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
import type { LibraryAssistantDataSource } from '../services/library/toolExecutor.ts';
import { getExercisePrerequisiteGaps } from '../services/openrouter/exercises/brief.ts';
import { retryDurableLessonVisual } from '../services/openrouter/lessonVisualRetryClient.ts';
import { ProjectStorageError } from '../services/projects/projectRepository.ts';
import type {
  ExerciseAttachment,
  LessonGeneratedVisualBlock,
  LessonLearningAid,
  LessonNode,
} from '../types.ts';
import {
  getLessonSourcePageLabel,
  resolveLessonSourceReferences,
} from '../utils/context/sourceMaterial.ts';
import { collectSectionLearningArtifactPayloads } from '../utils/learning/artifacts.ts';
import { findPathNodeById, flattenLessons } from '../utils/learning/pathNodes.ts';

type WorkspaceController = ReturnType<typeof useWorkspaceController>;
type WorkspaceReaderState = ReturnType<typeof useWorkspaceReaderState>;
type WorkspaceReaderActions = ReturnType<typeof useWorkspaceReaderActions>;

export const loadStoredDocumentSourceFile = async ({
  loadPrimarySource,
  loadSourceById,
  loadSources,
  sourceId,
  usePrimarySource,
}: {
  loadPrimarySource: () => ReturnType<WorkspaceController['loadStoredProjectSource']>;
  loadSourceById: () => ReturnType<WorkspaceController['loadStoredProjectSourceById']>;
  loadSources: () => ReturnType<WorkspaceController['loadStoredProjectSources']>;
  sourceId: string;
  usePrimarySource: boolean;
}) => {
  if (usePrimarySource) {
    return loadPrimarySource();
  }

  try {
    return await loadSourceById();
  } catch (error) {
    if (!(error instanceof ProjectStorageError) || error.httpStatus !== 404) {
      throw error;
    }
    const storedSources = await loadSources();
    return storedSources.find(stored => stored.ref.id === sourceId)?.file || null;
  }
};

interface UseReaderShellPropsArgs {
  controller: WorkspaceController;
  handleAttachSourceFile: () => void;
  handleBackToLibrary: () => void;
  handleExportProject: (projectId?: string) => Promise<void>;
  libraryAssistantDataSource: LibraryAssistantDataSource;
  notify: (message: string, kind?: 'error' | 'success') => void;
  onOpenLibraryReference: (reference: LibraryNavigationTarget) => void;
  pdfMappingWarning: string | null;
  readerActions: WorkspaceReaderActions;
  readerState: WorkspaceReaderState;
  syncState: 'saved' | 'saving' | 'error';
}

interface GeneratedVisualRetryContext {
  activeSection: LessonNode | null;
  activeSectionId: string | null;
  applyPersistedProjectRevision: (args: {
    projectId: string;
    revision: number;
  }) => Promise<boolean>;
  lessonWorkflowRequestId: number;
  projectId: string | null;
}

interface GeneratedVisualRetryCoordinator {
  dispose: () => void;
  retry: (block: LessonGeneratedVisualBlock) => Promise<boolean>;
  setContext: (context: GeneratedVisualRetryContext) => void;
}

interface ActiveGeneratedVisualRetry {
  abortController: AbortController;
  projectId: string;
  promise: Promise<boolean>;
  sectionId: string;
  workflowRequestId: number;
}

const findRetryBlock = (
  section: LessonNode,
  slotId: string
): LessonGeneratedVisualBlock | undefined =>
  section.contentBlocks?.find(
    (block): block is LessonGeneratedVisualBlock =>
      block.type === 'generated-visual' && block.slotId === slotId && Boolean(block.retryPlan)
  );

const matchesRetryOrigin = (
  context: GeneratedVisualRetryContext,
  projectId: string | null,
  sectionId: string,
  workflowRequestId: number
): boolean =>
  context.projectId === projectId &&
  context.activeSectionId === sectionId &&
  context.lessonWorkflowRequestId === workflowRequestId;

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

export const createGeneratedVisualRetryCoordinator = ({
  initialContext,
  retryVisual = retryDurableLessonVisual,
}: {
  initialContext: GeneratedVisualRetryContext;
  retryVisual?: typeof retryDurableLessonVisual;
}): GeneratedVisualRetryCoordinator => {
  let currentContext = initialContext;
  let disposed = false;
  const activeRetries = new Map<string, ActiveGeneratedVisualRetry>();

  const runRetry = async (
    block: LessonGeneratedVisualBlock,
    projectId: string,
    sectionId: string,
    workflowRequestId: number,
    signal: AbortSignal
  ): Promise<boolean> => {
    const context = currentContext;
    if (
      disposed ||
      !matchesRetryOrigin(context, projectId, sectionId, workflowRequestId) ||
      !context.activeSection
    )
      return false;
    const currentBlock = findRetryBlock(context.activeSection, block.slotId);
    if (!currentBlock?.retryPlan) return false;

    let result: Awaited<ReturnType<typeof retryVisual>>;
    try {
      result = await retryVisual(
        {
          projectId,
          sectionId,
          slotId: currentBlock.slotId,
        },
        { signal }
      );
    } catch (error) {
      if (isAbortError(error)) return false;
      throw error;
    }
    const latestContext = currentContext;
    if (
      disposed ||
      !matchesRetryOrigin(latestContext, projectId, sectionId, workflowRequestId) ||
      !latestContext.activeSection
    )
      return false;
    return latestContext.applyPersistedProjectRevision({
      projectId,
      revision: result.projectRevision,
    });
  };

  const retry = (block: LessonGeneratedVisualBlock): Promise<boolean> => {
    if (disposed) return Promise.resolve(false);
    const context = currentContext;
    const sectionId = context.activeSection?.id;
    const projectId = context.projectId;
    if (!projectId || !sectionId || !block.retryPlan) return Promise.resolve(false);
    const retryKey = `${projectId}:${sectionId}:${block.slotId}`;
    const existing = activeRetries.get(retryKey);
    if (existing !== undefined) return existing.promise;
    const abortController = new AbortController();
    const workflowRequestId = context.lessonWorkflowRequestId;
    const promise = runRetry(
      block,
      projectId,
      sectionId,
      workflowRequestId,
      abortController.signal
    );
    const activeRetry = {
      abortController,
      projectId,
      promise,
      sectionId,
      workflowRequestId,
    };
    activeRetries.set(retryKey, activeRetry);
    return promise.finally(() => {
      if (activeRetries.get(retryKey) === activeRetry) activeRetries.delete(retryKey);
    });
  };

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const activeRetry of activeRetries.values()) {
        activeRetry.abortController.abort();
      }
      activeRetries.clear();
    },
    retry,
    setContext: context => {
      if (disposed) return;
      currentContext = context;
      for (const activeRetry of activeRetries.values()) {
        if (
          !context.activeSection ||
          !matchesRetryOrigin(
            context,
            activeRetry.projectId,
            activeRetry.sectionId,
            activeRetry.workflowRequestId
          )
        ) {
          activeRetry.abortController.abort();
        }
      }
    },
  };
};

export const useGeneratedVisualRetryCoordinator = ({
  context,
  retryVisual,
}: {
  context: GeneratedVisualRetryContext;
  retryVisual?: typeof retryDurableLessonVisual;
}): GeneratedVisualRetryCoordinator => {
  const [coordinator] = useState(() =>
    createGeneratedVisualRetryCoordinator({ initialContext: context, retryVisual })
  );
  useEffect(() => coordinator.setContext(context), [context, coordinator]);
  useEffect(() => () => coordinator.dispose(), [coordinator]);
  return coordinator;
};

export const useReaderShellProps = ({
  controller,
  handleAttachSourceFile,
  handleBackToLibrary,
  handleExportProject,
  libraryAssistantDataSource,
  notify,
  onOpenLibraryReference,
  pdfMappingWarning,
  readerActions,
  readerState,
  syncState,
}: UseReaderShellPropsArgs): WorkspaceReaderShellProps => {
  const visualRetryContext = useMemo<GeneratedVisualRetryContext>(
    () => ({
      activeSection: controller.activeSection,
      activeSectionId: controller.activeSectionId,
      applyPersistedProjectRevision: controller.applyPersistedProjectRevision,
      lessonWorkflowRequestId: controller.workflowState.loadSection.requestId,
      projectId: controller.currentProjectId,
    }),
    [
      controller.activeSection,
      controller.activeSectionId,
      controller.applyPersistedProjectRevision,
      controller.currentProjectId,
      controller.workflowState.loadSection.requestId,
    ]
  );
  const visualRetryCoordinator = useGeneratedVisualRetryCoordinator({
    context: visualRetryContext,
  });
  const activeSectionSourcePageRangeLabel = useMemo(
    () =>
      getLessonSourcePageLabel({
        activeSection: controller.activeSection,
        documentIndex: controller.documentIndex,
      }),
    [controller.activeSection, controller.documentIndex]
  );
  const activeSectionSourceReferences = useMemo(
    () =>
      resolveLessonSourceReferences({
        activeSection: controller.activeSection,
        source: controller.source,
      }),
    [controller.activeSection, controller.source]
  );
  const loadDocumentSourceFile = useCallback(
    async (sourceId: string) => {
      const inMemoryFile = activeSectionSourceReferences.find(
        reference => reference.sourceId === sourceId
      )?.file;
      if (inMemoryFile?.data) {
        return inMemoryFile;
      }

      const projectId = controller.currentProjectId;
      if (!projectId) {
        return null;
      }
      const reference = activeSectionSourceReferences.find(item => item.sourceId === sourceId);
      const storedFile = await loadStoredDocumentSourceFile({
        loadPrimarySource: () => controller.loadStoredProjectSource(projectId),
        loadSourceById: () => controller.loadStoredProjectSourceById(projectId, sourceId),
        loadSources: () => controller.loadStoredProjectSources(projectId),
        sourceId,
        usePrimarySource: reference?.kind === 'archive' || !controller.source?.sources?.length,
      });
      if (controller.getCurrentProjectId() !== projectId) {
        return null;
      }
      return storedFile;
    },
    [activeSectionSourceReferences, controller]
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
  const handleRetryGeneratedVisual = visualRetryCoordinator.retry;

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
        projectId: controller.currentProjectId,
        documentSourceReferences: activeSectionSourceReferences,
        loadDocumentSourceFile,
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
        onRequestExerciseFeedback: handleRequestExerciseFeedback,
        onRetryGeneratedVisual: handleRetryGeneratedVisual,
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
        learningAids: controller.activeSection?.learningAids || [],
        loadingStatus,
        musicUrl: controller.musicUrl,
        musicVolume: readerState.musicVolume,
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
        libraryAssistantDataSource,
        lessonCreationBlockReason: controller.isLessonGenerationActive
          ? 'lesson-generation'
          : controller.isGenerationActive ||
              controller.workflowState.loadSection.status === 'pending' ||
              controller.workflowState.generateExercise.status === 'pending'
            ? 'other-operation'
            : null,
        loadDocumentSourceFile,
        onAskContextQuestion: readerActions.handleContextQuestion,
        onAttachArtifactToAnnotation: readerActions.handleAttachArtifactToAnnotation,
        onCloseContextAnswer: readerState.readerContext.closeContextAnswer,
        onCloseContextMenu: readerState.readerContext.closeContextMenu,
        onCreateLesson: readerActions.handleCreateLesson,
        onDeleteAnnotation: readerActions.handleDeleteAnnotation,
        onDetachArtifactFromAnnotation: readerActions.handleDetachArtifactFromAnnotation,
        onHighlight: readerActions.handleHighlight,
        onOpenLibraryReference,
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
        isSectionLoading: controller.workflowState.loadSection.status === 'pending',
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
      activeSectionSourceReferences,
      activeSectionSourcePageRangeLabel,
      activeExercise,
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
      controller.currentProjectId,
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
      handleRetryGeneratedVisual,
      handleUpdateExerciseInternalText,
      hasNextSection,
      isActiveSectionLoading,
      isRepairingApplicationExercises,
      isEvaluatingExercise,
      libraryAssistantDataSource,
      loadingStatus,
      onOpenLibraryReference,
      loadDocumentSourceFile,
      pdfMappingWarning,
      playerCurrentChunkIsLoading,
      readerActions,
      readerState.activeSectionAssetsById,
      readerState.activeSectionGeneratedVisualsById,
      readerState.activeSectionImageRefsById,
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
