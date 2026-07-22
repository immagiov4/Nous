import type {
  LessonContentBlock,
  LessonGeneratedVisual,
  LessonYouTubeClipsBlock,
  QuizQuestion,
} from '../../types.ts';

const STRUCTURAL_MARKER =
  /\{\{(?:INLINE_QUIZ|YOUTUBE_CLIP_SOURCE|VISUAL_SLOT|VISUAL_EXAMPLE):[^}]+}}/g;
const INLINE_QUIZ_PREFIX = '{{INLINE_QUIZ:';
const YOUTUBE_CLIP_PREFIX = '{{YOUTUBE_CLIP_SOURCE:';
const VISUAL_SLOT_PREFIX = '{{VISUAL_SLOT:';
const VISUAL_EXAMPLE_PREFIX = '{{VISUAL_EXAMPLE:';

export const lessonContentBlocksToLegacyMarkdown = (blocks: LessonContentBlock[]): string => {
  let quizIndex = 0;
  return blocks
    .map(block => {
      switch (block.type) {
        case 'markdown':
          return block.markdown.trim();
        case 'inline-quiz':
          return `{{INLINE_QUIZ:${quizIndex++}}}`;
        case 'youtube-clips':
          return block.clips
            .map(
              clip =>
                `{{YOUTUBE_CLIP_SOURCE:${clip.sourceIndex}|START:${clip.startSeconds}|END:${clip.endSeconds}}}`
            )
            .join('\n');
        case 'generated-visual':
          return block.visualId
            ? `{{VISUAL_EXAMPLE:${block.visualId}}}`
            : `{{VISUAL_SLOT:${block.slotId}}}`;
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
};

export const legacyMarkdownToLessonContentBlocks = (
  content: string,
  quiz: QuizQuestion[] = []
): LessonContentBlock[] => {
  const blocks: LessonContentBlock[] = [];
  let cursor = 0;
  for (const match of content.matchAll(STRUCTURAL_MARKER)) {
    const index = match.index ?? 0;
    const markdown = content.slice(cursor, index).trim();
    if (markdown) blocks.push({ markdown, type: 'markdown' });
    appendLegacyMarkerBlock(blocks, match[0], quiz);
    cursor = index + match[0].length;
  }
  const trailingMarkdown = content.slice(cursor).trim();
  if (trailingMarkdown) blocks.push({ markdown: trailingMarkdown, type: 'markdown' });
  return blocks;
};

const getMarkerPayload = (marker: string, prefix: string): string =>
  marker.slice(prefix.length, -2).trim();

const appendLegacyMarkerBlock = (
  blocks: LessonContentBlock[],
  marker: string,
  quiz: QuizQuestion[]
): void => {
  if (marker.startsWith(INLINE_QUIZ_PREFIX)) {
    const question = quiz[Number.parseInt(getMarkerPayload(marker, INLINE_QUIZ_PREFIX), 10)];
    if (question) blocks.push({ quiz: question, type: 'inline-quiz' });
    return;
  }
  if (marker.startsWith(YOUTUBE_CLIP_PREFIX)) {
    appendLegacyYouTubeClip(blocks, getMarkerPayload(marker, YOUTUBE_CLIP_PREFIX));
    return;
  }
  const visualId = marker.startsWith(VISUAL_EXAMPLE_PREFIX)
    ? getMarkerPayload(marker, VISUAL_EXAMPLE_PREFIX).split('|')[0]?.trim()
    : undefined;
  if (visualId) {
    blocks.push({ slotId: `legacy:${visualId}`, type: 'generated-visual', visualId });
    return;
  }
  const slotId = marker.startsWith(VISUAL_SLOT_PREFIX)
    ? getMarkerPayload(marker, VISUAL_SLOT_PREFIX)
    : '';
  if (slotId) blocks.push({ slotId, type: 'generated-visual' });
};

const appendLegacyYouTubeClip = (blocks: LessonContentBlock[], payload: string): void => {
  const [sourcePart, startPart, endPart] = payload.split('|');
  const clip = {
    sourceIndex: Number.parseInt(sourcePart ?? '', 10),
    startSeconds: Number.parseInt(startPart?.replace('START:', '') ?? '', 10),
    endSeconds: Number.parseInt(endPart?.replace('END:', '') ?? '', 10),
  };
  const previous = blocks.at(-1);
  if (previous?.type === 'youtube-clips') previous.clips.push(clip);
  else blocks.push({ clips: [clip], type: 'youtube-clips' });
};

export const normalizeLessonContentBlocks = (value: unknown): LessonContentBlock[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap(normalizeLessonContentBlock);
};

const normalizeLessonContentBlock = (entry: unknown): LessonContentBlock[] => {
  if (!entry || typeof entry !== 'object') return [];
  const block = entry as Record<string, unknown>;
  switch (block.type) {
    case 'markdown':
      return normalizeMarkdownBlock(block);
    case 'inline-quiz':
      return normalizeInlineQuizBlock(block);
    case 'generated-visual':
      return normalizeGeneratedVisualBlock(block);
    case 'youtube-clips':
      return normalizeYouTubeClipsBlock(block);
    default:
      return [];
  }
};

const normalizeMarkdownBlock = (block: Record<string, unknown>): LessonContentBlock[] => {
  const markdown = typeof block.markdown === 'string' ? block.markdown.trim() : '';
  return markdown ? [{ markdown, type: 'markdown' }] : [];
};

const normalizeInlineQuizBlock = (block: Record<string, unknown>): LessonContentBlock[] => {
  if (!block.quiz || typeof block.quiz !== 'object') return [];
  const quiz = block.quiz as QuizQuestion;
  return typeof quiz.question === 'string' &&
    Array.isArray(quiz.options) &&
    Number.isInteger(quiz.correctIndex)
    ? [{ quiz, type: 'inline-quiz' }]
    : [];
};

const normalizeGeneratedVisualBlock = (block: Record<string, unknown>): LessonContentBlock[] => {
  const slotId = typeof block.slotId === 'string' ? block.slotId.trim() : '';
  if (!slotId) return [];
  const visualId = typeof block.visualId === 'string' ? block.visualId.trim() : '';
  return [{ slotId, type: 'generated-visual', ...(visualId ? { visualId } : {}) }];
};

const normalizeYouTubeClipsBlock = (block: Record<string, unknown>): LessonContentBlock[] => {
  if (!Array.isArray(block.clips)) return [];
  const clips = block.clips.flatMap(normalizeYouTubeClip);
  return clips.length ? [{ clips, type: 'youtube-clips' }] : [];
};

const normalizeYouTubeClip = (clip: unknown): LessonYouTubeClipsBlock['clips'] => {
  if (!clip || typeof clip !== 'object') return [];
  const candidate = clip as Record<string, unknown>;
  const sourceIndex = Number(candidate.sourceIndex);
  const startSeconds = Number(candidate.startSeconds);
  const endSeconds = Number(candidate.endSeconds);
  if (
    !Number.isInteger(sourceIndex) ||
    sourceIndex < 0 ||
    startSeconds < 0 ||
    endSeconds <= startSeconds
  ) {
    return [];
  }
  const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
  return [{ endSeconds, sourceIndex, startSeconds, ...(title ? { title } : {}) }];
};

export const hasValidTypedQuizBlocks = (
  blocks: LessonContentBlock[],
  options: { exact?: number; max?: number; min?: number }
): boolean => {
  const quizBlocks = blocks.filter(block => block.type === 'inline-quiz');
  return (
    (options.exact === undefined || quizBlocks.length === options.exact) &&
    (options.min === undefined || quizBlocks.length >= options.min) &&
    (options.max === undefined || quizBlocks.length <= options.max) &&
    blocks.every(
      (block, index) =>
        block.type !== 'inline-quiz' || (index > 0 && blocks[index - 1]?.type !== 'inline-quiz')
    )
  );
};

export const deriveQuizFromLessonContentBlocks = (
  blocks: LessonContentBlock[]
): import('../../types.ts').QuizQuestion[] =>
  blocks.filter(block => block.type === 'inline-quiz').map(block => block.quiz);

export const materializeGeneratedVisualBlocks = (
  blocks: LessonContentBlock[],
  plans: Array<{ slotId: string }>,
  visuals: LessonGeneratedVisual[]
): LessonContentBlock[] => {
  const visualIdBySlotId = new Map(
    plans.flatMap((plan, index) => {
      const visual = visuals[index];
      return visual ? [[plan.slotId, visual.id] as const] : [];
    })
  );
  return blocks.flatMap((block): LessonContentBlock[] => {
    if (block.type !== 'generated-visual') return [block];
    const visualId = visualIdBySlotId.get(block.slotId);
    return visualId ? [{ ...block, visualId }] : [];
  });
};
