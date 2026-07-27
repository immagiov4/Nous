import type {
  LearningPlan,
  LessonNode,
  PathNode,
  PdfDocumentAssets,
  PdfTextIndex,
  ProjectSnapshot,
  ProjectSource,
  QuizQuestion,
  ResearchCoursePlan,
  ResearchDossiersBySectionId,
  ResearchLessonDossier,
  SyllabusItem,
  UserProfile,
  WorkspaceDomainState,
} from '../../types';
import { findPathNodeById } from '../../utils/learning/pathNodes.ts';
import { insertSectionAfterSubtree } from '../../utils/learning/sectionTree.ts';

export const createEmptyWorkspaceDomainState = (): WorkspaceDomainState => ({
  source: null,
  learningPlan: null,
  documentAssets: null,
  documentIndex: null,
  isLearnMode: false,
  userProfile: null,
  syllabus: [],
  researchCoursePlan: null,
  researchDossiersBySectionId: {},
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
  | { type: 'set-research-course-plan'; researchCoursePlan: ResearchCoursePlan | null }
  | { type: 'set-research-lesson-dossier'; dossier: ResearchLessonDossier }
  | {
      type: 'set-research-dossiers';
      researchDossiersBySectionId: ResearchDossiersBySectionId;
    }
  | { type: 'set-active-section'; activeSectionId: string | null }
  | { type: 'set-music-url'; musicUrl: string }
  | { type: 'set-generation-notes'; generationNotes: string }
  | { type: 'update-active-section-content'; content: string }
  | { type: 'update-active-section-quiz'; quiz: QuizQuestion[] }
  | {
      type: 'update-section';
      sectionId: string;
      updater: (section: LessonNode) => LessonNode;
    }
  | { type: 'insert-section-after'; parentSectionId: string; section: LessonNode };

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

const updateLessonInPlan = (
  learningPlan: LearningPlan,
  sectionId: string,
  updater: (lesson: LessonNode) => LessonNode
): LearningPlan => ({
  ...learningPlan,
  modules: learningPlan.modules.map(module => ({
    ...module,
    children: module.children.map(child =>
      child.kind === 'lesson' && child.id === sectionId ? updater(child) : child
    ),
  })),
});

const insertLessonAfterAnchorInPlan = (
  learningPlan: LearningPlan,
  anchorSectionId: string,
  newLesson: LessonNode
): LearningPlan => ({
  ...learningPlan,
  modules: learningPlan.modules.map(module => {
    const containsAnchor = module.children.some(
      child => child.kind === 'lesson' && child.id === anchorSectionId
    );
    if (!containsAnchor) {
      return module;
    }
    // Sub-chapter insertion only applies among lessons in this module.
    const lessons = module.children.filter((child): child is LessonNode => child.kind === 'lesson');
    const exercises = module.children.filter(
      (child): child is PathNode => child.kind === 'exercise'
    );
    const reorderedLessons = insertSectionAfterSubtree(lessons, anchorSectionId, newLesson);
    return {
      ...module,
      children: [...reorderedLessons, ...exercises],
    };
  }),
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
        researchCoursePlan: action.snapshot.researchCoursePlan ?? null,
        researchDossiersBySectionId: action.snapshot.researchDossiersBySectionId ?? {},
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

    case 'set-research-course-plan':
      return {
        ...state,
        researchCoursePlan: action.researchCoursePlan,
      };

    case 'set-research-lesson-dossier':
      return {
        ...state,
        researchDossiersBySectionId: {
          ...state.researchDossiersBySectionId,
          [action.dossier.sectionId]: action.dossier,
        },
      };

    case 'set-research-dossiers':
      return {
        ...state,
        researchDossiersBySectionId: action.researchDossiersBySectionId,
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

    case 'set-generation-notes':
      return updateLearningPlan(state, learningPlan => ({
        ...learningPlan,
        generationNotes: action.generationNotes,
      }));

    case 'update-active-section-content':
      if (!state.activeSectionId) {
        return state;
      }

      return updateLearningPlan(state, learningPlan =>
        updateLessonInPlan(learningPlan, state.activeSectionId as string, lesson => ({
          ...lesson,
          content: action.content,
        }))
      );

    case 'update-active-section-quiz':
      if (!state.activeSectionId) {
        return state;
      }

      return updateLearningPlan(state, learningPlan =>
        updateLessonInPlan(learningPlan, state.activeSectionId as string, lesson => ({
          ...lesson,
          quiz: action.quiz,
        }))
      );

    case 'update-section':
      return updateLearningPlan(state, learningPlan =>
        updateLessonInPlan(learningPlan, action.sectionId, action.updater)
      );

    case 'insert-section-after':
      return updateLearningPlan(state, learningPlan =>
        insertLessonAfterAnchorInPlan(learningPlan, action.parentSectionId, action.section)
      );
  }
};

export const selectActiveSection = (
  state: WorkspaceDomainState | Pick<WorkspaceDomainState, 'learningPlan' | 'activeSectionId'>
): LessonNode | null => {
  if (!state.learningPlan || !state.activeSectionId) {
    return null;
  }
  const node = findPathNodeById(state.learningPlan.modules, state.activeSectionId);
  return node?.kind === 'lesson' ? node : null;
};

export const selectMusicUrl = (
  state: WorkspaceDomainState | Pick<WorkspaceDomainState, 'learningPlan'>
): string => state.learningPlan?.backgroundMusicUrl ?? '';

export const selectGenerationNotes = (
  state: WorkspaceDomainState | Pick<WorkspaceDomainState, 'learningPlan'>
): string => state.learningPlan?.generationNotes ?? '';

export const selectNeedsSourceFile = (
  state:
    | WorkspaceDomainState
    | Pick<WorkspaceDomainState, 'source' | 'learningPlan' | 'isLearnMode'>
): boolean => !state.source && Boolean(state.learningPlan) && !state.isLearnMode;

export const selectActiveSectionContent = (
  state: WorkspaceDomainState | Pick<WorkspaceDomainState, 'learningPlan' | 'activeSectionId'>
): string => selectActiveSection(state)?.content ?? '';

export const selectActiveSectionQuiz = (
  state: WorkspaceDomainState | Pick<WorkspaceDomainState, 'learningPlan' | 'activeSectionId'>
): QuizQuestion[] => selectActiveSection(state)?.quiz ?? [];
