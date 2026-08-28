import { ACTIVE_PAUSE_EXERCISE_TYPES, LESSON_VISUAL_TYPES } from './lessonGenerationPolicy';

interface LessonContentBlockLike {
  readonly markdown?: unknown;
  readonly type?: unknown;
}

export const LESSON_MARKDOWN_BLOCK_TYPE = 'markdown' as const;
const LESSON_INLINE_QUIZ_BLOCK_TYPE = 'inline-quiz' as const;
const LESSON_YOUTUBE_CLIPS_BLOCK_TYPE = 'youtube-clips' as const;
const LESSON_GENERATED_VISUAL_BLOCK_TYPE = 'generated-visual' as const;
const LESSON_CONTENT_BLOCK_TYPES = [
  LESSON_MARKDOWN_BLOCK_TYPE,
  LESSON_INLINE_QUIZ_BLOCK_TYPE,
  LESSON_YOUTUBE_CLIPS_BLOCK_TYPE,
  LESSON_GENERATED_VISUAL_BLOCK_TYPE,
] as const;
const VISUAL_COMPLEXITIES = ['simple', 'moderate', 'complex'] as const;
const VISUAL_COVERAGE = ['all_elements', 'single_complex', 'complete_synthesis', 'none'] as const;
const VISUAL_INTERACTION_LEVELS = ['none', 'low', 'high'] as const;

type LessonContentBlockType = (typeof LESSON_CONTENT_BLOCK_TYPES)[number];

const lessonContentBlockTypes = new Set<string>(LESSON_CONTENT_BLOCK_TYPES);
const activePauseExerciseTypes = new Set<string>(ACTIVE_PAUSE_EXERCISE_TYPES);
const lessonVisualTypes = new Set<string>(LESSON_VISUAL_TYPES);
const visualComplexities = new Set<string>(VISUAL_COMPLEXITIES);
const visualCoverage = new Set<string>(VISUAL_COVERAGE);
const visualInteractionLevels = new Set<string>(VISUAL_INTERACTION_LEVELS);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && Boolean(value.trim());

const isOptionalString = (value: unknown): boolean =>
  value === undefined || typeof value === 'string';

const isAllowedString = (value: unknown, allowedValues: ReadonlySet<string>): value is string =>
  typeof value === 'string' && allowedValues.has(value);

const isValidInlineQuizBlock = (block: Record<string, unknown>): boolean => {
  if (!isRecord(block.quiz)) return false;
  const { anchorExcerpt, correctIndex, exerciseType, options, question } = block.quiz;
  return (
    isNonEmptyString(question) &&
    Array.isArray(options) &&
    options.length === 4 &&
    options.every(option => typeof option === 'string') &&
    Number.isInteger(correctIndex) &&
    (correctIndex as number) >= 0 &&
    (correctIndex as number) < options.length &&
    isOptionalString(anchorExcerpt) &&
    (exerciseType === undefined || isAllowedString(exerciseType, activePauseExerciseTypes))
  );
};

const isValidYouTubeClip = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  const { endSeconds, sourceIndex, startSeconds, title } = value;
  return (
    Number.isInteger(sourceIndex) &&
    (sourceIndex as number) >= 0 &&
    typeof startSeconds === 'number' &&
    Number.isFinite(startSeconds) &&
    startSeconds >= 0 &&
    typeof endSeconds === 'number' &&
    Number.isFinite(endSeconds) &&
    endSeconds > startSeconds &&
    isOptionalString(title)
  );
};

const isValidVisualRetryPlan = (value: unknown, slotId: string): boolean => {
  if (!isRecord(value)) return false;
  const requiredStrings = [
    'coverageRationale',
    'pedagogicalGoal',
    'reason',
    'visualDirection',
  ] as const;
  const optionalStrings = ['altText', 'anchorHeading', 'title'] as const;
  return (
    value.slotId === slotId &&
    isNonEmptyString(value.concept) &&
    requiredStrings.every(key => isNonEmptyString(value[key])) &&
    optionalStrings.every(key => isOptionalString(value[key])) &&
    isAllowedString(value.complexity, visualComplexities) &&
    isAllowedString(value.coverage, visualCoverage) &&
    isAllowedString(value.interactionLevel, visualInteractionLevels) &&
    isAllowedString(value.visualType, lessonVisualTypes) &&
    Array.isArray(value.factualRequirements) &&
    value.factualRequirements.every(requirement => typeof requirement === 'string') &&
    typeof value.requiresDepiction === 'boolean'
  );
};

const isValidGeneratedVisualBlock = (block: Record<string, unknown>): boolean => {
  if (!isNonEmptyString(block.slotId)) return false;
  const hasVisualId = block.visualId !== undefined;
  const hasRetryPlan = block.retryPlan !== undefined;
  return (
    (!hasVisualId || isNonEmptyString(block.visualId)) &&
    (!hasRetryPlan || isValidVisualRetryPlan(block.retryPlan, block.slotId)) &&
    (hasVisualId || hasRetryPlan)
  );
};

export const isLessonContentBlockType = (value: unknown): value is LessonContentBlockType =>
  typeof value === 'string' && lessonContentBlockTypes.has(value);

export const isCanonicalLessonContentBlock = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case LESSON_MARKDOWN_BLOCK_TYPE:
      return typeof value.markdown === 'string';
    case LESSON_INLINE_QUIZ_BLOCK_TYPE:
      return isValidInlineQuizBlock(value);
    case LESSON_YOUTUBE_CLIPS_BLOCK_TYPE:
      return Array.isArray(value.clips) && value.clips.every(isValidYouTubeClip);
    case LESSON_GENERATED_VISUAL_BLOCK_TYPE:
      return isValidGeneratedVisualBlock(value);
    default:
      return false;
  }
};

export const deriveLegacyLessonContent = (
  contentBlocks: readonly LessonContentBlockLike[]
): string =>
  contentBlocks
    .flatMap(block =>
      block.type === LESSON_MARKDOWN_BLOCK_TYPE &&
      typeof block.markdown === 'string' &&
      block.markdown.trim()
        ? [block.markdown.trim()]
        : []
    )
    .join('\n\n');
