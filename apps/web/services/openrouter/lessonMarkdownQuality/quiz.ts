import { unwrapWholeQuizCodeFormatting } from '../../../../../packages/shared-types/lessonQuizFormatting.ts';
import { normalizeActivePauseExerciseType } from '../../../utils/learning/activePause.ts';
import { stripInlineQuizMarkers } from '../../../utils/reader/inlineQuiz.ts';
import { getMarkdownHeadings } from '../lessonImages.ts';
import type { QuizQuestion } from '../shared.ts';
import {
  LESSON_QUIZ_OPTION_COUNT,
  MAX_LESSON_QUIZ_QUESTIONS,
  MIN_LESSON_QUIZ_QUESTIONS,
} from './constants.ts';
import { stripMarkdownForSimilarity } from './markdownHeuristics.ts';

// ── Helpers ────────────────────────────────────────────────────────────

const normalizeSimilarityWord = (word: string): string =>
  word
    .toLowerCase()
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .replaceAll(/[^a-z0-9]/g, '');

const countMeaningfulLessonWords = (contentMarkdown: string): number =>
  stripMarkdownForSimilarity(contentMarkdown)
    .split(/\s+/)
    .map(normalizeSimilarityWord)
    .filter(word => word.length >= 2).length;

const BLOCKISH_PARAGRAPH_PREFIX = /^(#{1,6}\s|[-*+]\s|>\s|```|~~~|\|.*\||\{\{PDF_IMAGE:)/;

const normalizeParagraphForDetection = (paragraph: string): string =>
  paragraph
    .replaceAll(/\n+/g, ' ')
    .replaceAll(/[ \t]{2,}/g, ' ')
    .trim();

const countMeaningfulLessonParagraphs = (contentMarkdown: string): number =>
  contentMarkdown
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(
      paragraph =>
        paragraph.length > 0 &&
        !BLOCKISH_PARAGRAPH_PREFIX.test(normalizeParagraphForDetection(paragraph))
    ).length;

// ── Estimate target quiz count ─────────────────────────────────────────

export const estimateTargetQuizCount = (contentMarkdown: string): number => {
  const trimmed = stripInlineQuizMarkers(contentMarkdown).trim();
  if (!trimmed) return MIN_LESSON_QUIZ_QUESTIONS;

  const wordCount = countMeaningfulLessonWords(trimmed);
  const paragraphCount = countMeaningfulLessonParagraphs(trimmed);
  const headingCount = getMarkdownHeadings(trimmed).length;

  if (
    wordCount >= 1600 ||
    (wordCount >= 1200 && paragraphCount >= 8) ||
    (wordCount >= 1400 && headingCount >= 5)
  ) {
    return 3;
  }

  if (wordCount >= 450 || paragraphCount >= 4 || headingCount >= 3) return 2;
  return 1;
};

// ── Quiz sanitization ──────────────────────────────────────────────────

const sanitizeQuizQuestion = (question: QuizQuestion): QuizQuestion => ({
  ...(question.anchorExcerpt?.trim() ? { anchorExcerpt: question.anchorExcerpt.trim() } : {}),
  exerciseType: normalizeActivePauseExerciseType(question.exerciseType),
  question: unwrapWholeQuizCodeFormatting(question.question),
  options: question.options.map(option => unwrapWholeQuizCodeFormatting(option)),
  correctIndex: question.correctIndex,
});

const isValidQuizQuestionPayload = (item: unknown): item is QuizQuestion => {
  if (typeof item !== 'object' || item === null) return false;
  const candidate = item as Partial<QuizQuestion>;
  return (
    typeof candidate.question === 'string' &&
    Array.isArray(candidate.options) &&
    candidate.options.length === LESSON_QUIZ_OPTION_COUNT &&
    candidate.options.every(option => typeof option === 'string') &&
    typeof candidate.correctIndex === 'number' &&
    Number.isInteger(candidate.correctIndex) &&
    candidate.correctIndex >= 0 &&
    candidate.correctIndex < candidate.options.length
  );
};

export const clampLessonQuizCount = (value: number): number =>
  Math.max(MIN_LESSON_QUIZ_QUESTIONS, Math.min(MAX_LESSON_QUIZ_QUESTIONS, value));

export const normalizeQuizLength = (
  quiz: QuizQuestion[],
  targetQuizCount: number
): QuizQuestion[] => quiz.slice(0, clampLessonQuizCount(targetQuizCount)).map(sanitizeQuizQuestion);

export const parseQuizPayload = (value: unknown): QuizQuestion[] =>
  Array.isArray(value) ? value.filter(isValidQuizQuestionPayload).map(sanitizeQuizQuestion) : [];
