// fallow-ignore-file unused-files
import { useEffect } from 'react';
import { defaultModelConfig } from '../../app/modelDefaults.ts';
import { resolvePdfMappingWarning } from '../../app/pdfMappingWarning.ts';
import { buildReaderShellProps } from '../../app/readerShellProps.ts';
import { useInitialSectionAutoOpen } from '../../app/useInitialSectionAutoOpen.ts';
import type { useWorkspaceController } from '../../hooks/workspace/useWorkspaceController.ts';
import type { useWorkspaceFileActions } from '../../hooks/workspace/useWorkspaceFileActions.ts';
import type { useWorkspaceNavigation } from '../../hooks/workspace/useWorkspaceNavigation.ts';
import { useWorkspaceReaderActions } from '../../hooks/workspace/useWorkspaceReaderActions.ts';
import type { useWorkspaceReaderRuntime } from '../../hooks/workspace/useWorkspaceReaderRuntime.ts';
import type { AppState } from '../../types.ts';
import CourseGenerationNotesDialog from './CourseGenerationNotesDialog.tsx';
import WorkspaceReaderShell from './WorkspaceReaderShell.tsx';

type WorkspaceController = ReturnType<typeof useWorkspaceController>;
type WorkspaceReaderRuntime = ReturnType<typeof useWorkspaceReaderRuntime>;
type WorkspaceFileActions = ReturnType<typeof useWorkspaceFileActions>;
type WorkspaceNavigation = ReturnType<typeof useWorkspaceNavigation>;

interface ReadingScreenContainerProps {
  controller: WorkspaceController;
  readerRuntime: WorkspaceReaderRuntime;
  fileActions: WorkspaceFileActions;
  navigation: WorkspaceNavigation;
  notify: (message: string) => void;
  screenState: AppState;
}

// fallow-ignore-next-line unused-exports — used by App.tsx
export const ReadingScreenContainer = ({
  controller,
  readerRuntime,
  fileActions,
  navigation,
  notify,
  screenState,
}: ReadingScreenContainerProps) => {
  const {
    activeSection,
    activeSectionId,
    currentProjectId,
    isBlocking,
    learningPlan,
    openSection,
    setGenerationNotes,
  } = controller;

  const readerActions = useWorkspaceReaderActions({
    activeSectionId,
    askContextQuestion: controller.askContextQuestion,
    closeContextMenu: readerRuntime.readerContext.closeContextMenu,
    completeActiveSection: controller.completeActiveSection,
    contextMenu: readerRuntime.readerContext.contextMenu,
    createLessonFromSelection: controller.createLessonFromSelection,
    documentIndex: controller.documentIndex,
    isMobileViewport: readerRuntime.readerChrome.isMobileViewport,
    learningPlan,
    notify,
    openContextAnswer: readerRuntime.readerContext.openContextAnswer,
    openSection,
    regenerateActiveSection: controller.regenerateActiveSection,
    sectionContent: controller.sectionContent,
    setIsMobileSidebarOpen: readerRuntime.readerChrome.setIsMobileSidebarOpen,
    source: controller.source,
    updateSection: controller.updateSection,
  });

  const { acknowledgeGenerationNotesDialog, isNotesDialogOpen } = useInitialSectionAutoOpen({
    activeSection,
    currentProjectId,
    isBlocking,
    learningPlan,
    openSection,
    screenState,
  });

  const pdfMappingWarning = resolvePdfMappingWarning(controller.source, controller.documentIndex);

  const readerShellProps = buildReaderShellProps({
    controller,
    handleAttachSourceFile: fileActions.handleAttachSourceFile,
    handleBackToLibrary: navigation.handleBackToLibrary,
    handleExportProject: fileActions.handleExportProject,
    modelDefaults: defaultModelConfig,
    notify,
    pdfMappingWarning,
    readerActions,
    readerRuntime,
  });

  // Close context menu when navigating away from reader (container unmounts)
  useEffect(() => {
    return () => {
      readerRuntime.readerContext.closeContextMenu();
    };
  }, [readerRuntime.readerContext.closeContextMenu]);

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
