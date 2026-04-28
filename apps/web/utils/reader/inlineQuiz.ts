export interface InlineQuizChunk {
  markdown: string;
  questionIndexes: number[];
}

const HEADING_LINE_REGEX = /^(#{1,6})\s+/;

const trimChunk = (value: string): string => value.trim();

const splitMarkdownByHeadings = (content: string): string[] => {
  const lines = content.split('\n');
  const chunks: string[] = [];
  let currentLines: string[] = [];

  const flushCurrent = () => {
    const chunk = trimChunk(currentLines.join('\n'));
    if (chunk) {
      chunks.push(chunk);
    }
    currentLines = [];
  };

  lines.forEach(line => {
    if (
      HEADING_LINE_REGEX.test(line) &&
      currentLines.some(currentLine => currentLine.trim().length > 0)
    ) {
      flushCurrent();
    }

    currentLines.push(line);
  });

  flushCurrent();
  return chunks;
};

const groupParagraphsIntoChunks = (paragraphs: string[], targetChunkCount: number): string[] => {
  if (paragraphs.length === 0) {
    return [];
  }

  const chunkCount = Math.max(1, Math.min(targetChunkCount, paragraphs.length));
  const chunks: string[] = [];

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const startIndex = Math.floor((chunkIndex * paragraphs.length) / chunkCount);
    const endIndex = Math.floor(((chunkIndex + 1) * paragraphs.length) / chunkCount);
    const chunk = trimChunk(paragraphs.slice(startIndex, endIndex).join('\n\n'));
    if (chunk) {
      chunks.push(chunk);
    }
  }

  return chunks;
};

const splitMarkdownIntoChunks = (content: string, questionCount: number): string[] => {
  const normalizedContent = trimChunk(content);
  if (!normalizedContent) {
    return [];
  }

  const headingChunks = splitMarkdownByHeadings(normalizedContent);
  if (headingChunks.length >= Math.min(Math.max(questionCount, 1), 2)) {
    return headingChunks;
  }

  const paragraphs = normalizedContent
    .split(/\n{2,}/)
    .map(paragraph => trimChunk(paragraph))
    .filter(Boolean);

  if (paragraphs.length <= 1) {
    return headingChunks.length > 0 ? headingChunks : [normalizedContent];
  }

  return groupParagraphsIntoChunks(paragraphs, Math.max(2, questionCount || 1));
};

export const buildInlineQuizLayout = (
  content: string,
  questionCount: number
): InlineQuizChunk[] => {
  const contentChunks = splitMarkdownIntoChunks(content, questionCount);
  if (contentChunks.length === 0) {
    return [];
  }

  const layout = contentChunks.map(markdown => ({
    markdown,
    questionIndexes: [],
  }));

  for (let questionIndex = 0; questionIndex < questionCount; questionIndex += 1) {
    const targetChunkIndex = Math.min(
      layout.length - 1,
      Math.floor(((questionIndex + 1) * layout.length) / (questionCount + 1))
    );
    layout[targetChunkIndex]?.questionIndexes.push(questionIndex);
  }

  return layout;
};
