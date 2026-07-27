import type { LearningPlan } from '../../types.ts';

const APPLICATION_EXERCISE_TITLE_PREFIX = 'Laboratorio pratico';
const TEMPORARY_LAB_LESSON_ID_SUFFIX = '-lab';

export const removeTemporaryMiniLabLessons = (plan: LearningPlan): LearningPlan => {
  let didChange = false;
  const modules = plan.modules.map(module => {
    const children = module.children.filter(child => {
      const isTemporaryLabLesson =
        child.kind === 'lesson' &&
        child.id.endsWith(TEMPORARY_LAB_LESSON_ID_SUFFIX) &&
        child.title.startsWith(`${APPLICATION_EXERCISE_TITLE_PREFIX}:`);
      if (isTemporaryLabLesson) {
        didChange = true;
      }
      return !isTemporaryLabLesson;
    });

    return children.length === module.children.length ? module : { ...module, children };
  });

  return didChange ? { ...plan, modules, applicationExercisePlanningStatus: 'not-run' } : plan;
};
