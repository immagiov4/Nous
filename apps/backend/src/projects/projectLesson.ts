import { isRecord } from '../utils/validation.js';
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

const findNestedRecordById = (values: unknown, id: string): Record<string, unknown> | null => {
  if (!Array.isArray(values)) return null;
  for (const value of values) {
    if (!isRecord(value)) continue;
    if (value.id === id) return value;
    const child = findNestedRecordById(value.children, id);
    if (child) return child;
  }
  return null;
};

export const findResearchLesson = (
  project: ProjectSnapshot,
  sectionId: string
): Record<string, unknown> | null => {
  if (!isRecord(project.researchCoursePlan) || !Array.isArray(project.researchCoursePlan.lessons)) {
    return null;
  }
  const lesson = project.researchCoursePlan.lessons.find(
    candidate => isRecord(candidate) && candidate.id === sectionId
  );
  return isRecord(lesson) ? lesson : null;
};

export const readPreviousLessonTitles = (project: ProjectSnapshot): string[] =>
  (project.learningPlan?.modules ?? []).flatMap(module =>
    (module.children ?? []).flatMap(candidate =>
      candidate.isCompleted && typeof candidate.title === 'string' ? [candidate.title] : []
    )
  );

export interface LessonAuthoringContext {
  readonly parent: LearningPlanNodeSnapshot | null;
  readonly researchLesson: Record<string, unknown> | null;
  readonly syllabusItem: Record<string, unknown> | null;
}

/**
 * Project inputs that shape a lesson around its plan entry. The lesson prompt and the
 * source-authority fingerprint both read this, so the fingerprint covers exactly the
 * planning context the prompt sees.
 */
export const readLessonAuthoringContext = (
  project: ProjectSnapshot,
  sectionId: string,
  parentId: unknown
): LessonAuthoringContext => ({
  parent: typeof parentId === 'string' ? findProjectLessonSection(project, parentId) : null,
  researchLesson: findResearchLesson(project, sectionId),
  syllabusItem: findNestedRecordById(project.syllabus, sectionId),
});
