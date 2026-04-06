import type { LessonImageRef, PdfDocumentAssets, PdfImageAsset, PdfTextPage } from '../../types.ts';
import {
  MODEL_PDF_IMAGE_CAPTION,
  MODEL_FLASH,
  callOpenRouter,
  fileToDataUrl,
  getBackendUrl,
  isPdfFile,
  retryWithBackoff,
  type FileData,
} from './shared.ts';

const PDF_PARSE_CACHE = new Map<string, Promise<PdfAssetSession>>();
const PDF_TEXT_PARSE_CACHE = new Map<string, Promise<PdfAssetSession>>();
const PDF_ASSET_CACHE_VERSION = 'resolution-filter-v2';
const IMAGE_ID_PREFIX = 'pdf-img-';
const MAX_BACKEND_EXTRACTED_IMAGES = 36;

interface BackendPdfImage {
  id: string;
  mimeType: string;
  dataUrl: string;
  sizeBytes: number;
  hash: string;
  pageNumber: number;
  intrinsicWidth?: number;
  intrinsicHeight?: number;
  textBefore?: string;
  textCurrent?: string;
  textAfter?: string;
}

interface BackendPdfExtractResponse {
  success: boolean;
  imageCount?: number;
  images?: BackendPdfImage[];
  error?: string;
}

interface BackendPdfTextResponse {
  success: boolean;
  text?: string;
  pages?: PdfTextPage[];
  textLength?: number;
  parser?: 'pdftotext' | 'pdf-parse';
  sourceHash?: string;
  pageCount?: number;
  error?: string;
}

export interface PdfAssetSession {
  images: PdfImageAsset[];
  extractedText: string;
  pages: PdfTextPage[];
  pageCount?: number;
  parser?: 'pdftotext' | 'pdf-parse';
  parsedAt: string;
  sourceHash?: string;
}

const logPdfAssetDebug = (label: string, payload: Record<string, unknown>) => {
  console.groupCollapsed(`[Lumina][PDF] ${label}`);
  Object.entries(payload).forEach(([key, value]) => {
    console.info(key, value);
  });
  console.groupEnd();
};

const sanitizePartialPages = (partialPages?: number[]): number[] | undefined => {
  if (!Array.isArray(partialPages) || partialPages.length === 0) {
    return undefined;
  }

  const cleaned = Array.from(
    new Set(
      partialPages.filter(page => Number.isInteger(page) && page > 0).map(page => Math.trunc(page))
    )
  ).sort((left, right) => left - right);

  return cleaned.length > 0 ? cleaned : undefined;
};

const getPdfCacheKey = (file: FileData, partialPages?: number[]): string => {
  const partialPageKey = sanitizePartialPages(partialPages)?.join(',') || 'all-pages';
  return `${PDF_ASSET_CACHE_VERSION}:${file.name}:${file.data.length}:${file.data.slice(0, 96)}:${partialPageKey}`;
};

const normalizeCaptionResponse = (value: string): string => {
  const trimmed = value.trim();
  return /^DECORATIVE$/iu.test(trimmed) ? '' : trimmed;
};

const normalizePageContextText = (pageText: string): string =>
  pageText.replace(/\r\n?/g, '\n').trim();

const buildImageSourceContext = (
  image: BackendPdfImage,
  _pages: PdfTextPage[] | undefined
): { promptContext: string; textBefore: string; textCurrent: string; textAfter: string } => {
  const backendTextBefore = normalizePageContextText(image.textBefore || '');
  const backendTextCurrent = normalizePageContextText(image.textCurrent || '');
  const backendTextAfter = normalizePageContextText(image.textAfter || '');

  if (backendTextBefore || backendTextCurrent || backendTextAfter) {
    return {
      promptContext: [
        backendTextBefore ? `Text immediately above the image:\n${backendTextBefore}` : '',
        backendTextCurrent ? `Text aligned with the image area:\n${backendTextCurrent}` : '',
        backendTextAfter ? `Text immediately below the image:\n${backendTextAfter}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      textBefore: backendTextBefore,
      textCurrent: backendTextCurrent,
      textAfter: backendTextAfter,
    };
  }

  return {
    textBefore: '',
    promptContext: '',
    textCurrent: '',
    textAfter: '',
  };
};

const requestImageCaption = async (
  image: BackendPdfImage,
  prompt: string,
  model: string
): Promise<string> => {
  const response = await retryWithBackoff(
    () =>
      callOpenRouter({
        model,
        disableModelOverride: true,
        max_tokens: 120,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: image.dataUrl } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
    2,
    500
  );

  return normalizeCaptionResponse(response || '');
};

const captionBackendImage = async (
  image: BackendPdfImage,
  index: number,
  pages: PdfTextPage[]
): Promise<PdfImageAsset> => {
  const sourceContext = buildImageSourceContext(image, pages);
  const prompt = `Describe this technical PDF figure in Italian with a concise, factual caption.
Rules:
- Mention the figure type when visible: diagram, schema, chart, UI mockup, architecture, map, raycast/visibility cone, labeled components, timeline, code screenshot, or illustration.
- Mention labels, geometric relations, arrows, regions, overlays, or compared elements if clearly visible.
- Max 45 words.
- No speculation.
- Use nearby PDF text only to disambiguate a figure that is already visually recognizable. Do not use the PDF text to guess the content of a blurry, partial, cropped, or unreadable image.
- If the image is decorative, partial, heavily cropped, blurry, mostly empty background, just a border/frame/wrapper, a section box, a separator, an icon, a badge, a ribbon, a logo, an ornament, or if the main subject is not clearly distinguishable, answer exactly: DECORATIVE
${
  sourceContext.promptContext
    ? `

PDF text context near the image (same/adjacent pages; use only to disambiguate labels/topic when consistent with the visible figure):
Page ${image.pageNumber}
${sourceContext.promptContext}`
    : ''
}`;

  let normalizedCaption = await requestImageCaption(image, prompt, MODEL_PDF_IMAGE_CAPTION);

  if (!normalizedCaption) {
    normalizedCaption = await requestImageCaption(image, prompt, MODEL_FLASH);
  }

  return {
    id: image.id || `${IMAGE_ID_PREFIX}${String(index + 1).padStart(3, '0')}`,
    mimeType: image.mimeType || 'image/png',
    dataUrl: image.dataUrl,
    caption: normalizedCaption || undefined,
    textBefore: sourceContext.textBefore,
    textCurrent: sourceContext.textCurrent,
    textAfter: sourceContext.textAfter,
    sourceOrder: index + 1,
    pageNumber: image.pageNumber,
  };
};

const extractPdfImagesViaBackend = async (
  file: FileData,
  pages: PdfTextPage[],
  partialPages?: number[]
): Promise<PdfImageAsset[]> => {
  const response = await fetch(`${getBackendUrl()}/api/pdf/extract-images`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fileData: fileToDataUrl(file),
      limit: MAX_BACKEND_EXTRACTED_IMAGES,
      partialPages: sanitizePartialPages(partialPages),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`PDF extraction backend error: ${response.status} ${errorText}`);
  }

  const payload = (await response.json()) as BackendPdfExtractResponse;
  if (!payload.success) {
    throw new Error(payload.error || 'Unknown PDF extraction backend error');
  }

  const images = Array.isArray(payload.images) ? payload.images : [];
  logPdfAssetDebug('Backend extraction result', {
    filename: file.name,
    imageCount: images.length,
    images: images.slice(0, 12).map(image => ({
      id: image.id,
      pageNumber: image.pageNumber,
      intrinsicWidth: image.intrinsicWidth,
      intrinsicHeight: image.intrinsicHeight,
      sizeBytes: image.sizeBytes,
      hash: image.hash,
    })),
  });

  const captionedImages = await Promise.all(
    images.map((image, index) => captionBackendImage(image, index, pages))
  );

  logPdfAssetDebug('Backend image captions', {
    filename: file.name,
    captionModel: MODEL_PDF_IMAGE_CAPTION,
    captionedImageCount: captionedImages.length,
    emptyCaptionCount: captionedImages.filter(image => !image.caption?.trim()).length,
    captionedImages: captionedImages.map(image => ({
      id: image.id,
      caption: image.caption || '',
      sourceTextBeforeChars: image.textBefore.length,
      sourceTextCurrentChars: image.textCurrent?.length || 0,
      sourceTextAfterChars: image.textAfter.length,
      pageNumber: image.pageNumber,
      sourceOrder: image.sourceOrder,
    })),
  });

  return captionedImages;
};

const extractPdfTextViaBackend = async (file: FileData): Promise<PdfAssetSession> => {
  const response = await fetch(`${getBackendUrl()}/api/pdf/extract-text`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fileData: fileToDataUrl(file),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`PDF text backend error: ${response.status} ${errorText}`);
  }

  const payload = (await response.json()) as BackendPdfTextResponse;
  if (!payload.success) {
    throw new Error(payload.error || 'Unknown PDF text backend error');
  }

  const extractedText = typeof payload.text === 'string' ? payload.text : '';
  const pages = Array.isArray(payload.pages)
    ? payload.pages
        .filter(
          (page): page is PdfTextPage =>
            Boolean(page) && Number.isInteger(page.pageNumber) && typeof page.text === 'string'
        )
        .map(page => ({
          pageNumber: page.pageNumber,
          text: page.text,
        }))
    : [];
  logPdfAssetDebug('Backend text extraction result', {
    filename: file.name,
    parser: payload.parser,
    pageCount: payload.pageCount,
    pageTextCount: pages.length,
    textLength: extractedText.length,
    sourceHash: payload.sourceHash,
    preview: extractedText.slice(0, 400),
  });

  return {
    images: [],
    extractedText,
    pages,
    pageCount: payload.pageCount,
    parser: payload.parser,
    parsedAt: new Date().toISOString(),
    sourceHash: payload.sourceHash,
  };
};

export const getPdfTextSession = async (file: FileData): Promise<PdfAssetSession | null> => {
  if (!isPdfFile(file)) {
    return null;
  }

  const cacheKey = getPdfCacheKey(file);
  const cached = PDF_TEXT_PARSE_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  const nextPromise = extractPdfTextViaBackend(file).catch(error => {
    PDF_TEXT_PARSE_CACHE.delete(cacheKey);
    throw error;
  });

  PDF_TEXT_PARSE_CACHE.set(cacheKey, nextPromise);
  return nextPromise;
};

export const getPdfAssetSession = async (
  file: FileData,
  options?: { partialPages?: number[] }
): Promise<PdfAssetSession | null> => {
  if (!isPdfFile(file)) {
    return null;
  }

  const sanitizedPartialPages = sanitizePartialPages(options?.partialPages);
  const cacheKey = getPdfCacheKey(file, sanitizedPartialPages);
  const cached = PDF_PARSE_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  const nextPromise = (async () => {
    const parsedResult = await getPdfTextSession(file);
    if (!parsedResult) {
      return null;
    }

    if (parsedResult.images.length > 0) {
      return parsedResult;
    }

    try {
      const backendImages = await extractPdfImagesViaBackend(
        file,
        parsedResult.pages,
        sanitizedPartialPages
      );
      if (backendImages.length > 0) {
        return {
          ...parsedResult,
          images: backendImages,
        } satisfies PdfAssetSession;
      }

      logPdfAssetDebug('Backend extraction returned no usable images', {
        filename: file.name,
      });
    } catch (error) {
      console.warn(
        '[Lumina][PDF] Backend extraction failed, using text-only parsed session.',
        error
      );
    }

    return parsedResult;
  })().catch(error => {
    PDF_PARSE_CACHE.delete(cacheKey);
    throw error;
  });

  PDF_PARSE_CACHE.set(cacheKey, nextPromise);
  return nextPromise;
};

export const buildStoredPdfDocumentAssets = (
  session: PdfAssetSession,
  imageRefs: LessonImageRef[],
  existingAssets?: PdfDocumentAssets | null
): PdfDocumentAssets => {
  const availableAssets = new Map<string, PdfImageAsset>();

  session.images.forEach(asset => {
    availableAssets.set(asset.id, asset);
  });

  existingAssets?.usedImages.forEach(asset => {
    if (!availableAssets.has(asset.id)) {
      availableAssets.set(asset.id, asset);
    }
  });

  const usedImages = Array.from(new Set(imageRefs.map(ref => ref.assetId)))
    .map(assetId => availableAssets.get(assetId))
    .filter((asset): asset is PdfImageAsset => Boolean(asset));

  return {
    kind: 'pdf',
    parsedAt: session.parsedAt,
    imageCount: session.images.length,
    sourceHash: session.sourceHash,
    usedImages,
  };
};
