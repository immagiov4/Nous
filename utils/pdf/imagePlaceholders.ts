import type { LessonImageRef, PdfImageAsset } from '../../types';

const PDF_IMAGE_PLACEHOLDER_REGEX =
  /\{\{PDF_IMAGE:([^|}]+)(?:\|alt=([^|}]*))?(?:\|caption=([^}]*))?\}\}/g;
const LEGACY_PDF_FIGURE_REGEX = /<figure\b[\s\S]*?<img\b[^>]*data-pdf-asset-id=(["'])([^"'<>]+)\1[^>]*>[\s\S]*?<\/figure>/gi;
const LEGACY_PDF_IMAGE_REGEX = /<img\b[^>]*data-pdf-asset-id=(["'])([^"'<>]+)\1[^>]*>/gi;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const decodeHtml = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const escapePlaceholderValue = (value: string): string =>
  value.replace(/[|}]/g, ' ').trim();

const extractAttribute = (tag: string, attributeName: string): string | undefined => {
  const attributeRegex = new RegExp(`${attributeName}=(["'])([\\s\\S]*?)\\1`, 'i');
  const match = tag.match(attributeRegex);
  return match ? decodeHtml(match[2]) : undefined;
};

const stripHtml = (value: string): string =>
  decodeHtml(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const buildPlaceholder = (assetId: string, alt?: string, caption?: string): string => {
  const normalizedAssetId = escapePlaceholderValue(assetId);
  const normalizedAlt = escapePlaceholderValue(alt || 'Figura dal PDF');
  const normalizedCaption = escapePlaceholderValue(caption || '');
  return normalizedCaption
    ? `{{PDF_IMAGE:${normalizedAssetId}|alt=${normalizedAlt}|caption=${normalizedCaption}}}`
    : `{{PDF_IMAGE:${normalizedAssetId}|alt=${normalizedAlt}}}`;
};

const buildFigureHtml = (asset: PdfImageAsset, imageRef?: LessonImageRef, altFallback?: string, captionFallback?: string): string => {
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
  content.replace(PDF_IMAGE_PLACEHOLDER_REGEX, (_match, assetId, alt, caption) => {
    const normalizedAssetId = String(assetId || '').trim();
    const asset = lessonAssetsById[normalizedAssetId];
    if (!asset) {
      return '';
    }

    return buildFigureHtml(asset, lessonImageRefsById[normalizedAssetId], String(alt || '').trim(), String(caption || '').trim());
  });

export const stripPdfImagePlaceholders = (content: string): string =>
  content.replace(PDF_IMAGE_PLACEHOLDER_REGEX, ' ');

export const restoreLegacyPdfImagePlaceholders = (content: string): string => {
  const figuresRestored = content.replace(LEGACY_PDF_FIGURE_REGEX, (figureHtml) => {
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

  return figuresRestored.replace(LEGACY_PDF_IMAGE_REGEX, (imageTag) => {
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
  asset: PdfImageAsset;
  imageRef?: LessonImageRef;
  alt: string;
  caption?: string;
}

export type ParsedPdfContentPart = ParsedMarkdownPart | ParsedPdfImagePart;

export const parsePdfContentParts = (
  content: string,
  lessonAssetsById: Record<string, PdfImageAsset> = {},
  lessonImageRefsById: Record<string, LessonImageRef> = {}
): ParsedPdfContentPart[] => {
  const parts: ParsedPdfContentPart[] = [];
  let lastIndex = 0;
  let match = PDF_IMAGE_PLACEHOLDER_REGEX.exec(content);

  while (match) {
    const [fullMatch, assetId, altFallback, captionFallback] = match;
    const matchIndex = match.index;
    if (matchIndex > lastIndex) {
      parts.push({
        key: `md-${lastIndex}-${matchIndex}`,
        type: 'markdown',
        content: content.slice(lastIndex, matchIndex),
      });
    }

    const normalizedAssetId = String(assetId || '').trim();
    const asset = lessonAssetsById[normalizedAssetId];
    if (asset) {
      const imageRef = lessonImageRefsById[normalizedAssetId];
      parts.push({
        key: `img-${normalizedAssetId}-${matchIndex}`,
        type: 'image',
        asset,
        imageRef,
        alt: imageRef?.alt || String(altFallback || '').trim() || 'Figura dal PDF',
        caption: imageRef?.caption || String(captionFallback || '').trim() || undefined,
      });
    }

    lastIndex = matchIndex + fullMatch.length;
    match = PDF_IMAGE_PLACEHOLDER_REGEX.exec(content);
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
