import { normalizeMarkdownForRendering } from '../../../utils/markdown/render.ts';
import { normalizeLineEndings } from '../../../utils/text.ts';
import { sanitizeAssetIdMentions } from '../lessonImages.ts';
import type { QuizQuestion } from '../shared.ts';

// ── Repetition detection constants ─────────────────────────────────────

const BLOCKISH_PARAGRAPH_PREFIX = /^(#{1,6}\s|[-*+]\s|>\s|```|~~~|\|.*\||\{\{PDF_IMAGE:)/;
const LABEL_BODY_REGEX = /^(?:\*\*)?([^*\n:]{2,90})(?:\*\*)?:\s+(.+)$/;
const STANDALONE_LABEL_REGEX = /^(?:\*\*)?([^*\n:]{2,90})(?:\*\*)?:\s*$/;
const MAX_LIST_LABEL_WORDS = 12;
const REPETITION_SIMILARITY_THRESHOLD = 0.72;
const REPETITION_SECONDARY_KEYWORD_THRESHOLD = 0.2;
const REPETITION_FULL_WORD_OVERLAP_THRESHOLD = 0.45;
const REPETITION_MIN_SHARED_KEYWORDS = 3;
const REPETITION_RECENT_PARAGRAPH_WINDOW = 4;
const REPETITION_MIN_KEYWORD_COUNT = 8;
const PARAGRAPH_REPETITION_STOP_WORDS = new Set([
  'alla',
  'alle',
  'anche',
  'avere',
  'come',
  'core',
  'cosa',
  'cui',
  'dalla',
  'dalle',
  'della',
  'delle',
  'dello',
  'dentro',
  'dopo',
  'essere',
  'framework',
  'function',
  'functions',
  'hanno',
  'loro',
  'nelle',
  'nella',
  'non',
  'organization',
  'organizzazione',
  'organizzazioni',
  'partire',
  'perche',
  'pero',
  'questa',
  'queste',
  'questi',
  'questo',
  'quindi',
  'risultati',
  'risultato',
  'sono',
  'solo',
  'stessa',
  'stesso',
  'subcategories',
  'subcategory',
  'tutte',
  'tutti',
]);

// ── Similarity helpers ─────────────────────────────────────────────────

const normalizeParagraphForDetection = (paragraph: string): string =>
  paragraph
    .replace(/\n+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

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

const extractParagraphKeywords = (paragraph: string): string[] =>
  Array.from(
    new Set(
      stripMarkdownForSimilarity(paragraph)
        .split(/\s+/)
        .map(normalizeSimilarityWord)
        .filter(word => word.length >= 4 && !PARAGRAPH_REPETITION_STOP_WORDS.has(word))
    )
  );

const extractParagraphWords = (paragraph: string): string[] =>
  Array.from(
    new Set(
      stripMarkdownForSimilarity(paragraph)
        .split(/\s+/)
        .map(normalizeSimilarityWord)
        .filter(word => word.length >= 2)
    )
  );

interface ParagraphSimilarityMetrics {
  fullWordOverlap: number;
  keywordOverlap: number;
  sharedKeywordCount: number;
}

const computeParagraphSimilarity = (left: string, right: string): ParagraphSimilarityMetrics => {
  const leftKeywords = extractParagraphKeywords(left);
  const rightKeywords = extractParagraphKeywords(right);
  const leftWords = extractParagraphWords(left);
  const rightWords = extractParagraphWords(right);
  const rightWordSet = new Set(rightWords);
  const sharedWordCount = leftWords.filter(word => rightWordSet.has(word)).length;
  const rightKeywordSet = new Set(rightKeywords);
  const sharedKeywordCount = leftKeywords.filter(keyword => rightKeywordSet.has(keyword)).length;

  return {
    fullWordOverlap: sharedWordCount / Math.max(1, Math.min(leftWords.length, rightWords.length)),
    keywordOverlap:
      leftKeywords.length < REPETITION_MIN_KEYWORD_COUNT ||
      rightKeywords.length < REPETITION_MIN_KEYWORD_COUNT
        ? 0
        : sharedKeywordCount / Math.max(1, Math.min(leftKeywords.length, rightKeywords.length)),
    sharedKeywordCount,
  };
};

const isRedundantParagraphMatch = (metrics: ParagraphSimilarityMetrics): boolean =>
  metrics.keywordOverlap >= REPETITION_SIMILARITY_THRESHOLD ||
  (metrics.sharedKeywordCount >= REPETITION_MIN_SHARED_KEYWORDS &&
    metrics.keywordOverlap >= REPETITION_SECONDARY_KEYWORD_THRESHOLD &&
    metrics.fullWordOverlap >= REPETITION_FULL_WORD_OVERLAP_THRESHOLD);

const isMeaningfulParagraphForRepetitionCheck = (paragraph: string): boolean => {
  const normalized = normalizeParagraphForDetection(paragraph);
  if (!normalized || BLOCKISH_PARAGRAPH_PREFIX.test(normalized)) {
    return false;
  }
  return extractParagraphKeywords(paragraph).length >= REPETITION_MIN_KEYWORD_COUNT;
};

interface RepetitionHit {
  currentIndex: number;
  previousIndex: number;
  similarity: number;
}

const _findRedundantParagraphPairs = (paragraphs: string[]): RepetitionHit[] => {
  const hits: RepetitionHit[] = [];

  paragraphs.forEach((paragraph, index) => {
    if (!isMeaningfulParagraphForRepetitionCheck(paragraph)) return;

    const startIndex = Math.max(0, index - REPETITION_RECENT_PARAGRAPH_WINDOW);
    for (let previousIndex = startIndex; previousIndex < index; previousIndex += 1) {
      const previousParagraph = paragraphs[previousIndex];
      if (!isMeaningfulParagraphForRepetitionCheck(previousParagraph)) continue;

      const similarity = computeParagraphSimilarity(previousParagraph, paragraph);
      if (isRedundantParagraphMatch(similarity)) {
        hits.push({
          currentIndex: index,
          previousIndex,
          similarity: Math.max(similarity.keywordOverlap, similarity.fullWordOverlap),
        });
        break;
      }
    }
  });

  return hits;
};

// ── Collapse redundant paragraphs ──────────────────────────────────────

export const collapseRedundantParagraphs = (contentMarkdown: string): string => {
  const paragraphs = contentMarkdown
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length < 2) {
    return contentMarkdown.trim();
  }

  const keptParagraphs: string[] = [];

  paragraphs.forEach(paragraph => {
    if (!isMeaningfulParagraphForRepetitionCheck(paragraph)) {
      keptParagraphs.push(paragraph);
      return;
    }

    const recentParagraphs = keptParagraphs.slice(-REPETITION_RECENT_PARAGRAPH_WINDOW);
    const hasRedundantMatch = recentParagraphs.some(previousParagraph => {
      if (!isMeaningfulParagraphForRepetitionCheck(previousParagraph)) return false;
      return isRedundantParagraphMatch(computeParagraphSimilarity(previousParagraph, paragraph));
    });

    if (!hasRedundantMatch) {
      keptParagraphs.push(paragraph);
    }
  });

  return keptParagraphs.join('\n\n').trim();
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
  if (BLOCKISH_PARAGRAPH_PREFIX.test(normalized)) return null;
  const match = normalized.match(STANDALONE_LABEL_REGEX);
  if (!match) return null;
  const label = match[1].trim();
  return isReasonableListLabel(label) ? `#### ${label}` : null;
};

const toListItemParagraph = (paragraph: string): string | null => {
  const normalized = normalizeParagraphForDetection(paragraph);
  if (BLOCKISH_PARAGRAPH_PREFIX.test(normalized)) return null;
  const match = normalized.match(LABEL_BODY_REGEX);
  if (!match) return null;
  const [, rawLabel, rawBody] = match;
  const label = rawLabel.trim();
  const body = rawBody.trim();
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
    normalizeLineEndings(contentMarkdown)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/([^\n])\s+(#{1,6}\s+)/g, '$1\n\n$2')
      .replace(/([^\n])\n(#{1,6}\s+)/g, '$1\n\n$2')
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
