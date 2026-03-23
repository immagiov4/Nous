import { AppState, type LearningPlan, type LearningSection, type ProjectSnapshot } from '../../types.ts';
import { restoreLegacyPdfImagePlaceholders } from '../../utils/pdfImagePlaceholders.ts';

export const normalizeLearningPlanContent = (
  learningPlan: LearningPlan | null
): LearningPlan | null => {
  if (!learningPlan) {
    return null;
  }

  let didChange = false;
  const normalizedSections = learningPlan.sections.map(section => {
    if (!section.content) {
      return section;
    }

    const normalizedContent = restoreLegacyPdfImagePlaceholders(section.content);
    if (normalizedContent === section.content) {
      return section;
    }

    didChange = true;
    return {
      ...section,
      content: normalizedContent,
    };
  });

  return didChange
    ? {
        ...learningPlan,
        sections: normalizedSections,
      }
    : learningPlan;
};

export const resolvePlanSection = (
  learningPlan: LearningPlan | null,
  activeSectionId?: string | null
): LearningSection | null =>
  learningPlan?.sections.find(section => section.id === activeSectionId) ||
  learningPlan?.sections.find(section => !section.isCompleted) ||
  learningPlan?.sections[0] ||
  null;

export const resolveScreenStateForSnapshot = (
  snapshot: Pick<ProjectSnapshot, 'learningPlan' | 'source'>
): AppState => {
  if (snapshot.learningPlan) {
    return AppState.READING;
  }

  if (snapshot.source) {
    return AppState.ASSESSMENT;
  }

  return AppState.LIBRARY;
};

export const prepareSnapshotForHydration = (snapshot: ProjectSnapshot): ProjectSnapshot => {
  const normalizedLearningPlan = normalizeLearningPlanContent(snapshot.learningPlan);
  const nextSection = resolvePlanSection(normalizedLearningPlan, snapshot.activeSectionId);

  return {
    ...snapshot,
    learningPlan: normalizedLearningPlan,
    activeSectionId: nextSection?.id || null,
  };
};
