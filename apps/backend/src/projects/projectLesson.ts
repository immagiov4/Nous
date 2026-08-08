import type { LearningPlanNodeSnapshot, ProjectSnapshot } from './types.js';

export const findProjectLessonSection = (
  snapshot: ProjectSnapshot,
  sectionId: string
): LearningPlanNodeSnapshot | null => {
  const moduleSection = snapshot.learningPlan?.modules
    ?.flatMap(module => module.children ?? [])
    .find(section => section.id === sectionId && section.kind !== 'exercise');
  if (moduleSection) return moduleSection;

  return (
    snapshot.learningPlan?.sections?.find(
      section => section.id === sectionId && section.kind !== 'exercise'
    ) ?? null
  );
};
