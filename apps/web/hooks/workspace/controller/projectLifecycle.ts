import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import { pushNousDebugTrace } from '../../../services/core/debugTrace.ts';
import { getErrorMessage } from '../../../services/core/errorMessage.ts';
import {
  createProjectSourceFromDescriptors,
  getCourseSourceDescriptors,
  mergeCourseSourceDescriptors,
} from '../../../services/projects/courseSources.ts';
import { ProjectStorageError } from '../../../services/projects/projectRepository.ts';
import {
  createProjectId,
  createProjectSnapshot,
} from '../../../services/projects/projectSnapshot.ts';
import {
  createProjectSourceFromFile,
  decodeTextBase64,
  getProjectSourceFile,
  getProjectSourceName,
  isZipFileData,
} from '../../../services/projects/projectSource.ts';
import {
  ASSESSMENT_SOURCE_ARCHIVE_PREVIEW_BUDGET_CHARS,
  formatSourceArchiveIndex,
} from '../../../services/projects/sourceArchive.ts';
import {
  prepareSnapshotForHydrationResult,
  resolvePlanLesson,
} from '../../../services/workspace/controller/snapshotHydration.ts';
import { WORKSPACE_WORKFLOW_IDS } from '../../../services/workspace/workflow.ts';
import {
  AppState,
  type FileData,
  type LessonNode,
  type ProjectSource,
  type ProjectSourceWarning,
} from '../../../types.ts';
import { findPathNodeById } from '../../../utils/learning/pathNodes.ts';
import {
  getPdfProjectHydrationState,
  needsPdfProjectHydration,
} from '../../../utils/pdf/projectHydration.ts';
import {
  getProjectSourceWarnings,
  prepareUploadedCourseSource,
  readSourceFileData,
} from './controllerContext.ts';
import { importProjectBackupFile, isNousBackupArchive } from './projectImport.ts';
import type {
  AssessmentSourceInput,
  OpenProjectOptions,
  OpenSectionOptions,
  OpenSectionOutcome,
  WorkspaceControllerContext,
} from './types.ts';

interface ProjectLifecycleDependencies {
  openSection: (section: LessonNode, options?: OpenSectionOptions) => Promise<OpenSectionOutcome>;
  resumePlanGeneration: (projectId: string) => Promise<'not-found' | 'resumed'>;
  startAssessment: (input: AssessmentSourceInput) => Promise<void>;
  startLearnAssessment: () => Promise<void>;
}

const OPEN_PROJECT_PDF_REPAIR_TIMEOUT_MS = 20_000;

const waitWithTimeout = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T | null> => {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<null>(resolve => {
        timeoutHandle = globalThis.setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) globalThis.clearTimeout(timeoutHandle);
    controller.abort();
  }
};

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
const PROJECT_SWITCH_WORKFLOWS_TO_INVALIDATE = WORKSPACE_WORKFLOW_IDS.filter(
  workflowId => workflowId !== 'openProject'
);
const PROJECT_NAVIGATION_WORKFLOWS_TO_INVALIDATE = ['attachSource'] as const;

export const createProjectLifecycleCommands = (
  context: WorkspaceControllerContext,
  {
    openSection,
    resumePlanGeneration,
    startAssessment,
    startLearnAssessment,
  }: ProjectLifecycleDependencies
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
    outcome: 'failed' | 'imported' | 'started-assessment' | 'reattached';
    sourceWarnings?: ProjectSourceWarning[];
  }> {
    const requestId = state.beginWorkflow('attachSource', t('Caricamento...'));
    const selectedFiles = Array.isArray(selectedFilesInput)
      ? selectedFilesInput
      : [selectedFilesInput];
    const selectedFile = selectedFiles[0];
    if (!selectedFile) {
      return {
        outcome: options?.mode === 'reattach-source' ? 'failed' : 'started-assessment',
        errorMessage: 'Nessuna fonte selezionata.',
      };
    }
    pushNousDebugTrace('attach-source:start', {
      mode: options?.mode || 'new-project',
      name: selectedFile.name,
      sourceCount: selectedFiles.length,
      requestId,
      size: selectedFile.size,
      type: selectedFile.type || null,
    });
    let sourceWarnings: ProjectSourceWarning[] = [];

    try {
      let nextSource: ProjectSource | null = null;
      let nextFile: FileData | null = null;
      let archiveFile: File | undefined;

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

        const archiveSource = await import('../../../utils/project/codebaseBundle.ts').then(
          module => module.createSourceArchiveFromZip(selectedFile)
        );
        nextSource = archiveSource;
        nextFile = archiveSource.file;
        archiveFile = selectedFile;
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

      sourceWarnings = getProjectSourceWarnings(nextSource);

      if (nextSource.kind === 'pdf' && !nextSource.sources?.length) {
        state.setWorkflowMessage('attachSource', requestId, t('Verifica testo PDF...'));
        await openRouter.validatePdfTextSource(nextFile);
      }

      pushNousDebugTrace('attach-source:prepared', {
        name: nextFile.name,
        normalizedMimeType: nextFile.mimeType,
        requestId,
        sourceKind: nextSource.kind,
        archiveEntryCount: nextSource.kind === 'archive' ? nextSource.index.entries.length : null,
      });

      if (options?.mode === 'reattach-source' && projectLibrary.currentProjectId) {
        const reattachProjectId = projectLibrary.currentProjectId;
        const isReattachProjectSelected = () =>
          projectLibrary.getCurrentProjectId() === reattachProjectId;
        const isReattachCurrent = () =>
          state.isWorkflowCurrent('attachSource', requestId) && isReattachProjectSelected();
        const replacementSources = getCourseSourceDescriptors(nextSource);
        const existingSources = getCourseSourceDescriptors(domain.source);
        if (replacementSources.length > 0 && existingSources.length > 0) {
          nextSource = createProjectSourceFromDescriptors(
            mergeCourseSourceDescriptors(existingSources, replacementSources)
          );
        } else if (nextSource.kind === 'archive') {
          const existingSourceId = domain.source?.ref?.id || domain.source?.file.sourceId;
          if (existingSourceId) {
            nextSource = {
              ...nextSource,
              file: { ...nextSource.file, sourceId: existingSourceId },
            };
          }
        }
        const previousSource = domain.source;
        projectLibrary.setProjectHydrated(false);
        domain.setSource(nextSource);
        try {
          const saved = await projectLibrary.saveCurrentProject(
            { source: nextSource },
            { archiveFile, throwOnError: true }
          );
          if (!isReattachCurrent()) {
            if (isReattachProjectSelected() && domain.source === nextSource) {
              projectLibrary.setProjectHydrated(true);
            }
            return { outcome: 'failed' };
          }
          if (!saved) {
            throw new Error('La sorgente del progetto non è stata salvata.');
          }
          if (nextSource.kind === 'archive') {
            if (saved.snapshot.source?.kind !== 'archive') {
              throw new Error('La sorgente archivio salvata non è valida.');
            }
            nextSource = saved.snapshot.source;
            sourceWarnings = getProjectSourceWarnings(nextSource);
            domain.setSource(nextSource);
          }
        } catch (error) {
          if (!isReattachCurrent()) {
            if (isReattachProjectSelected() && domain.source === nextSource) {
              domain.setSource(previousSource);
              projectLibrary.setProjectHydrated(true);
            }
            return { outcome: 'failed' };
          }
          domain.setSource(previousSource);
          projectLibrary.setProjectHydrated(true);
          throw error;
        }
        state.invalidateWorkflows([...REATTACH_SOURCE_WORKFLOWS_TO_INVALIDATE]);
        state.setProjectMissingSource(reattachProjectId, false);
        state.resetSessionState();
        projectLibrary.setProjectHydrated(true);
        state.succeedWorkflow('attachSource', requestId);
        return { outcome: 'reattached', sourceWarnings };
      }

      const nextProjectId = createProjectId();
      projectLibrary.setProjectHydrated(false);
      domain.resetDomain();
      state.resetSessionState();
      projectLibrary.setCurrentProjectId(nextProjectId);
      domain.setSource(nextSource);

      const saved = await projectLibrary.persistSnapshot(
        createProjectSnapshot({
          id: nextProjectId,
          state: AppState.ASSESSMENT,
          source: nextSource,
        }),
        { archiveFile, throwOnError: true }
      );
      if (!saved?.snapshot.source) {
        throw new Error('La sorgente del progetto non è stata salvata.');
      }
      nextSource = saved.snapshot.source;
      sourceWarnings = getProjectSourceWarnings(nextSource);
      domain.setSource(nextSource);
      projectLibrary.setProjectHydrated(true);
      state.succeedWorkflow('attachSource', requestId);
      pushNousDebugTrace('attach-source:persisted', {
        projectId: nextProjectId,
        requestId,
        sourceKind: nextSource.kind,
      });
      await startAssessment(
        (nextSource.sources?.length || 0) > 1
          ? { sources: nextSource.sources }
          : nextSource.kind === 'archive'
            ? {
                textSource: {
                  name: nextSource.name,
                  text: formatSourceArchiveIndex(nextSource.index, {
                    previewBudgetChars: ASSESSMENT_SOURCE_ARCHIVE_PREVIEW_BUDGET_CHARS,
                  }),
                },
              }
            : nextSource.kind === 'document'
              ? {
                  textSource: {
                    name: nextSource.file.name,
                    text: decodeTextBase64(nextSource.file.data),
                  },
                }
              : { file: nextFile }
      );
      return { outcome: 'started-assessment', sourceWarnings };
    } catch (error) {
      if (error instanceof ProjectStorageError && error.sourceWarnings?.length) {
        sourceWarnings = error.sourceWarnings;
      }
      if (
        options?.mode !== 'reattach-source' &&
        error instanceof ProjectStorageError &&
        (error.code === 'source-archive-unusable' ||
          error.code === 'source-archive-busy' ||
          error.code === 'source-archive-invalid')
      ) {
        const rejectedProjectId = projectLibrary.getCurrentProjectId();
        if (rejectedProjectId) {
          try {
            await projectLibrary.deleteStoredProject(rejectedProjectId);
          } catch (cleanupError) {
            pushNousDebugTrace('attach-source:rejected-archive-cleanup-failed', {
              errorMessage: getErrorMessage(cleanupError),
              projectId: rejectedProjectId,
            });
          }
        }
        domain.resetDomain();
        projectLibrary.setCurrentProjectId(null);
        projectLibrary.setProjectHydrated(true);
        state.setScreenState(AppState.LIBRARY);
      }
      const errorMessage = getErrorMessage(error);
      state.failWorkflow('attachSource', requestId, errorMessage);
      return {
        outcome: options?.mode === 'reattach-source' ? 'failed' : 'started-assessment',
        errorMessage,
        sourceWarnings,
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
    projectId: string,
    options: OpenProjectOptions = {}
  ): Promise<{ errorMessage?: string; outcome: 'failed' | 'missing' | 'opened' | 'stale' }> {
    state.invalidateOpenSectionRequests();
    const requestId = state.beginWorkflow('openProject', t('Apertura progetto...'));
    if (projectLibrary.getCurrentProjectId() !== projectId) {
      state.invalidateWorkflows([...PROJECT_NAVIGATION_WORKFLOWS_TO_INVALIDATE]);
    }
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
        await projectLibrary.refreshLibraryState();
        state.succeedWorkflow('openProject', requestId);
        return { outcome: 'missing' };
      }

      pushNousDebugTrace('open-project:snapshot-loaded', {
        hasLearningPlan: Boolean(snapshot.learningPlan),
        projectId,
        requestId,
        sourceKind: snapshot.source?.kind || null,
        sourceName: getProjectSourceName(snapshot.source) || null,
        archiveEntryCount:
          snapshot.source?.kind === 'archive' ? snapshot.source.index.entries.length : null,
      });

      if (!state.isWorkflowCurrent('openProject', requestId)) {
        pushNousDebugTrace('open-project:stale-before-hydration', { projectId, requestId });
        return { outcome: 'stale' };
      }

      let snapshotToHydrate = snapshot;
      let repairedProjectRevision: number | undefined;
      let hasAuthoritativeSnapshot = false;
      const pdfFile = snapshot.source?.kind === 'pdf' ? snapshot.source.file : null;
      if (needsPdfProjectHydration(pdfFile, snapshot.learningPlan, snapshot.documentIndex)) {
        const repairState = getPdfProjectHydrationState(
          pdfFile,
          snapshot.learningPlan,
          snapshot.documentIndex
        );
        state.setWorkflowMessage(
          'openProject',
          requestId,
          repairState === 'missing-document-index'
            ? t('Indicizzazione capitoli del PDF...')
            : t('Allineamento lezioni con il PDF...')
        );
        try {
          const repair = await waitWithTimeout(
            signal => openRouter.repairDurablePdfMapping({ projectId, signal }),
            OPEN_PROJECT_PDF_REPAIR_TIMEOUT_MS
          );
          const knownProjectRevision = projectLibrary.savedProjects.find(
            project => project.id === projectId
          )?.revision;
          if (
            repair &&
            (repair.repaired ||
              knownProjectRevision === undefined ||
              repair.projectRevision > knownProjectRevision)
          ) {
            const repairedProject = await projectLibrary.loadStoredProjectWithRevision(projectId);
            if (repairedProject) {
              snapshotToHydrate = repairedProject.snapshot;
              repairedProjectRevision = repairedProject.revision;
              hasAuthoritativeSnapshot = true;
            }
          } else if (!repair) {
            pushNousDebugTrace('open-project:pdf-repair-timeout', {
              projectId,
              requestId,
              timeoutMs: OPEN_PROJECT_PDF_REPAIR_TIMEOUT_MS,
            });
          }
        } catch (error) {
          pushNousDebugTrace('open-project:pdf-repair-failed', {
            errorMessage: getErrorMessage(error),
            projectId,
            requestId,
          });
        }
        if (!state.isWorkflowCurrent('openProject', requestId)) {
          pushNousDebugTrace('open-project:stale-after-pdf-repair', { projectId, requestId });
          return { outcome: 'stale' };
        }
      }

      if (!hasAuthoritativeSnapshot) {
        const projectBeforeHydration = await projectLibrary.validateStoredProjectForOpen(projectId);
        if (!state.isWorkflowCurrent('openProject', requestId)) {
          pushNousDebugTrace('open-project:stale-before-authoritative-hydration', {
            projectId,
            requestId,
          });
          return { outcome: 'stale' };
        }
        if (!projectBeforeHydration) {
          pushNousDebugTrace('open-project:deleted-before-hydration', { projectId, requestId });
          state.succeedWorkflow('openProject', requestId);
          didSettleOpenWorkflow = true;
          state.setOpeningProjectId(null);
          return { outcome: 'missing' };
        }
        snapshotToHydrate = projectBeforeHydration.snapshot;
        repairedProjectRevision = projectBeforeHydration.revision;
      }

      const hydration = prepareSnapshotForHydrationResult(snapshotToHydrate);
      let preparedSnapshot = hydration.snapshot;
      const requestedPathNode = options.activeSectionId
        ? findPathNodeById(preparedSnapshot.learningPlan?.modules, options.activeSectionId)
        : null;
      if (options.activeSectionId && requestedPathNode?.kind !== 'lesson') {
        throw new Error(t('Non sono riuscito ad aprire il materiale recuperato. Riprova.'));
      }
      if (projectLibrary.getCurrentProjectId() !== projectId) {
        state.invalidateWorkflows([...PROJECT_SWITCH_WORKFLOWS_TO_INVALIDATE]);
      }
      persistHydratedSnapshot(preparedSnapshot, repairedProjectRevision);
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
        const resumeOutcome = await resumePlanGeneration(projectId);
        if (resumeOutcome === 'resumed') {
          pushNousDebugTrace('open-project:course-generation-resumed', { projectId, requestId });
          return { outcome: 'opened' };
        }

        const latestSnapshot = await projectLibrary.loadStoredProject(projectId);
        if (latestSnapshot) {
          preparedSnapshot = prepareSnapshotForHydrationResult(latestSnapshot).snapshot;
          persistHydratedSnapshot(preparedSnapshot);
        }
      }

      if (!preparedSnapshot.learningPlan) {
        const assessmentSources = getCourseSourceDescriptors(preparedSnapshot.source);
        if (assessmentSources.length > 1) {
          await startAssessment({ sources: assessmentSources });
        } else if (preparedSnapshot.source?.kind === 'archive') {
          pushNousDebugTrace('open-project:start-text-assessment', {
            projectId,
            requestId,
            archiveEntryCount: preparedSnapshot.source.index.entries.length,
          });
          await startAssessment({
            textSource: {
              name: preparedSnapshot.source.name,
              text: formatSourceArchiveIndex(preparedSnapshot.source.index, {
                previewBudgetChars: ASSESSMENT_SOURCE_ARCHIVE_PREVIEW_BUDGET_CHARS,
              }),
            },
          });
        } else if (preparedSnapshot.source?.kind === 'document') {
          const sourceFile =
            getProjectSourceFile(preparedSnapshot.source) ??
            (await projectLibrary.loadStoredProjectSource(projectId));
          if (!sourceFile) {
            throw new Error('La sorgente documento non è disponibile.');
          }
          await startAssessment({
            textSource: {
              name: sourceFile.name,
              text: decodeTextBase64(sourceFile.data),
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
        } else if (preparedSnapshot.isLearnMode) {
          await startLearnAssessment();
        }
      } else if (preparedSnapshot.learningPlan) {
        const requestedSection = requestedPathNode?.kind === 'lesson' ? requestedPathNode : null;
        const nextSection =
          requestedSection ||
          resolvePlanLesson(preparedSnapshot.learningPlan, preparedSnapshot.activeSectionId);
        if (requestedSection) {
          if (requestedSection.content?.length) {
            const openOutcome = await openSection(requestedSection, { allowWhileBlocking: true });
            if (openOutcome === 'ignored-busy') {
              throw new Error(t('Non sono riuscito ad aprire il materiale recuperato. Riprova.'));
            }
          } else {
            void openSection(requestedSection, { allowWhileBlocking: true }).catch(error => {
              pushNousDebugTrace('open-project:requested-section-load-failed', {
                errorMessage: getErrorMessage(error),
                projectId,
                requestId,
                sectionId: requestedSection.id,
              });
            });
          }
        }
        const hydratedPdfFile =
          preparedSnapshot.source?.kind === 'pdf' ? preparedSnapshot.source.file : null;
        if (
          !requestedSection &&
          !needsPdfProjectHydration(
            hydratedPdfFile,
            preparedSnapshot.learningPlan,
            preparedSnapshot.documentIndex
          ) &&
          nextSection &&
          (!nextSection.content || nextSection.content.length === 0)
        ) {
          void (async () => {
            if (
              projectLibrary.getCurrentProjectId() !== projectId ||
              !state.isWorkflowCurrent('openProject', requestId)
            ) {
              return;
            }
            await openSection(nextSection, { allowWhileBlocking: true });
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

  function cancelProjectOpen(): void {
    if (state.getWorkflowState().openProject.status !== 'pending') return;

    const projectId = state.getOpeningProjectId();
    state.invalidateWorkflows(['openProject']);
    state.setOpeningProjectId(null);
    pushNousDebugTrace('open-project:cancelled', { projectId });
  }

  function handleRemoteProjectDeleted(projectId: string): void {
    pushNousDebugTrace('project:remote-deleted', { projectId });
    stopAudio(true);
    projectLibrary.setProjectHydrated(false);
    projectLibrary.setCurrentProjectId(null);
    domain.resetDomain();
    state.invalidateWorkflows([...WORKSPACE_WORKFLOW_IDS]);
    state.resetSessionState();
    state.setScreenState(AppState.LIBRARY);
  }

  return {
    cancelProjectOpen,
    deleteProject,
    handleRemoteProjectDeleted,
    handleSourceUpload,
    importProjectFile,
    openProject,
  };
};
