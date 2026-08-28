interface LessonContentBlockLike {
  readonly markdown?: unknown;
  readonly type?: unknown;
}

export const LESSON_MARKDOWN_BLOCK_TYPE = 'markdown' as const;

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
