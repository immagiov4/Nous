import { pushLuminaDebugTrace } from '../../../services/core/debugTrace.ts';
import { getErrorMessage } from '../../../services/core/errorMessage.ts';
import {
  createProjectId,
  createProjectSnapshot,
} from '../../../services/projects/projectSnapshot.ts';
import {
  createProjectSourceFromFile,
  getProjectSourceFile,
  isZipFileData,
} from '../../../services/projects/projectSource.ts';
import {
  prepareSnapshotForHydration,
  resolvePlanSection,
} from '../../../services/workspace/controller/snapshotHydration.ts';
import {
  AppState,
  type FileData,
  type LearningPlan,
  type LearningSection,
  type ProjectSource,
} from '../../../types.ts';
import { readSourceFileData } from './controllerContext.ts';
import { importProjectBackupFile, isLuminaBackupArchive } from './projectImport.ts';
import type {
  AssessmentSourceInput,
  OpenSectionOptions,
  OpenSectionOutcome,
  WorkspaceControllerContext,
} from './types.ts';

interface ProjectLifecycleDependencies {
  openSection: (
    section: LearningSection,
    options?: OpenSectionOptions
  ) => Promise<OpenSectionOutcome>;
  startAssessment: (input: AssessmentSourceInput) => Promise<void>;
}

const REATTACH_SOURCE_WORKFLOWS_TO_INVALIDATE = [
  'openProject',
  'importProject',
  'assessment',
  'generatePlan',
  'loadSection',
  'contextQuestion',
  'createLesson',
  'completeSection',
] as const;

export const createProjectLifecycleCommands = (
  context: WorkspaceControllerContext,
  { openSection, startAssessment }: ProjectLifecycleDependencies
) => {
  const { domain, openRouter, persistHydratedSnapshot, projectLibrary, state, stopAudio } = context;

  const refreshLibraryMetadataInBackground = (projectId: string, requestId: number) => {
    void (async () => {
      try {
        await projectLibrary.touchStoredProject(projectId);
        await projectLibrary.refreshSavedProjects();
        pushLuminaDebugTrace('open-project:library-refreshed', { projectId, requestId });
      } catch (error) {
        pushLuminaDebugTrace('open-project:library-refresh-failed', {
          errorMessage: getErrorMessage(error),
          projectId,
          requestId,
        });
      }
    })();
  };

  async function handleSourceUpload(
    selectedFile: File,
    options?: { mode?: 'new-project' | 'reattach-source' }
  ): Promise<{ errorMessage?: string; outcome: 'imported' | 'started-assessment' | 'reattached' }> {
    const requestId = state.beginWorkflow('attachSource', 'Caricamento...');
    pushLuminaDebugTrace('attach-source:start', {
      mode: options?.mode || 'new-project',
      name: selectedFile.name,
      requestId,
      size: selectedFile.size,
      type: selectedFile.type || null,
    });

    try {
      let nextSource: ProjectSource | null = null;
      let nextFile: FileData | null = null;

      if (isZipFileData({ name: selectedFile.name, mimeType: selectedFile.type })) {
        const isBackupArchive = await isLuminaBackupArchive(selectedFile);

        if (isBackupArchive) {
          if (options?.mode === 'reattach-source') {
            throw new Error(
              'Questo ZIP e un backup Lumina completo. Usa Importa dalla libreria invece di Ricollega sorgente.'
            );
          }

          state.setWorkflowMessage('attachSource', requestId, 'Importazione backup...');
          const importedSnapshot = await importProjectBackupFile(context, selectedFile);
          pushLuminaDebugTrace('attach-source:backup-imported', {
            projectId: importedSnapshot.id,
            requestId,
            screen: importedSnapshot.learningPlan ? 'reading' : 'assessment',
          });
          state.succeedWorkflow('attachSource', requestId);
          return { outcome: 'imported' };
        }

        nextSource = await import('../../../utils/project/codebaseBundle.ts').then(module =>
          module.createCodebaseBundleSourceFromZip(selectedFile)
        );
        nextFile = getProjectSourceFile(nextSource);
      } else {
        nextFile = await readSourceFileData(selectedFile);
        nextSource = createProjectSourceFromFile(nextFile);
      }

      if (!nextSource || !nextFile) {
        throw new Error('Unable to prepare project source');
      }

      pushLuminaDebugTrace('attach-source:prepared', {
        name: nextFile.name,
        normalizedMimeType: nextFile.mimeType,
        requestId,
        sourceKind: nextSource.kind,
        textLength: nextSource.kind === 'codebase-bundle' ? nextSource.aggregatedText.length : null,
      });

      if (options?.mode === 'reattach-source' && projectLibrary.currentProjectId) {
        state.invalidateWorkflows([...REATTACH_SOURCE_WORKFLOWS_TO_INVALIDATE]);
        state.resetRuntimeState();
        domain.setSource(nextSource);
        projectLibrary.setProjectHydrated(true);
        await projectLibrary.saveCurrentProject({ source: nextSource });
        state.succeedWorkflow('attachSource', requestId);
        return { outcome: 'reattached' };
      }

      const nextProjectId = createProjectId();
      projectLibrary.setProjectHydrated(false);
      domain.resetDomain();
      state.resetRuntimeState();
      projectLibrary.setCurrentProjectId(nextProjectId);
      domain.setSource(nextSource);
      projectLibrary.setProjectHydrated(true);

      await projectLibrary.persistSnapshot(
        createProjectSnapshot({
          id: nextProjectId,
          state: AppState.ASSESSMENT,
          source: nextSource,
        })
      );
      state.succeedWorkflow('attachSource', requestId);
      pushLuminaDebugTrace('attach-source:persisted', {
        projectId: nextProjectId,
        requestId,
        sourceKind: nextSource.kind,
      });
      await startAssessment(
        nextSource.kind === 'codebase-bundle'
          ? {
              textSource: {
                name: nextSource.name,
                text: nextSource.aggregatedText,
              },
            }
          : { file: nextFile }
      );
      return { outcome: 'started-assessment' };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      state.failWorkflow('attachSource', requestId, errorMessage);
      return {
        outcome: options?.mode === 'reattach-source' ? 'reattached' : 'started-assessment',
        errorMessage,
      };
    }
  }

  async function importProjectFile(
    selectedFile: File
  ): Promise<{ errorMessage?: string; outcome: 'failed' | 'imported' }> {
    const requestId = state.beginWorkflow('importProject', 'Importazione progetto...');

    try {
      await importProjectBackupFile(context, selectedFile);
      state.succeedWorkflow('importProject', requestId);
      return { outcome: 'imported' };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      state.failWorkflow('importProject', requestId, errorMessage);
      return { outcome: 'failed', errorMessage };
    }
  }

  async function openProject(
    projectId: string
  ): Promise<{ errorMessage?: string; outcome: 'failed' | 'missing' | 'opened' | 'stale' }> {
    const requestId = state.beginWorkflow('openProject', 'Apertura progetto...');
    let didSettleOpenWorkflow = false;
    state.setOpeningProjectId(projectId);
    pushLuminaDebugTrace('open-project:start', { projectId, requestId });

    try {
      const snapshot = await projectLibrary.loadStoredProject(projectId);
      if (!state.isWorkflowCurrent('openProject', requestId)) {
        pushLuminaDebugTrace('open-project:stale-after-load', { projectId, requestId });
        return { outcome: 'stale' };
      }

      if (!snapshot) {
        pushLuminaDebugTrace('open-project:missing-snapshot', { projectId, requestId });
        state.succeedWorkflow('openProject', requestId);
        return { outcome: 'missing' };
      }

      pushLuminaDebugTrace('open-project:snapshot-loaded', {
        hasLearningPlan: Boolean(snapshot.learningPlan),
        projectId,
        requestId,
        sourceKind: snapshot.source?.kind || null,
        sourceName:
          snapshot.source?.kind === 'pdf'
            ? snapshot.source.file.name
            : snapshot.source?.name || null,
        textLength:
          snapshot.source?.kind === 'codebase-bundle'
            ? snapshot.source.aggregatedText.length
            : null,
      });

      let nextSnapshot = snapshot;
      const snapshotFile = snapshot.source?.kind === 'pdf' ? snapshot.source.file : null;
      const pdfHydrationState = openRouter.getPdfLessonMappingState(
        snapshotFile,
        snapshot.learningPlan,
        snapshot.documentIndex
      );

      if (
        pdfHydrationState === 'missing-document-index' ||
        pdfHydrationState === 'missing-primary-chunk-mappings'
      ) {
        state.setWorkflowMessage(
          'openProject',
          requestId,
          pdfHydrationState === 'missing-document-index'
            ? 'Indicizzazione capitoli del PDF...'
            : 'Allineamento lezioni con il PDF...'
        );

        const prepared = await context.preparePdfLessonPlan(
          snapshotFile,
          snapshot.learningPlan as LearningPlan,
          snapshot.documentIndex
        );
        if (!state.isWorkflowCurrent('openProject', requestId)) {
          pushLuminaDebugTrace('open-project:stale-after-pdf-prepare', { projectId, requestId });
          return { outcome: 'stale' };
        }

        nextSnapshot = createProjectSnapshot({
          ...snapshot,
          learningPlan: prepared.learningPlan,
          documentIndex: prepared.documentIndex,
        });
        await projectLibrary.persistSnapshot(nextSnapshot);
      }

      if (!state.isWorkflowCurrent('openProject', requestId)) {
        pushLuminaDebugTrace('open-project:stale-before-hydration', { projectId, requestId });
        return { outcome: 'stale' };
      }

      const preparedSnapshot = prepareSnapshotForHydration(nextSnapshot);
      if (JSON.stringify(preparedSnapshot) !== JSON.stringify(nextSnapshot)) {
        await projectLibrary.persistSnapshot(preparedSnapshot);
      }
      persistHydratedSnapshot(preparedSnapshot);
      pushLuminaDebugTrace('open-project:hydrated-snapshot', {
        hasLearningPlan: Boolean(preparedSnapshot.learningPlan),
        projectId,
        requestId,
        screen: preparedSnapshot.learningPlan
          ? 'reading'
          : preparedSnapshot.source
            ? 'assessment'
            : 'library',
        sourceKind: preparedSnapshot.source?.kind || null,
      });
      state.succeedWorkflow('openProject', requestId);
      didSettleOpenWorkflow = true;
      state.setOpeningProjectId(null);
      pushLuminaDebugTrace('open-project:settled-before-follow-up', { projectId, requestId });
      refreshLibraryMetadataInBackground(projectId, requestId);

      if (!preparedSnapshot.learningPlan) {
        if (preparedSnapshot.source?.kind === 'codebase-bundle') {
          pushLuminaDebugTrace('open-project:start-text-assessment', {
            projectId,
            requestId,
            textLength: preparedSnapshot.source.aggregatedText.length,
          });
          await startAssessment({
            textSource: {
              name: preparedSnapshot.source.name,
              text: preparedSnapshot.source.aggregatedText,
            },
          });
        } else if (preparedSnapshot.source?.kind === 'pdf') {
          pushLuminaDebugTrace('open-project:start-pdf-assessment', {
            fileName: preparedSnapshot.source.file.name,
            projectId,
            requestId,
          });
          await startAssessment({ file: preparedSnapshot.source.file });
        }
      } else if (preparedSnapshot.learningPlan) {
        const nextSnapshotFile = getProjectSourceFile(preparedSnapshot.source);
        const nextSection = resolvePlanSection(
          preparedSnapshot.learningPlan,
          preparedSnapshot.activeSectionId
        );
        if (nextSection && (!nextSection.content || nextSection.content.length === 0)) {
          await openSection(nextSection, {
            allowWhileBlocking: true,
            currentDocumentAssets: preparedSnapshot.documentAssets ?? null,
            currentDocumentIndex: preparedSnapshot.documentIndex ?? null,
            currentPlan: preparedSnapshot.learningPlan,
            currentSourceFile: nextSnapshotFile ?? undefined,
            currentSyllabus: preparedSnapshot.syllabus,
            currentUserProfile: preparedSnapshot.userProfile,
            isLearnMode: preparedSnapshot.isLearnMode,
          });
        }
      }

      pushLuminaDebugTrace('open-project:completed', { projectId, requestId });
      return { outcome: 'opened' };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      pushLuminaDebugTrace('open-project:failed', {
        errorMessage,
        projectId,
        requestId,
      });
      if (!didSettleOpenWorkflow) {
        state.failWorkflow('openProject', requestId, errorMessage);
      }
      return { outcome: 'failed', errorMessage };
    } finally {
      if (state.isWorkflowCurrent('openProject', requestId)) {
        state.setOpeningProjectId(null);
        pushLuminaDebugTrace('open-project:cleared-opening-id', { projectId, requestId });
      }
    }
  }

  async function deleteProject(projectId: string): Promise<void> {
    await projectLibrary.deleteStoredProject(projectId);
    if (projectLibrary.currentProjectId === projectId) {
      stopAudio(true);
      projectLibrary.setProjectHydrated(false);
      projectLibrary.setCurrentProjectId(null);
      domain.resetDomain();
      state.resetRuntimeState();
      state.setScreenState(AppState.LIBRARY);
    }
    await projectLibrary.refreshLibraryState();
  }

  return {
    deleteProject,
    handleSourceUpload,
    importProjectFile,
    openProject,
  };
};
