import {
  COURSE_INTERVIEW_DECISION_SIGNAL,
  COURSE_INTERVIEW_USER_ANSWER_SIGNAL,
} from '@shared/courseInterviewContract';
import type {
  CourseWorkflowResult,
  CourseWorkflowSnapshot,
  CourseWorkflowStage,
} from '@shared/courseWorkflowContract';

import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import { pushNousDebugTrace } from '../../../services/core/debugTrace.ts';
import { getErrorMessage } from '../../../services/core/errorMessage.ts';
import { recordFeedbackWorkflowSnapshot } from '../../../services/feedback/browserDiagnostics.ts';
import type { CourseInterviewSnapshot } from '../../../services/openrouter/courseInterviewClient.ts';
import { createGenerationProgressBridge } from '../../../services/openrouter/generationProgress.ts';
import { ProjectStorageError } from '../../../services/projects/projectRepository.ts';
import {
  createProjectId,
  createProjectSnapshot,
} from '../../../services/projects/projectSnapshot.ts';
import {
  createProjectSourceFromFile,
  getProjectSourceName,
  isZipFileData,
} from '../../../services/projects/projectSource.ts';
import {
  ASSESSMENT_SOURCE_ARCHIVE_PREVIEW_BUDGET_CHARS,
  formatSourceArchiveIndex,
} from '../../../services/projects/sourceArchive.ts';
import {
  AppState,
  type FileData,
  type HomeChatToolPreferences,
  type LessonNode,
  type ProjectSource,
  type ProjectSourceWarning,
  type UserProfile,
} from '../../../types.ts';
import {
  getProjectSourceWarnings,
  prepareUploadedCourseSource,
  readSourceFileData,
} from './controllerContext.ts';
import { importProjectBackupFile, isNousBackupArchive } from './projectImport.ts';
import type {
  AssessmentSourceInput,
  OpenSectionOptions,
  OpenSectionOutcome,
  WorkspaceControllerContext,
} from './types.ts';

interface AssessmentPlanningDependencies {
  openSection: (section: LessonNode, options?: OpenSectionOptions) => Promise<OpenSectionOutcome>;
}

type CourseInterviewOutcome = 'abandoned' | 'assessment-complete' | 'continued';

interface HomeChatStartArgs {
  input: string;
  selectedFile?: File | null;
  selectedFiles?: File[];
  toolPreferences?: HomeChatToolPreferences;
}

interface HomeChatStartResult {
  errorMessage?: string;
  outcome:
    | 'abandoned'
    | 'assessment-complete'
    | 'continued'
    | 'failed'
    | 'imported'
    | 'noop'
    | 'planned';
  sourceWarnings?: ProjectSourceWarning[];
}

interface PendingHomeChatInterviewRun {
  readonly projectId: string;
  readonly runId: Promise<string | null>;
}

class LateCourseInterviewCancellationError extends Error {}

const getCourseInterviewOutcome = (snapshot: CourseInterviewSnapshot): CourseInterviewOutcome => {
  if (snapshot.status === 'cancelled' || snapshot.result?.kind === 'cancelled') return 'abandoned';
  if (snapshot.result?.kind === 'exhausted') {
    throw new Error('L’intervista ha raggiunto il limite di sicurezza. Riprova.');
  }
  if (snapshot.status === 'failed' || snapshot.status === 'expired') {
    throw new Error('L’intervista per il corso non è riuscita. Riprova.');
  }
  if (snapshot.wait?.signalType === COURSE_INTERVIEW_DECISION_SIGNAL && snapshot.proposal) {
    return 'assessment-complete';
  }
  if (snapshot.status === 'completed' && !snapshot.result) {
    throw new Error('L’intervista si è conclusa senza un risultato valido. Riprova.');
  }
  return 'continued';
};

export const createAssessmentPlanningCommands = (
  context: WorkspaceControllerContext,
  _: AssessmentPlanningDependencies
) => {
  const { domain, openRouter, projectLibrary, state } = context;
  let activeAssessmentCancellationPromise: Promise<void> | null = null;
  let activeHomeChatStartPromise: Promise<HomeChatStartResult> | null = null;
  let pendingHomeChatInterviewRun: PendingHomeChatInterviewRun | null = null;
  let latestHomeChatRequestToken: symbol | null = null;

  const applyInterviewSnapshot = (snapshot: CourseInterviewSnapshot): CourseInterviewOutcome => {
    recordFeedbackWorkflowSnapshot({
      operation: 'assessment-interview',
      projectId: snapshot.projectId,
      runId: snapshot.runId,
      status: snapshot.status,
    });
    state.setAssessmentMessages([...snapshot.messages]);
    state.setCourseProposal(
      snapshot.wait?.signalType === COURSE_INTERVIEW_DECISION_SIGNAL ? snapshot.proposal : null
    );
    return getCourseInterviewOutcome(snapshot);
  };

  const resetInterviewClientState = (): void => {
    domain.resetDomain();
    state.resetSessionState();
    projectLibrary.setCurrentProjectId(null);
    projectLibrary.setProjectHydrated(true);
    state.setScreenState(AppState.LIBRARY);
  };

  const ensureInterviewProject = async (
    mode: 'document' | 'learn',
    source: ProjectSource | null = domain.source
  ): Promise<string> => {
    const existingProjectId = projectLibrary.getCurrentProjectId();
    if (existingProjectId) {
      const saved = await projectLibrary.saveCurrentProject(
        { isLearnMode: mode === 'learn', source, state: AppState.ASSESSMENT },
        { throwOnError: true }
      );
      if (!saved) throw new Error('Non è stato possibile preparare l’intervista del corso.');
      return existingProjectId;
    }

    const projectId = createProjectId();
    projectLibrary.setCurrentProjectId(projectId);
    projectLibrary.setProjectHydrated(false);
    const saved = await projectLibrary.persistSnapshot(
      createProjectSnapshot({
        documentAssets: domain.documentAssets,
        documentIndex: domain.documentIndex,
        id: projectId,
        isLearnMode: mode === 'learn',
        researchCoursePlan: domain.researchCoursePlan,
        researchDossiersBySectionId: domain.researchDossiersBySectionId,
        source,
        state: AppState.ASSESSMENT,
        syllabus: domain.syllabus,
      }),
      { throwOnError: true }
    );
    if (!saved) throw new Error('Non è stato possibile preparare l’intervista del corso.');
    projectLibrary.setProjectHydrated(true);
    return projectId;
  };

  const startOrResumeInterview = async (input: {
    hasReliableSourceContext: boolean;
    initialMessage?: string;
    isRequestCurrent?: () => boolean;
    mode: 'document' | 'learn';
    onRunStarted?: (runId: string) => void;
    projectId: string;
    sourceContext?: string;
  }): Promise<CourseInterviewOutcome> => {
    const clientOptions = input.onRunStarted ? { onRunStarted: input.onRunStarted } : undefined;
    const active = await openRouter.getActiveCourseInterview(input.projectId, clientOptions);
    const snapshot =
      active ??
      (await openRouter.startCourseInterview(
        {
          hasReliableSourceContext: input.hasReliableSourceContext,
          ...(input.initialMessage ? { initialMessage: input.initialMessage } : {}),
          mode: input.mode,
          projectId: input.projectId,
          ...(input.sourceContext ? { sourceContext: input.sourceContext } : {}),
        },
        clientOptions
      ));
    if (input.isRequestCurrent && !input.isRequestCurrent()) {
      if (snapshot.status !== 'cancelled' && snapshot.result?.kind !== 'cancelled') {
        try {
          await openRouter.cancelCourseInterview({
            projectId: snapshot.projectId,
            runId: snapshot.runId,
          });
        } catch (error) {
          throw new LateCourseInterviewCancellationError(
            'Late course interview cancellation failed.',
            { cause: error }
          );
        }
      }
      return 'abandoned';
    }
    return applyInterviewSnapshot(snapshot);
  };

  async function startAssessment({
    file,
    sources,
    textSource,
  }: AssessmentSourceInput): Promise<void> {
    const requestId = state.beginWorkflow('assessment', t('Avvio Valutazione...'));
    state.setScreenState(AppState.LIBRARY);
    pushNousDebugTrace('assessment:start', {
      fileName: file?.name || null,
      hasFile: Boolean(file),
      sourceCount: sources?.length || 0,
      hasTextSource: Boolean(textSource),
      requestId,
      textLength: textSource?.text.length || null,
    });

    try {
      const assessmentContext = sources?.length
        ? openRouter.buildAssessmentDocumentContextFromSourceSet(sources)
        : textSource
          ? openRouter.buildAssessmentDocumentContextFromTextSource(textSource)
          : file
            ? await openRouter.buildAssessmentDocumentPrompt(file, status => {
                state.setWorkflowMessage('assessment', requestId, status);
              })
            : (() => {
                throw new Error('Missing source input for assessment');
              })();
      const projectId = await ensureInterviewProject('document');
      await startOrResumeInterview({
        hasReliableSourceContext: assessmentContext.hasReliableSourceContext,
        mode: 'document',
        projectId,
        sourceContext: assessmentContext.content,
      });
      if (!state.isWorkflowCurrent('assessment', requestId)) return;
      state.succeedWorkflow('assessment', requestId);
    } catch (error) {
      state.setScreenState(AppState.LIBRARY);
      pushNousDebugTrace('assessment:failed', {
        errorMessage: getErrorMessage(error),
        requestId,
      });
      state.failWorkflow('assessment', requestId, getErrorMessage(error));
      throw error;
    }
  }

  async function startLearnAssessment(): Promise<void> {
    const requestId = state.beginWorkflow('assessment', t('Avvio Profilazione...'));
    state.setScreenState(AppState.LIBRARY);

    try {
      const projectId = await ensureInterviewProject('learn');
      await startOrResumeInterview({
        hasReliableSourceContext: false,
        mode: 'learn',
        projectId,
      });
      state.succeedWorkflow('assessment', requestId);
    } catch (error) {
      state.setScreenState(AppState.LIBRARY);
      state.failWorkflow('assessment', requestId, getErrorMessage(error));
      throw error;
    }
  }

  const createCourseProgressFeedback = (profile: UserProfile | null, requestId: number) => {
    const progressBridge = createGenerationProgressBridge({
      getProgress: () => state.getWorkflowState().generatePlan.progress,
      setProgress: progress => state.setWorkflowProgress('generatePlan', requestId, progress),
    });
    const progressObserver = openRouter.createGenerationProgressObserver({
      language: profile?.language || 'Italiano',
      onUpdate: progress => progressBridge.updateFromObserver(progress),
      operation: 'plan',
      subject: profile?.topic || getProjectSourceName(domain.source) || 'Nuovo percorso',
    });
    return { progressBridge, progressObserver };
  };

  const runDurableCourse = async ({
    execute,
    profile,
    progressFeedback,
    projectId,
    requestId,
  }: {
    execute: (callbacks: {
      onProgressStage: (stage: CourseWorkflowStage) => void;
      onWorkflowSnapshot: (snapshot: CourseWorkflowSnapshot) => void;
    }) => Promise<CourseWorkflowResult | null>;
    profile: UserProfile | null;
    progressFeedback?: ReturnType<typeof createCourseProgressFeedback>;
    projectId: string;
    requestId: number;
  }): Promise<boolean> => {
    const feedback = progressFeedback ?? createCourseProgressFeedback(profile, requestId);

    try {
      const result = await execute({
        onProgressStage: feedback.progressObserver.setStage,
        onWorkflowSnapshot: snapshot => {
          if (!state.isWorkflowCurrent('generatePlan', requestId)) return;
          recordFeedbackWorkflowSnapshot({
            operation: 'generate-course',
            projectId: snapshot.projectId,
            runId: snapshot.id,
            sectionId: snapshot.result?.firstSectionId,
            status: snapshot.status,
          });
          feedback.progressBridge.updateFromWorkflow(snapshot);
        },
      });
      if (!result) return false;
      if (!state.isWorkflowCurrent('generatePlan', requestId)) return true;

      const applied = await projectLibrary.applyPersistedProjectRevision({
        projectId: result.projectId,
        revision: result.projectRevision,
      });
      if (
        !state.isWorkflowCurrent('generatePlan', requestId) ||
        projectLibrary.getCurrentProjectId() !== projectId
      ) {
        return true;
      }
      if (!applied && !domain.learningPlan) {
        throw new Error('Il corso è stato generato, ma non è stato possibile caricarlo.');
      }

      state.setScreenState(AppState.READING);
      await feedback.progressObserver.finish();
      feedback.progressObserver.complete();
      return true;
    } finally {
      feedback.progressObserver.dispose();
    }
  };

  async function resumePlanGeneration(projectId: string): Promise<'not-found' | 'resumed'> {
    const requestId = state.beginWorkflow('generatePlan', t('Creazione Piano Studi...'));
    state.setScreenState(AppState.PLANNING);

    try {
      const resumed = await runDurableCourse({
        execute: callbacks => openRouter.resumeActiveDurableCourse({ projectId, ...callbacks }),
        profile: domain.userProfile,
        projectId,
        requestId,
      });
      if (state.isWorkflowCurrent('generatePlan', requestId)) {
        state.succeedWorkflow('generatePlan', requestId);
      }
      return resumed ? 'resumed' : 'not-found';
    } catch (error) {
      if (state.isWorkflowCurrent('generatePlan', requestId)) {
        state.setScreenState(AppState.LIBRARY);
        state.failWorkflow('generatePlan', requestId, getErrorMessage(error));
      }
      throw error;
    }
  }

  async function runAssessmentCancellation(): Promise<void> {
    latestHomeChatRequestToken = null;
    state.invalidateWorkflows(['assessment']);
    const invalidatedRequestId = state.getWorkflowState().assessment.requestId;
    const projectId = projectLibrary.getCurrentProjectId();
    if (projectId) {
      const pendingRun =
        pendingHomeChatInterviewRun?.projectId === projectId ? pendingHomeChatInterviewRun : null;
      const pendingRunId = pendingRun ? await pendingRun.runId : null;
      const interview = pendingRunId ? null : await openRouter.getActiveCourseInterview(projectId);
      if (pendingRunId) {
        await openRouter.cancelCourseInterview({ projectId, runId: pendingRunId });
      } else if (interview?.wait?.signalType === COURSE_INTERVIEW_DECISION_SIGNAL) {
        await openRouter.sendCourseInterviewDecision({
          decision: { kind: 'cancel' },
          projectId,
          runId: interview.runId,
          waitId: interview.wait.waitId,
        });
      } else if (interview) {
        await openRouter.cancelCourseInterview({ projectId, runId: interview.runId });
      }
      if (!interview && activeHomeChatStartPromise) {
        const cancelledStart = await activeHomeChatStartPromise;
        if (cancelledStart.outcome === 'failed') {
          throw new Error(t('Operazione non riuscita. Riprova.'));
        }
      }
      await projectLibrary.refreshLibraryState();
    }
    if (state.getWorkflowState().assessment.requestId === invalidatedRequestId) {
      resetInterviewClientState();
    }
  }

  function cancelAssessment(): Promise<void> {
    if (activeAssessmentCancellationPromise) return activeAssessmentCancellationPromise;

    const cancellationPromise = runAssessmentCancellation();
    activeAssessmentCancellationPromise = cancellationPromise;
    void cancellationPromise.then(
      () => {
        if (activeAssessmentCancellationPromise === cancellationPromise) {
          activeAssessmentCancellationPromise = null;
        }
      },
      () => {
        if (activeAssessmentCancellationPromise === cancellationPromise) {
          activeAssessmentCancellationPromise = null;
        }
      }
    );
    return cancellationPromise;
  }

  async function runHomeChatStart(args: HomeChatStartArgs): Promise<HomeChatStartResult> {
    const trimmedInput = args.input.trim();
    if (!trimmedInput) {
      return { outcome: 'noop' };
    }

    const selectedFiles = args.selectedFiles?.length
      ? args.selectedFiles
      : args.selectedFile
        ? [args.selectedFile]
        : [];
    const requestId = state.beginWorkflow(
      'assessment',
      t(selectedFiles.length > 0 ? 'Preparazione sorgente...' : 'Avvio conversazione...')
    );
    const requestToken = Symbol('home-chat-request');
    latestHomeChatRequestToken = requestToken;
    let sourceWarnings: ProjectSourceWarning[] = [];
    let draftProjectId: string | null = null;
    const isRequestCurrent = () => state.isWorkflowCurrent('assessment', requestId);
    const abandonCancelledStart = async () => {
      if (draftProjectId) {
        try {
          await projectLibrary.deleteStoredProject(draftProjectId);
          await projectLibrary.refreshLibraryState();
        } catch (cleanupError) {
          pushNousDebugTrace('assessment:cancelled-draft-cleanup-failed', {
            errorMessage: getErrorMessage(cleanupError),
            projectId: draftProjectId,
          });
        }
      }
      if (latestHomeChatRequestToken === null || latestHomeChatRequestToken === requestToken) {
        resetInterviewClientState();
      }
      return { outcome: 'abandoned' as const, sourceWarnings };
    };

    try {
      domain.resetDomain();
      state.resetSessionState();
      projectLibrary.setCurrentProjectId(null);
      projectLibrary.setProjectHydrated(false);

      let hasReliableSourceContext = false;
      let mode: 'document' | 'learn' = 'learn';
      let sourceContext: string | undefined;
      let preparedSource: ProjectSource | null = null;

      if (selectedFiles.length > 0) {
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
          const selectedFile = zipFiles[0];
          const isBackupArchive = await isNousBackupArchive(selectedFile);
          if (!isRequestCurrent()) return abandonCancelledStart();

          if (isBackupArchive) {
            state.setWorkflowMessage('assessment', requestId, t('Importazione backup...'));
            const importedSnapshot = await importProjectBackupFile(context, selectedFile);
            if (!isRequestCurrent()) {
              draftProjectId = importedSnapshot.id;
              return abandonCancelledStart();
            }
            state.succeedWorkflow('assessment', requestId);
            return { outcome: 'imported' };
          }

          const archiveSource = await import('../../../utils/project/codebaseBundle.ts').then(
            module => module.createSourceArchiveFromZip(selectedFile)
          );
          if (!isRequestCurrent()) return abandonCancelledStart();
          nextSource = archiveSource;
          nextFile = archiveSource.file;
          archiveFile = selectedFile;
        } else {
          if (selectedFiles.length === 1) {
            nextFile = await readSourceFileData(selectedFiles[0]);
            nextSource = createProjectSourceFromFile(nextFile);
          } else {
            const prepared = await prepareUploadedCourseSource(
              context,
              selectedFiles,
              (completed, total) => {
                state.setWorkflowMessage(
                  'assessment',
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

        if (nextSource.kind === 'pdf' && !nextSource.sources?.length) {
          state.setWorkflowMessage('assessment', requestId, t('Verifica testo PDF...'));
          await openRouter.validatePdfTextSource(nextFile);
        }

        if (nextSource.kind === 'archive') {
          const projectId = createProjectId();
          draftProjectId = projectId;
          projectLibrary.setCurrentProjectId(projectId);
          const saved = await projectLibrary.persistSnapshot(
            createProjectSnapshot({
              id: projectId,
              state: AppState.ASSESSMENT,
              source: nextSource,
            }),
            { archiveFile, throwOnError: true }
          );
          if (saved?.snapshot.source?.kind !== 'archive') {
            throw new Error('La sorgente archivio non è stata salvata.');
          }
          if (!isRequestCurrent()) return abandonCancelledStart();
          nextSource = saved.snapshot.source;
          sourceWarnings = getProjectSourceWarnings(nextSource);
        }

        sourceWarnings = getProjectSourceWarnings(nextSource);

        domain.setSource(nextSource);
        preparedSource = nextSource;
        if (nextSource.kind === 'archive') {
          projectLibrary.setProjectHydrated(true);
        }
        domain.setIsLearnMode(false);
        mode = 'document';

        const assessmentContext = nextSource.sources?.length
          ? openRouter.buildAssessmentDocumentContextFromSourceSet(nextSource.sources)
          : nextSource.kind === 'archive'
            ? openRouter.buildAssessmentDocumentContextFromTextSource({
                name: nextSource.name,
                text: formatSourceArchiveIndex(nextSource.index, {
                  previewBudgetChars: ASSESSMENT_SOURCE_ARCHIVE_PREVIEW_BUDGET_CHARS,
                }),
              })
            : await openRouter.buildAssessmentDocumentPrompt(nextFile, status => {
                state.setWorkflowMessage('assessment', requestId, status);
              });
        hasReliableSourceContext = assessmentContext.hasReliableSourceContext;
        sourceContext = assessmentContext.content;
      } else {
        domain.setSource(null);
        domain.setIsLearnMode(true);
      }

      if (!isRequestCurrent()) return abandonCancelledStart();
      const projectId = await ensureInterviewProject(mode, preparedSource);
      draftProjectId = projectId;
      if (!isRequestCurrent()) return abandonCancelledStart();
      let resolveRunId: (runId: string | null) => void = () => {};
      let hasResolvedRunId = false;
      const runId = new Promise<string | null>(resolve => {
        resolveRunId = resolve;
      });
      const pendingRun = { projectId, runId };
      pendingHomeChatInterviewRun = pendingRun;
      const reportRunStarted = (startedRunId: string) => {
        if (hasResolvedRunId) return;
        hasResolvedRunId = true;
        resolveRunId(startedRunId);
      };
      let outcome: CourseInterviewOutcome;
      try {
        outcome = await startOrResumeInterview({
          hasReliableSourceContext,
          initialMessage: trimmedInput,
          isRequestCurrent,
          mode,
          onRunStarted: reportRunStarted,
          projectId,
          ...(sourceContext ? { sourceContext } : {}),
        });
      } finally {
        if (!hasResolvedRunId) resolveRunId(null);
        if (pendingHomeChatInterviewRun === pendingRun) pendingHomeChatInterviewRun = null;
      }
      if (!isRequestCurrent()) return abandonCancelledStart();
      state.succeedWorkflow('assessment', requestId);
      if (outcome === 'abandoned') {
        await projectLibrary.refreshLibraryState();
        resetInterviewClientState();
      }
      return { outcome, sourceWarnings };
    } catch (error) {
      if (!isRequestCurrent()) {
        if (error instanceof LateCourseInterviewCancellationError) {
          pushNousDebugTrace('assessment:late-cancellation-failed', {
            errorMessage: getErrorMessage(error.cause),
            projectId: draftProjectId,
          });
          return { outcome: 'failed', sourceWarnings };
        }
        return abandonCancelledStart();
      }
      if (error instanceof ProjectStorageError && error.sourceWarnings?.length) {
        sourceWarnings = error.sourceWarnings;
      }
      const errorMessage = getErrorMessage(error);
      state.failWorkflow('assessment', requestId, errorMessage);
      const failedDraftProjectId = projectLibrary.getCurrentProjectId();
      if (failedDraftProjectId) {
        try {
          const activeInterview = await openRouter.getActiveCourseInterview(failedDraftProjectId);
          if (!activeInterview) await projectLibrary.deleteStoredProject(failedDraftProjectId);
        } catch (cleanupError) {
          pushNousDebugTrace('assessment:draft-cleanup-failed', {
            errorMessage: getErrorMessage(cleanupError),
            projectId: failedDraftProjectId,
          });
        }
      }
      resetInterviewClientState();
      return { outcome: 'failed', errorMessage, sourceWarnings };
    }
  }

  function startHomeChat(args: HomeChatStartArgs): Promise<HomeChatStartResult> {
    const startPromise = runHomeChatStart(args);
    activeHomeChatStartPromise = startPromise;
    void startPromise.then(
      () => {
        if (activeHomeChatStartPromise === startPromise) activeHomeChatStartPromise = null;
      },
      () => {
        if (activeHomeChatStartPromise === startPromise) activeHomeChatStartPromise = null;
      }
    );
    return startPromise;
  }

  async function submitAssessment(
    input: string,
    _toolPreferences?: HomeChatToolPreferences
  ): Promise<{
    errorMessage?: string;
    outcome: 'abandoned' | 'assessment-complete' | 'continued' | 'failed' | 'noop' | 'planned';
    sourceWarnings?: ProjectSourceWarning[];
  }> {
    const trimmedInput = input.trim();
    const projectId = projectLibrary.getCurrentProjectId();
    if (!trimmedInput || !projectId) {
      return { outcome: 'noop' };
    }

    const requestId = state.beginWorkflow('assessment', t('Valutazione risposta...'));

    try {
      const interview = await openRouter.getActiveCourseInterview(projectId);
      if (!interview?.wait) throw new Error('L’intervista non è pronta per una risposta.');
      const snapshot =
        interview.wait.signalType === COURSE_INTERVIEW_USER_ANSWER_SIGNAL
          ? await openRouter.sendCourseInterviewAnswer({
              projectId,
              runId: interview.runId,
              text: trimmedInput,
              waitId: interview.wait.waitId,
            })
          : await openRouter.sendCourseInterviewDecision({
              decision: { details: trimmedInput, kind: 'add-details' },
              projectId,
              runId: interview.runId,
              waitId: interview.wait.waitId,
            });
      if (!state.isWorkflowCurrent('assessment', requestId)) {
        return { outcome: 'abandoned' };
      }
      const outcome = applyInterviewSnapshot(snapshot);
      state.succeedWorkflow('assessment', requestId);
      if (outcome === 'abandoned') {
        await projectLibrary.refreshLibraryState();
        resetInterviewClientState();
      }
      return { outcome };
    } catch (error) {
      if (!state.isWorkflowCurrent('assessment', requestId)) {
        return { outcome: 'abandoned' };
      }
      const errorMessage = getErrorMessage(error);
      state.failWorkflow('assessment', requestId, errorMessage);
      return { outcome: 'failed', errorMessage };
    }
  }

  async function confirmPlanGeneration(): Promise<{
    errorMessage?: string;
    outcome: 'failed' | 'planned';
  }> {
    let requestId: number | undefined;
    let progressFeedback: ReturnType<typeof createCourseProgressFeedback> | undefined;
    try {
      const projectId = projectLibrary.getCurrentProjectId();
      if (!projectId) throw new Error('Nessun corso da generare.');
      const interview = await openRouter.getActiveCourseInterview(projectId);
      if (interview?.wait?.signalType !== COURSE_INTERVIEW_DECISION_SIGNAL) {
        throw new Error('La proposta del corso non è pronta.');
      }
      const courseProposal = interview.proposal ?? state.getCourseProposal();
      if (!courseProposal) throw new Error('La proposta del corso non è disponibile.');
      requestId = state.beginWorkflow('generatePlan', t('Creazione Piano Studi...'));
      state.setScreenState(AppState.PLANNING);
      progressFeedback = createCourseProgressFeedback(courseProposal, requestId);
      const approvedInterview = await openRouter.sendCourseInterviewDecision({
        decision: { kind: 'approve' },
        projectId,
        runId: interview.runId,
        waitId: interview.wait.waitId,
      });
      applyInterviewSnapshot(approvedInterview);
      const generated = await runDurableCourse({
        execute: callbacks => openRouter.resumeActiveDurableCourse({ projectId, ...callbacks }),
        profile: courseProposal,
        progressFeedback,
        projectId,
        requestId,
      });
      if (!generated) throw new Error('La generazione del corso non è stata avviata.');
      if (state.isWorkflowCurrent('generatePlan', requestId)) {
        state.succeedWorkflow('generatePlan', requestId);
      }
      return { outcome: 'planned' };
    } catch (error) {
      progressFeedback?.progressObserver.dispose();
      const errorMessage = getErrorMessage(error);
      if (requestId !== undefined && state.isWorkflowCurrent('generatePlan', requestId)) {
        state.setScreenState(AppState.LIBRARY);
        state.failWorkflow('generatePlan', requestId, errorMessage);
      }
      return { outcome: 'failed', errorMessage };
    }
  }

  return {
    cancelAssessment,
    confirmPlanGeneration,
    resumePlanGeneration,
    startHomeChat,
    startAssessment,
    startLearnAssessment,
    submitAssessment,
  };
};
