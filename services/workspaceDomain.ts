import type {
  LearningPlan,
  LearningSection,
  PdfDocumentAssets,
  PdfTextIndex,
  ProjectSnapshot,
  ProjectSource,
  QuizQuestion,
  SyllabusItem,
  UserProfile,
  WorkspaceDomainState,
} from '../types';

export const createEmptyWorkspaceDomainState = (): WorkspaceDomainState => ({
  source: null,
  learningPlan: null,
  documentAssets: null,
  documentIndex: null,
  isLearnMode: false,
  userProfile: null,
  syllabus: [],
  activeSectionId: null,
});

export type WorkspaceDomainAction =
  | { type: 'reset' }
  | { type: 'hydrate'; snapshot: ProjectSnapshot }
  | { type: 'set-source'; source: ProjectSource | null }
  | { type: 'set-learning-plan'; learningPlan: LearningPlan | null }
  | { type: 'set-document-assets'; documentAssets: PdfDocumentAssets | null }
  | { type: 'set-document-index'; documentIndex: PdfTextIndex | null }
  | { type: 'set-learn-mode'; isLearnMode: boolean }
  | { type: 'set-user-profile'; userProfile: UserProfile | null }
  | { type: 'set-syllabus'; syllabus: SyllabusItem[] }
  | { type: 'set-active-section'; activeSectionId: string | null }
  | { type: 'set-music-url'; musicUrl: string }
  | { type: 'update-active-section-content'; content: string }
  | { type: 'update-active-section-quiz'; quiz: QuizQuestion[] }
  | { type: 'update-section'; sectionId: string; updater: (section: LearningSection) => LearningSection }
  | { type: 'insert-section-after'; parentSectionId: string; section: LearningSection };

const updateLearningPlan = (
  state: WorkspaceDomainState,
  updater: (learningPlan: LearningPlan) => LearningPlan
): WorkspaceDomainState => {
  if (!state.learningPlan) {
    return state;
  }

  return {
    ...state,
    learningPlan: updater(state.learningPlan),
  };
};

const updateSectionInPlan = (
  learningPlan: LearningPlan,
  sectionId: string,
  updater: (section: LearningSection) => LearningSection
): LearningPlan => ({
  ...learningPlan,
  sections: learningPlan.sections.map(section =>
    section.id === sectionId ? updater(section) : section
  ),
});

export const workspaceDomainReducer = (
  state: WorkspaceDomainState,
  action: WorkspaceDomainAction
): WorkspaceDomainState => {
  switch (action.type) {
    case 'reset':
      return createEmptyWorkspaceDomainState();

    case 'hydrate':
      return {
        source: action.snapshot.source,
        learningPlan: action.snapshot.learningPlan,
        documentAssets: action.snapshot.documentAssets ?? null,
        documentIndex: action.snapshot.documentIndex ?? null,
        isLearnMode: action.snapshot.isLearnMode,
        userProfile: action.snapshot.userProfile,
        syllabus: action.snapshot.syllabus,
        activeSectionId: action.snapshot.activeSectionId,
      };

    case 'set-source':
      return {
        ...state,
        source: action.source,
      };

    case 'set-learning-plan':
      return {
        ...state,
        learningPlan: action.learningPlan,
      };

    case 'set-document-assets':
      return {
        ...state,
        documentAssets: action.documentAssets,
      };

    case 'set-document-index':
      return {
        ...state,
        documentIndex: action.documentIndex,
      };

    case 'set-learn-mode':
      return {
        ...state,
        isLearnMode: action.isLearnMode,
      };

    case 'set-user-profile':
      return {
        ...state,
        userProfile: action.userProfile,
      };

    case 'set-syllabus':
      return {
        ...state,
        syllabus: action.syllabus,
      };

    case 'set-active-section':
      return {
        ...state,
        activeSectionId: action.activeSectionId,
      };

    case 'set-music-url':
      return updateLearningPlan(state, learningPlan => ({
        ...learningPlan,
        backgroundMusicUrl: action.musicUrl,
      }));

    case 'update-active-section-content':
      if (!state.activeSectionId) {
        return state;
      }

      return updateLearningPlan(state, learningPlan =>
        updateSectionInPlan(learningPlan, state.activeSectionId as string, section => ({
          ...section,
          content: action.content,
        }))
      );

    case 'update-active-section-quiz':
      if (!state.activeSectionId) {
        return state;
      }

      return updateLearningPlan(state, learningPlan =>
        updateSectionInPlan(learningPlan, state.activeSectionId as string, section => ({
          ...section,
          quiz: action.quiz,
        }))
      );

    case 'update-section':
      return updateLearningPlan(state, learningPlan =>
        updateSectionInPlan(learningPlan, action.sectionId, action.updater)
      );

    case 'insert-section-after':
      return updateLearningPlan(state, learningPlan => {
        const parentIndex = learningPlan.sections.findIndex(
          section => section.id === action.parentSectionId
        );

        if (parentIndex < 0) {
          return learningPlan;
        }

        return {
          ...learningPlan,
          sections: [
            ...learningPlan.sections.slice(0, parentIndex + 1),
            action.section,
            ...learningPlan.sections.slice(parentIndex + 1),
          ],
        };
      });
  }
};

export const selectActiveSection = (
  state: WorkspaceDomainState
): LearningSection | null => {
  if (!state.learningPlan || !state.activeSectionId) {
    return null;
  }

  return (
    state.learningPlan.sections.find(section => section.id === state.activeSectionId) ?? null
  );
};

export const selectMusicUrl = (state: WorkspaceDomainState): string =>
  state.learningPlan?.backgroundMusicUrl ?? '';

export const selectNeedsSourceFile = (state: WorkspaceDomainState): boolean =>
  !state.source && Boolean(state.learningPlan) && !state.isLearnMode;

export const selectActiveSectionContent = (state: WorkspaceDomainState): string =>
  selectActiveSection(state)?.content ?? '';

export const selectActiveSectionQuiz = (state: WorkspaceDomainState): QuizQuestion[] =>
  selectActiveSection(state)?.quiz ?? [];
