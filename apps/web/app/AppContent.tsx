import { useEffect, useState } from 'react';
import { AssessmentScreenContainer } from '../components/assessment/AssessmentScreenContainer.tsx';
import StylePreviewLab from '../components/dev/StylePreviewLab.tsx';
import { LibraryScreenContainer } from '../components/library/LibraryScreenContainer.tsx';
import LoadingScreen from '../components/shared/LoadingScreen';
import { ReadingScreenContainer } from '../components/workspace/ReadingScreenContainer.tsx';
import { useLibraryAssistantChat } from '../hooks/library/useLibraryAssistantChat.ts';
import { useProjectLibrary } from '../hooks/library/useProjectLibrary.ts';
import { useUiPreferencesPersistence } from '../hooks/workspace/useUiPreferencesPersistence.ts';
import { useWorkspaceController } from '../hooks/workspace/useWorkspaceController.ts';
import { useWorkspaceDomain } from '../hooks/workspace/useWorkspaceDomain.ts';
import { useWorkspaceFileActions } from '../hooks/workspace/useWorkspaceFileActions.ts';
import { useWorkspaceNavigation } from '../hooks/workspace/useWorkspaceNavigation.ts';
import { useWorkspaceReaderState } from '../hooks/workspace/useWorkspaceReaderState.ts';
import { translateUiMessage as t } from '../i18n/uiMessages.ts';
import { selectBlockingProgress, selectBlockingReasoning } from '../services/workspace/workflow.ts';
import { AppState } from '../types';
import { useAppDialogs } from './useAppDialogs.tsx';

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
    hydrateSnapshot: domain.hydrateSnapshot,
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
        title: t('Eliminare corso'),
        message: t('Eliminare "{projectTitle}" dalla libreria server?', { projectTitle }),
        confirmLabel: t('Elimina'),
      }),
    deleteProject: controller.deleteProject,
    exportProject: controller.exportProject,
    handleSourceUpload: controller.handleSourceUpload,
    importProjectFile: controller.importProjectFile,
    notify,
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

  useEffect(() => {
    if (screenState === AppState.LIBRARY || typeof window === 'undefined') {
      return;
    }

    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [screenState]);

  const isLoading = isBlocking;
  const loadingStatus = controller.blockingMessage || t('Caricamento...');
  const loadingReasoningText = selectBlockingReasoning(workflowState);
  const loadingProgress = selectBlockingProgress(workflowState);
  const shouldShowStyleLab =
    typeof window !== 'undefined' && window.location.hash.startsWith('#style-lab');
  const shouldShowLoadingPreview =
    typeof window !== 'undefined' && window.location.hash === '#preview-loading';
  const [previewStartedAt] = useState(() => Date.now() - 67_000);
  const previewProgress = {
    operation: 'lesson' as const,
    sections: ['I sistemi di memoria', 'Come si forma un ricordo', 'Applicazioni pratiche'],
    stage: 'drafting' as const,
    startedAt: previewStartedAt,
    stepOffset: 4,
    subject: 'Come funziona la memoria',
  };

  return (
    <>
      {shouldShowStyleLab ? <StylePreviewLab /> : null}
      {!shouldShowStyleLab && !shouldShowLoadingPreview && screenState === AppState.LIBRARY && (
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
      {!shouldShowStyleLab && typeof window !== 'undefined' && shouldShowLoadingPreview && (
        <LoadingScreen
          message={t('Analisi Volume in Corso...')}
          isDarkMode={readerState.readerChrome.isDarkMode}
          progress={previewProgress}
          subMessage={t('Strutturazione semantica del piano di studi...')}
        />
      )}
      {!shouldShowStyleLab && !shouldShowLoadingPreview && screenState === AppState.PLANNING && (
        <LoadingScreen
          message={t('Analisi Volume in Corso...')}
          isDarkMode={readerState.readerChrome.isDarkMode}
          reasoningText={loadingReasoningText}
          progress={loadingProgress}
          subMessage={loadingStatus || t('Costruzione piano...')}
        />
      )}
      {!shouldShowStyleLab && !shouldShowLoadingPreview && screenState === AppState.READING && (
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

export default AppContent;
