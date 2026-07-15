import { normalizeMarkdownForRendering } from '../../../utils/markdown/render.ts';
import { normalizeLineEndings } from '../../../utils/text.ts';
import { sanitizeAssetIdMentions } from '../lessonImages.ts';
import type { QuizQuestion } from '../shared.ts';
import { parseLabelBodyPair, parseStandaloneLabel } from './markdownHeuristics.ts';
import {
  collapseRedundantParagraphs,
  isBlockishParagraph,
  normalizeParagraphForDetection,
} from './repetition.ts';

export { collapseRedundantParagraphs } from './repetition.ts';

const MAX_LIST_LABEL_WORDS = 12;

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

    if (
      isHeading &&
      normalizedLines.length > 0 &&
      normalizedLines[normalizedLines.length - 1] !== ''
    ) {
      normalizedLines.push('');
    }

    normalizedLines.push(line);
  }

  return normalizedLines.join('\n');
};

// ── Pseudo-list normalization ──────────────────────────────────────────

const isReasonableListLabel = (label: string): boolean => {
  const trimmed = label.trim();
  if (!trimmed || trimmed.length > 90 || !/^[A-ZÀ-ÖØ-Þ]/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  return words.length <= MAX_LIST_LABEL_WORDS;
};

const toStandaloneSubheading = (paragraph: string): string | null => {
  const normalized = normalizeParagraphForDetection(paragraph);
  if (isBlockishParagraph(normalized)) return null;
  const label = parseStandaloneLabel(normalized);
  if (!label) return null;
  return isReasonableListLabel(label) ? `#### ${label}` : null;
};

const toListItemParagraph = (paragraph: string): string | null => {
  const normalized = normalizeParagraphForDetection(paragraph);
  if (isBlockishParagraph(normalized)) return null;
  const parsedPair = parseLabelBodyPair(normalized);
  if (!parsedPair) return null;
  const { body, label } = parsedPair;
  if (!isReasonableListLabel(label) || !body) return null;
  return `- **${label}**: ${body}`;
};

const normalizePseudoLists = (contentMarkdown: string): string => {
  const paragraphs = contentMarkdown
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);

  const normalizedParagraphs: string[] = [];

  for (let index = 0; index < paragraphs.length; ) {
    const standaloneSubheading = toStandaloneSubheading(paragraphs[index]);
    if (standaloneSubheading) {
      normalizedParagraphs.push(standaloneSubheading);
      index += 1;
      continue;
    }

    const listItems: string[] = [];
    let cursor = index;

    while (cursor < paragraphs.length) {
      const item = toListItemParagraph(paragraphs[cursor]);
      if (!item) break;
      listItems.push(item);
      cursor += 1;
    }

    if (listItems.length >= 2) {
      normalizedParagraphs.push(listItems.join('\n'));
      index = cursor;
      continue;
    }

    normalizedParagraphs.push(paragraphs[index]);
    index += 1;
  }

  return normalizedParagraphs.join('\n\n');
};

// ── Strip helpers ──────────────────────────────────────────────────────

const stripModelMarkdownImages = (contentMarkdown: string): string =>
  contentMarkdown
    .replace(/!\[[^\]]*]\([^)\n]*\)/g, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n');

const QUIZ_SECTION_HEADING_REGEX =
  /^\s{0,3}(#{1,6}\s*(?:quiz|verifica|domande(?:\s+di\s+verifica)?|test\s+finale|quiz\s+finale|domande\s+finali)\s*)$/gim;

const stripStructuredQuizFromMarkdown = (
  contentMarkdown: string,
  structuredQuiz: QuizQuestion[]
): string => {
  if (structuredQuiz.length === 0) return contentMarkdown;

  const headingMatch = Array.from(contentMarkdown.matchAll(QUIZ_SECTION_HEADING_REGEX))[0];
  if (headingMatch?.index !== undefined) {
    return contentMarkdown.slice(0, headingMatch.index).trim();
  }

  const paragraphs = contentMarkdown
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return contentMarkdown.trim();

  let firstQuizParagraphIndex = -1;
  for (let index = 0; index < paragraphs.length; index += 1) {
    const looksLikeQuizIntro =
      /^(quiz|verifica|domande(?:\s+di\s+verifica)?|test\s+finale)/i.test(paragraphs[index]) ||
      (paragraphs[index].toLowerCase().includes('domanda 1') &&
        paragraphs[index].toLowerCase().includes('risposta')) ||
      (paragraphs[index].includes('1.') &&
        paragraphs[index].includes('2.') &&
        paragraphs[index].includes('3.'));
    if (looksLikeQuizIntro) {
      firstQuizParagraphIndex = index;
      break;
    }
  }

  if (firstQuizParagraphIndex === -1) return contentMarkdown.trim();
  return paragraphs.slice(0, firstQuizParagraphIndex).join('\n\n').trim();
};

// ── Spacing prettification ─────────────────────────────────────────────

const prettifyMarkdownSpacing = (contentMarkdown: string): string =>
  normalizePseudoLists(
    insertHeadingSpacing(
      normalizeLineEndings(contentMarkdown).split('\n').map(trimLineTrailingWhitespace).join('\n')
    )
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );

// ── Public export ──────────────────────────────────────────────────────

export const sanitizeLessonMarkdownContent = (
  contentMarkdown: string,
  structuredQuiz: QuizQuestion[],
  visibleLabelByAssetId?: Map<string, string>
): string => {
  let next = contentMarkdown || '';

  if (visibleLabelByAssetId) {
    next = sanitizeAssetIdMentions(next, visibleLabelByAssetId);
  }

  next = stripModelMarkdownImages(next);
  next = stripStructuredQuizFromMarkdown(next, structuredQuiz);
  next = collapseRedundantParagraphs(next);
  return normalizeMarkdownForRendering(prettifyMarkdownSpacing(next));
};
