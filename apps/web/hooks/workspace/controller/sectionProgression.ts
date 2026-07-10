import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import { getErrorMessage } from '../../../services/core/errorMessage.ts';
import {
  addExerciseAttachments,
  markApplicationExercisePlanningFailed,
  updateApplicationExerciseInPlan,
  withGeneratedExerciseBrief,
} from '../../../services/exercises/plan.ts';
import { getProjectSourceFile } from '../../../services/projects/projectSource.ts';
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
  'loadSection',
  'contextQuestion',
  'createLesson',
  'completeSection',
  'generateExercise',
  'evaluateExercise',
];

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
    stopAudio(true);
    domain.setActiveSectionId(exercise.id);
    void projectLibrary.patchCurrentProject({
      activeSectionId: exercise.id,
      state: AppState.READING,
    });

    if (exercise.brief?.trim() || !domain.learningPlan) {
      return;
    }

    const gaps = openRouter.getExercisePrerequisiteGaps(domain.learningPlan, exercise.id);
    if (gaps.length > 0) {
      return;
    }

    const isLoadingSection = state.getWorkflowState().loadSection.status === 'pending';
    if (selectIsBlocking(state.getWorkflowState()) || isLoadingSection) {
      return;
    }

    state.setGeneratingSectionId(exercise.id);
    const requestId = state.beginWorkflow('loadSection', t('Controllo le lezioni precedenti...'));

    try {
      const result = await openRouter.generateApplicationExerciseBrief({
        documentIndex: domain.documentIndex,
        exercise,
        learningPlan: domain.learningPlan,
        profile: domain.userProfile,
        researchDossiersBySectionId: domain.researchDossiersBySectionId,
        onStatusUpdate: status => {
          state.setWorkflowMessage('loadSection', requestId, status);
        },
        onReasoningUpdate: reasoning => {
          state.setWorkflowReasoning('loadSection', requestId, reasoning);
        },
      });

      if (!state.isWorkflowCurrent('loadSection', requestId)) {
        return;
      }

      const updatedPlan = updateApplicationExerciseInPlan(domain.learningPlan, exercise.id, node =>
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
      state.failWorkflow('loadSection', requestId, getErrorMessage(error));
      throw error;
    } finally {
      state.setGeneratingSectionId(null);
    }
  }

  async function repairApplicationExercises(): Promise<{ outcome: 'noop' | 'repaired' }> {
    if (!domain.learningPlan) {
      return { outcome: 'noop' };
    }

    const requestId = state.beginWorkflow(
      'generateExercise',
      t('Scelgo dove inserire gli esercizi...')
    );

    try {
      const result = await openRouter.generateApplicationExercisePlacements({
        courseIntent: domain.learningPlan.summary || domain.learningPlan.title,
        learningPlan: domain.learningPlan,
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
      const attempts =
        typeof (error as { attempts?: unknown }).attempts === 'number'
          ? (error as { attempts: number }).attempts
          : 1;
      const failedPlan = markApplicationExercisePlanningFailed(
        domain.learningPlan,
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

  async function openSection(
    section: LessonNode,
    options: OpenSectionOptions = {}
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

    stopAudio(true);
    domain.setActiveSectionId(section.id);

    // Sections with content navigate immediately — even if another generation
    // is running. The user can freely switch between ready lessons.
    if (!forceRegenerate && section.content?.length) {
      void projectLibrary.patchCurrentProject({
        activeSectionId: section.id,
        state: AppState.READING,
      });
      return 'reused-cached';
    }

    // Guard: starting a NEW generation is blocked while any blocking workflow is
    // active or another loadSection is already running (avoids accidental double-
    // clicks and rate-limit contention). Only one generation at a time.
    const isLoadingSection = state.getWorkflowState().loadSection.status === 'pending';
    if (
      !options.allowWhileBlocking &&
      (selectIsBlocking(state.getWorkflowState()) || isLoadingSection)
    ) {
      return 'ignored-busy';
    }

    void projectLibrary.patchCurrentProject({
      activeSectionId: section.id,
      state: AppState.READING,
    });

    const sourceFile =
      options.currentSourceFile === undefined
        ? await loadProjectSourceFile(context)
        : options.currentSourceFile;

    const lessonGenerationState = resolveLessonGenerationState({
      file: sourceFile,
      isLearnMode,
      learningPlan: currentPlan,
      syllabus: currentSyllabus,
    });

    if (lessonGenerationState === 'blocked-missing-source') {
      return 'blocked-missing-source';
    }

    state.setGeneratingSectionId(section.id);

    const requestId = state.beginWorkflow(
      'loadSection',
      t(forceRegenerate ? 'Rigenerazione lezione...' : 'Analisi contenuti...')
    );

    const completedTitles = flattenLessons(currentPlan.modules)
      .filter(currentLesson => currentLesson.isCompleted)
      .map(currentLesson => currentLesson.title)
      .join(', ');

    try {
      if (lessonGenerationState === 'learn-mode') {
        if (!isLearnMode) {
          domain.setIsLearnMode(true);
        }

        const { anchorLessonContextPrompt, anchorLessonId, moduleId, moduleTitle } =
          resolveLearnSectionContext(section, currentPlan, currentSyllabus);

        let nextResearchDossiersBySectionId = currentResearchDossiersBySectionId;
        const cachedResearchDossier = currentResearchDossiersBySectionId[section.id];
        const learnLessonResult = currentResearchCoursePlan
          ? await (async () => {
              const researchDossier =
                cachedResearchDossier ||
                (await openRouter.generateResearchLessonDossier({
                  lesson: section,
                  moduleTitle,
                  profile: currentUserProfile,
                  researchCoursePlan: currentResearchCoursePlan,
                  onStatusUpdate: status => {
                    state.setWorkflowMessage('loadSection', requestId, status);
                  },
                  onReasoningUpdate: reasoning => {
                    state.setWorkflowReasoning('loadSection', requestId, reasoning);
                  },
                }));

              if (!state.isWorkflowCurrent('loadSection', requestId)) {
                return { content: '', generatedVisuals: [], learningAids: [], quiz: [] };
              }

              if (!cachedResearchDossier) {
                nextResearchDossiersBySectionId = {
                  ...currentResearchDossiersBySectionId,
                  [section.id]: researchDossier,
                };
                domain.setResearchLessonDossier(researchDossier);
              }

              return openRouter.generateResearchLessonContent({
                lessonTitle: section.title,
                moduleTitle,
                contextPrompt: section.contextPrompt || anchorLessonContextPrompt,
                profile: currentUserProfile,
                syllabus: currentSyllabus,
                researchDossier,
                generationNotes: currentPlan.generationNotes,
                onStatusUpdate: status => {
                  state.setWorkflowMessage('loadSection', requestId, status);
                },
                onReasoningUpdate: reasoning => {
                  state.setWorkflowReasoning('loadSection', requestId, reasoning);
                },
              });
            })()
          : await (async () => {
              const content = await openRouter.generateLearnLessonContent(
                section.title,
                moduleTitle,
                moduleId,
                anchorLessonId,
                section.contextPrompt || anchorLessonContextPrompt,
                currentUserProfile,
                currentSyllabus,
                status => {
                  state.setWorkflowMessage('loadSection', requestId, status);
                },
                currentPlan.generationNotes,
                reasoning => {
                  state.setWorkflowReasoning('loadSection', requestId, reasoning);
                }
              );
              if (!state.isWorkflowCurrent('loadSection', requestId)) {
                return { content: '', generatedVisuals: [], learningAids: [], quiz: [] };
              }

              const learningAids = await openRouter.generateLessonLearningAids({
                contentMarkdown: content,
                sectionDescription: section.description,
                sectionTitle: section.title,
              });

              return { content, generatedVisuals: [], learningAids, quiz: [] };
            })();

        if (!state.isWorkflowCurrent('loadSection', requestId)) {
          return 'ignored-busy';
        }

        const { content, generatedVisuals, learningAids, quiz } = learnLessonResult;

        domain.updateSection(section.id, section => ({
          ...section,
          content,
          quiz,
          imageRefs: [],
          generatedVisuals,
          learningAids,
        }));
        const mergedDocumentAssets = mergeDocumentAssetsForPlan(
          domain.learningPlan ?? currentPlan,
          currentDocumentAssets,
          null
        );
        domain.setDocumentAssets(mergedDocumentAssets);
        void projectLibrary.patchSectionLessonContent(section.id, {
          content,
          generatedVisuals,
          imageRefs: [],
          learningAids,
          quiz,
        });
        void projectLibrary.patchCurrentProject({
          documentAssets: mergedDocumentAssets,
          researchDossiersBySectionId: nextResearchDossiersBySectionId,
          activeSectionId: section.id,
          state: AppState.READING,
          isLearnMode: true,
        });
      } else {
        if (!sourceFile) {
          throw new Error('Missing source file for section generation');
        }

        const {
          content,
          documentAssets: nextDocumentAssets,
          generatedVisuals,
          imageRefs,
          learningAids,
          quiz,
        } = await openRouter.generateSectionContent(
          sourceFile,
          section.title,
          section.description,
          completedTitles,
          section.primaryChunkIds,
          currentDocumentIndex,
          status => {
            state.setWorkflowMessage('loadSection', requestId, status);
          },
          currentPlan.generationNotes,
          reasoning => {
            state.setWorkflowReasoning('loadSection', requestId, reasoning);
          }
        );

        if (!state.isWorkflowCurrent('loadSection', requestId)) {
          return 'ignored-busy';
        }

        domain.updateSection(section.id, section => ({
          ...section,
          content,
          quiz,
          imageRefs,
          learningAids,
          generatedVisuals,
        }));
        const mergedDocumentAssets = mergeDocumentAssetsForPlan(
          domain.learningPlan ?? currentPlan,
          currentDocumentAssets,
          nextDocumentAssets
        );
        domain.setDocumentAssets(mergedDocumentAssets);
        void projectLibrary.patchSectionLessonContent(section.id, {
          content,
          generatedVisuals,
          imageRefs,
          learningAids,
          quiz,
        });
        void projectLibrary.patchCurrentProject({
          documentAssets: mergedDocumentAssets,
          activeSectionId: section.id,
          state: AppState.READING,
        });
      }

      state.succeedWorkflow('loadSection', requestId);
      state.setGeneratingSectionId(null);
      return 'loaded';
    } catch (error) {
      state.failWorkflow('loadSection', requestId, getErrorMessage(error));
      state.setGeneratingSectionId(null);
      throw error;
    }
  }

  async function regenerateActiveSection(): Promise<OpenSectionOutcome> {
    if (!domain.activeSection || !domain.learningPlan) {
      return 'ignored-busy';
    }

    return openSection(domain.activeSection, { forceRegenerate: true });
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
    const sourceFile = canAnswerFromLesson
      ? getProjectSourceFile(domain.source)
      : await loadProjectSourceFile(context);

    if (!sourceFile && !canAnswerFromLesson) {
      return {
        errorMessage:
          'Questo progetto non ha una fonte collegata e la lezione corrente non contiene abbastanza contesto per rispondere.',
      };
    }

    const requestId = state.beginWorkflow('contextQuestion', t('Analisi contesto...'));

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

    const requestId = state.beginWorkflow('createLesson', t('Creazione approfondimento...'));
    const previousPlan = domain.learningPlan;
    const previousDocumentIndex = domain.documentIndex;
    const previousActiveSectionId = domain.activeSectionId;

    try {
      const sourceFile = await loadProjectSourceFile(context);
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
        await openSection(mappedNewLesson, {
          allowWhileBlocking: true,
          currentDocumentAssets: domain.documentAssets,
          currentDocumentIndex: nextDocumentIndex,
          currentPlan: updatedPlan,
          currentSourceFile: sourceFile,
          currentSyllabus: domain.syllabus,
          currentUserProfile: domain.userProfile,
          isLearnMode: domain.isLearnMode,
        });
      } catch (error) {
        domain.setLearningPlan(previousPlan);
        domain.setDocumentIndex(previousDocumentIndex);
        domain.setActiveSectionId(previousActiveSectionId);
        // Rollback save is critical for consistency — await is intentional.
        await projectLibrary.saveCurrentProject({
          activeSectionId: previousActiveSectionId,
          documentIndex: previousDocumentIndex,
          learningPlan: previousPlan,
          state: AppState.READING,
        });
        throw error;
      }

      // Fire-and-forget: update active section after lesson open
      void projectLibrary.patchCurrentProject({
        activeSectionId: mappedNewLesson.id,
        documentIndex: nextDocumentIndex,
      });
      return { outcome: 'created' };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      state.failWorkflow('createLesson', requestId, errorMessage);
      return { outcome: 'failed', errorMessage };
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
    state.setGeneratingSectionId(null);
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
    openExercise,
    openSection,
    repairApplicationExercises,
    regenerateActiveSection,
    updateApplicationExercise,
  };
};
