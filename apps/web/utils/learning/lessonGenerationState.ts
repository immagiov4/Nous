import type { FileData, LearningPlan, SyllabusItem } from '../../types';
import { flattenLessons } from './pathNodes.ts';

export type LessonGenerationState = 'blocked-missing-source' | 'learn-mode' | 'source-backed';

interface ResolveLessonGenerationStateArgs {
  file: FileData | null;
  hasResearchContext?: boolean;
  hasToolBackedSource?: boolean;
  isLearnMode: boolean;
  learningPlan: LearningPlan | null;
  syllabus: SyllabusItem[];
}

export const resolveLessonGenerationState = ({
  file,
  hasResearchContext = false,
  hasToolBackedSource = false,
  isLearnMode,
  learningPlan,
  syllabus,
}: ResolveLessonGenerationStateArgs): LessonGenerationState => {
  const hasParentIds = Boolean(
    flattenLessons(learningPlan?.modules).some(section => Boolean(section.parentId))
  );
  const canGenerateInLearnMode =
    isLearnMode || hasResearchContext || syllabus.length > 0 || hasParentIds;

  if (!file && !hasToolBackedSource && !canGenerateInLearnMode) {
    return 'blocked-missing-source';
  }

  return !file && canGenerateInLearnMode && !hasToolBackedSource ? 'learn-mode' : 'source-backed';
};
