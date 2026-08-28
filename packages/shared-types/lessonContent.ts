interface LessonContentBlockLike {
  readonly markdown?: unknown;
  readonly type?: unknown;
}

export const LESSON_MARKDOWN_BLOCK_TYPE = 'markdown' as const;
export const LESSON_CONTENT_BLOCK_TYPES = [
  LESSON_MARKDOWN_BLOCK_TYPE,
  'inline-quiz',
  'youtube-clips',
  'generated-visual',
] as const;

export type LessonContentBlockType = (typeof LESSON_CONTENT_BLOCK_TYPES)[number];

const lessonContentBlockTypes = new Set<string>(LESSON_CONTENT_BLOCK_TYPES);

export const isLessonContentBlockType = (value: unknown): value is LessonContentBlockType =>
  typeof value === 'string' && lessonContentBlockTypes.has(value);

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
