import type { LearningPlan, LearningSection, SyllabusItem, UserProfile } from '../../../types.ts';
import { flattenLessons } from '../../../utils/learning/pathNodes.ts';
import { groupSectionsIntoModules } from '../../learning/groupSectionsIntoModules.ts';

export const buildLearningPlanFromSyllabus = (
  profile: UserProfile,
  syllabus: SyllabusItem[]
): LearningPlan => {
  const sections: LearningSection[] = syllabus.flatMap(module =>
    (module.children || []).map(lesson => ({
      id: lesson.id,
      title: lesson.title,
      description: lesson.description,
      isCompleted: false,
      type: 'core' as const,
      parentId: module.id,
      contextPrompt: lesson.contextPrompt,
    }))
  );

  return {
    title: profile.topic,
    summary: profile.context,
    modules: groupSectionsIntoModules(sections),
    applicationExercisePlanningStatus: 'not-run',
  };
};

export const resolveLearnSectionContext = (
  section: LearningSection,
  learningPlan: LearningPlan | null,
  syllabus: SyllabusItem[]
): {
  anchorLessonId: string;
  anchorLessonContextPrompt?: string;
  moduleId: string;
  moduleTitle: string;
} => {
  const sectionById = new Map(flattenLessons(learningPlan?.modules).map(item => [item.id, item]));
  const moduleById = new Map(syllabus.map(module => [module.id, module]));

  let currentSection: LearningSection | undefined = section;
  let anchorLesson = section;
  let moduleId = '';
  let moduleTitle = '';
  const visited = new Set<string>();

  while (currentSection && !visited.has(currentSection.id)) {
    visited.add(currentSection.id);
    anchorLesson = currentSection;

    if (currentSection.parentId && moduleById.has(currentSection.parentId)) {
      moduleId = currentSection.parentId;
      moduleTitle = moduleById.get(currentSection.parentId)?.title || '';
      break;
    }

    currentSection = currentSection.parentId ? sectionById.get(currentSection.parentId) : undefined;
  }

  return {
    anchorLessonId: anchorLesson.id,
    anchorLessonContextPrompt: anchorLesson.contextPrompt,
    moduleId,
    moduleTitle,
  };
};
