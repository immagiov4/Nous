import { getErrorMessage } from '../../services/errorMessage.ts';
import { getProjectSourceFile } from '../../services/projectSource.ts';
import { mergeDocumentAssetsForPlan } from '../../services/workspace-controller/documentAssets.ts';
import { resolveLearnSectionContext } from '../../services/workspace-controller/learnMode.ts';
import { selectIsBlocking } from '../../services/workspaceWorkflow.ts';
import { AppState, type LearningSection } from '../../types.ts';
import { insertSectionAfterSubtree } from '../../utils/learningSectionTree.ts';
import { resolveLessonGenerationState } from '../../utils/lessonGenerationState.ts';
import type {
  CompleteSectionOutcome,
  CreateLessonOutcome,
  OpenSectionOptions,
  OpenSectionOutcome,
  WorkspaceControllerContext,
} from './types.ts';

export const createSectionCommands = (context: WorkspaceControllerContext) => {
  const { domain, gemini, projectLibrary, state, stopAudio } = context;

  async function openSection(
    section: LearningSection,
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
    const sourceFile =
      options.currentSourceFile === undefined
        ? domain.file ?? getProjectSourceFile(domain.source)
        : options.currentSourceFile;
    const isLearnMode =
      options.isLearnMode === undefined ? domain.isLearnMode : options.isLearnMode;
    const currentSyllabus =
      options.currentSyllabus === undefined ? domain.syllabus : options.currentSyllabus;
    const currentUserProfile =
      options.currentUserProfile === undefined ? domain.userProfile : options.currentUserProfile;
    const forceRegenerate = options.forceRegenerate === true;

    if (!currentPlan) {
      return 'ignored-busy';
    }

    if (!options.allowWhileBlocking && selectIsBlocking(state.getWorkflowState())) {
      return 'ignored-busy';
    }

    if (!forceRegenerate && domain.activeSectionId === section.id && section.content?.length) {
      return 'reused-cached';
    }

    stopAudio(true);
    domain.setActiveSectionId(section.id);

    if (!forceRegenerate && section.content?.length) {
      void projectLibrary.saveCurrentProject({
        activeSectionId: section.id,
        state: AppState.READING,
      });
      return 'reused-cached';
    }

    void projectLibrary.saveCurrentProject({
      activeSectionId: section.id,
      state: AppState.READING,
    });

    const lessonGenerationState = resolveLessonGenerationState({
      file: sourceFile,
      isLearnMode,
      learningPlan: currentPlan,
      syllabus: currentSyllabus,
    });

    if (lessonGenerationState === 'blocked-missing-source') {
      return 'blocked-missing-source';
    }

    const requestId = state.beginWorkflow(
      'loadSection',
      forceRegenerate ? 'Rigenerazione lezione...' : 'Analisi contenuti...'
    );

    const completedTitles = currentPlan.sections
      .filter(currentSection => currentSection.isCompleted)
      .map(currentSection => currentSection.title)
      .join(', ');

    try {
      if (lessonGenerationState === 'learn-mode') {
        if (!isLearnMode) {
          domain.setIsLearnMode(true);
        }

        const { anchorLessonContextPrompt, anchorLessonId, moduleId, moduleTitle } =
          resolveLearnSectionContext(section, currentPlan, currentSyllabus);

        const content = await gemini.generateLearnLessonContent(
          section.title,
          moduleTitle,
          moduleId,
          anchorLessonId,
          section.contextPrompt || anchorLessonContextPrompt,
          currentUserProfile,
          currentSyllabus,
          status => {
            state.setWorkflowMessage('loadSection', requestId, status);
          }
        );

        if (!state.isWorkflowCurrent('loadSection', requestId)) {
          return 'ignored-busy';
        }

        const updatedPlan = {
          ...currentPlan,
          sections: currentPlan.sections.map(currentSection =>
            currentSection.id === section.id
              ? { ...currentSection, content, quiz: [], imageRefs: [] }
              : currentSection
          ),
        };
        const mergedDocumentAssets = mergeDocumentAssetsForPlan(
          updatedPlan,
          currentDocumentAssets,
          null
        );
        domain.setLearningPlan(updatedPlan);
        domain.setDocumentAssets(mergedDocumentAssets);
        await projectLibrary.saveCurrentProject({
          learningPlan: updatedPlan,
          documentAssets: mergedDocumentAssets,
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
          imageRefs,
          quiz,
        } = await gemini.generateSectionContent(
          sourceFile,
          section.title,
          section.description,
          completedTitles,
          section.primaryChunkIds,
          currentDocumentIndex,
          status => {
            state.setWorkflowMessage('loadSection', requestId, status);
          }
        );

        if (!state.isWorkflowCurrent('loadSection', requestId)) {
          return 'ignored-busy';
        }

        const updatedPlan = {
          ...currentPlan,
          sections: currentPlan.sections.map(currentSection =>
            currentSection.id === section.id
              ? { ...currentSection, content, quiz, imageRefs }
              : currentSection
          ),
        };
        const mergedDocumentAssets = mergeDocumentAssetsForPlan(
          updatedPlan,
          currentDocumentAssets,
          nextDocumentAssets
        );
        domain.setLearningPlan(updatedPlan);
        domain.setDocumentAssets(mergedDocumentAssets);
        await projectLibrary.saveCurrentProject({
          learningPlan: updatedPlan,
          documentAssets: mergedDocumentAssets,
          activeSectionId: section.id,
          state: AppState.READING,
        });
      }

      state.succeedWorkflow('loadSection', requestId);
      return 'loaded';
    } catch (error) {
      state.failWorkflow('loadSection', requestId, getErrorMessage(error));
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
      domain.activeSection?.content || domain.sectionContent || args.contextBefore || args.contextAfter
    );
    const sourceFile = domain.file ?? getProjectSourceFile(domain.source);

    if (!sourceFile && !canAnswerFromLesson) {
      return {
        errorMessage:
          'Questo progetto non ha una fonte collegata e la lezione corrente non contiene abbastanza contesto per rispondere.',
      };
    }

    const requestId = state.beginWorkflow('contextQuestion', 'Analisi contesto...');

    try {
      const answer = await gemini.askContextualQuestion({
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

    const parentSection = domain.learningPlan.sections.find(
      currentSection => currentSection.id === domain.activeSectionId
    );
    if (!parentSection) {
      return {
        outcome: 'failed',
        errorMessage:
          'Non riesco a trovare la lezione corrente nel piano. Ricarica il progetto e riprova.',
      };
    }

    const requestId = state.beginWorkflow('createLesson', 'Creazione approfondimento...');

    try {
      const sourceFile = domain.file ?? getProjectSourceFile(domain.source);
      const canCreateWithoutFile =
        domain.isLearnMode ||
        domain.syllabus.length > 0 ||
        domain.learningPlan.sections.some(currentSection => Boolean(currentSection.parentId));

      const newSection = sourceFile
        ? await gemini.createSubChapterMetadata(
            sourceFile,
            parentSection,
            args.selectedText,
            args.instructions
          )
        : canCreateWithoutFile
          ? await gemini.createLearnSubChapterMetadata(
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

      const newSections = insertSectionAfterSubtree(
        domain.learningPlan.sections,
        parentSection.id,
        newSection
      );

      let updatedPlan = { ...domain.learningPlan, sections: newSections };
      let nextDocumentIndex = domain.documentIndex;

      if (sourceFile) {
        state.setWorkflowMessage(
          'createLesson',
          requestId,
          'Associazione chunk alla nuova lezione...'
        );
        const prepared = await context.preparePdfLessonPlan(
          sourceFile,
          updatedPlan,
          domain.documentIndex,
          [newSection.id]
        );
        updatedPlan = prepared.learningPlan;
        nextDocumentIndex = prepared.documentIndex;
      }

      domain.setLearningPlan(updatedPlan);
      domain.setDocumentIndex(nextDocumentIndex);
      await projectLibrary.saveCurrentProject({
        learningPlan: updatedPlan,
        documentIndex: nextDocumentIndex,
        activeSectionId: domain.activeSectionId,
        state: AppState.READING,
      });

      const mappedNewSection =
        updatedPlan.sections.find(currentSection => currentSection.id === newSection.id) ||
        newSection;
      state.succeedWorkflow('createLesson', requestId);
      await openSection(mappedNewSection, {
        allowWhileBlocking: true,
        currentDocumentAssets: domain.documentAssets,
        currentDocumentIndex: nextDocumentIndex,
        currentPlan: updatedPlan,
        currentSourceFile: sourceFile,
        currentSyllabus: domain.syllabus,
        currentUserProfile: domain.userProfile,
        isLearnMode: domain.isLearnMode,
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

    const requestId = state.beginWorkflow('completeSection', 'Salvataggio progresso...');

    try {
      const newSections = domain.learningPlan.sections.map(currentSection =>
        currentSection.id === domain.activeSectionId
          ? { ...currentSection, isCompleted: true }
          : currentSection
      );
      const updatedPlan = { ...domain.learningPlan, sections: newSections };
      domain.setLearningPlan(updatedPlan);
      await projectLibrary.saveCurrentProject({
        learningPlan: updatedPlan,
        activeSectionId: domain.activeSectionId,
        state: AppState.READING,
      });
      const currentIndex = newSections.findIndex(
        currentSection => currentSection.id === domain.activeSectionId
      );
      if (currentIndex < newSections.length - 1) {
        state.succeedWorkflow('completeSection', requestId);
        await openSection(newSections[currentIndex + 1], {
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

  async function goToLibrary(): Promise<void> {
    stopAudio(true);
    state.resetRuntimeState();
    state.setScreenState(AppState.LIBRARY);
  }

  return {
    askContextQuestion,
    completeActiveSection,
    createLessonFromSelection,
    goToLibrary,
    openSection,
    regenerateActiveSection,
  };
};
