import {
  canonicalizeLearningPlanContent,
  canonicalizeLessonNodeContent,
} from '@shared/projectSnapshotWire';

import { isRecord } from '../utils/validation.js';
import type {
  LearningPlanNodeSnapshot,
  LearningPlanSnapshot,
  ProjectPatch,
  ProjectSnapshot,
  SectionPatch,
} from './types.js';

const LEARNING_PLAN_NOT_FOUND_ERROR = 'Learning plan non trovato';
const NAVIGATION_PATCH_FIELDS = new Set<keyof ProjectPatch>([
  'activeSectionId',
  'state',
  'updatedAt',
]);

export const isNavigationProjectPatch = (patch: ProjectPatch): boolean => {
  const populatedFields = Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key as keyof ProjectPatch);
  return (
    populatedFields.includes('activeSectionId') &&
    populatedFields.every(field => NAVIGATION_PATCH_FIELDS.has(field))
  );
};

const applySectionPatchToNode = (
  node: LearningPlanNodeSnapshot,
  sectionPatch: SectionPatch
): LearningPlanNodeSnapshot =>
  canonicalizeLessonNodeContent({
    ...node,
    ...(sectionPatch.annotations !== undefined ? { annotations: sectionPatch.annotations } : {}),
    ...(sectionPatch.content !== undefined ? { content: sectionPatch.content } : {}),
    ...(sectionPatch.contentBlocks === undefined
      ? {}
      : { contentBlocks: sectionPatch.contentBlocks }),
    ...(sectionPatch.generationWarnings === undefined
      ? {}
      : { generationWarnings: sectionPatch.generationWarnings }),
    ...(sectionPatch.generatedVisuals !== undefined
      ? { generatedVisuals: sectionPatch.generatedVisuals }
      : {}),
    ...(sectionPatch.imageRefs !== undefined ? { imageRefs: sectionPatch.imageRefs } : {}),
    ...(sectionPatch.isCompleted !== undefined ? { isCompleted: sectionPatch.isCompleted } : {}),
    ...(sectionPatch.instructionPacks !== undefined
      ? { instructionPacks: sectionPatch.instructionPacks }
      : {}),
    ...(sectionPatch.learningAids !== undefined ? { learningAids: sectionPatch.learningAids } : {}),
    ...(sectionPatch.lastGenerationRunId !== undefined
      ? { lastGenerationRunId: sectionPatch.lastGenerationRunId }
      : {}),
    ...(sectionPatch.quiz !== undefined ? { quiz: sectionPatch.quiz } : {}),
    ...(sectionPatch.visualPlanningDecision !== undefined
      ? { visualPlanningDecision: sectionPatch.visualPlanningDecision }
      : {}),
  });

const patchLearningPlanSection = (
  learningPlan: LearningPlanSnapshot | null | undefined,
  sectionPatch: SectionPatch
): LearningPlanSnapshot => {
  if (!learningPlan) {
    throw new Error(LEARNING_PLAN_NOT_FOUND_ERROR);
  }

  if (Array.isArray(learningPlan.modules)) {
    return {
      ...learningPlan,
      modules: learningPlan.modules.map(module => ({
        ...module,
        children: Array.isArray(module.children)
          ? module.children.map(child =>
              isRecord(child) && child.id === sectionPatch.sectionId && child.kind !== 'exercise'
                ? applySectionPatchToNode(child, sectionPatch)
                : child
            )
          : module.children,
      })),
    };
  }

  if (Array.isArray(learningPlan.sections)) {
    return {
      ...learningPlan,
      sections: learningPlan.sections.map(section =>
        section.id === sectionPatch.sectionId
          ? applySectionPatchToNode(section, sectionPatch)
          : section
      ),
    };
  }

  throw new Error(LEARNING_PLAN_NOT_FOUND_ERROR);
};

const resolvePatchedLearningPlan = (
  currentLearningPlan: ProjectSnapshot['learningPlan'],
  learningPlanPatch: ProjectPatch['learningPlan']
): ProjectSnapshot['learningPlan'] => {
  if (learningPlanPatch === undefined) return currentLearningPlan;
  if (learningPlanPatch === null) return null;
  return canonicalizeLearningPlanContent(
    learningPlanPatch as Record<string, unknown>
  ) as ProjectSnapshot['learningPlan'];
};

const applyProjectTitlePatch = (snapshot: ProjectSnapshot, title: string | undefined): void => {
  if (title === undefined) return;
  snapshot.title = title;
  if (snapshot.learningPlan) {
    snapshot.learningPlan = { ...snapshot.learningPlan, title };
  }
};

export const applyProjectPatch = (
  existing: ProjectSnapshot,
  patch: ProjectPatch,
  updatedAt: string
): ProjectSnapshot => {
  const snapshot = { ...existing };

  if (patch.activeSectionId !== undefined) snapshot.activeSectionId = patch.activeSectionId;
  if (patch.state !== undefined) snapshot.state = patch.state;
  if (patch.isLearnMode !== undefined) snapshot.isLearnMode = patch.isLearnMode;
  snapshot.learningPlan = resolvePatchedLearningPlan(snapshot.learningPlan, patch.learningPlan);
  applyProjectTitlePatch(snapshot, patch.title);
  if (patch.userProfile !== undefined) {
    snapshot.userProfile = patch.userProfile as ProjectSnapshot['userProfile'];
  }
  if (patch.syllabus !== undefined) snapshot.syllabus = patch.syllabus;
  if (patch.researchCoursePlan !== undefined) {
    snapshot.researchCoursePlan = patch.researchCoursePlan;
  }
  if (patch.researchDossiersBySectionId !== undefined) {
    snapshot.researchDossiersBySectionId = patch.researchDossiersBySectionId;
  }
  if (patch.lastCourseGenerationRunId !== undefined) {
    snapshot.lastCourseGenerationRunId = patch.lastCourseGenerationRunId;
  }
  if (patch.documentAssets !== undefined) snapshot.documentAssets = patch.documentAssets;
  if (patch.documentIndex !== undefined) snapshot.documentIndex = patch.documentIndex;
  if (patch.section) {
    snapshot.learningPlan = patchLearningPlanSection(snapshot.learningPlan, patch.section);
  }

  snapshot.updatedAt = updatedAt;
  return snapshot;
};
