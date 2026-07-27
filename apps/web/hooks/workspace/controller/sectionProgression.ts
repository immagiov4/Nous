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
import { getProjectSourceFile } from '../../../services/projects/projectSource.ts';
import { resolveLearnSectionContext } from '../../../services/workspace/controller/learnMode.ts';
import {
  selectIsBlocking,
  type WorkspaceWorkflowId,
} from '../../../services/workspace/workflow.ts';
import {
  type ApplicationExerciseNode,
  AppState,
  type ExerciseAttachment,
  type LearningPlan,
  type LearningSection,
  type LessonNode,
} from '../../../types.ts';
import { resolveLessonGenerationState } from '../../../utils/learning/lessonGenerationState.ts';
import { findPathNodeById, flattenLessons } from '../../../utils/learning/pathNodes.ts';
import { insertSectionAfterSubtree } from '../../../utils/learning/sectionTree.ts';
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
      state.isGenerationActive(projectLibrary.currentProjectId) ||
      workflowState.generateExercise.status === 'pending' ||
      workflowState.loadSection.status === 'pending' ||
      selectIsBlocking(workflowState)
    ) {
      return;
    }

    const projectId = projectLibrary.currentProjectId;
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
        projectLibrary.currentProjectId === projectId &&
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
        void projectLibrary.patchCurrentProject({
          learningPlan: updatedPlan,
          activeSectionId: exercise.id,
          state: AppState.READING,
        });
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
      state.isGenerationActive(projectLibrary.currentProjectId) ||
      workflowState.generateExercise.status === 'pending' ||
      workflowState.loadSection.status === 'pending' ||
      selectIsBlocking(workflowState)
    ) {
      return { outcome: 'noop' };
    }

    const projectId = projectLibrary.currentProjectId;
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
        void projectLibrary.patchCurrentProject({
          learningPlan: result.plan,
          activeSectionId: domain.activeSectionId,
          state: AppState.READING,
        });
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
        void projectLibrary.patchCurrentProject({
          learningPlan: failedPlan,
          activeSectionId: domain.activeSectionId,
          state: AppState.READING,
        });
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
    let deliverable: ExerciseDeliverableValidationResult;

    try {
      deliverable = await validateExerciseDeliverable({
        attachments: submittedExercise.attachments,
        internalText: submittedExercise.internalText,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error && error.message.trim()
          ? error.message
          : t('La consegna non contiene testo leggibile.');
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
      const savedProject = await projectLibrary.patchCurrentProject({
        learningPlan: updatedPlan,
        activeSectionId: submittedExercise.id,
        state: AppState.READING,
      });
      if (!savedProject) {
        throw new Error('Application exercise feedback persistence failed');
      }

      domain.setLearningPlan(updatedPlan);
      state.succeedWorkflow('evaluateExercise', requestId);
      return { outcome: 'evaluated' };
    } catch (error) {
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

    // Ready lessons remain navigable, but every new lesson or sublesson generation
    // shares this gate so workflow invalidation and command recreation cannot open a race.
    const workflowState = state.getWorkflowState();
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
      const projectId = projectLibrary.currentProjectId;
      const token = state.tryBeginGeneration(projectId, 'lesson');
      if (token === null) {
        return 'ignored-busy';
      }
      activeGeneration = { projectId, token };
    }

    state.setGeneratingSectionId(activeGeneration.projectId, activeGeneration.token, section.id);
    const requestId = state.beginWorkflow(
      'loadSection',
      t(forceRegenerate ? 'Rigenerazione lezione...' : 'Analisi contenuti...')
    );
    const isGenerationRequestCurrent = () =>
      projectLibrary.currentProjectId === activeGeneration.projectId &&
      state.isWorkflowCurrent('loadSection', requestId);

    stopAudio(true);
    domain.setActiveSectionId(section.id);

    void projectLibrary.patchCurrentProject({
      activeSectionId: section.id,
      state: AppState.READING,
    });

    const projectId = activeGeneration.projectId;
    if (!projectId) {
      if (ownsGenerationGate) state.finishGeneration(projectId, activeGeneration.token);
      return 'ignored-busy';
    }

    const progressObserver = openRouter.createGenerationProgressObserver({
      language: domain.userProfile?.language || 'Italiano',
      onUpdate: progress => state.setWorkflowProgress('loadSection', requestId, progress),
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
        projectId,
        sectionId: section.id,
      });
      if (!isGenerationRequestCurrent()) return 'ignored-busy';

      if (
        typeof result.projectRevision === 'number' &&
        !(await projectLibrary.applyPersistedProjectRevision({
          projectId,
          revision: result.projectRevision,
        }))
      ) {
        if (!isGenerationRequestCurrent()) return 'ignored-busy';
        await progressObserver.finish();
        progressObserver.complete();
        state.succeedWorkflow('loadSection', requestId);
        return 'loaded';
      }
      if (!isGenerationRequestCurrent()) return 'ignored-busy';

      domain.updateSection(section.id, currentSection => ({
        ...currentSection,
        content: result.content,
        contentBlocks: result.contentBlocks,
        generatedVisuals: result.generatedVisuals,
        imageRefs: result.imageRefs,
        learningAids: result.learningAids,
        quiz: result.quiz,
        visualPlanningDecision: result.visualPlanningDecision,
      }));
      if (result.researchDossier) domain.setResearchLessonDossier(result.researchDossier);
      if (result.documentAssets !== undefined) domain.setDocumentAssets(result.documentAssets);
      await progressObserver.finish();
      progressObserver.complete();
      state.succeedWorkflow('loadSection', requestId);
      return 'loaded';
    } catch (error) {
      if (!isGenerationRequestCurrent()) return 'ignored-busy';
      state.failWorkflow('loadSection', requestId, getErrorMessage(error));
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
    parentContent?: string;
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
    const projectId = projectLibrary.currentProjectId;
    const generationToken = state.tryBeginGeneration(projectId, 'lesson');
    if (generationToken === null) {
      return {
        outcome: 'failed',
        errorMessage: t('Rigenerazione in corso'),
      };
    }
    const activeGeneration = { projectId, token: generationToken };

    const requestId = state.beginWorkflow('createLesson', t('Creazione approfondimento...'));
    const previousPlan = domain.learningPlan;
    const previousDocumentIndex = domain.documentIndex;
    const previousActiveSectionId = domain.activeSectionId;
    const rollbackCreatedLesson = async () => {
      domain.setLearningPlan(previousPlan);
      domain.setDocumentIndex(previousDocumentIndex);
      domain.setActiveSectionId(previousActiveSectionId);
      await projectLibrary.saveCurrentProject({
        activeSectionId: previousActiveSectionId,
        documentIndex: previousDocumentIndex,
        learningPlan: previousPlan,
        state: AppState.READING,
      });
    };

    try {
      const sourceFile = await loadProjectSourceFile(context, () =>
        state.isWorkflowCurrent('createLesson', requestId)
      );
      if (!state.isWorkflowCurrent('createLesson', requestId)) {
        return { outcome: 'ignored-busy' };
      }
      const canCreateWithoutFile =
        resolveLessonGenerationState({
          file: null,
          hasResearchContext: domain.researchCoursePlan !== null,
          hasToolBackedSource: domain.source?.kind === 'archive',
          isLearnMode: domain.isLearnMode,
          learningPlan: domain.learningPlan,
          syllabus: domain.syllabus,
        }) !== 'blocked-missing-source';
      const metadataContext = {
        annotationNote: args.annotationNote,
        contextAfter: args.contextAfter,
        contextBefore: args.contextBefore,
        parentContent: args.parentContent,
        parentSection,
        selection: args.selectedText,
        userInstructions: args.instructions,
      };
      const archiveSource = domain.source?.kind === 'archive' ? domain.source : null;
      if (archiveSource && !projectId) {
        throw new Error(
          'Il progetto corrente non è disponibile per consultare la sorgente archivio.'
        );
      }

      let newSection: LearningSection | null = null;
      if (archiveSource && projectId) {
        newSection = await openRouter.createArchiveSubChapterMetadata({
          ...metadataContext,
          projectId,
          source: archiveSource,
        });
      } else if (sourceFile) {
        newSection = await openRouter.createSubChapterMetadata(sourceFile, metadataContext);
      } else if (canCreateWithoutFile) {
        newSection = await openRouter.createLearnSubChapterMetadata({
          ...metadataContext,
          moduleTitle: resolveLearnSectionContext(
            parentSection,
            domain.learningPlan,
            domain.syllabus
          ).moduleTitle,
          profile: domain.userProfile,
        });
      }

      if (!state.isWorkflowCurrent('createLesson', requestId)) {
        return { outcome: 'ignored-busy' };
      }

      if (!newSection) {
        state.succeedWorkflow('createLesson', requestId);
        return { outcome: 'blocked-missing-source' };
      }

      const newLesson: LessonNode = { kind: 'lesson', ...newSection };
      const updatedModules = domain.learningPlan.modules.map(module => {
        const containsAnchor = module.children.some(
          child => child.kind === 'lesson' && child.id === parentSection.id
        );
        if (!containsAnchor) {
          return module;
        }
        const lessons = module.children.filter(
          (child): child is LessonNode => child.kind === 'lesson'
        );
        const exercises = module.children.filter(child => child.kind === 'exercise');
        const reorderedLessons = insertSectionAfterSubtree(lessons, parentSection.id, newLesson);
        return { ...module, children: [...reorderedLessons, ...exercises] };
      });
      let updatedPlan = { ...domain.learningPlan, modules: updatedModules };
      let nextDocumentIndex = domain.documentIndex;

      if (sourceFile) {
        state.setWorkflowMessage(
          'createLesson',
          requestId,
          t('Associazione chunk alla nuova lezione...')
        );
        const prepared = await context.preparePdfLessonPlan(
          sourceFile,
          updatedPlan,
          domain.documentIndex,
          [newSection.id]
        );
        if (!state.isWorkflowCurrent('createLesson', requestId)) {
          return { outcome: 'ignored-busy' };
        }
        updatedPlan = prepared.learningPlan;
        // Se il mapping PDF fallisce/torna null, manteniamo l'indice esistente:
        // un indice obsoleto è sempre meglio di nessun indice (i chunk delle altre
        // sezioni continuano a funzionare).
        nextDocumentIndex = prepared.documentIndex ?? domain.documentIndex;
      }

      domain.setLearningPlan(updatedPlan);
      domain.setDocumentIndex(nextDocumentIndex);
      const didPersistNewLesson = await projectLibrary.patchCurrentProject({
        learningPlan: updatedPlan,
        // Includiamo documentIndex solo se è effettivamente cambiato e non-null,
        // così l'autosave o un altro patch non lo azzerano per sbaglio.
        ...(nextDocumentIndex != null && nextDocumentIndex !== domain.documentIndex
          ? { documentIndex: nextDocumentIndex }
          : {}),
        activeSectionId: domain.activeSectionId,
        state: AppState.READING,
      });
      const isCurrentProject = projectLibrary.getCurrentProjectId() === projectId;
      if (!state.isWorkflowCurrent('createLesson', requestId) || !isCurrentProject) {
        if (isCurrentProject) {
          await rollbackCreatedLesson();
        }
        return { outcome: 'ignored-busy' };
      }
      if (projectId && !didPersistNewLesson) {
        await rollbackCreatedLesson();
        throw new Error('La nuova lezione non è stata salvata. Riprova.');
      }

      const mappedNewLesson =
        flattenLessons(updatedPlan.modules).find(
          currentLesson => currentLesson.id === newLesson.id
        ) ?? newLesson;
      state.succeedWorkflow('createLesson', requestId);
      try {
        const openOutcome = await openSectionWithGenerationGate(
          mappedNewLesson,
          { allowWhileBlocking: true },
          activeGeneration
        );
        if (openOutcome === 'blocked-missing-source') {
          await rollbackCreatedLesson();
          return { outcome: 'blocked-missing-source' };
        }
        if (openOutcome === 'ignored-busy') {
          throw new Error(t('Rigenerazione in corso'));
        }
      } catch (error) {
        // Rollback save is critical for consistency — await is intentional.
        await rollbackCreatedLesson();
        throw error;
      }

      // Fire-and-forget: update active section after lesson open
      void projectLibrary.patchCurrentProject({
        activeSectionId: mappedNewLesson.id,
        documentIndex: nextDocumentIndex,
      });
      return { outcome: 'created' };
    } catch (error) {
      if (!state.isWorkflowCurrent('createLesson', requestId)) {
        return { outcome: 'ignored-busy' };
      }
      const errorMessage = getErrorMessage(error);
      state.failWorkflow('createLesson', requestId, errorMessage);
      return { outcome: 'failed', errorMessage };
    } finally {
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
