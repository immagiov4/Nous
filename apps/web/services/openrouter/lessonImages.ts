import { getSearchKeywords, normalizeSearchText } from './planQuality.ts';
import type { LessonGeneratedVisual, LessonImageRef, PdfDocumentAssets } from './types.ts';
import { generateLessonVisualExamples } from './visualExamples.ts';

const MIN_FALLBACK_IMAGE_SCORE = 2;
const PDF_PLACEHOLDER_PREFIX = '{{PDF_IMAGE:';
const VISUAL_PLACEHOLDER_PREFIX = '{{VISUAL_EXAMPLE:';

export interface SectionImagePlacement {
  assetId: string;
  alt: string;
  caption?: string | null;
  anchorHeading?: string | null;
}

const getPdfImageSearchText = (image: PdfDocumentAssets['usedImages'][number]): string =>
  [image.caption || '', image.textBefore, image.textCurrent || '', image.textAfter]
    .filter(Boolean)
    .join(' ');

const scorePageProximity = (pageNumber: number | undefined, targetedPages: number[]): number => {
  if (!Number.isInteger(pageNumber) || targetedPages.length === 0) {
    return 0;
  }

  const centerPage = (targetedPages[0] + targetedPages[targetedPages.length - 1]) / 2;
  const distance = Math.abs((pageNumber as number) - centerPage);
  if (distance <= 0.5) {
    return 4;
  }

  if (distance <= 1.5) {
    return 3;
  }

  if (distance <= 2.5) {
    return 2;
  }

  if (distance <= 3.5) {
    return 1;
  }

  return 0;
};

const scoreKeywordHits = (haystack: string, keywords: Iterable<string>): number =>
  Array.from(keywords).reduce((total, keyword) => total + (haystack.includes(keyword) ? 1 : 0), 0);

const trimLeadingSummaryPunctuation = (value: string): string => {
  let startIndex = 0;

  while (startIndex < value.length) {
    const character = value[startIndex];
    if (
      character !== ':' &&
      character !== ';' &&
      character !== ',' &&
      character !== '-' &&
      character !== ' '
    ) {
      break;
    }

    startIndex += 1;
  }

  return value.slice(startIndex);
};

const trimAfterSentencePunctuation = (value: string): string => {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (
      character === '.' ||
      character === ':' ||
      character === ';' ||
      character === '!' ||
      character === '?'
    ) {
      return value.slice(0, index);
    }
  }

  return value;
};

export const selectCandidatePdfImages = (
  images: PdfDocumentAssets['usedImages'],
  sectionTitle: string,
  sectionDescription: string,
  targetedPages: number[] = []
) => {
  const visuallyClearImages = images.filter(image => Boolean(image.caption?.trim()));
  if (visuallyClearImages.length === 0) {
    return [];
  }

  const keywords = new Set(getSearchKeywords(`${sectionTitle} ${sectionDescription}`));
  const scored = visuallyClearImages
    .map(image => {
      const haystack = normalizeSearchText(getPdfImageSearchText(image));
      const keywordScore = scoreKeywordHits(haystack, keywords);
      const pageScore = scorePageProximity(image.pageNumber, targetedPages);
      const score = keywordScore * 3 + pageScore;
      return { image, score };
    })
    .sort((left, right) =>
      right.score === left.score
        ? left.image.sourceOrder - right.image.sourceOrder
        : right.score - left.score
    );

  const relevant = scored.filter(item => item.score > 0).map(item => item.image);
  if (relevant.length > 0) {
    return relevant;
  }

  // Use only figures that the vision pass considered clear enough to describe.
  return scored.map(item => item.image);
};

export const getMarkdownHeadings = (contentMarkdown: string): string[] =>
  contentMarkdown
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^(#{1,6})\s+/.test(line))
    .map(line => line.replace(/^(#{1,6})\s+/, '').trim())
    .filter(Boolean);

const buildImageContextSummary = (
  image: PdfDocumentAssets['usedImages'][number],
  sectionTitle: string,
  sectionDescription: string
): string => {
  const joinedContext = getPdfImageSearchText(image).trim();
  const normalized = joinedContext.replace(/\s+/g, ' ').trim();
  const sentenceCandidates = normalized
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(Boolean);
  const sectionKeywords = getSearchKeywords(`${sectionTitle} ${sectionDescription}`);
  const bestSentence = sentenceCandidates
    .map(sentence => ({
      sentence,
      score: scoreKeywordHits(normalizeSearchText(sentence), sectionKeywords),
    }))
    .sort((left, right) => right.score - left.score)[0]?.sentence;

  const chosen =
    image.caption?.trim() || bestSentence || sentenceCandidates[0] || normalized || sectionTitle;
  const compact = trimLeadingSummaryPunctuation(chosen).replace(/[|}]/g, ' ').trim();

  return compact.length > 140 ? `${compact.slice(0, 137).trim()}...` : compact;
};

export const buildVisibleImageLabel = (
  image: PdfDocumentAssets['usedImages'][number],
  sectionTitle: string,
  sectionDescription: string
): string => {
  const summary = buildImageContextSummary(image, sectionTitle, sectionDescription)
    .replace(/^(la|il|lo|i|gli|le|una|un|uno)\s+/i, '')
    .trim();
  const compactSummary = trimAfterSentencePunctuation(summary).trim();

  if (!compactSummary) {
    return `Figura del PDF: ${sectionTitle}`;
  }

  return compactSummary.length > 72 ? `${compactSummary.slice(0, 69).trim()}...` : compactSummary;
};

const pickFallbackAnchorHeading = (
  image: PdfDocumentAssets['usedImages'][number],
  headings: string[],
  sectionTitle: string,
  sectionDescription: string
): string | undefined => {
  if (headings.length === 0) {
    return undefined;
  }

  const imageHaystack = normalizeSearchText(getPdfImageSearchText(image));
  const sectionKeywords = new Set(getSearchKeywords(`${sectionTitle} ${sectionDescription}`));
  const bestHeading = headings
    .map(heading => {
      const headingKeywords = new Set(getSearchKeywords(heading));
      const headingScore = scoreKeywordHits(imageHaystack, headingKeywords);
      const sectionScore = scoreKeywordHits(normalizeSearchText(heading), sectionKeywords);
      return {
        heading,
        score: headingScore * 2 + sectionScore,
      };
    })
    .sort((left, right) => right.score - left.score)[0];

  return bestHeading && bestHeading.score > 0 ? bestHeading.heading : undefined;
};

export const buildFallbackImageRefs = (
  images: PdfDocumentAssets['usedImages'],
  sectionTitle: string,
  sectionDescription: string,
  contentMarkdown: string,
  visibleLabelByAssetId: Map<string, string>
): LessonImageRef[] => {
  const sectionKeywords = new Set(getSearchKeywords(`${sectionTitle} ${sectionDescription}`));
  const headings = getMarkdownHeadings(contentMarkdown);

  return images
    .map(image => {
      const imageHaystack = normalizeSearchText(getPdfImageSearchText(image));
      const headingScore = headings.reduce((total, heading) => {
        const headingKeywords = getSearchKeywords(heading);
        return Math.max(total, scoreKeywordHits(imageHaystack, headingKeywords));
      }, 0);
      const sectionScore = scoreKeywordHits(imageHaystack, sectionKeywords);

      return {
        image,
        score: sectionScore * 2 + headingScore,
      };
    })
    .filter(item => item.score >= MIN_FALLBACK_IMAGE_SCORE)
    .sort((left, right) =>
      right.score === left.score
        ? left.image.sourceOrder - right.image.sourceOrder
        : right.score - left.score
    )
    .map(({ image }) => ({
      assetId: image.id,
      alt: sanitizePlaceholderValue(
        buildImageContextSummary(image, sectionTitle, sectionDescription) ||
          `Figura dal PDF: ${sectionTitle}`
      ),
      caption: sanitizePlaceholderValue(visibleLabelByAssetId.get(image.id) || ''),
      anchorHeading: pickFallbackAnchorHeading(image, headings, sectionTitle, sectionDescription),
    }));
};

const sanitizePlaceholderValue = (value: string): string =>
  value.replace(/[|}]/g, ' ').replace(/\s+/g, ' ').trim();

const buildPdfImagePlaceholder = (imageRef: LessonImageRef): string => {
  const alt = sanitizePlaceholderValue(imageRef.alt || 'Figura dal PDF');
  const caption = sanitizePlaceholderValue(imageRef.caption || '');
  return caption
    ? `${PDF_PLACEHOLDER_PREFIX}${imageRef.assetId}|alt=${alt}|caption=${caption}}}`
    : `${PDF_PLACEHOLDER_PREFIX}${imageRef.assetId}|alt=${alt}}}`;
};

export const appendGeneratedVisualExample = async ({
  contentMarkdown,
  generationNotes,
  hasPdfImages,
  onStatusUpdate,
  sectionDescription,
  sectionTitle,
}: {
  contentMarkdown: string;
  generationNotes?: string;
  hasPdfImages: boolean;
  onStatusUpdate?: (status: string) => void;
  sectionDescription: string;
  sectionTitle: string;
}): Promise<{ content: string; generatedVisuals: LessonGeneratedVisual[] }> => {
  if (!contentMarkdown.trim()) {
    return { content: contentMarkdown, generatedVisuals: [] };
  }

  try {
    onStatusUpdate?.('Generazione esempio visivo...');
    const results = await generateLessonVisualExamples({
      generationNotes,
      hasPdfImages,
      lessonMarkdown: contentMarkdown,
      sectionDescription,
      sectionTitle,
    });

    if (results.length === 0) {
      onStatusUpdate?.('Lezione generata senza esempi visivi aggiuntivi');
      return { content: contentMarkdown, generatedVisuals: [] };
    }

    const content = results.reduceRight(
      (currentContent, result) =>
        insertGeneratedVisualExamplePlaceholder(
          currentContent,
          result.contentSuffix,
          result.anchorHeading
        ),
      contentMarkdown
    );
    onStatusUpdate?.(
      results.length === 1
        ? 'Esempio visivo integrato'
        : `${results.length} esempi visivi integrati`
    );
    return {
      content,
      generatedVisuals: results.map(result => result.visual),
    };
  } catch (error) {
    console.warn(
      '[Nous][Lesson] Generated visual example failed, keeping text-only lesson.',
      error
    );
    onStatusUpdate?.('Esempio visivo non disponibile');
    return { content: contentMarkdown, generatedVisuals: [] };
  }
};

const normalizeHeading = (text: string): string =>
  normalizeSearchText(text.replace(/^#+\s*/, '').replace(/[*_`]/g, ' '));

const HEADING_LINE_REGEX = /^(#{1,6})\s+/;
const FENCE_LINE_REGEX = /^(```|~~~)/;
const LIST_ITEM_LINE_REGEX = /^([-*+]|\d+\.)\s+/;
const TABLE_LINE_REGEX = /^\|.*\|$/;

const findSectionEndIndex = (lines: string[], headingIndex: number): number => {
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (HEADING_LINE_REGEX.test(lines[index] || '')) {
      return index;
    }
  }

  return lines.length;
};

const findFirstReadableBlockEndIndex = (lines: string[], headingIndex: number): number => {
  const sectionEndIndex = findSectionEndIndex(lines, headingIndex);

  let blockStartIndex = -1;
  for (let index = headingIndex + 1; index < sectionEndIndex; index += 1) {
    const line = (lines[index] || '').trim();
    if (
      !line ||
      line.startsWith(PDF_PLACEHOLDER_PREFIX) ||
      line.startsWith(VISUAL_PLACEHOLDER_PREFIX)
    ) {
      continue;
    }

    blockStartIndex = index;
    break;
  }

  if (blockStartIndex < 0) {
    return headingIndex;
  }

  const firstLine = (lines[blockStartIndex] || '').trim();
  if (FENCE_LINE_REGEX.test(firstLine)) {
    for (let index = blockStartIndex + 1; index < sectionEndIndex; index += 1) {
      if (FENCE_LINE_REGEX.test((lines[index] || '').trim())) {
        return index;
      }
    }
  }

  const isBlockContinuation = TABLE_LINE_REGEX.test(firstLine)
    ? (line: string): boolean => TABLE_LINE_REGEX.test(line.trim())
    : LIST_ITEM_LINE_REGEX.test(firstLine)
      ? (line: string): boolean => {
          const trimmed = line.trim();
          return LIST_ITEM_LINE_REGEX.test(trimmed) || (trimmed.length > 0 && /^\s+/.test(line));
        }
      : (line: string): boolean => {
          const trimmed = line.trim();
          return trimmed.length > 0 && !HEADING_LINE_REGEX.test(trimmed);
        };

  let blockEndIndex = blockStartIndex;
  for (let index = blockStartIndex + 1; index < sectionEndIndex; index += 1) {
    if (!isBlockContinuation(lines[index] || '')) {
      break;
    }

    blockEndIndex = index;
  }

  return blockEndIndex;
};

export const insertGeneratedVisualExamplePlaceholder = (
  contentMarkdown: string,
  contentSuffix: string,
  anchorHeading?: string
): string => {
  const placeholder = contentSuffix.trim();
  const trimmedContent = contentMarkdown.trim();
  if (!trimmedContent || !placeholder) {
    return trimmedContent;
  }

  const lines = trimmedContent.split('\n');
  const headingIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(item => HEADING_LINE_REGEX.test(item.line));

  const headingIndexByName = new Map(
    headingIndexes.map(item => [normalizeHeading(item.line), item.index])
  );
  const headingIndex = anchorHeading
    ? headingIndexByName.get(normalizeHeading(anchorHeading))
    : undefined;

  if (headingIndex === undefined) {
    return `${trimmedContent}\n\n${placeholder}`;
  }

  const insertAfterIndex = findFirstReadableBlockEndIndex(lines, headingIndex);
  const baseInsertionIndex = Math.min(insertAfterIndex + 1, lines.length);
  const insertionIndex =
    (lines[baseInsertionIndex] || '').trim() === ''
      ? Math.min(baseInsertionIndex + 1, lines.length)
      : baseInsertionIndex;
  lines.splice(insertionIndex, 0, '', placeholder, '');

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

export const injectImagePlaceholders = (
  contentMarkdown: string,
  imageRefs: LessonImageRef[]
): string => {
  if (!contentMarkdown.trim() || imageRefs.length === 0) {
    return contentMarkdown.trim();
  }

  const lines = contentMarkdown.trim().split('\n');
  const headingIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(item => HEADING_LINE_REGEX.test(item.line));
  const headingIndexByName = new Map(
    headingIndexes.map(item => [normalizeHeading(item.line), item.index])
  );

  let appendedCount = 0;

  const placementTargets = imageRefs
    .map((imageRef, position) => {
      const headingIndex = imageRef.anchorHeading
        ? headingIndexByName.get(normalizeHeading(imageRef.anchorHeading))
        : undefined;
      const fallbackIndex =
        headingIndexes[position + 1]?.index ??
        headingIndexes[position]?.index ??
        headingIndexes[0]?.index ??
        Math.max(lines.length - 1, 0);
      const insertAfterIndex =
        headingIndex === undefined
          ? fallbackIndex
          : findFirstReadableBlockEndIndex(lines, headingIndex);

      return { imageRef, insertAfterIndex, position };
    })
    .sort(
      (first, second) =>
        first.insertAfterIndex - second.insertAfterIndex || first.position - second.position
    );

  placementTargets.forEach(({ imageRef, insertAfterIndex }) => {
    const placeholder = buildPdfImagePlaceholder(imageRef);
    const baseInsertionIndex = Math.min(insertAfterIndex + 1 + appendedCount * 3, lines.length);
    const insertionIndex =
      (lines[baseInsertionIndex] || '').trim() === ''
        ? Math.min(baseInsertionIndex + 1, lines.length)
        : baseInsertionIndex;
    lines.splice(insertionIndex, 0, '', placeholder, '');
    appendedCount += 1;
  });

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

export const normalizeImagePlacements = (
  placements: SectionImagePlacement[] | undefined,
  availableAssetIds: Set<string>,
  visibleLabelByAssetId: Map<string, string>
): LessonImageRef[] => {
  if (!Array.isArray(placements)) {
    return [];
  }

  const refs: LessonImageRef[] = [];
  const seenAssetIds = new Set<string>();

  placements.forEach(placement => {
    if (
      !placement ||
      typeof placement.assetId !== 'string' ||
      !availableAssetIds.has(placement.assetId) ||
      seenAssetIds.has(placement.assetId)
    ) {
      return;
    }

    const alt = sanitizePlaceholderValue(placement.alt || 'Figura dal PDF');
    if (!alt) {
      return;
    }

    refs.push({
      assetId: placement.assetId,
      alt,
      caption:
        sanitizePlaceholderValue(
          placement.caption || visibleLabelByAssetId.get(placement.assetId) || ''
        ) || undefined,
      anchorHeading: placement.anchorHeading
        ? sanitizePlaceholderValue(placement.anchorHeading)
        : undefined,
    });
    seenAssetIds.add(placement.assetId);
  });

  return refs;
};

export const sanitizeAssetIdMentions = (
  contentMarkdown: string,
  visibleLabelByAssetId: Map<string, string>
): string =>
  contentMarkdown
    .replace(
      /\b([Ff]igura|[Ii]mmagine)\s+(pdf-img-\d+)\b/g,
      (_match, noun: string, assetId: string) => {
        const label = visibleLabelByAssetId.get(assetId.toLowerCase());
        return label ? `${noun} "${label}"` : `${noun} seguente`;
      }
    )
    .replace(/\b(pdf-img-\d+)\b/gi, (_match, assetId: string) => {
      const label = visibleLabelByAssetId.get(assetId.toLowerCase());
      return label ? `"${label}"` : 'figura seguente';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/""/g, '"');
