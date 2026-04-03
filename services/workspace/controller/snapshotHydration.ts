import { AppState, type LearningPlan, type LearningSection, type ProjectSnapshot } from '../../../types.ts';
import { pushLuminaDebugTrace } from '../../core/debugTrace.ts';
import { restoreLegacyPdfImagePlaceholders } from '../../../utils/pdf/imagePlaceholders.ts';
import { normalizeMarkdownForRendering } from '../../../utils/markdown/render.ts';
import { migrateSectionAnnotations } from '../../../utils/learning/sectionAnnotations.ts';

const HYDRATION_TRACE_PREVIEW_CHARS = 1600;

const summarizeHydratedContent = (content: string) => ({
  hasCodeFence: /(^|\n)```/.test(content),
  length: content.length,
  preview: content.slice(0, HYDRATION_TRACE_PREVIEW_CHARS),
});

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

    const normalizedContent = normalizeMarkdownForRendering(
      restoreLegacyPdfImagePlaceholders(section.content)
    );
    const migratedSection = migrateSectionAnnotations({
      annotations: section.annotations,
      content: normalizedContent,
    });

    if (!migratedSection.didChange && normalizedContent === section.content) {
      return section;
    }

    didChange = true;
    return {
      ...section,
      content: migratedSection.content,
      annotations: migratedSection.annotations,
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

  if (nextSection?.content) {
    pushLuminaDebugTrace('snapshot-hydration:active-section', {
      sectionId: nextSection.id,
      sectionTitle: nextSection.title,
      ...summarizeHydratedContent(nextSection.content),
    });
  }

  return {
    ...snapshot,
    learningPlan: normalizedLearningPlan,
    activeSectionId: nextSection?.id || null,
  };
};
