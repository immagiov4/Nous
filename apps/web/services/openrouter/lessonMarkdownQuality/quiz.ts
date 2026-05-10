import { normalizeActivePauseExerciseType } from '../../../utils/learning/activePause.ts';
import { getMarkdownHeadings } from '../lessonImages.ts';
import type { QuizQuestion } from '../shared.ts';
import {
  LESSON_QUIZ_OPTION_COUNT,
  MAX_LESSON_QUIZ_QUESTIONS,
  MIN_LESSON_QUIZ_QUESTIONS,
} from './constants.ts';

// ── Helpers ────────────────────────────────────────────────────────────

const stripMarkdownForSimilarity = (value: string): string =>
  value
    .replace(/`[^`]+`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[[^\]]+\]\([^)]+\)/g, ' ')
    .replace(/[*_#>|[\]()`~]/g, ' ')
    .replace(/\{\{PDF_IMAGE:[^}]+\}\}/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeSimilarityWord = (word: string): string =>
  word
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');

const countMeaningfulLessonWords = (contentMarkdown: string): number =>
  stripMarkdownForSimilarity(contentMarkdown)
    .split(/\s+/)
    .map(normalizeSimilarityWord)
    .filter(word => word.length >= 2).length;

const BLOCKISH_PARAGRAPH_PREFIX = /^(#{1,6}\s|[-*+]\s|>\s|```|~~~|\|.*\||\{\{PDF_IMAGE:)/;

const normalizeParagraphForDetection = (paragraph: string): string =>
  paragraph
    .replace(/\n+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
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
  const trimmed = contentMarkdown.trim();
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

const WHOLE_QUIZ_CODE_FENCE_REGEX = /^\s*```(?:[a-z0-9_+-]+)?\s*\n([\s\S]*?)\n```\s*$/i;
const WHOLE_QUIZ_INLINE_CODE_REGEX = /^\s*(`+)([\s\S]*?)\1\s*$/;

const unwrapWholeQuizCodeFormatting = (value: string): string => {
  const trimmedValue = value.trim();
  if (!trimmedValue) return '';

  const fencedMatch = trimmedValue.match(WHOLE_QUIZ_CODE_FENCE_REGEX);
  if (fencedMatch) return fencedMatch[1].trim().replace(/\s*\n+\s*/g, ' ');

  const inlineMatch = trimmedValue.match(WHOLE_QUIZ_INLINE_CODE_REGEX);
  if (!inlineMatch) return trimmedValue;

  const unwrapped = inlineMatch[2].trim();
  return unwrapped ? unwrapped.replace(/\s*\n+\s*/g, ' ') : trimmedValue;
};

const sanitizeQuizQuestion = (question: QuizQuestion): QuizQuestion => ({
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
