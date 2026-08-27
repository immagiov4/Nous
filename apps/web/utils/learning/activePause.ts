import {
  ACTIVE_PAUSE_EXERCISE_TYPES,
  type ActivePauseExerciseType,
} from '@shared/lessonGenerationPolicy';

export { ACTIVE_PAUSE_EXERCISE_PROMPT_GUIDE } from '@shared/lessonGenerationPolicy';

export const DEFAULT_ACTIVE_PAUSE_EXERCISE_TYPE: ActivePauseExerciseType = 'concept-check';

const ACTIVE_PAUSE_EXERCISE_TYPE_SET = new Set<string>(ACTIVE_PAUSE_EXERCISE_TYPES);

export const normalizeActivePauseExerciseType = (value: unknown): ActivePauseExerciseType =>
  typeof value === 'string' && ACTIVE_PAUSE_EXERCISE_TYPE_SET.has(value)
    ? (value as ActivePauseExerciseType)
    : DEFAULT_ACTIVE_PAUSE_EXERCISE_TYPE;
