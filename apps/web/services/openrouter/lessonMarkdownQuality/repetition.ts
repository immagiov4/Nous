import { stripMarkdownForSimilarity } from './markdownHeuristics.ts';

const BLOCKISH_PARAGRAPH_PREFIX = /^(#{1,6}\s|[-*+]\s|>\s|```|~~~|\|.*\||\{\{PDF_IMAGE:)/;
const SIMILARITY_THRESHOLD = 0.72;
const SECONDARY_KEYWORD_THRESHOLD = 0.2;
const FULL_WORD_OVERLAP_THRESHOLD = 0.45;
const MIN_SHARED_KEYWORDS = 3;
const RECENT_PARAGRAPH_WINDOW = 4;
const MIN_KEYWORD_COUNT = 8;
const STOP_WORDS = new Set([
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

interface ParagraphSimilarityMetrics {
  fullWordOverlap: number;
  keywordOverlap: number;
  sharedKeywordCount: number;
}

export interface RepetitionHit {
  currentIndex: number;
  previousIndex: number;
  similarity: number;
}

export const normalizeParagraphForDetection = (paragraph: string): string =>
  paragraph
    .replace(/\n+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

export const isBlockishParagraph = (paragraph: string): boolean =>
  BLOCKISH_PARAGRAPH_PREFIX.test(paragraph);

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
        .filter(word => word.length >= 4 && !STOP_WORDS.has(word))
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
      leftKeywords.length < MIN_KEYWORD_COUNT || rightKeywords.length < MIN_KEYWORD_COUNT
        ? 0
        : sharedKeywordCount / Math.max(1, Math.min(leftKeywords.length, rightKeywords.length)),
    sharedKeywordCount,
  };
};

const isRedundantParagraphMatch = (metrics: ParagraphSimilarityMetrics): boolean =>
  metrics.keywordOverlap >= SIMILARITY_THRESHOLD ||
  (metrics.sharedKeywordCount >= MIN_SHARED_KEYWORDS &&
    metrics.keywordOverlap >= SECONDARY_KEYWORD_THRESHOLD &&
    metrics.fullWordOverlap >= FULL_WORD_OVERLAP_THRESHOLD);

const isMeaningfulParagraph = (paragraph: string): boolean => {
  const normalized = normalizeParagraphForDetection(paragraph);
  return (
    Boolean(normalized) &&
    !isBlockishParagraph(normalized) &&
    extractParagraphKeywords(paragraph).length >= MIN_KEYWORD_COUNT
  );
};

export const findRedundantParagraphPairs = (paragraphs: string[]): RepetitionHit[] => {
  const hits: RepetitionHit[] = [];
  paragraphs.forEach((paragraph, index) => {
    if (!isMeaningfulParagraph(paragraph)) return;
    const startIndex = Math.max(0, index - RECENT_PARAGRAPH_WINDOW);
    for (let previousIndex = startIndex; previousIndex < index; previousIndex += 1) {
      const previousParagraph = paragraphs[previousIndex];
      if (!isMeaningfulParagraph(previousParagraph)) continue;
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

export const collapseRedundantParagraphs = (contentMarkdown: string): string => {
  const paragraphs = contentMarkdown
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);
  if (paragraphs.length < 2) {
    return contentMarkdown.trim();
  }

  const keptParagraphs: string[] = [];
  for (const paragraph of paragraphs) {
    if (!isMeaningfulParagraph(paragraph)) {
      keptParagraphs.push(paragraph);
      continue;
    }
    const hasRedundantMatch = keptParagraphs
      .slice(-RECENT_PARAGRAPH_WINDOW)
      .some(
        previousParagraph =>
          isMeaningfulParagraph(previousParagraph) &&
          isRedundantParagraphMatch(computeParagraphSimilarity(previousParagraph, paragraph))
      );
    if (!hasRedundantMatch) {
      keptParagraphs.push(paragraph);
    }
  }
  return keptParagraphs.join('\n\n').trim();
};
