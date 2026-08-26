import type {
  LessonImageRef,
  PdfDocumentImageAsset,
  PdfImageAsset,
  StoredLessonVisual,
} from '../../types';

const PDF_IMAGE_PLACEHOLDER_REGEX =
  /\{\{PDF_IMAGE:([^|{}]+)(?:\|alt=([^|{}]*))?(?:\|caption=([^{}]*))?\}\}/g;
const VISUAL_EXAMPLE_PLACEHOLDER_REGEX = /\{\{VISUAL_EXAMPLE:([^|{}]+)(?:\|title=([^{}]*))?\}\}/g;
const LEGACY_PDF_FIGURE_REGEX =
  /<figure\b[\s\S]*?<img\b[^>]*data-pdf-asset-id=(["'])([^"'<>]+)\1[^>]*>[\s\S]*?<\/figure>/gi;
const LEGACY_PDF_IMAGE_REGEX = /<img\b[^>]*data-pdf-asset-id=(["'])([^"'<>]+)\1[^>]*>/gi;

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const decodeHtml = (value: string): string =>
  value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

const escapePlaceholderValue = (value: string): string => value.replaceAll(/[|{}]/g, ' ').trim();

const extractAttribute = (tag: string, attributeName: string): string | undefined => {
  const attributeRegex = new RegExp(String.raw`${attributeName}=(["'])([\s\S]*?)\1`, 'i');
  const match = tag.match(attributeRegex);
  return match ? decodeHtml(match[2]) : undefined;
};

const stripHtmlTags = (value: string): string => {
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    const tagStart = value.indexOf('<', cursor);
    if (tagStart === -1) {
      chunks.push(value.slice(cursor));
      break;
    }

    const tagEnd = value.indexOf('>', tagStart + 1);
    if (tagEnd === -1) {
      chunks.push(value.slice(cursor));
      break;
    }

    chunks.push(value.slice(cursor, tagStart), ' ');
    cursor = tagEnd + 1;
  }

  return chunks.join('');
};

const collapseWhitespace = (value: string): string => {
  const characters: string[] = [];

  for (const character of value) {
    if (character.trim() === '') {
      if (characters.at(-1) !== ' ') {
        characters.push(' ');
      }
      continue;
    }

    characters.push(character);
  }

  return characters.join('').trim();
};

const stripHtml = (value: string): string => collapseWhitespace(decodeHtml(stripHtmlTags(value)));

const buildPlaceholder = (assetId: string, alt?: string, caption?: string): string => {
  const normalizedAssetId = escapePlaceholderValue(assetId);
  const normalizedAlt = escapePlaceholderValue(alt || 'Figura dal PDF');
  const normalizedCaption = escapePlaceholderValue(caption || '');
  return normalizedCaption
    ? `{{PDF_IMAGE:${normalizedAssetId}|alt=${normalizedAlt}|caption=${normalizedCaption}}}`
    : `{{PDF_IMAGE:${normalizedAssetId}|alt=${normalizedAlt}}}`;
};

const buildFigureHtml = (
  asset: PdfImageAsset,
  imageRef?: LessonImageRef,
  altFallback?: string,
  captionFallback?: string
): string => {
  const alt = escapeHtml(imageRef?.alt || altFallback || 'Figura dal PDF');
  const caption = imageRef?.caption || captionFallback || '';

  return `<figure class="my-10 overflow-hidden rounded-[28px] border border-gray-200/80 bg-white/85 shadow-sm dark:border-zinc-700/80 dark:bg-zinc-900/85">
  <img src="${escapeHtml(asset.dataUrl)}" alt="${alt}" loading="lazy" data-pdf-asset-id="${escapeHtml(asset.id)}" class="m-0 block w-full bg-gray-50 object-contain dark:bg-zinc-950" />
  ${caption ? `<figcaption class="px-5 py-4 text-sm leading-relaxed text-gray-600 dark:text-gray-300">${escapeHtml(caption)}</figcaption>` : ''}
</figure>`;
};

export const replacePdfImagePlaceholders = (
  content: string,
  lessonAssetsById: Record<string, PdfImageAsset> = {},
  lessonImageRefsById: Record<string, LessonImageRef> = {}
): string =>
  content.replaceAll(PDF_IMAGE_PLACEHOLDER_REGEX, (_match, assetId, alt, caption) => {
    const normalizedAssetId = String(assetId || '').trim();
    const asset = lessonAssetsById[normalizedAssetId];
    if (!asset) {
      return '';
    }

    return buildFigureHtml(
      asset,
      lessonImageRefsById[normalizedAssetId],
      String(alt || '').trim(),
      String(caption || '').trim()
    );
  });

export const stripPdfImagePlaceholders = (content: string): string =>
  content.replaceAll(PDF_IMAGE_PLACEHOLDER_REGEX, ' ');

export const restoreLegacyPdfImagePlaceholders = (content: string): string => {
  const figuresRestored = content.replaceAll(LEGACY_PDF_FIGURE_REGEX, figureHtml => {
    const imageTag = figureHtml.match(/<img\b[^>]*data-pdf-asset-id=(["'])[^"'<>]+\1[^>]*>/i)?.[0];
    const assetId = imageTag ? extractAttribute(imageTag, 'data-pdf-asset-id') : undefined;
    if (!assetId) {
      return figureHtml;
    }

    const alt = imageTag ? extractAttribute(imageTag, 'alt') : undefined;
    const captionMatch = figureHtml.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i);
    const caption = captionMatch ? stripHtml(captionMatch[1]) : undefined;
    return `\n\n${buildPlaceholder(assetId, alt, caption)}\n\n`;
  });

  return figuresRestored.replaceAll(LEGACY_PDF_IMAGE_REGEX, imageTag => {
    const assetId = extractAttribute(imageTag, 'data-pdf-asset-id');
    if (!assetId) {
      return imageTag;
    }

    const alt = extractAttribute(imageTag, 'alt');
    return `\n\n${buildPlaceholder(assetId, alt)}\n\n`;
  });
};

export interface ParsedMarkdownPart {
  key: string;
  type: 'markdown';
  content: string;
}

export interface ParsedPdfImagePart {
  key: string;
  type: 'image';
  asset: PdfDocumentImageAsset;
  imageRef?: LessonImageRef;
  alt: string;
  caption?: string;
}

export interface ParsedGeneratedVisualPart {
  key: string;
  type: 'visual';
  title: string;
  visual: StoredLessonVisual;
}

export type ParsedPdfContentPart =
  | ParsedMarkdownPart
  | ParsedPdfImagePart
  | ParsedGeneratedVisualPart;

type PlaceholderMatch =
  | {
      assetId: string;
      altFallback?: string;
      captionFallback?: string;
      fullMatch: string;
      index: number;
      type: 'image';
    }
  | {
      fullMatch: string;
      index: number;
      titleFallback?: string;
      type: 'visual';
      visualId: string;
    };

const getPlaceholderMatches = (content: string): PlaceholderMatch[] => {
  const matches: PlaceholderMatch[] = [];
  PDF_IMAGE_PLACEHOLDER_REGEX.lastIndex = 0;
  VISUAL_EXAMPLE_PLACEHOLDER_REGEX.lastIndex = 0;

  for (const match of content.matchAll(PDF_IMAGE_PLACEHOLDER_REGEX)) {
    matches.push({
      type: 'image',
      fullMatch: match[0],
      assetId: match[1],
      altFallback: match[2],
      captionFallback: match[3],
      index: match.index ?? 0,
    });
  }

  for (const match of content.matchAll(VISUAL_EXAMPLE_PLACEHOLDER_REGEX)) {
    matches.push({
      type: 'visual',
      fullMatch: match[0],
      visualId: match[1],
      titleFallback: match[2],
      index: match.index ?? 0,
    });
  }

  return matches.sort((left, right) => left.index - right.index);
};

export const parsePdfContentParts = (
  content: string,
  lessonAssetsById: Record<string, PdfDocumentImageAsset> = {},
  lessonImageRefsById: Record<string, LessonImageRef> = {},
  generatedVisualsById: Record<string, StoredLessonVisual> = {}
): ParsedPdfContentPart[] => {
  const parts: ParsedPdfContentPart[] = [];
  let lastIndex = 0;
  const placeholderMatches = getPlaceholderMatches(content);

  for (const match of placeholderMatches) {
    const matchIndex = match.index;
    if (matchIndex > lastIndex) {
      parts.push({
        key: `md-${lastIndex}-${matchIndex}`,
        type: 'markdown',
        content: content.slice(lastIndex, matchIndex),
      });
    }

    if (match.type === 'image') {
      const normalizedAssetId = String(match.assetId || '').trim();
      const asset = lessonAssetsById[normalizedAssetId];
      if (asset) {
        const imageRef = lessonImageRefsById[normalizedAssetId];
        parts.push({
          key: `img-${normalizedAssetId}-${matchIndex}`,
          type: 'image',
          asset,
          imageRef,
          alt: imageRef?.alt || String(match.altFallback || '').trim() || 'Figura dal PDF',
          caption: imageRef?.caption || String(match.captionFallback || '').trim() || undefined,
        });
      }
    } else {
      const normalizedVisualId = String(match.visualId || '').trim();
      const visual = generatedVisualsById[normalizedVisualId];
      if (visual) {
        parts.push({
          key: `visual-${normalizedVisualId}-${matchIndex}`,
          type: 'visual',
          title: String(match.titleFallback || '').trim() || visual.title || 'Esempio visuale',
          visual,
        });
      }
    }

    lastIndex = matchIndex + match.fullMatch.length;
  }

  if (lastIndex < content.length) {
    parts.push({
      key: `md-${lastIndex}-${content.length}`,
      type: 'markdown',
      content: content.slice(lastIndex),
    });
  }

  return parts.length > 0 ? parts : [{ key: `md-0-${content.length}`, type: 'markdown', content }];
};
