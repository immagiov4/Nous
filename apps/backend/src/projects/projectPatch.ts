import { isRecord } from '../utils/validation.js';
import type {
  LearningPlanNodeSnapshot,
  LearningPlanSnapshot,
  ProjectPatch,
  ProjectSnapshot,
  SectionPatch,
} from './types.js';

const LEARNING_PLAN_NOT_FOUND_ERROR = 'Learning plan non trovato';

const applySectionPatchToNode = (
  node: LearningPlanNodeSnapshot,
  sectionPatch: SectionPatch
): LearningPlanNodeSnapshot => ({
  ...node,
  ...(sectionPatch.annotations !== undefined ? { annotations: sectionPatch.annotations } : {}),
  ...(sectionPatch.content !== undefined ? { content: sectionPatch.content } : {}),
  ...(sectionPatch.generatedVisuals !== undefined
    ? { generatedVisuals: sectionPatch.generatedVisuals }
    : {}),
  ...(sectionPatch.imageRefs !== undefined ? { imageRefs: sectionPatch.imageRefs } : {}),
  ...(sectionPatch.isCompleted !== undefined ? { isCompleted: sectionPatch.isCompleted } : {}),
  ...(sectionPatch.learningAids !== undefined ? { learningAids: sectionPatch.learningAids } : {}),
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

export const applyProjectPatch = (
  existing: ProjectSnapshot,
  patch: ProjectPatch,
  updatedAt: string
): ProjectSnapshot => {
  const snapshot = { ...existing };

  if (patch.activeSectionId !== undefined) snapshot.activeSectionId = patch.activeSectionId;
  if (patch.state !== undefined) snapshot.state = patch.state;
  if (patch.isLearnMode !== undefined) snapshot.isLearnMode = patch.isLearnMode;
  if (patch.source !== undefined) snapshot.source = patch.source as ProjectSnapshot['source'];
  if (patch.learningPlan !== undefined) {
    snapshot.learningPlan = patch.learningPlan as ProjectSnapshot['learningPlan'];
  }
  if (patch.title !== undefined) {
    snapshot.title = patch.title;
    if (snapshot.learningPlan) {
      snapshot.learningPlan = { ...snapshot.learningPlan, title: patch.title };
    }
  }
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
  if (patch.documentAssets !== undefined) snapshot.documentAssets = patch.documentAssets;
  if (patch.documentIndex !== undefined) snapshot.documentIndex = patch.documentIndex;
  if (patch.section) {
    snapshot.learningPlan = patchLearningPlanSection(snapshot.learningPlan, patch.section);
  }

  snapshot.updatedAt = updatedAt;
  return snapshot;
};
