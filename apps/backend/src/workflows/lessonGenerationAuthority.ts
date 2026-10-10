import { createHash } from 'node:crypto';
import {
  findProjectLessonSection,
  readLessonAuthoringContext,
  readPreviousLessonTitles,
} from '../projects/projectLesson.js';
import type { LearningPlanNodeSnapshot, ProjectSnapshot } from '../projects/types.js';
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
      ([key, value]) =>
        key !== 'playback' && !GENERATED_LESSON_FIELDS.has(key) && value !== undefined
    )
  );

const generatedSectionShape = (section: LearningPlanNodeSnapshot): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(section).filter(
      ([key, value]) => GENERATED_LESSON_FIELDS.has(key) && value != null
    )
  );

export const buildLessonGenerationSourceFingerprint = (
  project: ProjectSnapshot,
  sectionId: string
): string => {
  const section = findProjectLessonSection(project, sectionId);
  if (!section) throw new Error('Lesson source authority target is missing.');
  const { parent, researchLesson, syllabusItem } = readLessonAuthoringContext(
    project,
    sectionId,
    section.parentId
  );
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
    previousLessonTitles: readPreviousLessonTitles(project),
    researchLesson,
    section: generationSectionShape(section),
    source: project.source ?? null,
    sourceKind: project.sourceKind ?? null,
    syllabusItem,
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
