interface LessonContentBlockLike {
  readonly markdown?: unknown;
  readonly type?: unknown;
}

export const deriveLegacyLessonContent = (
  contentBlocks: readonly LessonContentBlockLike[]
): string =>
  contentBlocks
    .flatMap(block =>
      block.type === 'markdown' && typeof block.markdown === 'string' && block.markdown.trim()
        ? [block.markdown.trim()]
        : []
    )
    .join('\n\n');
