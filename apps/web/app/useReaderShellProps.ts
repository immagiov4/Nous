// fallow-ignore-file unused-files
import { useCallback, useMemo } from 'react';
import type {
  WorkspaceReaderBannersModel,
  WorkspaceReaderContentModel,
  WorkspaceReaderHeaderModel,
  WorkspaceReaderOverlaysModel,
  WorkspaceReaderShellProps,
  WorkspaceReaderSidebarModel,
  WorkspaceReaderTtsModel,
} from '../components/workspace/shell/types.ts';
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

const notifyIfErrored = (r: ErrorResult, n: (m: string) => void) => {
  if (r.errorMessage) n(r.errorMessage);
};

// fallow-ignore-next-line unused-exports — used by ReadingScreenContainer
export const useReaderShellProps = ({
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
}: UseReaderShellPropsArgs): WorkspaceReaderShellProps => {
  // ── Controller values ────────────────────────────────────────────────
  const [
    aLabExId,
    aSection,
    aSectionId,
    addLabT,
    attLabF,
    dIdx,
    evLab,
    genLab,
    isB,
    isCB,
    lab,
    lp,
    mus,
    needS,
    opLabEx,
    quiz,
    regLab,
    remLab,
    secC,
    setGN,
    setM,
    storE,
    updLabM,
    updLabT,
    wf,
    genSId,
    blkMsg,
  ] = useMemo(
    () => [
      controller.activeLaboratoryExerciseId,
      controller.activeSection,
      controller.activeSectionId,
      controller.addLaboratoryTextAttachment,
      controller.attachLaboratoryFiles,
      controller.documentIndex,
      controller.evaluateActiveLaboratoryExercise,
      controller.generateLaboratory,
      controller.isBlocking,
      controller.isContextBusy,
      controller.laboratory,
      controller.learningPlan,
      controller.musicUrl,
      controller.needsSourceFile,
      controller.openLaboratoryExercise,
      controller.quiz,
      controller.regenerateActiveLaboratoryExercise,
      controller.removeLaboratoryAttachment,
      controller.sectionContent,
      controller.setGenerationNotes,
      controller.setMusicUrl,
      controller.storageError,
      controller.updateLaboratoryAttachmentMetadata,
      controller.updateLaboratoryTextAttachment,
      controller.workflowState,
      controller.generatingSectionId,
      controller.blockingMessage,
    ],
    [controller]
  );

  // ── Derived ──────────────────────────────────────────────────────────
  const isLB = useMemo(() => selectIsLaboratoryBusy(wf), [wf]);
  const isLG = wf.generateLaboratory.status === 'pending';
  const isLE = wf.evaluateLaboratory.status === 'pending';
  const labMsg = useMemo(() => selectLaboratoryMessage(wf) || 'Laboratorio in corso...', [wf]);
  const labRsn = useMemo(() => selectLaboratoryReasoning(wf), [wf]);
  const srcPL = useMemo(
    () => getLessonSourcePageLabel({ activeSection: aSection, documentIndex: dIdx }),
    [aSection, dIdx]
  );
  const actLab = useMemo(() => selectActiveLaboratoryExercise(lab, aLabExId), [lab, aLabExId]);
  const labSPL = useMemo(
    () => getLaboratorySourcePageLabel({ activeExercise: actLab, documentIndex: dIdx }),
    [actLab, dIdx]
  );

  const isLV = !aSectionId && Boolean(lab);
  const isASL = genSId !== null && genSId === aSectionId;
  const lSt = blkMsg || 'Caricamento...';
  const hIL = isB || (isLV && isLB);
  const hLS = isB ? lSt : labMsg;

  // ── Runtime refs ─────────────────────────────────────────────────────
  const rC = readerRuntime.readerChrome;
  const tP = readerRuntime.ttsPlayer;
  const rX = readerRuntime.readerContext;
  const rA = readerActions;

  const pCL = tP.audioState.chunks[tP.audioState.currentChunkIndex]?.isLoading || false;

  // ── Stable callbacks ──────────────────────────────────────────────────
  const onExp = useCallback(() => {
    void handleExportProject();
  }, [handleExportProject]);
  const onALT = useCallback(() => {
    void addLabT().then(r => notifyIfErrored(r, notify));
  }, [addLabT, notify]);
  const onAtF = useCallback(
    (f: FileList | null) => {
      if (!f?.length) return;
      void attLabF(f).then(r => notifyIfErrored(r, notify));
    },
    [attLabF, notify]
  );
  const onCpl = useCallback(() => {
    void rA.handleCompleteSection();
  }, [rA.handleCompleteSection]);
  const onEvL = useCallback(() => {
    void evLab().then(r => notifyIfErrored(r, notify));
  }, [evLab, notify]);
  const onGnL = useCallback(() => {
    void genLab({ openFirstExercise: true }).then(r => notifyIfErrored(r, notify));
  }, [genLab, notify]);
  const onRmL = useCallback(
    (i: string) => {
      void remLab(i).then(r => notifyIfErrored(r, notify));
    },
    [remLab, notify]
  );
  const onUpM = useCallback(
    (i: string, u: { description?: string; name?: string }) => {
      void updLabM(i, u);
    },
    [updLabM]
  );
  const onUpT = useCallback(
    (i: string, u: { content: string; name?: string }) => {
      void updLabT(i, u);
    },
    [updLabT]
  );
  const onRgL = useCallback(() => {
    void regLab().then(r => notifyIfErrored(r, notify));
  }, [regLab, notify]);
  const onOpS = useCallback(() => {
    rC.setIsMobileSidebarOpen(v => !v);
  }, [rC.setIsMobileSidebarOpen]);
  const onRgI = useCallback(() => {
    void genLab({ force: true, openFirstExercise: !aSectionId }).then(r =>
      notifyIfErrored(r, notify)
    );
  }, [genLab, aSectionId, notify]);
  const onOLX = useCallback(
    (i: string) => {
      void opLabEx(i).then(o => {
        if (o === 'missing') notify('Esercizio non disponibile.');
      });
    },
    [opLabEx, notify]
  );

  // ── tts ──────────────────────────────────────────────────────────────
  const tts = useMemo<WorkspaceReaderTtsModel>(
    () => ({
      availableVoices: tP.availableVoices,
      currentTime: tP.playerCurrentTime,
      currentVoice: tP.audioState.currentVoice,
      duration: tP.playerDuration,
      isPlaying: tP.audioState.isPlaying,
      isLoading: pCL,
      playbackRate: tP.audioState.playbackRate,
      sectionContent: secC,
      ttsConnected: tP.ttsConnected,
      onPlayPause: tP.togglePlayPause,
      onSeek: tP.handleSeek,
      onSkipChunk: tP.handleSkipChunk,
      onSpeedChange: tP.handleSpeedChange,
      onVoiceChange: tP.handleVoiceChange,
    }),
    [
      tP.availableVoices,
      tP.playerCurrentTime,
      tP.audioState.currentVoice,
      tP.playerDuration,
      tP.audioState.isPlaying,
      pCL,
      tP.audioState.playbackRate,
      secC,
      tP.ttsConnected,
      tP.togglePlayPause,
      tP.handleSeek,
      tP.handleSkipChunk,
      tP.handleSpeedChange,
      tP.handleVoiceChange,
    ]
  );

  // ── banners ───────────────────────────────────────────────────────────
  const banners = useMemo<WorkspaceReaderBannersModel>(
    () => ({
      needsSourceFile: needS,
      onAttachSourceFile: handleAttachSourceFile,
      onBackToLibrary: handleBackToLibrary,
      onExportProject: onExp,
      pdfMappingWarning,
      storageError: storE,
    }),
    [needS, handleAttachSourceFile, handleBackToLibrary, onExp, pdfMappingWarning, storE]
  );

  // ── content ───────────────────────────────────────────────────────────
  const content = useMemo<WorkspaceReaderContentModel>(
    () => ({
      activeSectionTitle: aSection?.title || null,
      activeSectionAssetsById: readerRuntime.activeSectionAssetsById,
      activeSectionGeneratedVisualsById: readerRuntime.activeSectionGeneratedVisualsById,
      activeSectionImageRefsById: readerRuntime.activeSectionImageRefsById,
      contentRef: readerRuntime.contentRef,
      isDarkMode: rC.isDarkMode,
      isFocusMode: rC.isFocusMode,
      isLoading: isASL,
      isLaboratoryEvaluating: isLE,
      isLaboratoryGenerating: isLG,
      isLaboratoryView: isLV,
      isMobileViewport: rC.isMobileViewport,
      isQuizSubmitted: readerRuntime.isQuizSubmitted,
      activeLaboratoryExercise: actLab,
      laboratoryActivityMessage: labMsg,
      laboratoryReasoningText: labRsn,
      laboratoryErrorMessage: lab?.errorMessage,
      laboratorySourcePageRangeLabel: labSPL,
      laboratoryStatus: lab?.status || null,
      laboratorySummary: lab?.summary || '',
      laboratoryTitle: lab?.title || 'Laboratorio',
      onAddLaboratoryTextAttachment: onALT,
      onAttachLaboratoryFiles: onAtF,
      onCompleteSection: onCpl,
      onContentClick: rX.handleContentClick,
      onContentContextMenu: rX.handleContentContextMenu,
      onContentPointerDownCapture: rX.handleContentPointerDownCapture,
      onEvaluateActiveLaboratoryExercise: onEvL,
      onGenerateLaboratory: onGnL,
      onRemoveLaboratoryAttachment: onRmL,
      onSelectQuizAnswer: readerRuntime.handleSelectQuizAnswer,
      onSetIsQuizSubmitted: readerRuntime.setIsQuizSubmitted,
      onUpdateLaboratoryAttachmentMetadata: onUpM,
      onUpdateLaboratoryTextAttachment: onUpT,
      quiz,
      quizAnswers: readerRuntime.quizAnswers,
      scrollContainerRef: readerRuntime.scrollContainerRef,
      sectionAnnotations: aSection?.annotations,
      sectionContent: secC,
      sectionReasoningText: wf.loadSection.reasoning,
      sourcePageRangeLabel: srcPL,
    }),
    [
      aSection,
      readerRuntime.activeSectionAssetsById,
      readerRuntime.activeSectionGeneratedVisualsById,
      readerRuntime.activeSectionImageRefsById,
      readerRuntime.contentRef,
      rC.isDarkMode,
      rC.isFocusMode,
      isASL,
      isLE,
      isLG,
      isLV,
      rC.isMobileViewport,
      readerRuntime.isQuizSubmitted,
      actLab,
      labMsg,
      labRsn,
      lab?.errorMessage,
      labSPL,
      lab?.status,
      lab?.summary,
      lab?.title,
      onALT,
      onAtF,
      onCpl,
      rX.handleContentClick,
      rX.handleContentContextMenu,
      rX.handleContentPointerDownCapture,
      onEvL,
      onGnL,
      onRmL,
      readerRuntime.handleSelectQuizAnswer,
      readerRuntime.setIsQuizSubmitted,
      onUpM,
      onUpT,
      quiz,
      readerRuntime.quizAnswers,
      readerRuntime.scrollContainerRef,
      secC,
      wf.loadSection.reasoning,
      srcPL,
    ]
  );

  // ── header ────────────────────────────────────────────────────────────
  const header = useMemo<WorkspaceReaderHeaderModel>(
    () => ({
      activeLaboratoryExercise: actLab,
      activeSectionId: aSection?.id ?? null,
      activeSectionTitle: aSection?.title ?? null,
      hasActiveSection: Boolean(aSection),
      activeSidebarGroup: readerRuntime.activeSidebarGroup,
      courseGenerationNotes: lp?.generationNotes ?? '',
      isDarkMode: rC.isDarkMode,
      isFocusMode: rC.isFocusMode,
      isLoading: hIL,
      isLaboratoryView: isLV,
      isMobileViewport: rC.isMobileViewport,
      isMobileSidebarOpen: rC.isMobileSidebarOpen,
      isMusicPlaying: readerRuntime.isMusicPlaying,
      isSettingsOpen: rC.isSettingsOpen,
      laboratoryTitle: lab?.title || 'Laboratorio',
      learningPlanTitle: lp?.title || 'Percorso di Studio',
      loadingStatus: hLS,
      modelDefaults,
      musicUrl: mus,
      musicVolume: readerRuntime.musicVolume,
      onBackToLibrary: handleBackToLibrary,
      onOpenSidebar: onOpS,
      onRegenerateActiveLaboratoryExercise: onRgL,
      onRegenerateActiveSection: rA.handleRegenerateActiveSection,
      onSetDarkMode: rC.setIsDarkMode,
      onSetCourseGenerationNotes: setGN,
      onSetFocusMode: rC.setIsFocusMode,
      onSetIsMusicPlaying: readerRuntime.setIsMusicPlaying,
      onSetMusicUrl: setM,
      onSetMusicVolume: readerRuntime.setMusicVolume,
      onSetPreferredOpenRouterModel: readerRuntime.setPreferredOpenRouterModel,
      onSetSettingsOpen: rC.setIsSettingsOpen,
      onSetSettingsPanelExpandedSections: readerRuntime.setSettingsPanelExpandedSections,
      preferredModels: readerRuntime.preferredModels,
      settingsPanelExpandedSections: readerRuntime.settingsPanelExpandedSections,
      syncState,
      tts,
    }),
    [
      actLab,
      aSection?.id,
      aSection?.title,
      readerRuntime.activeSidebarGroup,
      lp?.generationNotes,
      rC.isDarkMode,
      rC.isFocusMode,
      hIL,
      isLV,
      rC.isMobileViewport,
      rC.isMobileSidebarOpen,
      readerRuntime.isMusicPlaying,
      rC.isSettingsOpen,
      lab?.title,
      lp?.title,
      hLS,
      modelDefaults,
      mus,
      readerRuntime.musicVolume,
      handleBackToLibrary,
      onOpS,
      onRgL,
      rA.handleRegenerateActiveSection,
      rC.setIsDarkMode,
      setGN,
      rC.setIsFocusMode,
      readerRuntime.setIsMusicPlaying,
      setM,
      readerRuntime.setMusicVolume,
      readerRuntime.setPreferredOpenRouterModel,
      rC.setIsSettingsOpen,
      readerRuntime.setSettingsPanelExpandedSections,
      readerRuntime.preferredModels,
      readerRuntime.settingsPanelExpandedSections,
      syncState,
      tts,
    ]
  );

  // ── overlays ──────────────────────────────────────────────────────────
  const overlays = useMemo<WorkspaceReaderOverlaysModel>(
    () => ({
      contextAnswer: rX.contextAnswer,
      contextAnswerPanelRef: rX.contextAnswerPanelRef,
      contextAnswerResizePreviewRef: rX.contextAnswerResizePreviewRef,
      contextAnswerSize: rX.contextAnswerSize,
      contextMenu: rX.contextMenu,
      contextMenuRef: rX.contextMenuRef,
      handleContextAnswerResizeStart: rX.handleContextAnswerResizeStart,
      isContextLoading: isCB,
      isDarkMode: rC.isDarkMode,
      isMobileViewport: rC.isMobileViewport,
      onAskContextQuestion: rA.handleContextQuestion,
      onCloseContextAnswer: rX.closeContextAnswer,
      onCloseContextMenu: rX.closeContextMenu,
      onCreateLesson: rA.handleCreateLesson,
      onDeleteAnnotation: rA.handleDeleteAnnotation,
      onHighlight: rA.handleHighlight,
      preferredModels: readerRuntime.preferredModels,
      onSaveConversationNote: rA.handleSaveConversationNote,
      onUpdateConversationNote: rA.handleUpdateConversationNote,
      onSaveNote: rA.handleSaveNote,
    }),
    [
      rX.contextAnswer,
      rX.contextAnswerPanelRef,
      rX.contextAnswerResizePreviewRef,
      rX.contextAnswerSize,
      rX.contextMenu,
      rX.contextMenuRef,
      rX.handleContextAnswerResizeStart,
      isCB,
      rC.isDarkMode,
      rC.isMobileViewport,
      rA.handleContextQuestion,
      rX.closeContextAnswer,
      rX.closeContextMenu,
      rA.handleCreateLesson,
      rA.handleDeleteAnnotation,
      rA.handleHighlight,
      readerRuntime.preferredModels,
      rA.handleSaveConversationNote,
      rA.handleUpdateConversationNote,
      rA.handleSaveNote,
    ]
  );

  // ── sidebar ───────────────────────────────────────────────────────────
  const sidebar = useMemo<WorkspaceReaderSidebarModel>(
    () => ({
      activeLaboratoryExerciseId: aLabExId,
      activeSectionId: aSectionId,
      expandedModuleId: rC.expandedModuleId,
      generatingSectionId: genSId ?? null,
      isLoading: isB,
      isMobileViewport: rC.isMobileViewport,
      laboratoryExercises: lab?.exercises || [],
      laboratoryStatus: lab?.status || null,
      laboratoryTitle: lab?.title || 'Laboratorio',
      learningPlanTitle: lp?.title || 'Percorso di Studio',
      onBackToLibrary: handleBackToLibrary,
      onExportProject: onExp,
      onGenerateLaboratory: onGnL,
      onRegenerateLaboratoryIndex: onRgI,
      onModuleToggle: rC.handleModuleToggle,
      onSelectLaboratoryExercise: onOLX,
      onSelectSection: rA.handleSelectSection,
      onSetFocusMode: rC.setIsFocusMode,
      onSetIsMobileSidebarOpen: rC.setIsMobileSidebarOpen,
      shouldShowSidebar: rC.shouldShowSidebar,
      sidebarGroups: readerRuntime.sidebarGroups,
    }),
    [
      aLabExId,
      aSectionId,
      rC.expandedModuleId,
      genSId,
      isB,
      rC.isMobileViewport,
      lab?.exercises,
      lab?.status,
      lab?.title,
      lp?.title,
      handleBackToLibrary,
      onExp,
      onGnL,
      onRgI,
      rC.handleModuleToggle,
      onOLX,
      rA.handleSelectSection,
      rC.setIsFocusMode,
      rC.setIsMobileSidebarOpen,
      rC.shouldShowSidebar,
      readerRuntime.sidebarGroups,
    ]
  );

  return {
    banners,
    content,
    header,
    overlays,
    shouldUseDesktopSidebar: rC.shouldUseDesktopSidebar,
    sidebar,
  };
};
