import type { FileData, LearningPlan, SyllabusItem } from '../../types';
import { flattenLessons } from './pathNodes.ts';

export type LessonGenerationState = 'blocked-missing-source' | 'learn-mode' | 'source-backed';

interface ResolveLessonGenerationStateArgs {
  file: FileData | null;
  isLearnMode: boolean;
  learningPlan: LearningPlan | null;
  syllabus: SyllabusItem[];
}

export const resolveLessonGenerationState = ({
  file,
  isLearnMode,
  learningPlan,
  syllabus,
}: ResolveLessonGenerationStateArgs): LessonGenerationState => {
  const hasParentIds = Boolean(
    flattenLessons(learningPlan?.modules).some(section => Boolean(section.parentId))
  );
  const canGenerateInLearnMode = isLearnMode || syllabus.length > 0 || hasParentIds;

  if (!file && !canGenerateInLearnMode) {
    return 'blocked-missing-source';
  }

  return !file && canGenerateInLearnMode ? 'learn-mode' : 'source-backed';
};
