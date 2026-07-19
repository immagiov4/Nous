import { ACTIVE_PAUSE_EXERCISE_PROMPT_GUIDE } from '../../../utils/learning/activePause.ts';
import {
  callOpenRouter,
  MODEL_REASONING,
  type QuizQuestion,
  retryWithBackoff,
  teacherInstruction,
} from '../shared.ts';
import {
  LESSON_QUIZ_OPTION_COUNT,
  MAX_LESSON_QUIZ_QUESTIONS,
  MIN_LESSON_QUIZ_QUESTIONS,
} from './constants.ts';
import { clampLessonQuizCount, estimateTargetQuizCount, normalizeQuizLength } from './quiz.ts';

const ACTIVE_PAUSE_TYPE_RULES = ACTIVE_PAUSE_EXERCISE_PROMPT_GUIDE.map(
  exercise => `- ${exercise.type}: ${exercise.instruction}`
).join('\n');

const buildStandaloneQuizSchema = (exactQuizCount: number) =>
  ({
    name: 'nous_lesson_quiz_only',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quiz: {
          type: 'array',
          minItems: exactQuizCount,
          maxItems: exactQuizCount,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              exerciseType: {
                type: 'string',
                enum: ACTIVE_PAUSE_EXERCISE_PROMPT_GUIDE.map(exercise => exercise.type),
              },
              question: { type: 'string' },
              options: {
                type: 'array',
                minItems: LESSON_QUIZ_OPTION_COUNT,
                maxItems: LESSON_QUIZ_OPTION_COUNT,
                items: { type: 'string' },
              },
              correctIndex: {
                type: 'integer',
                minimum: 0,
                maximum: LESSON_QUIZ_OPTION_COUNT - 1,
              },
            },
            required: ['exerciseType', 'question', 'options', 'correctIndex'],
          },
        },
      },
      required: ['quiz'],
    },
  }) as const;

export const generateStandaloneLessonQuiz = async (args: {
  contentMarkdown: string;
  sectionTitle: string;
  language?: string;
}): Promise<QuizQuestion[]> => {
  const trimmedContent = args.contentMarkdown.trim();
  if (!trimmedContent) {
    return [];
  }

  const targetQuizCount = clampLessonQuizCount(estimateTargetQuizCount(trimmedContent));
  const language = args.language?.trim() || 'Italiano';

  const prompt = `Sei il Professor Nous. Devi generare ESATTAMENTE ${targetQuizCount} domanda/e di "active pause" per la lezione che segue.

REGOLE:
- ${LESSON_QUIZ_OPTION_COUNT} opzioni per domanda, esattamente una corretta (correctIndex 0-${LESSON_QUIZ_OPTION_COUNT - 1}).
- Domande basate ESCLUSIVAMENTE sui contenuti presenti nella lezione: niente nozioni esterne.
- Le domande devono testare la comprensione concettuale, non il ricordo letterale di frasi.
- Le opzioni distrattori devono essere plausibili, non assurde.
- Lingua: ${language}.

TIPI DI ESERCIZIO DISPONIBILI (scegli quello piu adatto per ogni domanda):
${ACTIVE_PAUSE_TYPE_RULES}

LEZIONE (titolo: "${args.sectionTitle}"):
${trimmedContent}`;

  const schema = buildStandaloneQuizSchema(targetQuizCount);

  const response = await retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_REASONING,
        modelSlot: 'lesson',
        temperature: 0.2,
        messages: [
          { role: 'system', content: teacherInstruction },
          { role: 'user', content: prompt },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: schema,
        },
      }),
    2,
    1000
  );

  if (!response) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch (error) {
    console.warn('[Nous][StandaloneQuiz] Failed to parse quiz JSON', { error });
    return [];
  }

  const quizArray =
    parsed && typeof parsed === 'object' && 'quiz' in (parsed as Record<string, unknown>)
      ? (parsed as { quiz?: unknown }).quiz
      : null;

  if (!Array.isArray(quizArray)) {
    return [];
  }

  const validatedQuiz = quizArray.filter((item): item is QuizQuestion => {
    if (!item || typeof item !== 'object') return false;
    const candidate = item as Partial<QuizQuestion>;
    const correctIndex = candidate.correctIndex;
    return (
      typeof candidate.question === 'string' &&
      Array.isArray(candidate.options) &&
      candidate.options.length === LESSON_QUIZ_OPTION_COUNT &&
      candidate.options.every(option => typeof option === 'string') &&
      Number.isInteger(correctIndex) &&
      typeof correctIndex === 'number' &&
      correctIndex >= 0 &&
      correctIndex < LESSON_QUIZ_OPTION_COUNT
    );
  });

  return normalizeQuizLength(validatedQuiz, targetQuizCount).slice(
    0,
    Math.max(MIN_LESSON_QUIZ_QUESTIONS, Math.min(MAX_LESSON_QUIZ_QUESTIONS, targetQuizCount))
  );
};
