import type { QuizQuestion } from '../../types.ts';

export interface InlineQuizChunk {
  markdown: string;
  questionIndexes: number[];
}

const QUIZ_MARKER_PREFIX = '{{INLINE_QUIZ:';
const QUIZ_MARKER_REGEX = /\{\{INLINE_QUIZ:(\d+)}}/g;

const findParagraphEndOffset = (content: string, excerptEndOffset: number): number => {
  const paragraphBreakOffset = content.indexOf('\n\n', excerptEndOffset);
  return paragraphBreakOffset >= 0 ? paragraphBreakOffset : content.length;
};

const materializeQuizMarkers = (content: string, questions: QuizQuestion[]): string => {
  const insertions = questions.map((question, questionIndex) => {
    const excerpt = question.anchorExcerpt?.trim();
    const excerptOffset = excerpt ? content.indexOf(excerpt) : -1;
    return {
      offset:
        excerptOffset >= 0
          ? findParagraphEndOffset(content, excerptOffset + (excerpt?.length || 0))
          : content.length,
      questionIndex,
    };
  });

  return insertions
    .sort((left, right) => right.offset - left.offset || right.questionIndex - left.questionIndex)
    .reduce(
      (current, insertion) =>
        `${current.slice(0, insertion.offset)}\n\n${QUIZ_MARKER_PREFIX}${insertion.questionIndex}}}\n\n${current.slice(insertion.offset)}`,
      content.trim()
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

export const buildInlineQuizLayout = (
  content: string,
  questionsOrCount: QuizQuestion[] | number
): InlineQuizChunk[] => {
  const questions =
    typeof questionsOrCount === 'number'
      ? Array.from({ length: questionsOrCount }, () => ({
          correctIndex: 0,
          options: [],
          question: '',
        }))
      : questionsOrCount;
  const markedContent = materializeQuizMarkers(content, questions);
  const chunks: InlineQuizChunk[] = [];
  let lastIndex = 0;
  QUIZ_MARKER_REGEX.lastIndex = 0;

  for (const match of markedContent.matchAll(QUIZ_MARKER_REGEX)) {
    const matchIndex = match.index ?? 0;
    const markdown = markedContent.slice(lastIndex, matchIndex).trim();
    if (markdown) {
      chunks.push({ markdown, questionIndexes: [] });
    }
    const questionIndex = Number.parseInt(match[1] || '', 10);
    const targetChunk = chunks.at(-1);
    if (targetChunk && Number.isInteger(questionIndex)) {
      targetChunk.questionIndexes.push(questionIndex);
    }
    lastIndex = matchIndex + match[0].length;
  }

  const trailingMarkdown = markedContent.slice(lastIndex).trim();
  if (trailingMarkdown) {
    chunks.push({ markdown: trailingMarkdown, questionIndexes: [] });
  }
  return chunks;
};
