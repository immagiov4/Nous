import { useCallback, useEffect, useMemo, useRef } from 'react';
import { resolvePdfMappingWarning } from '../../app/pdfMappingWarning.ts';
import { useInitialSectionAutoOpen } from '../../app/useInitialSectionAutoOpen.ts';
import { useReaderShellProps } from '../../app/useReaderShellProps.ts';
import { useStudyTimeTracking } from '../../hooks/library/useLearningActivity.ts';
import type { useProjectLibrary } from '../../hooks/library/useProjectLibrary.ts';
import { useSyncIndicator } from '../../hooks/workspace/useSyncIndicator.ts';
import type { useWorkspaceController } from '../../hooks/workspace/useWorkspaceController.ts';
import type { useWorkspaceFileActions } from '../../hooks/workspace/useWorkspaceFileActions.ts';
import type { useWorkspaceNavigation } from '../../hooks/workspace/useWorkspaceNavigation.ts';
import { useWorkspaceReaderActions } from '../../hooks/workspace/useWorkspaceReaderActions.ts';
import type { useWorkspaceReaderState } from '../../hooks/workspace/useWorkspaceReaderState.ts';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type { AppState } from '../../types.ts';
import { flattenLessons } from '../../utils/learning/pathNodes.ts';
import {
  resolveActiveSectionAnnotationHighlightTarget,
  setSectionAnnotationHighlightHit,
} from '../../utils/learning/sectionAnnotationHighlights.ts';
import type { LibraryNavigationTarget } from '../shared/LibraryToolReferences.tsx';
import CourseGenerationNotesDialog from './CourseGenerationNotesDialog.tsx';
import WorkspaceReaderShell from './WorkspaceReaderShell.tsx';

type WorkspaceController = ReturnType<typeof useWorkspaceController>;
type WorkspaceReaderState = ReturnType<typeof useWorkspaceReaderState>;
type WorkspaceFileActions = ReturnType<typeof useWorkspaceFileActions>;
type WorkspaceNavigation = ReturnType<typeof useWorkspaceNavigation>;
type ProjectLibrary = ReturnType<typeof useProjectLibrary>;

interface ReadingScreenContainerProps {
  readonly controller: WorkspaceController;
  readonly projectLibrary: ProjectLibrary;
  readonly readerState: WorkspaceReaderState;
  readonly fileActions: WorkspaceFileActions;
  readonly navigation: WorkspaceNavigation;
  readonly notify: (message: string, kind?: 'error' | 'success') => void;
  readonly screenState: AppState;
}

interface LibraryReferenceNavigationDependencies {
  readonly activeSectionId: string | null;
  readonly cancelPendingProjectOpen: () => void;
  readonly clearPendingReference: () => void;
  readonly closeContextAnswer: () => void;
  readonly currentProjectId: string | null;
  readonly isCurrentRequest: () => boolean;
  readonly isSectionLoadPending: boolean;
  readonly learningPlan: WorkspaceController['learningPlan'];
  readonly openProject: WorkspaceNavigation['handleOpenProject'];
  readonly openSection: WorkspaceController['openSection'];
  readonly reportFailure: (error?: unknown) => void;
  readonly revealAnnotation: () => void;
}

const openCrossProjectReference = async (
  reference: LibraryNavigationTarget,
  dependencies: LibraryReferenceNavigationDependencies
) => {
  if (dependencies.isSectionLoadPending) {
    dependencies.reportFailure();
    return;
  }
  const result = await dependencies.openProject(reference.projectId, {
    activeSectionId: reference.lessonId,
    source: 'library',
  });
  if (result.outcome === 'stale' || result.outcome === 'failed') {
    dependencies.clearPendingReference();
    return;
  }
  if (result.outcome === 'missing') {
    dependencies.reportFailure();
    return;
  }
  if (dependencies.isCurrentRequest()) {
    dependencies.closeContextAnswer();
  }
};

const openCurrentProjectReference = async (
  reference: LibraryNavigationTarget,
  dependencies: LibraryReferenceNavigationDependencies
) => {
  if (!reference.lessonId) {
    dependencies.closeContextAnswer();
    return;
  }
  const lesson = flattenLessons(dependencies.learningPlan?.modules).find(
    candidate => candidate.id === reference.lessonId
  );
  if (!lesson) {
    dependencies.reportFailure();
    return;
  }
  if (reference.lessonId === dependencies.activeSectionId) {
    if (!dependencies.isCurrentRequest()) return;
    dependencies.closeContextAnswer();
    dependencies.revealAnnotation();
    return;
  }

  const openOutcome = await dependencies.openSection(lesson);
  if (openOutcome === 'ignored-busy') {
    dependencies.reportFailure();
    return;
  }
  if (!dependencies.isCurrentRequest()) return;
  dependencies.closeContextAnswer();
  dependencies.revealAnnotation();
};

export const navigateToLibraryReference = async (
  reference: LibraryNavigationTarget,
  dependencies: LibraryReferenceNavigationDependencies
) => {
  try {
    dependencies.cancelPendingProjectOpen();
    if (reference.projectId !== dependencies.currentProjectId) {
      await openCrossProjectReference(reference, dependencies);
      return;
    }
    await openCurrentProjectReference(reference, dependencies);
  } catch (error) {
    dependencies.reportFailure(error);
  }
};

export const revealLibraryAnnotation = (annotationId: string): boolean => {
  const escapedAnnotationId = CSS.escape(annotationId);
  const annotationMark = document.querySelector<HTMLElement>(
    `mark[data-nous-annotation-id="${escapedAnnotationId}"], mark[data-lumina-annotation-id="${escapedAnnotationId}"]`
  );
  if (annotationMark) {
    annotationMark.scrollIntoView({ behavior: 'auto', block: 'center' });
    globalThis.requestAnimationFrame(() => {
      annotationMark.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    return true;
  }

  const nativeHighlightTarget = resolveActiveSectionAnnotationHighlightTarget(annotationId);
  if (!nativeHighlightTarget) return false;

  nativeHighlightTarget.element.scrollIntoView({ behavior: 'auto', block: 'center' });
  globalThis.requestAnimationFrame(() => {
    const revealedTarget =
      resolveActiveSectionAnnotationHighlightTarget(annotationId) || nativeHighlightTarget;
    const clickEvent = new MouseEvent('click', {
      bubbles: true,
      clientX: revealedTarget.hit.rect.left + revealedTarget.hit.rect.width / 2,
      clientY: revealedTarget.hit.rect.top + revealedTarget.hit.rect.height / 2,
    });
    setSectionAnnotationHighlightHit(clickEvent, revealedTarget.hit);
    revealedTarget.element.dispatchEvent(clickEvent);
  });
  return true;
};

export const ReadingScreenContainer = ({
  controller,
  projectLibrary,
  readerState,
  fileActions,
  navigation,
  notify,
  screenState,
}: ReadingScreenContainerProps) => {
  useStudyTimeTracking();

  const libraryAssistantDataSource = useMemo(
    () => ({
      attachedContextRefs: [],
      folders: projectLibrary.libraryFolders,
      loadProjectsById: projectLibrary.loadProjectsById,
      projects: projectLibrary.savedProjects,
      tree: projectLibrary.libraryTree,
    }),
    [
      projectLibrary.libraryFolders,
      projectLibrary.libraryTree,
      projectLibrary.loadProjectsById,
      projectLibrary.savedProjects,
    ]
  );
  const pendingAnnotationIdRef = useRef<string | null>(null);
  const libraryReferenceRequestIdRef = useRef(0);

  const {
    activeSection,
    activeSectionId,
    askContextQuestion,
    completeActiveSection,
    currentProjectId,
    createLessonFromSelection,
    documentIndex,
    isBlocking,
    learningPlan,
    openSection,
    openExercise,
    patchSectionAnnotations,
    regenerateActiveSection,
    sectionContent,
    setGenerationNotes,
    source,
    updateSection,
  } = controller;
  const {
    closeContextAnswer,
    closeContextMenu,
    contextMenu,
    contextMenuScrollTopRef,
    openContextAnswer,
  } = readerState.readerContext;
  const { isMobileViewport, setIsMobileSidebarOpen } = readerState.readerChrome;

  const revealPendingAnnotation = useCallback((requestId: number) => {
    if (libraryReferenceRequestIdRef.current !== requestId) return;

    const annotationId = pendingAnnotationIdRef.current;
    if (!annotationId) return;
    if (revealLibraryAnnotation(annotationId)) pendingAnnotationIdRef.current = null;
  }, []);

  const clearPendingLibraryReference = useCallback((requestId: number) => {
    if (libraryReferenceRequestIdRef.current === requestId) {
      pendingAnnotationIdRef.current = null;
    }
  }, []);

  const reportLibraryReferenceFailure = useCallback(
    (requestId: number, error?: unknown) => {
      if (libraryReferenceRequestIdRef.current !== requestId) return;

      pendingAnnotationIdRef.current = null;
      if (error) {
        console.error('[Nous][Library reference] Navigation failed.', error);
      }
      notify(t('Non sono riuscito ad aprire il materiale recuperato. Riprova.'), 'error');
    },
    [notify]
  );

  const handleOpenLibraryReference = useCallback(
    (reference: LibraryNavigationTarget) => {
      const requestId = libraryReferenceRequestIdRef.current + 1;
      libraryReferenceRequestIdRef.current = requestId;
      pendingAnnotationIdRef.current = reference.annotationId || null;
      void navigateToLibraryReference(reference, {
        activeSectionId,
        cancelPendingProjectOpen: controller.cancelProjectOpen,
        clearPendingReference: () => clearPendingLibraryReference(requestId),
        closeContextAnswer,
        currentProjectId,
        isCurrentRequest: () => libraryReferenceRequestIdRef.current === requestId,
        isSectionLoadPending: controller.workflowState.loadSection.status === 'pending',
        learningPlan,
        openProject: navigation.handleOpenProject,
        openSection,
        reportFailure: error => reportLibraryReferenceFailure(requestId, error),
        revealAnnotation: () => requestAnimationFrame(() => revealPendingAnnotation(requestId)),
      });
    },
    [
      activeSectionId,
      clearPendingLibraryReference,
      currentProjectId,
      closeContextAnswer,
      controller.cancelProjectOpen,
      controller.workflowState.loadSection.status,
      learningPlan,
      navigation,
      openSection,
      reportLibraryReferenceFailure,
      revealPendingAnnotation,
    ]
  );

  useEffect(() => {
    if (
      !pendingAnnotationIdRef.current ||
      !activeSection?.content ||
      !activeSectionId ||
      !currentProjectId
    )
      return;

    const requestId = libraryReferenceRequestIdRef.current;
    const frameId = requestAnimationFrame(() => revealPendingAnnotation(requestId));
    return () => cancelAnimationFrame(frameId);
  }, [activeSection?.content, activeSectionId, currentProjectId, revealPendingAnnotation]);

  const readerActions = useWorkspaceReaderActions({
    activeSectionId,
    advanceActiveSection: controller.advanceActiveSection,
    askContextQuestion,
    closeContextMenu,
    completeActiveSection,
    contextMenu,
    contextMenuScrollTopRef,
    createLessonFromSelection,
    documentIndex,
    isMobileViewport,
    learningPlan,
    notify,
    openContextAnswer,
    openExercise,
    openSection,
    patchSectionAnnotations,
    projectId: currentProjectId,
    regenerateActiveSection,
    sectionContent,
    scrollContainerRef: readerState.scrollContainerRef,
    setIsMobileSidebarOpen,
    source,
    updateSection,
  });

  const { acknowledgeGenerationNotesDialog, isNotesDialogOpen } = useInitialSectionAutoOpen({
    activeSection,
    currentProjectId,
    documentIndex,
    isBlocking,
    learningPlan,
    openSection,
    screenState,
    source,
  });

  const pdfMappingWarning = resolvePdfMappingWarning(controller.source, controller.documentIndex);

  const { syncState } = useSyncIndicator();

  const readerShellProps = useReaderShellProps({
    controller,
    handleAttachSourceFile: fileActions.handleAttachSourceFile,
    handleBackToLibrary: navigation.handleBackToLibrary,
    handleExportProject: fileActions.handleExportProject,
    notify,
    pdfMappingWarning,
    readerActions,
    readerState,
    libraryAssistantDataSource,
    onOpenLibraryReference: handleOpenLibraryReference,
    syncState,
  });

  // Close context menu when navigating away from reader (container unmounts)
  useEffect(() => {
    return () => {
      closeContextMenu();
    };
  }, [closeContextMenu]);

  return (
    <>
      <input
        id={fileActions.sourceFileInputId}
        type="file"
        className="hidden"
        onChange={fileActions.handleFileUpload}
      />
      <WorkspaceReaderShell {...readerShellProps} />
      {isNotesDialogOpen && learningPlan ? (
        <CourseGenerationNotesDialog
          courseTitle={learningPlan.title || 'Percorso di Studio'}
          initialValue={learningPlan.generationNotes ?? ''}
          onSaveAndContinue={notes => {
            setGenerationNotes(notes);
            acknowledgeGenerationNotesDialog();
          }}
          onSkip={acknowledgeGenerationNotesDialog}
        />
      ) : null}
    </>
  );
};
