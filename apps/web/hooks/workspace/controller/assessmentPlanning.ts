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

interface HomeChatStartState {
  draftProjectId: string | null;
  sourceWarnings: ProjectSourceWarning[];
}

interface PreparedHomeChatSource {
  hasReliableSourceContext: boolean;
  mode: 'document' | 'learn';
  preparedSource: ProjectSource | null;
  sourceContext?: string;
}

interface PreparedFileSource {
  archiveFile?: File;
  file: FileData;
  source: ProjectSource;
}

type HomeChatSourcePreparation =
  | { kind: 'completed'; result: HomeChatStartResult }
  | { kind: 'ready'; value: PreparedHomeChatSource };

type FileSourcePreparation =
  | { kind: 'completed'; result: HomeChatStartResult }
  | { kind: 'ready'; value: PreparedFileSource };

interface StartOrResumeInterviewInput {
  hasReliableSourceContext: boolean;
  initialMessage?: string;
  isRequestCurrent?: () => boolean;
  mode: 'document' | 'learn';
  onRunStarted?: (runId: string) => void;
  pollingSignal?: AbortSignal;
  projectId: string;
  startSignal?: AbortSignal;
  sourceContext?: string;
}

interface PendingAssessmentInterviewRun {
  readonly pollingAbortController?: AbortController;
  readonly projectId: string;
  readonly runId: Promise<string | null>;
  readonly startRequestAbortController?: AbortController;
}

interface PendingWorkspaceOpen {
  readonly outcome: Promise<boolean>;
  readonly projectId: string;
  readonly resolve: (opened: boolean) => void;
}

interface AssessmentWorkspaceOwnership {
  readonly adoptedProjectIds: Set<string>;
  draftCleanupPromise: Promise<void> | null;
  draftProjectId: string | null;
  readonly pendingOpenProjects: Map<number, PendingWorkspaceOpen>;
  readonly requestToken: symbol;
  requiresCancellationRetry: boolean;
}

interface PendingCancelledDraftCleanup {
  readonly ownership: AssessmentWorkspaceOwnership;
  readonly projectId: string;
}

class LateCourseInterviewCancellationError extends Error {}

const isTerminalCourseInterviewSnapshot = (snapshot: CourseInterviewSnapshot): boolean =>
  snapshot.status === 'cancelled' ||
  snapshot.status === 'completed' ||
  snapshot.status === 'expired' ||
  snapshot.status === 'failed';

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
  let activeHomeChatWorkspaceOwnership: AssessmentWorkspaceOwnership | null = null;
  const openProjectAttempts = new Map<number, PendingWorkspaceOpen>();
  const workspaceOwnershipByOpenProjectRequestId = new Map<
    number,
    Set<AssessmentWorkspaceOwnership>
  >();
  const assessmentRunCancellationPromises = new Map<string, Promise<void>>();
  let pendingCancelledDraftCleanup: PendingCancelledDraftCleanup | null = null;
  let pendingAssessmentInterviewRun: PendingAssessmentInterviewRun | null = null;
  let latestHomeChatRequestToken: symbol | null = null;

  const createAssessmentWorkspaceOwnership = (
    requestToken: symbol
  ): AssessmentWorkspaceOwnership => {
    const ownership: AssessmentWorkspaceOwnership = {
      adoptedProjectIds: new Set(),
      draftCleanupPromise: null,
      draftProjectId: null,
      pendingOpenProjects: new Map(),
      requestToken,
      requiresCancellationRetry: false,
    };
    const openProjectRequestId = state.getWorkflowState().openProject.requestId;
    const pendingOpenProject = openProjectAttempts.get(openProjectRequestId);
    if (pendingOpenProject) {
      ownership.pendingOpenProjects.set(openProjectRequestId, pendingOpenProject);
      const owners =
        workspaceOwnershipByOpenProjectRequestId.get(openProjectRequestId) ?? new Set();
      owners.add(ownership);
      workspaceOwnershipByOpenProjectRequestId.set(openProjectRequestId, owners);
    }
    return ownership;
  };

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

  const startOrResumeInterview = async (
    input: StartOrResumeInterviewInput
  ): Promise<CourseInterviewOutcome> => {
    const activeClientOptions =
      input.onRunStarted || input.startSignal
        ? { onRunStarted: input.onRunStarted, signal: input.startSignal }
        : undefined;
    let active: CourseInterviewSnapshot | null;
    try {
      active = await openRouter.getActiveCourseInterview(input.projectId, activeClientOptions);
    } catch (error) {
      if (!input.startSignal?.aborted) throw error;
      active = await openRouter.getActiveCourseInterview(
        input.projectId,
        input.onRunStarted ? { onRunStarted: input.onRunStarted } : undefined
      );
    }
    if (!active && input.isRequestCurrent && !input.isRequestCurrent()) return 'abandoned';
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
        {
          onRunStarted: input.onRunStarted,
          signal: input.pollingSignal,
          startSignal: input.startSignal,
        }
      ));
    if (input.isRequestCurrent && !input.isRequestCurrent()) {
      await cancelLateCourseInterview(snapshot);
      return 'abandoned';
    }
    return applyInterviewSnapshot(snapshot);
  };

  const cancelLateCourseInterview = async (snapshot: CourseInterviewSnapshot): Promise<void> => {
    if (isTerminalCourseInterviewSnapshot(snapshot)) return;
    try {
      const claimedCancellation = assessmentRunCancellationPromises.get(snapshot.runId);
      await (claimedCancellation ??
        openRouter
          .cancelCourseInterview({
            projectId: snapshot.projectId,
            runId: snapshot.runId,
          })
          .then(() => undefined));
    } catch (error) {
      throw new LateCourseInterviewCancellationError('Late course interview cancellation failed.', {
        cause: error,
      });
    }
  };

  const startTrackedAssessmentInterview = async (
    input: Omit<StartOrResumeInterviewInput, 'onRunStarted' | 'pollingSignal' | 'startSignal'>
  ): Promise<CourseInterviewOutcome> => {
    let resolveRunId: (runId: string | null) => void = () => {};
    let hasResolvedRunId = false;
    let startedRunId: string | null = null;
    const runId = new Promise<string | null>(resolve => {
      resolveRunId = resolve;
    });
    const pollingAbortController = new AbortController();
    const startRequestAbortController = new AbortController();
    const pendingRun = {
      pollingAbortController,
      projectId: input.projectId,
      runId,
      startRequestAbortController,
    };
    pendingAssessmentInterviewRun = pendingRun;
    const reportRunStarted = (startedId: string) => {
      if (hasResolvedRunId) return;
      startedRunId = startedId;
      hasResolvedRunId = true;
      resolveRunId(startedId);
    };

    try {
      return await startOrResumeInterview({
        ...input,
        onRunStarted: reportRunStarted,
        pollingSignal: pollingAbortController.signal,
        startSignal: startRequestAbortController.signal,
      });
    } finally {
      if (!hasResolvedRunId) resolveRunId(null);
      if (startedRunId) assessmentRunCancellationPromises.delete(startedRunId);
      if (pendingAssessmentInterviewRun === pendingRun) pendingAssessmentInterviewRun = null;
    }
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
      if (!state.isWorkflowCurrent('assessment', requestId)) return;
      const projectId = await ensureInterviewProject('document');
      await startTrackedAssessmentInterview({
        hasReliableSourceContext: assessmentContext.hasReliableSourceContext,
        isRequestCurrent: () => state.isWorkflowCurrent('assessment', requestId),
        mode: 'document',
        projectId,
        sourceContext: assessmentContext.content,
      });
      if (!state.isWorkflowCurrent('assessment', requestId)) return;
      state.succeedWorkflow('assessment', requestId);
    } catch (error) {
      if (!state.isWorkflowCurrent('assessment', requestId)) return;
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
      await startTrackedAssessmentInterview({
        hasReliableSourceContext: false,
        isRequestCurrent: () => state.isWorkflowCurrent('assessment', requestId),
        mode: 'learn',
        projectId,
      });
      if (!state.isWorkflowCurrent('assessment', requestId)) return;
      state.succeedWorkflow('assessment', requestId);
    } catch (error) {
      if (!state.isWorkflowCurrent('assessment', requestId)) return;
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

  const waitForPendingWorkspaceOpen = async (
    ownership: AssessmentWorkspaceOwnership | null
  ): Promise<void> => {
    while (ownership?.pendingOpenProjects.size) {
      await Promise.all(
        [...ownership.pendingOpenProjects.values()].map(
          pendingOpenProject => pendingOpenProject.outcome
        )
      );
    }
  };

  const deleteTrackedDraft = async ({
    ownership,
    projectId,
    refreshLibrary,
  }: {
    ownership: AssessmentWorkspaceOwnership;
    projectId: string;
    refreshLibrary: boolean;
  }): Promise<void> => {
    if (ownership.adoptedProjectIds.has(projectId)) return;
    const deletion = projectLibrary.deleteStoredProject(projectId);
    const cleanupPromise = refreshLibrary
      ? deletion.then(() => projectLibrary.refreshLibraryState())
      : deletion;
    ownership.draftCleanupPromise = cleanupPromise;
    try {
      await cleanupPromise;
    } catch (error) {
      pendingCancelledDraftCleanup = { ownership, projectId };
      throw error;
    } finally {
      if (ownership.draftCleanupPromise === cleanupPromise) {
        ownership.draftCleanupPromise = null;
      }
    }
  };

  const retryPendingCancelledDraftCleanup = async (): Promise<void> => {
    const cancelledDraftCleanup = pendingCancelledDraftCleanup;
    if (!cancelledDraftCleanup) return;
    await waitForPendingWorkspaceOpen(cancelledDraftCleanup.ownership);
    await deleteTrackedDraft({
      ownership: cancelledDraftCleanup.ownership,
      projectId: cancelledDraftCleanup.projectId,
      refreshLibrary: true,
    });
    if (pendingCancelledDraftCleanup === cancelledDraftCleanup) {
      pendingCancelledDraftCleanup = null;
    }
  };

  const cancelAssessmentInterview = async (
    projectId: string,
    pendingRun: PendingAssessmentInterviewRun | null
  ): Promise<void> => {
    const pendingRunId = pendingRun ? await pendingRun.runId : null;
    if (pendingRunId) {
      const cancellationPromise = openRouter
        .cancelCourseInterview({ projectId, runId: pendingRunId })
        .then(() => undefined);
      assessmentRunCancellationPromises.set(pendingRunId, cancellationPromise);
      await cancellationPromise;
      pendingRun?.pollingAbortController?.abort();
      return;
    }

    const interview = await openRouter.getActiveCourseInterview(projectId);
    if (interview?.wait?.signalType === COURSE_INTERVIEW_DECISION_SIGNAL) {
      await openRouter.sendCourseInterviewDecision({
        decision: { kind: 'cancel' },
        projectId,
        runId: interview.runId,
        waitId: interview.wait.waitId,
      });
    } else if (interview) {
      await openRouter.cancelCourseInterview({ projectId, runId: interview.runId });
    }
    pendingRun?.pollingAbortController?.abort();
  };

  const cleanupCancellationRetryDraft = async (
    ownership: AssessmentWorkspaceOwnership | null
  ): Promise<void> => {
    if (!ownership?.requiresCancellationRetry || !ownership.draftProjectId) return;
    await deleteTrackedDraft({
      ownership,
      projectId: ownership.draftProjectId,
      refreshLibrary: false,
    });
    ownership.requiresCancellationRetry = false;
  };

  async function runAssessmentCancellation(): Promise<void> {
    const homeChatWorkspaceOwnership = activeHomeChatWorkspaceOwnership;
    const homeChatStartPromise = activeHomeChatStartPromise;
    const isCancellingActiveHomeChat = Boolean(
      homeChatWorkspaceOwnership &&
        (latestHomeChatRequestToken === homeChatWorkspaceOwnership.requestToken ||
          pendingCancelledDraftCleanup?.ownership === homeChatWorkspaceOwnership ||
          homeChatWorkspaceOwnership.requiresCancellationRetry)
    );
    const hasHomeChatWorkspaceBeenAdopted = () => {
      const currentProjectId = projectLibrary.getCurrentProjectId();
      return Boolean(
        isCancellingActiveHomeChat &&
          currentProjectId &&
          homeChatWorkspaceOwnership?.adoptedProjectIds.has(currentProjectId)
      );
    };
    latestHomeChatRequestToken = null;
    const cancellationRequestId = state.beginWorkflow('assessment', t('Caricamento...'));
    try {
      await retryPendingCancelledDraftCleanup();
      const currentProjectId = projectLibrary.getCurrentProjectId();
      const pendingRun = pendingAssessmentInterviewRun;
      pendingRun?.startRequestAbortController?.abort();
      const cancellationRetryProjectId = homeChatWorkspaceOwnership?.requiresCancellationRetry
        ? homeChatWorkspaceOwnership.draftProjectId
        : null;
      const projectId = pendingRun?.projectId ?? cancellationRetryProjectId ?? currentProjectId;
      if (projectId) {
        await cancelAssessmentInterview(projectId, pendingRun);
        await waitForPendingWorkspaceOpen(homeChatWorkspaceOwnership);
        await cleanupCancellationRetryDraft(homeChatWorkspaceOwnership);
        await projectLibrary.refreshLibraryState();
      }
      if (homeChatStartPromise !== null) {
        const cancelledStart = await homeChatStartPromise;
        if (cancelledStart.outcome === 'failed') {
          throw new Error(t('Operazione non riuscita. Riprova.'));
        }
      }
      if (
        state.isWorkflowCurrent('assessment', cancellationRequestId) &&
        !hasHomeChatWorkspaceBeenAdopted()
      ) {
        state.invalidateWorkflows(['assessment']);
        resetInterviewClientState();
      }
    } catch (error) {
      pushNousDebugTrace('assessment:cancellation-failed', {
        errorMessage: getErrorMessage(error),
      });
      if (
        projectLibrary.getCurrentProjectId() &&
        state.isWorkflowCurrent('assessment', cancellationRequestId) &&
        !hasHomeChatWorkspaceBeenAdopted()
      ) {
        state.beginWorkflow('assessment', t('Operazione non riuscita. Riprova.'));
      }
      throw new Error(t('Operazione non riuscita. Riprova.'), { cause: error });
    } finally {
      if (
        activeHomeChatWorkspaceOwnership === homeChatWorkspaceOwnership &&
        activeHomeChatStartPromise !== homeChatStartPromise &&
        !homeChatWorkspaceOwnership?.requiresCancellationRetry &&
        pendingCancelledDraftCleanup?.ownership !== homeChatWorkspaceOwnership
      ) {
        activeHomeChatWorkspaceOwnership = null;
      }
    }
  }

  function cancelAssessment(): Promise<void> {
    if (activeAssessmentCancellationPromise !== null) return activeAssessmentCancellationPromise;

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

  const abandonCancelledHomeChatStart = async ({
    requestToken,
    startState,
    workspaceOwnership,
  }: {
    requestToken: symbol;
    startState: HomeChatStartState;
    workspaceOwnership: AssessmentWorkspaceOwnership;
  }): Promise<HomeChatStartResult> => {
    await waitForPendingWorkspaceOpen(workspaceOwnership);
    const currentProjectId = projectLibrary.getCurrentProjectId();
    const draftProjectId = startState.draftProjectId;
    const hasBeenAdoptedByOpenProject =
      draftProjectId !== null &&
      currentProjectId === draftProjectId &&
      workspaceOwnership.adoptedProjectIds.has(draftProjectId);
    if (draftProjectId && !hasBeenAdoptedByOpenProject) {
      try {
        await deleteTrackedDraft({
          ownership: workspaceOwnership,
          projectId: draftProjectId,
          refreshLibrary: true,
        });
      } catch (cleanupError) {
        pushNousDebugTrace('assessment:cancelled-draft-cleanup-failed', {
          errorMessage: getErrorMessage(cleanupError),
          projectId: draftProjectId,
        });
        return {
          errorMessage: t('Operazione non riuscita. Riprova.'),
          outcome: 'failed',
          sourceWarnings: startState.sourceWarnings,
        };
      }
    }

    const currentProjectIdAfterCleanup = projectLibrary.getCurrentProjectId();
    const stillOwnsWorkspace =
      latestHomeChatRequestToken === requestToken &&
      !hasBeenAdoptedByOpenProject &&
      (currentProjectIdAfterCleanup === null || currentProjectIdAfterCleanup === draftProjectId);
    if (stillOwnsWorkspace) resetInterviewClientState();
    return { outcome: 'abandoned', sourceWarnings: startState.sourceWarnings };
  };

  const prepareZipHomeChatSource = async ({
    abandonCancelledStart,
    isRequestCurrent,
    requestId,
    selectedFile,
    startState,
    workspaceOwnership,
  }: {
    abandonCancelledStart: () => Promise<HomeChatStartResult>;
    isRequestCurrent: () => boolean;
    requestId: number;
    selectedFile: File;
    startState: HomeChatStartState;
    workspaceOwnership: AssessmentWorkspaceOwnership;
  }): Promise<FileSourcePreparation> => {
    const isBackupArchive = await isNousBackupArchive(selectedFile);
    if (!isRequestCurrent()) {
      return { kind: 'completed', result: await abandonCancelledStart() };
    }
    if (isBackupArchive) {
      state.setWorkflowMessage('assessment', requestId, t('Importazione backup...'));
      const importedSnapshot = await importProjectBackupFile(context, selectedFile, {
        shouldHydrateWorkspace: isRequestCurrent,
      });
      if (!isRequestCurrent()) {
        startState.draftProjectId = importedSnapshot.id;
        workspaceOwnership.draftProjectId = importedSnapshot.id;
        return { kind: 'completed', result: await abandonCancelledStart() };
      }
      state.succeedWorkflow('assessment', requestId);
      return { kind: 'completed', result: { outcome: 'imported' } };
    }

    const source = await import('../../../utils/project/codebaseBundle.ts').then(module =>
      module.createSourceArchiveFromZip(selectedFile)
    );
    if (!isRequestCurrent()) {
      return { kind: 'completed', result: await abandonCancelledStart() };
    }
    return {
      kind: 'ready',
      value: { archiveFile: selectedFile, file: source.file, source },
    };
  };

  const prepareRegularHomeChatSource = async (
    selectedFiles: File[],
    requestId: number
  ): Promise<PreparedFileSource> => {
    if (selectedFiles.length === 1) {
      const file = await readSourceFileData(selectedFiles[0]);
      return { file, source: createProjectSourceFromFile(file) };
    }
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
    const file = prepared.descriptors.find(source => source.status !== 'error')?.file;
    if (!file) throw new Error('Unable to prepare project source');
    return { file, source: prepared.source };
  };

  const prepareHomeChatFiles = async ({
    abandonCancelledStart,
    isRequestCurrent,
    requestId,
    selectedFiles,
    startState,
    workspaceOwnership,
  }: {
    abandonCancelledStart: () => Promise<HomeChatStartResult>;
    isRequestCurrent: () => boolean;
    requestId: number;
    selectedFiles: File[];
    startState: HomeChatStartState;
    workspaceOwnership: AssessmentWorkspaceOwnership;
  }): Promise<FileSourcePreparation> => {
    const zipFiles = selectedFiles.filter(file =>
      isZipFileData({ name: file.name, mimeType: file.type })
    );
    if (zipFiles.length > 0 && selectedFiles.length !== 1) {
      throw new Error('Gli archivi ZIP devono essere caricati da soli.');
    }
    if (zipFiles.length === 1) {
      return prepareZipHomeChatSource({
        abandonCancelledStart,
        isRequestCurrent,
        requestId,
        selectedFile: zipFiles[0],
        startState,
        workspaceOwnership,
      });
    }
    return { kind: 'ready', value: await prepareRegularHomeChatSource(selectedFiles, requestId) };
  };

  const persistHomeChatArchiveSource = async ({
    archiveFile,
    source,
    startState,
    workspaceOwnership,
  }: {
    archiveFile?: File;
    source: ProjectSource;
    startState: HomeChatStartState;
    workspaceOwnership: AssessmentWorkspaceOwnership;
  }): Promise<ProjectSource> => {
    if (source.kind !== 'archive') return source;
    const projectId = createProjectId();
    startState.draftProjectId = projectId;
    workspaceOwnership.draftProjectId = projectId;
    projectLibrary.setCurrentProjectId(projectId);
    const saved = await projectLibrary.persistSnapshot(
      createProjectSnapshot({ id: projectId, state: AppState.ASSESSMENT, source }),
      { archiveFile, throwOnError: true }
    );
    if (saved?.snapshot.source?.kind !== 'archive') {
      throw new Error('La sorgente archivio non è stata salvata.');
    }
    return saved.snapshot.source;
  };

  const buildHomeChatAssessmentContext = async (
    source: ProjectSource,
    file: FileData,
    requestId: number
  ) => {
    if (source.sources?.length) {
      return openRouter.buildAssessmentDocumentContextFromSourceSet(source.sources);
    }
    if (source.kind === 'archive') {
      return openRouter.buildAssessmentDocumentContextFromTextSource({
        name: source.name,
        text: formatSourceArchiveIndex(source.index, {
          previewBudgetChars: ASSESSMENT_SOURCE_ARCHIVE_PREVIEW_BUDGET_CHARS,
        }),
      });
    }
    return openRouter.buildAssessmentDocumentPrompt(file, status => {
      state.setWorkflowMessage('assessment', requestId, status);
    });
  };

  const prepareHomeChatSource = async ({
    abandonCancelledStart,
    isRequestCurrent,
    requestId,
    selectedFiles,
    startState,
    workspaceOwnership,
  }: {
    abandonCancelledStart: () => Promise<HomeChatStartResult>;
    isRequestCurrent: () => boolean;
    requestId: number;
    selectedFiles: File[];
    startState: HomeChatStartState;
    workspaceOwnership: AssessmentWorkspaceOwnership;
  }): Promise<HomeChatSourcePreparation> => {
    if (selectedFiles.length === 0) {
      domain.setSource(null);
      domain.setIsLearnMode(true);
      return {
        kind: 'ready',
        value: { hasReliableSourceContext: false, mode: 'learn', preparedSource: null },
      };
    }

    const preparation = await prepareHomeChatFiles({
      abandonCancelledStart,
      isRequestCurrent,
      requestId,
      selectedFiles,
      startState,
      workspaceOwnership,
    });
    if (preparation.kind === 'completed') return preparation;
    let { source } = preparation.value;
    const { archiveFile, file } = preparation.value;
    if (!isRequestCurrent()) {
      return { kind: 'completed', result: await abandonCancelledStart() };
    }
    if (source.kind === 'pdf' && !source.sources?.length) {
      state.setWorkflowMessage('assessment', requestId, t('Verifica testo PDF...'));
      await openRouter.validatePdfTextSource(file);
      if (!isRequestCurrent()) {
        return { kind: 'completed', result: await abandonCancelledStart() };
      }
    }
    source = await persistHomeChatArchiveSource({
      archiveFile,
      source,
      startState,
      workspaceOwnership,
    });
    if (!isRequestCurrent()) {
      return { kind: 'completed', result: await abandonCancelledStart() };
    }

    startState.sourceWarnings = getProjectSourceWarnings(source);
    domain.setSource(source);
    if (source.kind === 'archive') projectLibrary.setProjectHydrated(true);
    domain.setIsLearnMode(false);
    const assessmentContext = await buildHomeChatAssessmentContext(source, file, requestId);
    return {
      kind: 'ready',
      value: {
        hasReliableSourceContext: assessmentContext.hasReliableSourceContext,
        mode: 'document',
        preparedSource: source,
        sourceContext: assessmentContext.content,
      },
    };
  };

  const handleHomeChatStartFailure = async ({
    abandonCancelledStart,
    error,
    isRequestCurrent,
    requestId,
    startState,
    workspaceOwnership,
  }: {
    abandonCancelledStart: () => Promise<HomeChatStartResult>;
    error: unknown;
    isRequestCurrent: () => boolean;
    requestId: number;
    startState: HomeChatStartState;
    workspaceOwnership: AssessmentWorkspaceOwnership;
  }): Promise<HomeChatStartResult> => {
    if (!isRequestCurrent()) {
      if (error instanceof LateCourseInterviewCancellationError) {
        workspaceOwnership.requiresCancellationRetry = true;
        pushNousDebugTrace('assessment:late-cancellation-failed', {
          errorMessage: getErrorMessage(error.cause),
          projectId: startState.draftProjectId,
        });
        return { outcome: 'failed', sourceWarnings: startState.sourceWarnings };
      }
      return abandonCancelledStart();
    }
    if (error instanceof ProjectStorageError && error.sourceWarnings?.length) {
      startState.sourceWarnings = error.sourceWarnings;
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
    return { outcome: 'failed', errorMessage, sourceWarnings: startState.sourceWarnings };
  };

  async function runHomeChatStart(args: HomeChatStartArgs): Promise<HomeChatStartResult> {
    const trimmedInput = args.input.trim();
    if (!trimmedInput) return { outcome: 'noop' };

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
    const workspaceOwnership = createAssessmentWorkspaceOwnership(requestToken);
    activeHomeChatWorkspaceOwnership = workspaceOwnership;
    const startState: HomeChatStartState = { draftProjectId: null, sourceWarnings: [] };
    const isRequestCurrent = () => state.isWorkflowCurrent('assessment', requestId);
    const abandonCancelledStart = () =>
      abandonCancelledHomeChatStart({ requestToken, startState, workspaceOwnership });

    try {
      domain.resetDomain();
      state.resetSessionState();
      projectLibrary.setCurrentProjectId(null);
      projectLibrary.setProjectHydrated(false);

      const preparation = await prepareHomeChatSource({
        abandonCancelledStart,
        isRequestCurrent,
        requestId,
        selectedFiles,
        startState,
        workspaceOwnership,
      });
      if (preparation.kind === 'completed') return preparation.result;
      if (!isRequestCurrent()) return abandonCancelledStart();
      const { hasReliableSourceContext, mode, preparedSource, sourceContext } = preparation.value;
      const projectId = await ensureInterviewProject(mode, preparedSource);
      startState.draftProjectId = projectId;
      workspaceOwnership.draftProjectId = projectId;
      if (!isRequestCurrent()) return abandonCancelledStart();
      const outcome = await startTrackedAssessmentInterview({
        hasReliableSourceContext,
        initialMessage: trimmedInput,
        isRequestCurrent,
        mode,
        projectId,
        ...(sourceContext ? { sourceContext } : {}),
      });
      if (!isRequestCurrent()) return abandonCancelledStart();
      state.succeedWorkflow('assessment', requestId);
      if (outcome === 'abandoned') {
        await projectLibrary.refreshLibraryState();
        resetInterviewClientState();
      }
      return { outcome, sourceWarnings: startState.sourceWarnings };
    } catch (error) {
      return handleHomeChatStartFailure({
        abandonCancelledStart,
        error,
        isRequestCurrent,
        requestId,
        startState,
        workspaceOwnership,
      });
    }
  }

  function startHomeChat(args: HomeChatStartArgs): Promise<HomeChatStartResult> {
    const startPromise = activeHomeChatWorkspaceOwnership?.requiresCancellationRetry
      ? cancelAssessment().then(
          () => runHomeChatStart(args),
          error => ({
            errorMessage: getErrorMessage(error),
            outcome: 'failed' as const,
          })
        )
      : runHomeChatStart(args);
    activeHomeChatStartPromise = startPromise;
    void startPromise.then(
      () => {
        if (activeHomeChatStartPromise === startPromise) {
          activeHomeChatStartPromise = null;
          if (
            !activeHomeChatWorkspaceOwnership?.requiresCancellationRetry &&
            pendingCancelledDraftCleanup?.ownership !== activeHomeChatWorkspaceOwnership
          ) {
            activeHomeChatWorkspaceOwnership = null;
          }
        }
      },
      () => {
        if (activeHomeChatStartPromise === startPromise) {
          activeHomeChatStartPromise = null;
          if (
            !activeHomeChatWorkspaceOwnership?.requiresCancellationRetry &&
            pendingCancelledDraftCleanup?.ownership !== activeHomeChatWorkspaceOwnership
          ) {
            activeHomeChatWorkspaceOwnership = null;
          }
        }
      }
    );
    return startPromise;
  }

  async function beginHomeChatWorkspaceOpen(
    projectId: string,
    openProjectRequestId: number
  ): Promise<void> {
    let resolveOutcome: (opened: boolean) => void = () => {};
    const outcome = new Promise<boolean>(resolve => {
      resolveOutcome = resolve;
    });
    const pendingOpenProject = {
      outcome,
      projectId,
      resolve: resolveOutcome,
    };
    openProjectAttempts.set(openProjectRequestId, pendingOpenProject);
    const owners = workspaceOwnershipByOpenProjectRequestId.get(openProjectRequestId) ?? new Set();
    const activeOwnership = activeHomeChatWorkspaceOwnership;
    if (activeOwnership) {
      activeOwnership.pendingOpenProjects.set(openProjectRequestId, pendingOpenProject);
      owners.add(activeOwnership);
    }
    const pendingCleanup = pendingCancelledDraftCleanup;
    if (pendingCleanup?.projectId === projectId) {
      pendingCleanup.ownership.pendingOpenProjects.set(openProjectRequestId, pendingOpenProject);
      owners.add(pendingCleanup.ownership);
    }
    if (owners.size === 0) return;
    workspaceOwnershipByOpenProjectRequestId.set(openProjectRequestId, owners);
    await Promise.all(
      [...owners]
        .map(ownership => ownership.draftCleanupPromise)
        .filter((cleanupPromise): cleanupPromise is Promise<void> => cleanupPromise !== null)
    );
  }

  function settleHomeChatWorkspaceOpen(
    projectId: string,
    openProjectRequestId: number,
    opened: boolean
  ): void {
    const pendingOpenProject = openProjectAttempts.get(openProjectRequestId);
    if (pendingOpenProject?.projectId !== projectId) return;
    const owners = workspaceOwnershipByOpenProjectRequestId.get(openProjectRequestId);
    if (owners) {
      for (const ownership of owners) {
        if (opened) ownership.adoptedProjectIds.add(projectId);
        ownership.pendingOpenProjects.delete(openProjectRequestId);
      }
      workspaceOwnershipByOpenProjectRequestId.delete(openProjectRequestId);
    }
    openProjectAttempts.delete(openProjectRequestId);
    pendingOpenProject.resolve(opened);
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
    const requestToken = Symbol('home-chat-follow-up');
    latestHomeChatRequestToken = requestToken;
    activeHomeChatWorkspaceOwnership = createAssessmentWorkspaceOwnership(requestToken);

    let resolveRunId: (runId: string | null) => void = () => {};
    let hasResolvedRunId = false;
    let startedRunId: string | null = null;
    const runId = new Promise<string | null>(resolve => {
      resolveRunId = resolve;
    });
    const requestAbortController = new AbortController();
    const pendingRun = {
      projectId,
      runId,
      startRequestAbortController: requestAbortController,
    };
    pendingAssessmentInterviewRun = pendingRun;
    const reportRunStarted = (runId: string) => {
      if (hasResolvedRunId) return;
      startedRunId = runId;
      hasResolvedRunId = true;
      resolveRunId(runId);
    };

    try {
      const interview = await openRouter.getActiveCourseInterview(projectId, {
        onRunStarted: reportRunStarted,
        signal: requestAbortController.signal,
      });
      if (!state.isWorkflowCurrent('assessment', requestId)) {
        return { outcome: 'abandoned' };
      }
      if (!interview?.wait) throw new Error('L’intervista non è pronta per una risposta.');
      const snapshot =
        interview.wait.signalType === COURSE_INTERVIEW_USER_ANSWER_SIGNAL
          ? await openRouter.sendCourseInterviewAnswer(
              {
                projectId,
                runId: interview.runId,
                text: trimmedInput,
                waitId: interview.wait.waitId,
              },
              { signal: requestAbortController.signal }
            )
          : await openRouter.sendCourseInterviewDecision(
              {
                decision: { details: trimmedInput, kind: 'add-details' },
                projectId,
                runId: interview.runId,
                waitId: interview.wait.waitId,
              },
              { signal: requestAbortController.signal }
            );
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
    } finally {
      if (!hasResolvedRunId) resolveRunId(null);
      if (startedRunId) assessmentRunCancellationPromises.delete(startedRunId);
      if (pendingAssessmentInterviewRun === pendingRun) pendingAssessmentInterviewRun = null;
      if (
        activeAssessmentCancellationPromise === null &&
        activeHomeChatWorkspaceOwnership?.requestToken === requestToken
      ) {
        activeHomeChatWorkspaceOwnership = null;
      }
      if (latestHomeChatRequestToken === requestToken) latestHomeChatRequestToken = null;
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
    beginHomeChatWorkspaceOpen,
    cancelAssessment,
    confirmPlanGeneration,
    resumePlanGeneration,
    settleHomeChatWorkspaceOpen,
    startHomeChat,
    startAssessment,
    startLearnAssessment,
    submitAssessment,
  };
};
