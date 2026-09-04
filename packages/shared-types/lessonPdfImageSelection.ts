import { getMarkdownHeadings } from './markdownHeadings';
import { getSearchKeywords, normalizeSearchText } from './searchText';

export { getMarkdownHeadings } from './markdownHeadings';

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

export type PdfImageReferenceSource = 'draft' | 'fallback';

export interface PdfImageReferenceResolution {
  imageRefs: PdfImageReference[];
  source: PdfImageReferenceSource;
}

const MIN_FALLBACK_IMAGE_SCORE = 2;

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

const normalizeImageAnchorHeading = (value: string): string => value.trim();

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

const pickFallbackAnchorHeading = (
  image: PdfImageContext,
  headings: string[],
  sectionTitle: string,
  sectionDescription: string
): string | undefined => {
  if (headings.length === 0) return undefined;
  const imageHaystack = normalizeSearchText(getPdfImageSearchText(image));
  const sectionKeywords = new Set(getSearchKeywords(`${sectionTitle} ${sectionDescription}`));
  const bestHeading = headings
    .map(heading => ({
      heading,
      score:
        scoreKeywordHits(imageHaystack, getSearchKeywords(heading)) * 2 +
        scoreKeywordHits(normalizeSearchText(heading), sectionKeywords),
    }))
    .sort((left, right) => right.score - left.score)[0];
  return bestHeading && bestHeading.score > 0 ? bestHeading.heading : undefined;
};

export const buildFallbackImageRefs = <T extends PdfImageContext>(
  images: T[],
  sectionTitle: string,
  sectionDescription: string,
  contentMarkdown: string,
  visibleLabelByAssetId: ReadonlyMap<string, string>
): PdfImageReference[] => {
  const sectionKeywords = new Set(getSearchKeywords(`${sectionTitle} ${sectionDescription}`));
  const headings = getMarkdownHeadings(contentMarkdown);
  return images
    .map(image => {
      const imageHaystack = normalizeSearchText(getPdfImageSearchText(image));
      const headingScore = headings.reduce(
        (highest, heading) =>
          Math.max(highest, scoreKeywordHits(imageHaystack, getSearchKeywords(heading))),
        0
      );
      return {
        image,
        score: scoreKeywordHits(imageHaystack, sectionKeywords) * 2 + headingScore,
      };
    })
    .filter(item => item.score >= MIN_FALLBACK_IMAGE_SCORE)
    .sort((left, right) =>
      right.score === left.score
        ? left.image.sourceOrder - right.image.sourceOrder
        : right.score - left.score
    )
    .map(({ image }) => ({
      alt: normalizeImageMetadataText(
        buildImageContextSummary(image, sectionTitle, sectionDescription) ||
          `Figura dal PDF: ${sectionTitle}`
      ),
      anchorHeading: pickFallbackAnchorHeading(image, headings, sectionTitle, sectionDescription),
      assetId: image.id,
      caption: normalizeImageMetadataText(visibleLabelByAssetId.get(image.id) || ''),
    }));
};

type ResolvePdfImageRefsInput = {
  contentMarkdown: string;
  draftRefs: Array<{ alt: string; anchorHeading: string; assetId: string; caption: string }>;
  images: PdfImageContext[];
  sectionDescription: string;
  sectionTitle: string;
};

export const resolvePdfImageRefsWithSource = ({
  contentMarkdown,
  draftRefs,
  images,
  sectionDescription,
  sectionTitle,
}: ResolvePdfImageRefsInput): PdfImageReferenceResolution => {
  const availableAssetIds = new Set(images.map(image => image.id));
  const visibleLabelByAssetId = new Map(
    images.map(image => [image.id, buildVisibleImageLabel(image, sectionTitle, sectionDescription)])
  );
  const seenAssetIds = new Set<string>();
  const normalized = draftRefs.flatMap(reference => {
    if (!availableAssetIds.has(reference.assetId) || seenAssetIds.has(reference.assetId)) return [];
    const alt = normalizeImageMetadataText(reference.alt || 'Figura dal PDF');
    if (!alt) return [];
    seenAssetIds.add(reference.assetId);
    const caption = normalizeImageMetadataText(
      reference.caption || visibleLabelByAssetId.get(reference.assetId) || ''
    );
    const anchorHeading = normalizeImageAnchorHeading(reference.anchorHeading || '');
    return [
      {
        alt,
        ...(anchorHeading ? { anchorHeading } : {}),
        assetId: reference.assetId,
        ...(caption ? { caption } : {}),
      },
    ];
  });
  if (normalized.length > 0) return { imageRefs: normalized, source: 'draft' };
  return {
    imageRefs: buildFallbackImageRefs(
      images,
      sectionTitle,
      sectionDescription,
      contentMarkdown,
      visibleLabelByAssetId
    ),
    source: 'fallback',
  };
};

export const resolvePdfImageRefs = (input: ResolvePdfImageRefsInput): PdfImageReference[] =>
  resolvePdfImageRefsWithSource(input).imageRefs;
