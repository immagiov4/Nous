import { createHash } from 'node:crypto';
import { findProjectLessonSection } from '../projects/projectLesson.js';
import type { LearningPlanNodeSnapshot, ProjectSnapshot } from '../projects/types.js';
import { isRecord } from '../utils/validation.js';
import { canonicalJson } from './schemaFingerprint.js';

const GENERATED_LESSON_FIELDS = new Set([
  'annotations',
  'content',
  'contentBlocks',
  'generationWarnings',
  'generatedVisuals',
  'imageRefs',
  'isCompleted',
  'lastGenerationRunId',
  'learningAids',
  'quiz',
  'visualPlanningDecision',
]);

const generationSectionShape = (section: LearningPlanNodeSnapshot): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(section).filter(
      ([key, value]) => !GENERATED_LESSON_FIELDS.has(key) && value !== undefined
    )
  );

const generatedSectionShape = (section: LearningPlanNodeSnapshot): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(section).filter(
      ([key, value]) => GENERATED_LESSON_FIELDS.has(key) && value != null
    )
  );

const findNestedValueById = (values: unknown, id: string): unknown => {
  if (!Array.isArray(values)) return null;
  for (const value of values) {
    if (!isRecord(value)) continue;
    if (value.id === id) return value;
    const nested = findNestedValueById(value.children, id);
    if (nested) return nested;
  }
  return null;
};

const findResearchLesson = (project: ProjectSnapshot, sectionId: string): unknown =>
  isRecord(project.researchCoursePlan) && Array.isArray(project.researchCoursePlan.lessons)
    ? (project.researchCoursePlan.lessons.find(
        candidate => isRecord(candidate) && candidate.id === sectionId
      ) ?? null)
    : null;

export const buildLessonGenerationSourceFingerprint = (
  project: ProjectSnapshot,
  sectionId: string
): string => {
  const section = findProjectLessonSection(project, sectionId);
  if (!section) throw new Error('Lesson source authority target is missing.');
  const parent =
    typeof section.parentId === 'string'
      ? findProjectLessonSection(project, section.parentId)
      : null;
  const authority = {
    documentIndex: project.documentIndex ?? null,
    existingDossier: project.researchDossiersBySectionId?.[sectionId] ?? null,
    generationNotes: project.learningPlan?.generationNotes ?? null,
    parent: parent
      ? {
          content: parent.content ?? null,
          description: parent.description ?? null,
          title: parent.title ?? null,
        }
      : null,
    previousLessonTitles: (project.learningPlan?.modules ?? []).flatMap(module =>
      (module.children ?? []).flatMap(candidate =>
        candidate.isCompleted && typeof candidate.title === 'string' ? [candidate.title] : []
      )
    ),
    researchLesson: findResearchLesson(project, sectionId),
    section: generationSectionShape(section),
    source: project.source ?? null,
    sourceKind: project.sourceKind ?? null,
    syllabusItem: findNestedValueById(project.syllabus, sectionId),
    title: project.learningPlan?.title ?? project.title ?? null,
    userProfile: project.userProfile ?? null,
  };
  return createHash('sha256').update(canonicalJson(authority)).digest('hex');
};

export const snapshotLessonGenerationTarget = (
  project: ProjectSnapshot,
  sectionId: string
): Record<string, unknown> => {
  const section = findProjectLessonSection(project, sectionId);
  if (!section) throw new Error('Lesson generation target is missing.');
  return generatedSectionShape(section);
};

export const buildLessonGenerationTargetFingerprint = (
  project: ProjectSnapshot,
  sectionId: string
): string =>
  createHash('sha256')
    .update(canonicalJson(snapshotLessonGenerationTarget(project, sectionId)))
    .digest('hex');
