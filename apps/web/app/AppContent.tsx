import type { FeedbackProductSurface } from '@shared/feedbackDiagnosticsContract';
import { useEffect } from 'react';
import { LibraryScreenContainer } from '../components/library/LibraryScreenContainer.tsx';
import LoadingScreen from '../components/shared/LoadingScreen';
import SurfaceErrorBoundary from '../components/shared/SurfaceErrorBoundary.tsx';
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
import { setFeedbackProductContext } from '../services/feedback/browserDiagnostics.ts';
import { selectBlockingProgress, selectBlockingReasoning } from '../services/workspace/workflow.ts';
import { AppState } from '../types';
import { useAppDialogs } from './useAppDialogs.tsx';

export const getFeedbackProductSurface = ({
  hasContextAnswer,
  isAssessmentActive,
  screenState,
}: {
  hasContextAnswer: boolean;
  isAssessmentActive: boolean;
  screenState: AppState;
}): FeedbackProductSurface => {
  if (isAssessmentActive || screenState === AppState.ASSESSMENT) return 'assessment';
  if (screenState === AppState.PLANNING) return 'planning';
  if (screenState === AppState.READING) return hasContextAnswer ? 'contextual-chat' : 'reader';
  return globalThis.location.pathname === '/' ? 'home' : 'library';
};

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
    setSource: domain.setSource,
  });

  const libraryAssistantChat = useLibraryAssistantChat({
    folders: projectLibrary.libraryFolders,
    loadProjectsById: projectLibrary.loadProjectsById,
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

  const { isLibraryLoading, openingProjectId, savedProjects, screenState, workflowState } =
    controller;

  const currentProject = savedProjects.find(project => project.id === controller.currentProjectId);

  useEffect(() => {
    setFeedbackProductContext({
      ...(controller.currentProjectId
        ? {
            project: {
              id: controller.currentProjectId,
              ...(currentProject?.revision === undefined
                ? {}
                : { revision: currentProject.revision }),
            },
          }
        : {}),
      ...(controller.activeSection
        ? {
            section: {
              id: controller.activeSection.id,
            },
          }
        : {}),
      surface: getFeedbackProductSurface({
        hasContextAnswer: Boolean(readerState.readerContext.contextAnswer),
        isAssessmentActive:
          controller.assessmentMessages.length > 0 || workflowState.assessment.status === 'pending',
        screenState,
      }),
    });
  }, [
    controller.activeSection,
    controller.currentProjectId,
    controller.assessmentMessages.length,
    currentProject?.revision,
    readerState.readerContext.contextAnswer,
    screenState,
    workflowState.assessment.status,
  ]);

  useEffect(() => {
    const syncState = projectLibrary.projectSyncState;
    if (syncState.kind !== 'remoteDeleted') return;

    projectLibrary.acknowledgeRemoteDeletion(syncState.projectId);
    controller.handleRemoteProjectDeleted(syncState.projectId, syncState.wasActive);
    notify(syncState.message);
  }, [controller, notify, projectLibrary]);

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
    onCloseContextAnswer: readerState.readerContext.closeContextAnswer,
    onGoToLibrary: controller.goToLibrary,
    onOpenProject: controller.openProject,
    openingProjectId,
    screenState,
    setIsFocusMode: readerState.readerChrome.setIsFocusMode,
    setIsMobileSidebarOpen: readerState.readerChrome.setIsMobileSidebarOpen,
  });

  useEffect(() => {
    if (screenState === AppState.LIBRARY || typeof globalThis.window === 'undefined') {
      return;
    }

    globalThis.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [screenState]);

  const loadingStatus = controller.blockingMessage || t('Caricamento...');
  const loadingReasoningText = selectBlockingReasoning(workflowState);
  const loadingProgress = selectBlockingProgress(workflowState);
  return (
    <>
      {screenState === AppState.LIBRARY && (
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
      {screenState === AppState.PLANNING && (
        <LoadingScreen
          message={t('Analisi Volume in Corso...')}
          isDarkMode={readerState.readerChrome.isDarkMode}
          reasoningText={loadingReasoningText}
          progress={loadingProgress}
          subMessage={loadingStatus || t('Costruzione piano...')}
        />
      )}
      {screenState === AppState.READING && (
        <SurfaceErrorBoundary resetKey={controller.currentProjectId} surface="reader">
          <ReadingScreenContainer
            controller={controller}
            readerState={readerState}
            projectLibrary={projectLibrary}
            fileActions={fileActions}
            navigation={navigation}
            notify={notify}
            screenState={screenState}
          />
        </SurfaceErrorBoundary>
      )}
      {appOverlays}
    </>
  );
};

export default AppContent;
