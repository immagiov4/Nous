import { normalizeMarkdownForRendering } from '../../../utils/markdown/render.ts';
import { normalizeLineEndings } from '../../../utils/text.ts';
import { sanitizeAssetIdMentions } from '../lessonImages.ts';

const trimLineTrailingWhitespace = (line: string): string => {
  let endIndex = line.length;

  while (endIndex > 0) {
    const character = line[endIndex - 1];
    if (character !== ' ' && character !== '\t') {
      break;
    }

    endIndex -= 1;
  }

  return endIndex === line.length ? line : line.slice(0, endIndex);
};

const insertHeadingSpacing = (contentMarkdown: string): string => {
  const lines = contentMarkdown.split('\n');
  const normalizedLines: string[] = [];

  for (const line of lines) {
    const trimmedLine = line.trimStart();
    const isHeading =
      trimmedLine.startsWith('# ') ||
      trimmedLine.startsWith('## ') ||
      trimmedLine.startsWith('### ') ||
      trimmedLine.startsWith('#### ') ||
      trimmedLine.startsWith('##### ') ||
      trimmedLine.startsWith('###### ');

    if (isHeading && normalizedLines.length > 0 && normalizedLines.at(-1) !== '') {
      normalizedLines.push('');
    }

    normalizedLines.push(line);
  }

  return normalizedLines.join('\n');
};

// ── Strip helpers ──────────────────────────────────────────────────────

const stripModelMarkdownImages = (contentMarkdown: string): string =>
  contentMarkdown
    .replaceAll(/!\[[^\]]*]\([^)\n]*\)/g, '')
    .replaceAll(/<img\b[^>]*>/gi, '')
    .replaceAll(/\n{3,}/g, '\n\n');

// ── Spacing prettification ─────────────────────────────────────────────

const prettifyMarkdownSpacing = (contentMarkdown: string): string =>
  insertHeadingSpacing(
    normalizeLineEndings(contentMarkdown).split('\n').map(trimLineTrailingWhitespace).join('\n')
  )
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();

// ── Public export ──────────────────────────────────────────────────────

export const sanitizeLessonMarkdownContent = (
  contentMarkdown: string,
  visibleLabelByAssetId?: Map<string, string>
): string => {
  let next = contentMarkdown || '';

  if (visibleLabelByAssetId) {
    next = sanitizeAssetIdMentions(next, visibleLabelByAssetId);
  }

  next = stripModelMarkdownImages(next);
  return normalizeMarkdownForRendering(prettifyMarkdownSpacing(next));
};
