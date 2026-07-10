import { type AppLocale, translateUiMessage as t, type UiMessage } from '../../i18n/uiMessages.ts';
import {
  ACTIVE_PAUSE_EXERCISE_TYPES,
  type ActivePauseExerciseType,
  type QuizQuestion,
} from '../../types.ts';

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

export const ACTIVE_PAUSE_EXERCISE_PROMPT_GUIDE: Array<{
  type: ActivePauseExerciseType;
  instruction: string;
}> = [
  {
    type: 'concept-check',
    instruction:
      'Controllo concettuale: scegli l affermazione che coglie meglio una distinzione appena spiegata.',
  },
  {
    type: 'application-card',
    instruction:
      'Applicazione lampo: applica un concetto a un mini-caso nuovo, concreto e risolvibile in pochi secondi.',
  },
  {
    type: 'prediction',
    instruction:
      'Previsione: prevedi la conseguenza piu probabile se cambia una condizione, un passaggio o un vincolo.',
  },
  {
    type: 'error-diagnosis',
    instruction:
      'Diagnosi errore: individua l errore, l assunzione falsa o la correzione migliore in un ragionamento breve.',
  },
  {
    type: 'classification',
    instruction:
      'Classificazione: assegna un esempio, un caso o un fenomeno alla categoria piu adatta.',
  },
  {
    type: 'compare-contrast',
    instruction:
      'Confronto: scegli la differenza, somiglianza o implicazione che separa correttamente due concetti.',
  },
  {
    type: 'sequence',
    instruction: 'Sequenza: scegli l ordine corretto di passaggi, cause, condizioni o priorita.',
  },
  {
    type: 'micro-synthesis',
    instruction:
      'Micro-sintesi: scegli la sintesi, etichetta o connessione piu fedele tra due idee appena viste.',
  },
];

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
