import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import { getErrorMessage } from '../../../services/core/errorMessage.ts';
import {
  type ExerciseDeliverableValidationResult,
  validateExerciseDeliverable,
} from '../../../services/exercises/deliverables.ts';
import {
  addExerciseAttachments,
  markApplicationExercisePlanningFailed,
  updateApplicationExerciseInPlan,
  withExerciseFeedback,
  withGeneratedExerciseBrief,
  withUpdatedExerciseDeliverable,
} from '../../../services/exercises/plan.ts';
import { createGenerationProgressBridge } from '../../../services/openrouter/generationProgress.ts';
import {
  LESSON_SOURCE_UNAVAILABLE_MESSAGE,
  LessonSourceUnavailableError,
} from '../../../services/openrouter/lessonGenerationClient.ts';
import { getProjectSourceFile } from '../../../services/projects/projectSource.ts';
import {
  selectIsBlocking,
  type WorkspaceWorkflowId,
} from '../../../services/workspace/workflow.ts';
import {
  type ApplicationExerciseNode,
  AppState,
  type ExerciseAttachment,
  type LearningPlan,
  type LessonNode,
} from '../../../types.ts';
import { findPathNodeById, flattenLessons } from '../../../utils/learning/pathNodes.ts';
import { loadProjectSourceFile } from './controllerContext.ts';
import type {
  AdvanceSectionOutcome,
  CompleteSectionOutcome,
  CreateLessonOutcome,
  OpenSectionOptions,
  OpenSectionOutcome,
  WorkspaceControllerContext,
} from './types.ts';

const READING_WORKFLOWS_TO_CANCEL_ON_LIBRARY_RETURN: WorkspaceWorkflowId[] = [
  'contextQuestion',
  'createLesson',
  'completeSection',
  'generateExercise',
  'evaluateExercise',
];

interface ActiveGeneration {
  projectId: string | null;
  token: number;
}

const getDeliverableValidationMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message;
  return t('La consegna non contiene testo leggibile.');
};

export const createSectionCommands = (context: WorkspaceControllerContext) => {
  const { domain, openRouter, projectLibrary, state, stopAudio } = context;

  const getNextLesson = (plan: LearningPlan | null): LessonNode | null => {
    if (!plan || !domain.activeSectionId) {
      return null;
    }

    const lessons = flattenLessons(plan.modules);
    const currentIndex = lessons.findIndex(
      currentLesson => currentLesson.id === domain.activeSectionId
    );
    if (currentIndex < 0 || currentIndex >= lessons.length - 1) {
      return null;
    }

    return lessons[currentIndex + 1] || null;
  };

  async function openExercise(exercise: ApplicationExerciseNode): Promise<void> {
    const learningPlan = domain.learningPlan;
    const needsBrief = !exercise.brief?.trim() && learningPlan !== null;
    const gaps = needsBrief
      ? openRouter.getExercisePrerequisiteGaps(learningPlan, exercise.id)
      : [];
    if (!needsBrief || !learningPlan || gaps.length > 0) {
      stopAudio(true);
      domain.setActiveSectionId(exercise.id);
      void projectLibrary.patchCurrentProject({
        activeSectionId: exercise.id,
        state: AppState.READING,
      });
      return;
    }

    const workflowState = state.getWorkflowState();
    if (
      state.isGenerationActive(projectLibrary.getCurrentProjectId()) ||
      workflowState.generateExercise.status === 'pending' ||
      workflowState.loadSection.status === 'pending' ||
      selectIsBlocking(workflowState)
    ) {
      return;
    }

    const projectId = projectLibrary.getCurrentProjectId();
    const generationToken = state.tryBeginGeneration(projectId, 'exercise');
    if (generationToken === null) {
      return;
    }

    try {
      stopAudio(true);
      domain.setActiveSectionId(exercise.id);
      void projectLibrary.patchCurrentProject({
        activeSectionId: exercise.id,
        state: AppState.READING,
      });
      state.setGeneratingSectionId(projectId, generationToken, exercise.id);
      const requestId = state.beginWorkflow('loadSection', t('Controllo le lezioni precedenti...'));
      const isGenerationRequestCurrent = () =>
        projectLibrary.getCurrentProjectId() === projectId &&
        state.isWorkflowCurrent('loadSection', requestId);

      try {
        const result = await openRouter.generateApplicationExerciseBrief({
          documentIndex: domain.documentIndex,
          exercise,
          learningPlan,
          profile: domain.userProfile,
          researchDossiersBySectionId: domain.researchDossiersBySectionId,
          onStatusUpdate: status => {
            state.setWorkflowMessage('loadSection', requestId, status);
          },
          onReasoningUpdate: reasoning => {
            state.setWorkflowReasoning('loadSection', requestId, reasoning);
          },
        });

        if (!isGenerationRequestCurrent()) {
          return;
        }

        const updatedPlan = updateApplicationExerciseInPlan(learningPlan, exercise.id, node =>
          withGeneratedExerciseBrief(node, {
            brief: result.brief,
            groundingSources: result.groundingSources,
          })
        );
        domain.setLearningPlan(updatedPlan);
        void projectLibrary.patchCurrentProject(
          {
            learningPlan: updatedPlan,
            activeSectionId: exercise.id,
            state: AppState.READING,
          },
          projectId
        );
        state.succeedWorkflow('loadSection', requestId);
      } catch (error) {
        if (!isGenerationRequestCurrent()) {
          return;
        }
        state.failWorkflow('loadSection', requestId, getErrorMessage(error));
        throw error;
      }
    } finally {
      state.finishGeneration(projectId, generationToken);
    }
  }

  async function repairApplicationExercises(): Promise<{ outcome: 'noop' | 'repaired' }> {
    const learningPlan = domain.learningPlan;
    if (!learningPlan) {
      return { outcome: 'noop' };
    }

    const workflowState = state.getWorkflowState();
    if (
      state.isGenerationActive(projectLibrary.getCurrentProjectId()) ||
      workflowState.generateExercise.status === 'pending' ||
      workflowState.loadSection.status === 'pending' ||
      selectIsBlocking(workflowState)
    ) {
      return { outcome: 'noop' };
    }

    const projectId = projectLibrary.getCurrentProjectId();
    const generationToken = state.tryBeginGeneration(projectId, 'exercise');
    if (generationToken === null) {
      return { outcome: 'noop' };
    }

    try {
      const requestId = state.beginWorkflow(
        'generateExercise',
        t('Scelgo dove inserire gli esercizi...')
      );

      try {
        const result = await openRouter.generateApplicationExercisePlacements({
          courseIntent: learningPlan.summary || learningPlan.title,
          learningPlan,
          profile: domain.userProfile,
          researchCoursePlan: domain.researchCoursePlan,
          researchDossiersBySectionId: domain.researchDossiersBySectionId,
          onStatusUpdate: status => {
            state.setWorkflowMessage('generateExercise', requestId, status);
          },
          onReasoningUpdate: reasoning => {
            state.setWorkflowReasoning('generateExercise', requestId, reasoning);
          },
        });

        if (!state.isWorkflowCurrent('generateExercise', requestId)) {
          return { outcome: 'noop' };
        }

        domain.setLearningPlan(result.plan);
        void projectLibrary.patchCurrentProject(
          {
            learningPlan: result.plan,
            activeSectionId: domain.activeSectionId,
            state: AppState.READING,
          },
          projectId
        );
        state.succeedWorkflow('generateExercise', requestId);
        return { outcome: 'repaired' };
      } catch (error) {
        if (!state.isWorkflowCurrent('generateExercise', requestId)) {
          return { outcome: 'noop' };
        }

        const attempts =
          typeof (error as { attempts?: unknown }).attempts === 'number'
            ? (error as { attempts: number }).attempts
            : 1;
        const failedPlan = markApplicationExercisePlanningFailed(
          learningPlan,
          error instanceof Error ? error : new Error(getErrorMessage(error)),
          attempts
        );
        domain.setLearningPlan(failedPlan);
        void projectLibrary.patchCurrentProject(
          {
            learningPlan: failedPlan,
            activeSectionId: domain.activeSectionId,
            state: AppState.READING,
          },
          projectId
        );
        state.failWorkflow('generateExercise', requestId, getErrorMessage(error));
        throw error;
      }
    } finally {
      state.finishGeneration(projectId, generationToken);
    }
  }

  async function updateApplicationExercise(
    exerciseId: string,
    updater: (exercise: ApplicationExerciseNode) => ApplicationExerciseNode
  ): Promise<void> {
    if (!domain.learningPlan) {
      return;
    }

    const updatedPlan = updateApplicationExerciseInPlan(domain.learningPlan, exerciseId, updater);
    domain.setLearningPlan(updatedPlan);
    await projectLibrary.patchCurrentProject({
      learningPlan: updatedPlan,
      activeSectionId: domain.activeSectionId,
      state: AppState.READING,
    });
  }

  async function attachExerciseFiles(
    exerciseId: string,
    attachments: ExerciseAttachment[]
  ): Promise<void> {
    await updateApplicationExercise(exerciseId, exercise =>
      addExerciseAttachments(exercise, attachments)
    );
  }

  async function evaluateApplicationExercise(
    exerciseId: string,
    internalText: string
  ): Promise<{
    errorMessage?: string;
    outcome: 'evaluated' | 'failed' | 'noop';
  }> {
    const currentPlan = domain.learningPlan;
    const exercise = findPathNodeById(currentPlan?.modules, exerciseId);
    if (exercise?.kind !== 'exercise' || !currentPlan) {
      return { outcome: 'noop' };
    }
    if (state.getWorkflowState().evaluateExercise.status === 'pending') {
      return { outcome: 'noop' };
    }

    const submittedExercise =
      internalText === (exercise.internalText || '')
        ? exercise
        : withUpdatedExerciseDeliverable(exercise, { internalText });
    const submittedPlan =
      submittedExercise === exercise
        ? currentPlan
        : updateApplicationExerciseInPlan(currentPlan, exercise.id, () => submittedExercise);
    if (submittedPlan !== currentPlan) {
      domain.setLearningPlan(submittedPlan);
    }

    const requestId = state.beginWorkflow('evaluateExercise', t('Valuto la consegna…'));
    const projectId = projectLibrary.getCurrentProjectId();
    let deliverable: ExerciseDeliverableValidationResult;

    try {
      deliverable = await validateExerciseDeliverable({
        attachments: submittedExercise.attachments,
        internalText: submittedExercise.internalText,
      });
    } catch (error) {
      const errorMessage = getDeliverableValidationMessage(error);
      state.failWorkflow('evaluateExercise', requestId, errorMessage);
      return { errorMessage, outcome: 'failed' };
    }

    if (deliverable.entries.length === 0) {
      const errorMessage = t('La consegna non contiene testo leggibile.');
      state.failWorkflow('evaluateExercise', requestId, errorMessage);
      return { errorMessage, outcome: 'failed' };
    }

    try {
      const feedback = await openRouter.generateApplicationExerciseFeedback({
        deliverable,
        exercise: submittedExercise,
        profile: domain.userProfile,
        onStatusUpdate: status => {
          state.setWorkflowMessage('evaluateExercise', requestId, status);
        },
        onReasoningUpdate: reasoning => {
          state.setWorkflowReasoning('evaluateExercise', requestId, reasoning);
        },
      });

      if (!state.isWorkflowCurrent('evaluateExercise', requestId)) {
        return { outcome: 'noop' };
      }

      const updatedPlan = updateApplicationExerciseInPlan(
        submittedPlan,
        submittedExercise.id,
        node => withExerciseFeedback(node, feedback)
      );
      const savedProject = await projectLibrary.patchCurrentProject(
        {
          learningPlan: updatedPlan,
          activeSectionId: submittedExercise.id,
          state: AppState.READING,
        },
        projectId
      );
      if (!savedProject) {
        throw new Error('Application exercise feedback persistence failed');
      }
      if (
        !state.isWorkflowCurrent('evaluateExercise', requestId) ||
        projectLibrary.getCurrentProjectId() !== projectId
      ) {
        return { outcome: 'noop' };
      }

      domain.setLearningPlan(updatedPlan);
      state.succeedWorkflow('evaluateExercise', requestId);
      return { outcome: 'evaluated' };
    } catch (error) {
      if (
        !state.isWorkflowCurrent('evaluateExercise', requestId) ||
        projectLibrary.getCurrentProjectId() !== projectId
      ) {
        return { outcome: 'noop' };
      }
      console.error('Application exercise feedback failed', error);
      const errorMessage = t('Non sono riuscito a valutare la consegna. Riprova.');
      state.failWorkflow('evaluateExercise', requestId, errorMessage);
      return { errorMessage, outcome: 'failed' };
    }
  }

  async function openSectionWithGenerationGate(
    section: LessonNode,
    options: OpenSectionOptions = {},
    activeGeneration?: ActiveGeneration
  ): Promise<OpenSectionOutcome> {
    const forceRegenerate = options.forceRegenerate === true;

    if (!domain.learningPlan) {
      return 'ignored-busy';
    }

    // Ready lessons remain navigable, but every new lesson or sublesson generation
    // shares this gate so workflow invalidation and command recreation cannot open a race.
    const workflowState = state.getWorkflowState();
    const currentProjectId = projectLibrary.getCurrentProjectId();
    if (
      state.isLessonGenerationActive(currentProjectId) &&
      state.getGeneratingSectionId(currentProjectId) === section.id &&
      state.reattachLessonGeneration(currentProjectId, section.id)
    ) {
      stopAudio(true);
      domain.setActiveSectionId(section.id);
      void projectLibrary.patchCurrentProject({
        activeSectionId: section.id,
        state: AppState.READING,
      });
      return 'reopened-generating';
    }

    // Sections with content navigate immediately — even if another generation
    // is running. The user can freely switch between ready lessons.
    if (!forceRegenerate && section.content?.length) {
      stopAudio(true);
      domain.setActiveSectionId(section.id);
      void projectLibrary.patchCurrentProject({
        activeSectionId: section.id,
        state: AppState.READING,
      });
      return 'reused-cached';
    }

    const isLoadingSection = workflowState.loadSection.status === 'pending';
    const isCreatingLesson = workflowState.createLesson.status === 'pending';
    const isGeneratingExercises = workflowState.generateExercise.status === 'pending';
    if (
      isLoadingSection ||
      isCreatingLesson ||
      isGeneratingExercises ||
      (!options.allowWhileBlocking && selectIsBlocking(workflowState))
    ) {
      return 'ignored-busy';
    }

    const ownsGenerationGate = activeGeneration === undefined;
    if (!activeGeneration) {
      const projectId = projectLibrary.getCurrentProjectId();
      const token = state.tryBeginGeneration(projectId, 'lesson');
      if (token === null) {
        return 'ignored-busy';
      }
      activeGeneration = { projectId, token };
    }

    state.setGeneratingSectionId(activeGeneration.projectId, activeGeneration.token, section.id);
    const beginLessonLoadWorkflow = () =>
      state.beginWorkflow(
        'loadSection',
        t(forceRegenerate ? 'Rigenerazione lezione...' : 'Analisi contenuti...')
      );
    let requestId = beginLessonLoadWorkflow();
    state.setLessonGenerationReattachHandler(
      activeGeneration.projectId,
      activeGeneration.token,
      () => {
        if (
          state.isWorkflowCurrent('loadSection', requestId) &&
          state.getWorkflowState().loadSection.status === 'pending'
        ) {
          return;
        }
        requestId = beginLessonLoadWorkflow();
      }
    );
    stopAudio(true);
    domain.setActiveSectionId(section.id);

    void projectLibrary.patchCurrentProject(
      {
        activeSectionId: section.id,
        state: AppState.READING,
      },
      activeGeneration.projectId
    );

    const projectId = activeGeneration.projectId;
    if (!projectId) {
      if (ownsGenerationGate) state.finishGeneration(projectId, activeGeneration.token);
      return 'ignored-busy';
    }
    const isGenerationCurrent = () => state.isGenerationCurrent(projectId, activeGeneration.token);
    const isGenerationViewCurrent = () =>
      projectLibrary.getCurrentProjectId() === projectId &&
      isGenerationCurrent() &&
      state.isWorkflowCurrent('loadSection', requestId);

    const progressBridge = createGenerationProgressBridge({
      getProgress: () => state.getWorkflowState().loadSection.progress,
      setProgress: progress => state.setWorkflowProgress('loadSection', requestId, progress),
    });
    const progressObserver = openRouter.createGenerationProgressObserver({
      language: domain.userProfile?.language || 'Italiano',
      onUpdate: progressBridge.updateFromObserver,
      operation: 'lesson',
      subject: section.title,
    });
    state.setWorkflowMessage(
      'loadSection',
      requestId,
      t(forceRegenerate ? 'Rigenerazione lezione...' : 'Analisi contenuti...')
    );
    try {
      const result = await openRouter.generateDurableLesson({
        forceRegenerate,
        onProgressStage: progressObserver.setStage,
        onWorkflowSnapshot: snapshot => {
          if (!isGenerationViewCurrent()) return;
          progressBridge.updateFromWorkflow(snapshot);
        },
        projectId,
        sectionId: section.id,
      });
      if (!isGenerationCurrent()) return 'ignored-busy';

      if (
        typeof result.projectRevision === 'number' &&
        !(await projectLibrary.applyPersistedProjectRevision({
          projectId,
          revision: result.projectRevision,
        }))
      ) {
        if (!isGenerationCurrent()) return 'ignored-busy';
        await progressObserver.finish();
        progressObserver.complete();
        if (isGenerationViewCurrent()) {
          state.succeedWorkflow('loadSection', requestId);
        }
        return 'loaded';
      }
      if (!isGenerationCurrent()) return 'ignored-busy';

      if (projectLibrary.getCurrentProjectId() === projectId) {
        domain.updateSection(section.id, currentSection => ({
          ...currentSection,
          content: result.content,
          contentBlocks: result.contentBlocks,
          generationWarnings: result.warnings,
          generatedVisuals: result.generatedVisuals,
          imageRefs: result.imageRefs,
          learningAids: result.learningAids,
          quiz: result.quiz,
          visualPlanningDecision: result.visualPlanningDecision,
        }));
        if (result.researchDossier) domain.setResearchLessonDossier(result.researchDossier);
        if (result.documentAssets !== undefined) domain.setDocumentAssets(result.documentAssets);
      }
      await progressObserver.finish();
      progressObserver.complete();
      if (isGenerationViewCurrent()) {
        state.succeedWorkflow('loadSection', requestId);
      }
      return 'loaded';
    } catch (error) {
      if (!isGenerationCurrent()) return 'ignored-busy';
      if (error instanceof LessonSourceUnavailableError) {
        state.setProjectMissingSource(projectId, true);
      }
      if (!isGenerationViewCurrent()) return 'ignored-busy';
      state.failWorkflow(
        'loadSection',
        requestId,
        error instanceof LessonSourceUnavailableError
          ? t(LESSON_SOURCE_UNAVAILABLE_MESSAGE)
          : getErrorMessage(error)
      );
      throw error;
    } finally {
      progressObserver.dispose();
      if (ownsGenerationGate) state.finishGeneration(projectId, activeGeneration.token);
    }
  }

  async function openSection(
    section: LessonNode,
    options: OpenSectionOptions = {}
  ): Promise<OpenSectionOutcome> {
    return openSectionWithGenerationGate(section, options);
  }

  async function regenerateActiveSection(): Promise<OpenSectionOutcome> {
    if (!domain.activeSection || !domain.learningPlan) {
      return 'ignored-busy';
    }
    return openSection(domain.activeSection, {
      forceRegenerate: true,
    });
  }

  async function askContextQuestion(args: {
    contextAfter?: string;
    contextBefore?: string;
    question: string;
    selectedText: string;
  }): Promise<{ answer?: string; errorMessage?: string }> {
    const canAnswerFromLesson = Boolean(
      domain.activeSection?.content ||
        domain.sectionContent ||
        args.contextBefore ||
        args.contextAfter
    );
    const requestId = state.beginWorkflow('contextQuestion', t('Analisi contesto...'));
    const sourceFile = canAnswerFromLesson
      ? getProjectSourceFile(domain.source)
      : await loadProjectSourceFile(context, () =>
          state.isWorkflowCurrent('contextQuestion', requestId)
        );

    if (!state.isWorkflowCurrent('contextQuestion', requestId)) {
      return {};
    }

    if (!sourceFile && !canAnswerFromLesson) {
      const errorMessage =
        'Questo progetto non ha una fonte collegata e la lezione corrente non contiene abbastanza contesto per rispondere.';
      state.failWorkflow('contextQuestion', requestId, errorMessage);
      return {
        errorMessage,
      };
    }

    try {
      const answer = await openRouter.askContextualQuestion({
        file: sourceFile,
        selection: args.selectedText,
        question: args.question,
        lessonTitle: domain.activeSection?.title,
        lessonDescription: domain.activeSection?.description,
        lessonContent: domain.activeSection?.content || domain.sectionContent,
        contextBefore: args.contextBefore,
        contextAfter: args.contextAfter,
      });
      state.succeedWorkflow('contextQuestion', requestId);
      return { answer };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      state.failWorkflow('contextQuestion', requestId, errorMessage);
      return { errorMessage };
    }
  }

  async function createLessonFromSelection(args: {
    annotationNote?: string;
    contextAfter?: string;
    contextBefore?: string;
    instructions: string;
    selectedText: string;
  }): Promise<{ errorMessage?: string; outcome: CreateLessonOutcome }> {
    if (!domain.learningPlan || !domain.activeSectionId) {
      return {
        outcome: 'failed',
        errorMessage:
          'La lezione attiva non e disponibile. Riprova dopo aver aperto una sezione del percorso.',
      };
    }

    const parentNode = findPathNodeById(domain.learningPlan.modules, domain.activeSectionId);
    const parentSection = parentNode?.kind === 'lesson' ? parentNode : null;
    if (!parentSection) {
      return {
        outcome: 'failed',
        errorMessage:
          'Non riesco a trovare la lezione corrente nel piano. Ricarica il progetto e riprova.',
      };
    }

    const workflowState = state.getWorkflowState();
    if (
      workflowState.createLesson.status === 'pending' ||
      workflowState.generateExercise.status === 'pending' ||
      workflowState.loadSection.status === 'pending'
    ) {
      return {
        outcome: 'failed',
        errorMessage: t('Rigenerazione in corso'),
      };
    }
    const projectId = projectLibrary.getCurrentProjectId();
    if (!projectId) {
      return {
        outcome: 'failed',
        errorMessage: 'Il progetto corrente non è disponibile. Ricaricalo e riprova.',
      };
    }
    const generationToken = state.tryBeginGeneration(projectId, 'lesson');
    if (generationToken === null) {
      return {
        outcome: 'failed',
        errorMessage: t('Rigenerazione in corso'),
      };
    }
    const activeGeneration = { projectId, token: generationToken };

    const beginSublessonWorkflow = () =>
      state.beginWorkflow('createLesson', t('Creazione approfondimento...'));
    let requestId = beginSublessonWorkflow();
    state.setLessonGenerationReattachHandler(projectId, generationToken, () => {
      if (
        state.isWorkflowCurrent('createLesson', requestId) &&
        state.getWorkflowState().createLesson.status === 'pending'
      ) {
        return;
      }
      requestId = beginSublessonWorkflow();
    });
    const isGenerationCurrent = () => state.isGenerationCurrent(projectId, generationToken);
    const isGenerationViewCurrent = () =>
      projectLibrary.getCurrentProjectId() === projectId &&
      isGenerationCurrent() &&
      state.isWorkflowCurrent('createLesson', requestId);
    const progressBridge = createGenerationProgressBridge({
      getProgress: () => state.getWorkflowState().createLesson.progress,
      setProgress: progress => state.setWorkflowProgress('createLesson', requestId, progress),
    });
    const progressObserver = openRouter.createGenerationProgressObserver({
      language: domain.userProfile?.language || 'Italiano',
      onUpdate: progressBridge.updateFromObserver,
      operation: 'lesson',
      subject: parentSection.title,
    });

    try {
      const result = await openRouter.generateDurableSublesson({
        annotationNote: args.annotationNote,
        contextAfter: args.contextAfter,
        contextBefore: args.contextBefore,
        instructions: args.instructions,
        onProgressStage: progressObserver.setStage,
        onWorkflowSnapshot: snapshot => {
          if (!isGenerationCurrent()) return;
          state.setGeneratingSectionId(projectId, generationToken, snapshot.sectionId);
          if (isGenerationViewCurrent()) progressBridge.updateFromWorkflow(snapshot);
        },
        parentSectionId: parentSection.id,
        projectId,
        selectedText: args.selectedText,
      });

      if (!isGenerationCurrent()) {
        return { outcome: 'ignored-busy' };
      }
      if (typeof result.projectRevision !== 'number') {
        throw new TypeError(
          'La nuova lezione è stata generata, ma non è stato possibile caricarla.'
        );
      }

      await projectLibrary.applyPersistedProjectRevision({
        projectId,
        revision: result.projectRevision,
      });
      if (!isGenerationCurrent()) {
        return { outcome: 'ignored-busy' };
      }
      const createdSection = domain.learningPlan
        ? findPathNodeById(domain.learningPlan.modules, result.sectionId)
        : null;
      if (createdSection?.kind !== 'lesson') {
        throw new Error('La nuova lezione è stata generata, ma non è stato possibile caricarla.');
      }
      if (
        projectLibrary.getCurrentProjectId() === projectId &&
        domain.activeSectionId !== result.sectionId
      ) {
        stopAudio(true);
        domain.setActiveSectionId(result.sectionId);
        void projectLibrary.patchCurrentProject(
          {
            activeSectionId: result.sectionId,
            state: AppState.READING,
          },
          projectId
        );
      }
      await progressObserver.finish();
      progressObserver.complete();
      if (isGenerationViewCurrent()) state.succeedWorkflow('createLesson', requestId);
      return { outcome: 'created' };
    } catch (error) {
      if (!isGenerationCurrent()) {
        return { outcome: 'ignored-busy' };
      }
      if (error instanceof LessonSourceUnavailableError) {
        state.setProjectMissingSource(projectId, true);
      }
      if (!isGenerationViewCurrent()) return { outcome: 'ignored-busy' };
      const errorMessage =
        error instanceof LessonSourceUnavailableError
          ? t(LESSON_SOURCE_UNAVAILABLE_MESSAGE)
          : getErrorMessage(error);
      state.failWorkflow('createLesson', requestId, errorMessage);
      return {
        outcome:
          error instanceof LessonSourceUnavailableError ? 'blocked-missing-source' : 'failed',
        errorMessage,
      };
    } finally {
      progressObserver.dispose();
      state.finishGeneration(activeGeneration.projectId, activeGeneration.token);
    }
  }

  async function completeActiveSection(): Promise<CompleteSectionOutcome> {
    if (!domain.learningPlan || !domain.activeSectionId) {
      return 'noop';
    }

    const requestId = state.beginWorkflow('completeSection', t('Salvataggio progresso...'));

    try {
      const updatedModules = domain.learningPlan.modules.map(module => ({
        ...module,
        children: module.children.map(child =>
          child.kind === 'lesson' && child.id === domain.activeSectionId
            ? { ...child, isCompleted: true }
            : child
        ),
      }));
      const updatedPlan = { ...domain.learningPlan, modules: updatedModules };
      domain.setLearningPlan(updatedPlan);

      // Optimistic: fire patch in background, don't await
      void projectLibrary.patchCurrentProject({
        learningPlan: updatedPlan,
        activeSectionId: domain.activeSectionId,
        state: AppState.READING,
      });
      const nextLesson = getNextLesson(updatedPlan);
      if (nextLesson) {
        state.succeedWorkflow('completeSection', requestId);
        await openSection(nextLesson, { allowWhileBlocking: true });
        return 'opened-next';
      }

      state.succeedWorkflow('completeSection', requestId);
      return 'journey-complete';
    } catch (error) {
      state.failWorkflow('completeSection', requestId, getErrorMessage(error));
      throw error;
    }
  }

  async function advanceActiveSection(): Promise<AdvanceSectionOutcome> {
    if (!domain.learningPlan || !domain.activeSectionId) {
      return 'noop';
    }

    const nextLesson = getNextLesson(domain.learningPlan);
    if (!nextLesson) {
      return 'journey-complete';
    }

    await openSection(nextLesson, { allowWhileBlocking: true });
    return 'opened-next';
  }

  async function goToLibrary(): Promise<void> {
    stopAudio(true);
    state.invalidateWorkflows(READING_WORKFLOWS_TO_CANCEL_ON_LIBRARY_RETURN);
    state.resetSessionState();
    state.setScreenState(AppState.LIBRARY);
  }

  return {
    advanceActiveSection,
    askContextQuestion,
    completeActiveSection,
    createLessonFromSelection,
    goToLibrary,
    attachExerciseFiles,
    evaluateApplicationExercise,
    openExercise,
    openSection,
    repairApplicationExercises,
    regenerateActiveSection,
    updateApplicationExercise,
  };
};
