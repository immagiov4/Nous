import {
  ACTIVE_PAUSE_EXERCISE_TYPES,
  type ActivePauseExerciseType,
} from '@shared/lessonGenerationPolicy';
import { type AppLocale, translateUiMessage as t, type UiMessage } from '../../i18n/uiMessages.ts';
import type { QuizQuestion } from '../../types.ts';

export { ACTIVE_PAUSE_EXERCISE_PROMPT_GUIDE } from '@shared/lessonGenerationPolicy';

export const DEFAULT_ACTIVE_PAUSE_EXERCISE_TYPE: ActivePauseExerciseType = 'concept-check';

const ACTIVE_PAUSE_EXERCISE_LABELS: Record<ActivePauseExerciseType, UiMessage> = {
  'application-card': 'Applicazione lampo',
  classification: 'Classificazione',
  'compare-contrast': 'Confronto',
  'concept-check': 'Controllo concettuale',
  'error-diagnosis': 'Diagnosi errore',
  'micro-synthesis': 'Micro-sintesi',
  prediction: 'Previsione',
  sequence: 'Sequenza',
};

const ACTIVE_PAUSE_EXERCISE_TYPE_SET = new Set<string>(ACTIVE_PAUSE_EXERCISE_TYPES);

export const normalizeActivePauseExerciseType = (value: unknown): ActivePauseExerciseType =>
  typeof value === 'string' && ACTIVE_PAUSE_EXERCISE_TYPE_SET.has(value)
    ? (value as ActivePauseExerciseType)
    : DEFAULT_ACTIVE_PAUSE_EXERCISE_TYPE;

export const getActivePauseExerciseLabel = (
  question: Pick<QuizQuestion, 'exerciseType'>,
  locale?: AppLocale
) =>
  t(
    ACTIVE_PAUSE_EXERCISE_LABELS[normalizeActivePauseExerciseType(question.exerciseType)],
    undefined,
    locale
  );
