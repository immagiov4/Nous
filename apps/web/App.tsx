// fallow-ignore-file unused-files
/* @refresh reset */
import { useEffect } from 'react';
import { useAppDialogs } from './app/useAppDialogs.tsx';
import AdminPanel from './components/admin/AdminPanel.tsx';
import { AssessmentScreenContainer } from './components/assessment/AssessmentScreenContainer.tsx';
import AuthGate from './components/auth/AuthGate.tsx';
import StylePreviewLab from './components/dev/StylePreviewLab.tsx';
import { LibraryScreenContainer } from './components/library/LibraryScreenContainer.tsx';
import LoadingScreen from './components/shared/LoadingScreen';
import { ReadingScreenContainer } from './components/workspace/ReadingScreenContainer.tsx';
import { useLibraryAssistantChat } from './hooks/library/useLibraryAssistantChat.ts';
import { useProjectLibrary } from './hooks/library/useProjectLibrary.ts';
import { useUiPreferencesPersistence } from './hooks/workspace/useUiPreferencesPersistence.ts';
import { useWorkspaceController } from './hooks/workspace/useWorkspaceController.ts';
import { useWorkspaceDomain } from './hooks/workspace/useWorkspaceDomain.ts';
import { useWorkspaceFileActions } from './hooks/workspace/useWorkspaceFileActions.ts';
import { useWorkspaceNavigation } from './hooks/workspace/useWorkspaceNavigation.ts';
import { useWorkspaceReaderState } from './hooks/workspace/useWorkspaceReaderState.ts';
import { selectBlockingReasoning } from './services/workspace/workflow.ts';
import { AppState } from './types';

const AppContent = () => {
  const { appOverlays, notify, requestConfirmation } = useAppDialogs();
  const domain = useWorkspaceDomain();

  const readerState = useWorkspaceReaderState({
    activeSection: domain.activeSection,
    activeSectionId: domain.activeSectionId,
    documentAssets: domain.documentAssets,
    learningPlan: domain.learningPlan,
    quiz: domain.quiz,
    sectionContent: domain.sectionContent,
    syllabus: domain.syllabus,
  });

  useUiPreferencesPersistence({
    uiPreferences: readerState.uiPreferences,
    applyUiPreferences: readerState.applyUiPreferences,
  });

  const projectLibrary = useProjectLibrary({
    domainState: domain.domainState,
  });

  const libraryAssistantChat = useLibraryAssistantChat({
    folders: projectLibrary.libraryFolders,
    loadProjectsById: projectLibrary.loadProjectsById,
    projectRepositoryMode: projectLibrary.projectRepositoryMode,
    projects: projectLibrary.savedProjects,
    replaceLessonGeneratedVisual: projectLibrary.replaceLessonGeneratedVisual,
    saveLessonArtifactNote: projectLibrary.saveLessonArtifactNote,
    tree: projectLibrary.libraryTree,
  });

  const controller = useWorkspaceController({
    domain,
    projectLibrary,
    stopAudio: readerState.ttsPlayer.stopAudio,
  });

  const {
    isBlocking,
    isLibraryLoading,
    openingProjectId,
    savedProjects,
    screenState,
    workflowState,
  } = controller;

  const fileActions = useWorkspaceFileActions({
    confirmProjectDelete: projectTitle =>
      requestConfirmation({
        title: 'Eliminare corso',
        message: `Eliminare "${projectTitle}" dalla libreria server?`,
        confirmLabel: 'Elimina',
      }),
    deleteProject: controller.deleteProject,
    exportProject: controller.exportProject,
    handleSourceUpload: controller.handleSourceUpload,
    importProjectFile: controller.importProjectFile,
    notifyError: notify,
    savedProjects,
  });

  const navigation = useWorkspaceNavigation({
    currentProjectId: controller.currentProjectId,
    isLibraryLoading,
    notifyError: notify,
    onGoToLibrary: controller.goToLibrary,
    onOpenProject: controller.openProject,
    openingProjectId,
    screenState,
    setIsFocusMode: readerState.readerChrome.setIsFocusMode,
    setIsMobileSidebarOpen: readerState.readerChrome.setIsMobileSidebarOpen,
  });

  // Scroll to top on screen transitions (library preserves scroll position)
  useEffect(() => {
    if (screenState === AppState.LIBRARY || typeof window === 'undefined') {
      return;
    }

    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [screenState]);

  const isLoading = isBlocking;
  const loadingStatus = controller.blockingMessage || 'Caricamento...';
  const loadingReasoningText = selectBlockingReasoning(workflowState);
  const shouldShowStyleLab =
    typeof window !== 'undefined' && window.location.hash.startsWith('#style-lab');

  return (
    <>
      {shouldShowStyleLab ? <StylePreviewLab /> : null}
      {!shouldShowStyleLab && screenState === AppState.LIBRARY && (
        <LibraryScreenContainer
          controller={controller}
          readerState={readerState}
          projectLibrary={projectLibrary}
          libraryAssistantChat={libraryAssistantChat}
          fileActions={fileActions}
          navigation={navigation}
          notify={notify}
          requestConfirmation={requestConfirmation}
        />
      )}
      {!shouldShowStyleLab && screenState === AppState.ASSESSMENT && (
        <AssessmentScreenContainer
          assessmentMessages={controller.assessmentMessages}
          isLoading={isLoading}
          loadingStatus={loadingStatus}
          navigation={navigation}
          notify={notify}
          readerState={readerState}
          screenState={screenState}
          startLearnJourney={controller.startLearnJourney}
          submitAssessment={controller.submitAssessment}
        />
      )}
      {!shouldShowStyleLab &&
        typeof window !== 'undefined' &&
        window.location.hash === '#preview-loading' && (
          <LoadingScreen
            message="Analisi Volume in Corso..."
            isDarkMode={readerState.readerChrome.isDarkMode}
            subMessage="Strutturazione semantica del piano di studi..."
          />
        )}
      {!shouldShowStyleLab && screenState === AppState.PLANNING && (
        <LoadingScreen
          message="Analisi Volume in Corso..."
          isDarkMode={readerState.readerChrome.isDarkMode}
          reasoningText={loadingReasoningText}
          subMessage={loadingStatus || 'Costruzione piano...'}
        />
      )}
      {!shouldShowStyleLab && screenState === AppState.READING && (
        <ReadingScreenContainer
          controller={controller}
          readerState={readerState}
          fileActions={fileActions}
          navigation={navigation}
          notify={notify}
          screenState={screenState}
        />
      )}
      {!shouldShowStyleLab && appOverlays}
    </>
  );
};

const App = () => (
  <AuthGate>
    {typeof window !== 'undefined' && window.location.pathname === '/admin' ? (
      <AdminPanel />
    ) : (
      <AppContent />
    )}
  </AuthGate>
);

// fallow-ignore-next-line unused-exports — Vite entry point component
export default App;
