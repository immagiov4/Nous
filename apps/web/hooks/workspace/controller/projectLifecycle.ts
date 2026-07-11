import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import { pushNousDebugTrace } from '../../../services/core/debugTrace.ts';
import { getErrorMessage } from '../../../services/core/errorMessage.ts';
import {
  createProjectSourceFromDescriptors,
  getCourseSourceDescriptors,
  mergeCourseSourceDescriptors,
} from '../../../services/projects/courseSources.ts';
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
  prepareSnapshotForHydrationResult,
  resolvePlanLesson,
} from '../../../services/workspace/controller/snapshotHydration.ts';
import {
  AppState,
  type FileData,
  type LearningPlan,
  type LessonNode,
  type ProjectSource,
} from '../../../types.ts';
import { prepareUploadedCourseSource, readSourceFileData } from './controllerContext.ts';
import { importProjectBackupFile, isNousBackupArchive } from './projectImport.ts';
import type {
  AssessmentSourceInput,
  OpenSectionOptions,
  OpenSectionOutcome,
  WorkspaceControllerContext,
} from './types.ts';

interface ProjectLifecycleDependencies {
  openSection: (section: LessonNode, options?: OpenSectionOptions) => Promise<OpenSectionOutcome>;
  startAssessment: (input: AssessmentSourceInput) => Promise<void>;
}

const OPEN_PROJECT_PDF_HYDRATION_TIMEOUT_MS = 20_000;

const REATTACH_SOURCE_WORKFLOWS_TO_INVALIDATE = [
  'openProject',
  'importProject',
  'assessment',
  'generatePlan',
  'generateExercise',
  'evaluateExercise',
  'loadSection',
  'contextQuestion',
  'createLesson',
  'completeSection',
] as const;

const withTimeoutFallback = async <T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | null> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<null>(resolve => {
        timeoutHandle = setTimeout(() => {
          resolve(null);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};

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
        pushNousDebugTrace('open-project:library-refreshed', { projectId, requestId });
      } catch (error) {
        pushNousDebugTrace('open-project:library-refresh-failed', {
          errorMessage: getErrorMessage(error),
          projectId,
          requestId,
        });
      }
    })();
  };

  const persistHydrationMigrationInBackground = (
    snapshot: Parameters<typeof projectLibrary.persistSnapshot>[0],
    requestId: number
  ) => {
    void (async () => {
      try {
        await projectLibrary.persistSnapshot(snapshot);
        pushNousDebugTrace('open-project:migration-persisted', {
          projectId: snapshot.id,
          requestId,
        });
      } catch (error) {
        pushNousDebugTrace('open-project:migration-persist-failed', {
          errorMessage: getErrorMessage(error),
          projectId: snapshot.id,
          requestId,
        });
      }
    })();
  };

  async function handleSourceUpload(
    selectedFilesInput: File | File[],
    options?: { mode?: 'new-project' | 'reattach-source' }
  ): Promise<{
    errorMessage?: string;
    outcome: 'imported' | 'started-assessment' | 'reattached';
    sourceWarnings?: Array<{ message: string; name: string }>;
  }> {
    const requestId = state.beginWorkflow('attachSource', t('Caricamento...'));
    const selectedFiles = Array.isArray(selectedFilesInput)
      ? selectedFilesInput
      : [selectedFilesInput];
    const selectedFile = selectedFiles[0];
    if (!selectedFile) {
      return { outcome: 'started-assessment', errorMessage: 'Nessuna fonte selezionata.' };
    }
    pushNousDebugTrace('attach-source:start', {
      mode: options?.mode || 'new-project',
      name: selectedFile.name,
      sourceCount: selectedFiles.length,
      requestId,
      size: selectedFile.size,
      type: selectedFile.type || null,
    });

    try {
      let nextSource: ProjectSource | null = null;
      let nextFile: FileData | null = null;

      const zipFiles = selectedFiles.filter(file =>
        isZipFileData({ name: file.name, mimeType: file.type })
      );
      if (zipFiles.length > 0 && selectedFiles.length !== 1) {
        throw new Error('Gli archivi ZIP devono essere caricati da soli.');
      }

      if (zipFiles.length === 1) {
        const isBackupArchive = await isNousBackupArchive(selectedFile);

        if (isBackupArchive) {
          if (options?.mode === 'reattach-source') {
            throw new Error(
              'Questo ZIP e un backup Nous completo. Usa Importa dalla libreria invece di Ricollega sorgente.'
            );
          }

          state.setWorkflowMessage('attachSource', requestId, t('Importazione backup...'));
          const importedSnapshot = await importProjectBackupFile(context, selectedFile);
          pushNousDebugTrace('attach-source:backup-imported', {
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
        if (selectedFiles.length === 1) {
          nextFile = await readSourceFileData(selectedFile);
          nextSource = createProjectSourceFromFile(nextFile);
        } else {
          const prepared = await prepareUploadedCourseSource(
            context,
            selectedFiles,
            (completed, total) => {
              state.setWorkflowMessage(
                'attachSource',
                requestId,
                t('Preparazione fonti... {completed}/{total}', { completed, total })
              );
            }
          );
          nextSource = prepared.source;
          nextFile = prepared.descriptors.find(source => source.status !== 'error')?.file || null;
        }
      }

      if (!nextSource || !nextFile) {
        throw new Error('Unable to prepare project source');
      }

      const sourceWarnings = (nextSource.sources || [])
        .filter(source => source.status === 'error')
        .map(source => ({
          message: source.errorMessage || 'Questa fonte non è utilizzabile.',
          name: source.name,
        }));

      if (nextSource.kind === 'pdf' && !nextSource.sources?.length) {
        state.setWorkflowMessage('attachSource', requestId, t('Verifica testo PDF...'));
        await openRouter.validatePdfTextSource(nextFile);
      }

      pushNousDebugTrace('attach-source:prepared', {
        name: nextFile.name,
        normalizedMimeType: nextFile.mimeType,
        requestId,
        sourceKind: nextSource.kind,
        textLength: nextSource.kind === 'codebase-bundle' ? nextSource.aggregatedText.length : null,
      });

      if (options?.mode === 'reattach-source' && projectLibrary.currentProjectId) {
        const replacementSources = getCourseSourceDescriptors(nextSource);
        const existingSources = getCourseSourceDescriptors(domain.source);
        if (replacementSources.length > 0 && existingSources.length > 0) {
          nextSource = createProjectSourceFromDescriptors(
            mergeCourseSourceDescriptors(existingSources, replacementSources)
          );
        }
        state.invalidateWorkflows([...REATTACH_SOURCE_WORKFLOWS_TO_INVALIDATE]);
        state.resetSessionState();
        domain.setSource(nextSource);
        projectLibrary.setProjectHydrated(true);
        await projectLibrary.saveCurrentProject({ source: nextSource });
        state.succeedWorkflow('attachSource', requestId);
        return { outcome: 'reattached', sourceWarnings };
      }

      const nextProjectId = createProjectId();
      projectLibrary.setProjectHydrated(false);
      domain.resetDomain();
      state.resetSessionState();
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
      pushNousDebugTrace('attach-source:persisted', {
        projectId: nextProjectId,
        requestId,
        sourceKind: nextSource.kind,
      });
      await startAssessment(
        (nextSource.sources?.length || 0) > 1
          ? { sources: nextSource.sources }
          : nextSource.kind === 'codebase-bundle'
            ? {
                textSource: {
                  name: nextSource.name,
                  text: nextSource.aggregatedText,
                },
              }
            : { file: nextFile }
      );
      return { outcome: 'started-assessment', sourceWarnings };
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
    const requestId = state.beginWorkflow('importProject', t('Importazione progetto...'));

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
    const requestId = state.beginWorkflow('openProject', t('Apertura progetto...'));
    let didSettleOpenWorkflow = false;
    state.setOpeningProjectId(projectId);
    pushNousDebugTrace('open-project:start', { projectId, requestId });

    try {
      const snapshot = await projectLibrary.loadStoredProject(projectId);
      if (!state.isWorkflowCurrent('openProject', requestId)) {
        pushNousDebugTrace('open-project:stale-after-load', { projectId, requestId });
        return { outcome: 'stale' };
      }

      if (!snapshot) {
        pushNousDebugTrace('open-project:missing-snapshot', { projectId, requestId });
        state.succeedWorkflow('openProject', requestId);
        return { outcome: 'missing' };
      }

      pushNousDebugTrace('open-project:snapshot-loaded', {
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
            ? t('Indicizzazione capitoli del PDF...')
            : t('Allineamento lezioni con il PDF...')
        );

        let prepared: Awaited<ReturnType<typeof context.preparePdfLessonPlan>> | null = null;

        try {
          const hydrationSourceFile =
            snapshotFile?.data || snapshot.source?.kind !== 'pdf'
              ? snapshotFile
              : await projectLibrary.loadStoredProjectSource(projectId);
          prepared = await withTimeoutFallback(
            context.preparePdfLessonPlan(
              hydrationSourceFile,
              snapshot.learningPlan as LearningPlan,
              snapshot.documentIndex
            ),
            OPEN_PROJECT_PDF_HYDRATION_TIMEOUT_MS
          );
        } catch (error) {
          console.warn(
            '[Nous][OpenProject] PDF hydration failed, opening the stored snapshot without remapping.',
            error
          );
          pushNousDebugTrace('open-project:pdf-prepare-failed', {
            errorMessage: getErrorMessage(error),
            projectId,
            requestId,
          });
        }
        if (!state.isWorkflowCurrent('openProject', requestId)) {
          pushNousDebugTrace('open-project:stale-after-pdf-prepare', { projectId, requestId });
          return { outcome: 'stale' };
        }

        if (!prepared) {
          console.warn(
            '[Nous][OpenProject] PDF hydration timed out, opening the stored snapshot without remapping.'
          );
          pushNousDebugTrace('open-project:pdf-prepare-timeout', {
            projectId,
            requestId,
            timeoutMs: OPEN_PROJECT_PDF_HYDRATION_TIMEOUT_MS,
          });
        } else {
          nextSnapshot = createProjectSnapshot({
            ...snapshot,
            learningPlan: prepared.learningPlan,
            documentIndex: prepared.documentIndex,
          });
          await projectLibrary.persistSnapshot(nextSnapshot);
        }
      }

      if (!state.isWorkflowCurrent('openProject', requestId)) {
        pushNousDebugTrace('open-project:stale-before-hydration', { projectId, requestId });
        return { outcome: 'stale' };
      }

      const hydration = prepareSnapshotForHydrationResult(nextSnapshot);
      const preparedSnapshot = hydration.snapshot;
      persistHydratedSnapshot(preparedSnapshot);
      pushNousDebugTrace('open-project:hydrated-snapshot', {
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
      pushNousDebugTrace('open-project:settled-before-follow-up', { projectId, requestId });
      if (hydration.didChange) {
        persistHydrationMigrationInBackground(preparedSnapshot, requestId);
      }
      refreshLibraryMetadataInBackground(projectId, requestId);

      if (!preparedSnapshot.learningPlan) {
        const assessmentSources = getCourseSourceDescriptors(preparedSnapshot.source);
        if (assessmentSources.length > 1) {
          await startAssessment({ sources: assessmentSources });
        } else if (preparedSnapshot.source?.kind === 'codebase-bundle') {
          pushNousDebugTrace('open-project:start-text-assessment', {
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
          pushNousDebugTrace('open-project:start-pdf-assessment', {
            fileName: preparedSnapshot.source.file.name,
            projectId,
            requestId,
          });
          const assessmentFile =
            getProjectSourceFile(preparedSnapshot.source) ??
            (await projectLibrary.loadStoredProjectSource(projectId));
          await startAssessment({ file: assessmentFile });
        }
      } else if (preparedSnapshot.learningPlan) {
        const nextSnapshotFile = getProjectSourceFile(preparedSnapshot.source);
        const nextSection = resolvePlanLesson(
          preparedSnapshot.learningPlan,
          preparedSnapshot.activeSectionId
        );
        if (nextSection && (!nextSection.content || nextSection.content.length === 0)) {
          void (async () => {
            const sourceFile =
              nextSnapshotFile ??
              (preparedSnapshot.source?.kind === 'pdf'
                ? await projectLibrary.loadStoredProjectSource(projectId)
                : null);
            await openSection(nextSection, {
              allowWhileBlocking: true,
              currentDocumentAssets: preparedSnapshot.documentAssets ?? null,
              currentDocumentIndex: preparedSnapshot.documentIndex ?? null,
              currentPlan: preparedSnapshot.learningPlan,
              currentSourceFile: sourceFile,
              currentSyllabus: preparedSnapshot.syllabus,
              currentUserProfile: preparedSnapshot.userProfile,
              isLearnMode: preparedSnapshot.isLearnMode,
            });
          })().catch(error => {
            pushNousDebugTrace('open-project:background-section-load-failed', {
              errorMessage: getErrorMessage(error),
              projectId,
              requestId,
              sectionId: nextSection.id,
            });
          });
        }
      }

      pushNousDebugTrace('open-project:completed', { projectId, requestId });
      return { outcome: 'opened' };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      pushNousDebugTrace('open-project:failed', {
        errorMessage,
        projectId,
        requestId,
      });
      if (!didSettleOpenWorkflow) {
        state.failWorkflow('openProject', requestId, errorMessage);
      }
      return { outcome: 'failed', errorMessage };
    } finally {
      // Azzeriamo openingProjectId anche quando il workflow è diventato stale
      // (es. l'utente ha rinavigato, una fetch è andata in timeout senza rigettare):
      // se non lo facciamo, shouldOpenProjectFromLocation continua a vedere
      // openingProjectId === locationProjectId e blocca i tentativi successivi
      // → spinner eterno senza fetch al backend.
      // Lo facciamo solo se openingProjectId punta ancora a NOSTRO projectId, per
      // non disturbare un openProject(altro) che sia partito nel frattempo.
      if (state.getOpeningProjectId() === projectId) {
        state.setOpeningProjectId(null);
        pushNousDebugTrace('open-project:cleared-opening-id', { projectId, requestId });
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
      state.resetSessionState();
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
