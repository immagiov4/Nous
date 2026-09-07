import { rewritePdfImagePlaceholders } from './pdfImagePlaceholder';
import { getSearchKeywords, normalizeSearchText } from './searchText';

export const getMarkdownHeadings = (contentMarkdown: string): string[] =>
  contentMarkdown
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^(#{1,6})\s+/u.test(line))
    .map(line => line.replace(/^(#{1,6})\s+/u, '').trim())
    .filter(Boolean);

export interface PdfImageContext {
  caption?: string;
  id: string;
  pageNumber?: number;
  sourceOrder: number;
  textAfter: string;
  textBefore: string;
  textCurrent?: string;
}

export interface PdfImageReference {
  alt: string;
  anchorHeading?: string;
  assetId: string;
  caption?: string;
}

const getPdfImageSearchText = (image: PdfImageContext): string =>
  [image.caption || '', image.textBefore, image.textCurrent || '', image.textAfter]
    .filter(Boolean)
    .join(' ');

const scoreKeywordHits = (haystack: string, keywords: Iterable<string>): number =>
  Array.from(keywords).reduce((total, keyword) => total + (haystack.includes(keyword) ? 1 : 0), 0);

const scorePageProximity = (
  pageNumber: number | undefined,
  targetedPages: readonly number[]
): number => {
  const [firstPage, ...remainingPages] = targetedPages;
  if (typeof pageNumber !== 'number' || !Number.isInteger(pageNumber) || firstPage === undefined) {
    return 0;
  }
  const lastPage = remainingPages.at(-1) ?? firstPage;
  const centerPage = (firstPage + lastPage) / 2;
  const distance = Math.abs(pageNumber - centerPage);
  if (distance <= 0.5) return 4;
  if (distance <= 1.5) return 3;
  if (distance <= 2.5) return 2;
  if (distance <= 3.5) return 1;
  return 0;
};

const trimLeadingSummaryPunctuation = (value: string): string => {
  let startIndex = 0;
  while (startIndex < value.length && ':;,- '.includes(value[startIndex] || '')) startIndex += 1;
  return value.slice(startIndex);
};

const trimAfterSentencePunctuation = (value: string): string => {
  for (let index = 0; index < value.length; index += 1) {
    if ('.:;!?'.includes(value[index] || '')) return value.slice(0, index);
  }
  return value;
};

const normalizeImageMetadataText = (value: string): string => value.replaceAll(/\s+/gu, ' ').trim();

const buildImageContextSummary = (
  image: PdfImageContext,
  sectionTitle: string,
  sectionDescription: string
): string => {
  const normalized = getPdfImageSearchText(image).replaceAll(/\s+/gu, ' ').trim();
  const sentenceCandidates = normalized
    .split(/(?<=[.!?])\s+/u)
    .map(sentence => sentence.trim())
    .filter(Boolean);
  const sectionKeywords = getSearchKeywords(`${sectionTitle} ${sectionDescription}`);
  const bestSentence = sentenceCandidates
    .map(sentence => ({
      score: scoreKeywordHits(normalizeSearchText(sentence), sectionKeywords),
      sentence,
    }))
    .sort((left, right) => right.score - left.score)[0]?.sentence;
  const chosen =
    image.caption?.trim() || bestSentence || sentenceCandidates[0] || normalized || sectionTitle;
  const compact = normalizeImageMetadataText(trimLeadingSummaryPunctuation(chosen));
  return compact.length > 140 ? `${compact.slice(0, 137).trim()}...` : compact;
};

export const buildVisibleImageLabel = <T extends PdfImageContext>(
  image: T,
  sectionTitle: string,
  sectionDescription: string
): string => {
  const summary = buildImageContextSummary(image, sectionTitle, sectionDescription)
    .replace(/^(la|il|lo|i|gli|le|una|un|uno)\s+/iu, '')
    .trim();
  const compactSummary = trimAfterSentencePunctuation(summary).trim();
  if (!compactSummary) return `Figura del PDF: ${sectionTitle}`;
  return compactSummary.length > 72 ? `${compactSummary.slice(0, 69).trim()}...` : compactSummary;
};

export const selectCandidatePdfImages = <T extends PdfImageContext>(
  images: T[],
  sectionTitle: string,
  sectionDescription: string,
  targetedPagesForImage: (image: T) => readonly number[] = () => []
): T[] => {
  const keywords = new Set(getSearchKeywords(`${sectionTitle} ${sectionDescription}`));
  const scored = images
    .filter(image => Boolean(image.caption?.trim()))
    .map(image => ({
      image,
      score:
        scoreKeywordHits(normalizeSearchText(getPdfImageSearchText(image)), keywords) * 3 +
        scorePageProximity(image.pageNumber, targetedPagesForImage(image)),
    }))
    .sort((left, right) =>
      right.score === left.score
        ? left.image.sourceOrder - right.image.sourceOrder
        : right.score - left.score
    );
  const relevant = scored.filter(item => item.score > 0).map(item => item.image);
  return relevant.length > 0 ? relevant : scored.map(item => item.image);
};

type ResolvePdfImageRefsInput = {
  contentMarkdown: string;
  draftRefs: Array<{ alt: string; anchorHeading?: string; assetId: string; caption: string }>;
  images: PdfImageContext[];
  sectionDescription: string;
  sectionTitle: string;
};

export const resolvePdfImageRefs = ({
  contentMarkdown,
  draftRefs,
  images,
  sectionDescription,
  sectionTitle,
}: ResolvePdfImageRefsInput): PdfImageReference[] => {
  const availableAssetIds = new Set(images.map(image => image.id));
  const visibleLabelByAssetId = new Map(
    images.map(image => [image.id, buildVisibleImageLabel(image, sectionTitle, sectionDescription)])
  );
  const seenAssetIds = new Set<string>();
  const placeholderAssetIds = new Set<string>();
  rewritePdfImagePlaceholders(contentMarkdown, ({ assetId, fullMatch }) => {
    placeholderAssetIds.add(assetId.trim());
    return fullMatch;
  });
  return draftRefs.flatMap(reference => {
    if (!availableAssetIds.has(reference.assetId) || seenAssetIds.has(reference.assetId)) return [];
    const alt = normalizeImageMetadataText(reference.alt || 'Figura dal PDF');
    if (!alt) return [];
    seenAssetIds.add(reference.assetId);
    const caption = normalizeImageMetadataText(
      reference.caption || visibleLabelByAssetId.get(reference.assetId) || ''
    );
    if (!placeholderAssetIds.has(reference.assetId)) {
      throw new Error('Selected PDF image is missing its placeholder in lesson content.');
    }
    return [
      {
        alt,
        assetId: reference.assetId,
        ...(caption ? { caption } : {}),
      },
    ];
  });
};
