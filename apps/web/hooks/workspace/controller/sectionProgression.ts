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
import type { GenerationStatusReporter } from '../../../services/openrouter/generationProgress.ts';
import { getCourseSourceDescriptors } from '../../../services/projects/courseSources.ts';
import { getProjectSourceFile } from '../../../services/projects/projectSource.ts';
import { SourceArchiveClient } from '../../../services/projects/sourceArchive.ts';
import { mergeDocumentAssetsForPlan } from '../../../services/workspace/controller/documentAssets.ts';
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
  const sourceArchiveClient = new SourceArchiveClient();

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
    const currentPlan = options.currentPlan ?? domain.learningPlan;
    const currentDocumentIndex =
      options.currentDocumentIndex === undefined
        ? domain.documentIndex
        : options.currentDocumentIndex;
    const currentDocumentAssets =
      options.currentDocumentAssets === undefined
        ? domain.documentAssets
        : options.currentDocumentAssets;
    const isLearnMode =
      options.isLearnMode === undefined ? domain.isLearnMode : options.isLearnMode;
    const currentSyllabus =
      options.currentSyllabus === undefined ? domain.syllabus : options.currentSyllabus;
    const currentUserProfile =
      options.currentUserProfile === undefined ? domain.userProfile : options.currentUserProfile;
    const currentResearchCoursePlan =
      options.currentResearchCoursePlan === undefined
        ? domain.researchCoursePlan
        : options.currentResearchCoursePlan;
    const currentResearchDossiersBySectionId =
      options.currentResearchDossiersBySectionId === undefined
        ? domain.researchDossiersBySectionId
        : options.currentResearchDossiersBySectionId;
    const forceRegenerate = options.forceRegenerate === true;

    if (!currentPlan) {
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

    let sourceFile: Awaited<ReturnType<typeof loadProjectSourceFile>>;
    try {
      sourceFile =
        options.currentSourceFile === undefined
          ? await loadProjectSourceFile(context, isGenerationRequestCurrent)
          : options.currentSourceFile;
    } catch (error) {
      if (!isGenerationRequestCurrent()) {
        if (ownsGenerationGate) {
          state.finishGeneration(activeGeneration.projectId, activeGeneration.token);
        }
        return 'ignored-busy';
      }
      state.failWorkflow('loadSection', requestId, getErrorMessage(error));
      if (ownsGenerationGate) {
        state.finishGeneration(activeGeneration.projectId, activeGeneration.token);
      }
      throw error;
    }

    if (!isGenerationRequestCurrent()) {
      if (ownsGenerationGate) {
        state.finishGeneration(activeGeneration.projectId, activeGeneration.token);
      }
      return 'ignored-busy';
    }

    const lessonGenerationState = resolveLessonGenerationState({
      file: sourceFile,
      hasToolBackedSource: domain.source?.kind === 'archive',
      isLearnMode,
      learningPlan: currentPlan,
      syllabus: currentSyllabus,
    });

    if (lessonGenerationState === 'blocked-missing-source') {
      state.invalidateWorkflows(['loadSection']);
      if (ownsGenerationGate) {
        state.finishGeneration(activeGeneration.projectId, activeGeneration.token);
      }
      return 'blocked-missing-source';
    }
    const progressObserver = openRouter.createGenerationProgressObserver({
      language: currentUserProfile?.language || 'Italiano',
      onUpdate: progress => state.setWorkflowProgress('loadSection', requestId, progress),
      operation: 'lesson',
      subject: section.title,
    });
    const reportStatus: GenerationStatusReporter = (status, stage) => {
      state.setWorkflowMessage('loadSection', requestId, status);
      if (stage) {
        progressObserver.setStage(stage);
      }
      progressObserver.updateStatus(status);
    };

    const completedTitles = flattenLessons(currentPlan.modules)
      .filter(currentLesson => currentLesson.isCompleted)
      .map(currentLesson => currentLesson.title)
      .join(', ');

    try {
      if (lessonGenerationState === 'learn-mode') {
        if (!isLearnMode) {
          domain.setIsLearnMode(true);
        }

        const { anchorLessonContextPrompt, moduleTitle } = resolveLearnSectionContext(
          section,
          currentPlan,
          currentSyllabus
        );

        let nextResearchDossiersBySectionId = currentResearchDossiersBySectionId;
        const cachedResearchDossier = currentResearchDossiersBySectionId[section.id];
        const researchDossier =
          cachedResearchDossier ||
          (await openRouter.generateResearchLessonDossier({
            lesson: section,
            moduleTitle,
            profile: currentUserProfile,
            researchCoursePlan: currentResearchCoursePlan,
            onStatusUpdate: reportStatus,
            onReasoningUpdate: progressObserver.push,
          }));

        if (!isGenerationRequestCurrent()) {
          return 'ignored-busy';
        }

        if (!cachedResearchDossier) {
          nextResearchDossiersBySectionId = {
            ...currentResearchDossiersBySectionId,
            [section.id]: researchDossier,
          };
          domain.setResearchLessonDossier(researchDossier);
        }

        const learnLessonResult = await openRouter.generateResearchLessonContent({
          lessonTitle: section.title,
          moduleTitle,
          contextPrompt: section.contextPrompt || anchorLessonContextPrompt,
          profile: currentUserProfile,
          syllabus: currentSyllabus,
          researchDossier,
          generationNotes: currentPlan.generationNotes,
          onStatusUpdate: reportStatus,
          onReasoningUpdate: progressObserver.push,
        });

        if (!isGenerationRequestCurrent() || !learnLessonResult) {
          return 'ignored-busy';
        }

        const {
          content,
          contentBlocks,
          generatedVisuals,
          learningAids,
          quiz,
          visualPlanningDecision,
        } = learnLessonResult;

        domain.updateSection(section.id, section => ({
          ...section,
          content,
          contentBlocks,
          quiz,
          imageRefs: [],
          generatedVisuals,
          learningAids,
          visualPlanningDecision,
        }));
        const mergedDocumentAssets = mergeDocumentAssetsForPlan(
          domain.learningPlan ?? currentPlan,
          currentDocumentAssets,
          null
        );
        domain.setDocumentAssets(mergedDocumentAssets);
        const didPersistLesson = await projectLibrary.patchSectionLessonContent(
          section.id,
          {
            content,
            contentBlocks,
            generatedVisuals,
            imageRefs: [],
            learningAids,
            quiz,
            visualPlanningDecision,
          },
          {
            documentAssets: mergedDocumentAssets,
            researchDossiersBySectionId: nextResearchDossiersBySectionId,
            activeSectionId: section.id,
            state: AppState.READING,
            isLearnMode: true,
          }
        );
        if (!didPersistLesson) {
          throw new Error(t('La lezione rigenerata non e stata salvata. Riprova.'));
        }
      } else {
        const archiveSource = domain.source?.kind === 'archive' ? domain.source : null;
        if (!sourceFile && !archiveSource) {
          throw new Error('Missing source file for section generation');
        }
        const generationSourceFile = sourceFile || archiveSource?.file;
        if (!generationSourceFile) {
          throw new Error('Missing source file for section generation');
        }

        const cachedResearchDossier = currentResearchDossiersBySectionId[section.id];
        let resolvedSourceArchiveContext: string | undefined;
        if (archiveSource) {
          if (
            !projectLibrary.currentProjectId ||
            !archiveSource.ref ||
            !section.sourceArchiveSelectors?.length
          ) {
            throw new Error('La lezione non contiene riferimenti validi alla sorgente archivio.');
          }
          const resolvedFiles = await sourceArchiveClient.resolveSelectors(
            projectLibrary.currentProjectId,
            { sourceHash: archiveSource.ref.hash, sourceId: archiveSource.ref.id },
            section.sourceArchiveSelectors
          );
          if (!isGenerationRequestCurrent()) {
            return 'ignored-busy';
          }
          resolvedSourceArchiveContext = resolvedFiles
            .map(file => `FILE ${file.path}\n${file.text}`)
            .join('\n\n---\n\n');
        }
        const originalSourceContext = resolvedSourceArchiveContext
          ? { content: resolvedSourceArchiveContext, sources: [] }
          : await openRouter.buildPrerequisiteSourceContext({
              documentIndex: currentDocumentIndex,
              file: generationSourceFile,
              primaryChunkIds: section.primaryChunkIds,
              sourceDescriptors: getCourseSourceDescriptors(domain.source),
              sourceReferences: section.sourceReferences,
            });
        if (!isGenerationRequestCurrent()) {
          return 'ignored-busy';
        }
        const coverageDecision =
          section.type === 'prerequisite' && !cachedResearchDossier
            ? await openRouter.selectPrerequisiteSourceCoverage({
                description: section.description,
                onReasoningUpdate: progressObserver.push,
                onStatusUpdate: reportStatus,
                sourceContext: originalSourceContext.content,
                title: section.title,
              })
            : null;
        if (!isGenerationRequestCurrent()) {
          return 'ignored-busy';
        }
        let nextResearchDossiersBySectionId = currentResearchDossiersBySectionId;
        const moduleTitle =
          currentPlan.modules.find(module => module.children.some(child => child.id === section.id))
            ?.title || section.title;
        const researchedDossier =
          cachedResearchDossier ||
          (await openRouter.generateResearchLessonDossier({
            courseTitle: currentPlan.title,
            coverageGaps: coverageDecision?.missingTopics,
            lesson: section,
            moduleTitle,
            profile: currentUserProfile,
            researchCoursePlan: currentResearchCoursePlan,
            onStatusUpdate: reportStatus,
            onReasoningUpdate: progressObserver.push,
          }));
        if (!isGenerationRequestCurrent()) {
          return 'ignored-busy';
        }
        const mixedDossier = openRouter.mergePrerequisiteDossierSources(
          researchedDossier,
          originalSourceContext.sources
        );
        nextResearchDossiersBySectionId = {
          ...currentResearchDossiersBySectionId,
          [section.id]: mixedDossier,
        };
        domain.setResearchLessonDossier(mixedDossier);

        const lessonResult = await openRouter.generateSectionContent({
          documentIndex: currentDocumentIndex,
          file: generationSourceFile,
          generationNotes: currentPlan.generationNotes,
          onReasoningUpdate: progressObserver.push,
          onStatusUpdate: reportStatus,
          previousContext: completedTitles,
          primaryChunkIds: section.primaryChunkIds,
          resolvedSourceArchiveContext,
          sectionDescription: section.description,
          sectionTitle: section.title,
          supplementalSourceContext: openRouter.formatResearchDossierForPrompt(mixedDossier),
        });

        const {
          content,
          contentBlocks,
          documentAssets: nextDocumentAssets,
          generatedVisuals,
          imageRefs,
          learningAids,
          quiz,
          visualPlanningDecision,
        } = lessonResult;

        if (!isGenerationRequestCurrent()) {
          return 'ignored-busy';
        }

        domain.updateSection(section.id, section => ({
          ...section,
          content,
          contentBlocks,
          quiz,
          imageRefs,
          learningAids,
          generatedVisuals,
          visualPlanningDecision,
        }));
        const mergedDocumentAssets = mergeDocumentAssetsForPlan(
          domain.learningPlan ?? currentPlan,
          currentDocumentAssets,
          nextDocumentAssets
        );
        domain.setDocumentAssets(mergedDocumentAssets);
        const didPersistLesson = await projectLibrary.patchSectionLessonContent(
          section.id,
          {
            content,
            contentBlocks,
            generatedVisuals,
            imageRefs,
            learningAids,
            quiz,
            visualPlanningDecision,
          },
          {
            documentAssets: mergedDocumentAssets,
            ...(nextResearchDossiersBySectionId !== currentResearchDossiersBySectionId
              ? { researchDossiersBySectionId: nextResearchDossiersBySectionId }
              : {}),
            activeSectionId: section.id,
            state: AppState.READING,
          }
        );
        if (!didPersistLesson) {
          throw new Error(t('La lezione rigenerata non e stata salvata. Riprova.'));
        }
      }

      await progressObserver.finish();
      progressObserver.complete();
      state.succeedWorkflow('loadSection', requestId);
      return 'loaded';
    } catch (error) {
      if (!isGenerationRequestCurrent()) {
        return 'ignored-busy';
      }
      state.failWorkflow('loadSection', requestId, getErrorMessage(error));
      throw error;
    } finally {
      if (ownsGenerationGate) {
        state.finishGeneration(activeGeneration.projectId, activeGeneration.token);
      }
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

    const researchDossiersBySectionId = { ...domain.researchDossiersBySectionId };
    delete researchDossiersBySectionId[domain.activeSection.id];

    return openSection(domain.activeSection, {
      currentResearchDossiersBySectionId: researchDossiersBySectionId,
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
        domain.isLearnMode ||
        domain.syllabus.length > 0 ||
        flattenLessons(domain.learningPlan.modules).some(currentLesson =>
          Boolean(currentLesson.parentId)
        );

      const newSection = sourceFile
        ? await openRouter.createSubChapterMetadata(
            sourceFile,
            parentSection,
            args.selectedText,
            args.instructions
          )
        : canCreateWithoutFile
          ? await openRouter.createLearnSubChapterMetadata(
              parentSection,
              args.selectedText,
              args.instructions,
              resolveLearnSectionContext(parentSection, domain.learningPlan, domain.syllabus)
                .moduleTitle,
              domain.userProfile
            )
          : null;

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
      void projectLibrary.patchCurrentProject({
        learningPlan: updatedPlan,
        // Includiamo documentIndex solo se è effettivamente cambiato e non-null,
        // così l'autosave o un altro patch non lo azzerano per sbaglio.
        ...(nextDocumentIndex != null && nextDocumentIndex !== domain.documentIndex
          ? { documentIndex: nextDocumentIndex }
          : {}),
        activeSectionId: domain.activeSectionId,
        state: AppState.READING,
      });

      const mappedNewLesson =
        flattenLessons(updatedPlan.modules).find(
          currentLesson => currentLesson.id === newLesson.id
        ) ?? newLesson;
      state.succeedWorkflow('createLesson', requestId);
      try {
        const openOutcome = await openSectionWithGenerationGate(
          mappedNewLesson,
          {
            allowWhileBlocking: true,
            currentDocumentAssets: domain.documentAssets,
            currentDocumentIndex: nextDocumentIndex,
            currentPlan: updatedPlan,
            currentSourceFile: sourceFile,
            currentSyllabus: domain.syllabus,
            currentUserProfile: domain.userProfile,
            isLearnMode: domain.isLearnMode,
          },
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
        await openSection(nextLesson, {
          allowWhileBlocking: true,
          currentPlan: updatedPlan,
        });
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

    await openSection(nextLesson, {
      allowWhileBlocking: true,
      currentPlan: domain.learningPlan,
    });
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
