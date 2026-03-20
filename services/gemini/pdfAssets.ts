import type { LessonImageRef, PdfDocumentAssets, PdfImageAsset } from '../../types';
import {
  MODEL_REASONING,
  callOpenRouter,
  fileToDataUrl,
  getBackendUrl,
  isPdfFile,
  retryWithBackoff,
  type FileData,
} from './shared';

const PDF_PARSE_CACHE = new Map<string, Promise<PdfAssetSession>>();
const PDF_TEXT_PARSE_CACHE = new Map<string, Promise<PdfAssetSession>>();
const IMAGE_ID_PREFIX = 'pdf-img-';
const MAX_BACKEND_EXTRACTED_IMAGES = 36;
const MAX_CAPTIONED_IMAGES = 24;

interface BackendPdfImage {
  id: string;
  mimeType: string;
  dataUrl: string;
  sizeBytes: number;
  hash: string;
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
  textLength?: number;
  parser?: 'pdftotext' | 'pdf-parse';
  sourceHash?: string;
  pageCount?: number;
  error?: string;
}

export interface PdfAssetSession {
  images: PdfImageAsset[];
  extractedText: string;
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

const getPdfCacheKey = (file: FileData): string => `${file.name}:${file.data.length}:${file.data.slice(0, 96)}`;

const captionBackendImage = async (image: BackendPdfImage, index: number): Promise<PdfImageAsset> => {
  const prompt = `Describe this PDF figure in Italian with a concise, factual caption.
Rules:
- Mention anatomical structures, charts, diagrams, labels, or illustrations if visible.
- Max 40 words.
- No speculation.
- If the image is decorative or not meaningful, answer exactly: DECORATIVE`;

  const response = await retryWithBackoff(
    () =>
      callOpenRouter({
        model: MODEL_REASONING,
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

  const caption = (response || '').trim();
  const normalizedCaption = caption === 'DECORATIVE' ? '' : caption;

  return {
    id: image.id || `${IMAGE_ID_PREFIX}${String(index + 1).padStart(3, '0')}`,
    mimeType: image.mimeType || 'image/png',
    dataUrl: image.dataUrl,
    textBefore: normalizedCaption,
    textAfter: '',
    sourceOrder: index + 1,
  };
};

const extractPdfImagesViaBackend = async (file: FileData): Promise<PdfImageAsset[]> => {
  const response = await fetch(`${getBackendUrl()}/api/pdf/extract-images`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fileData: fileToDataUrl(file),
      limit: MAX_BACKEND_EXTRACTED_IMAGES,
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
      sizeBytes: image.sizeBytes,
      hash: image.hash,
    })),
  });

  const captionTargets = images.slice(0, MAX_CAPTIONED_IMAGES);
  const captionedImages = await Promise.all(
    captionTargets.map((image, index) => captionBackendImage(image, index))
  );

  logPdfAssetDebug('Backend image captions', {
    filename: file.name,
    captionedImageCount: captionedImages.length,
    captionedImages: captionedImages.map(image => ({
      id: image.id,
      caption: image.textBefore,
      sourceOrder: image.sourceOrder,
    })),
  });

  return captionedImages.filter(image => image.textBefore.trim().length > 0);
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
  logPdfAssetDebug('Backend text extraction result', {
    filename: file.name,
    parser: payload.parser,
    pageCount: payload.pageCount,
    textLength: extractedText.length,
    sourceHash: payload.sourceHash,
    preview: extractedText.slice(0, 400),
  });

  return {
    images: [],
    extractedText,
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

export const getPdfAssetSession = async (file: FileData): Promise<PdfAssetSession | null> => {
  if (!isPdfFile(file)) {
    return null;
  }

  const cacheKey = getPdfCacheKey(file);
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
      const backendImages = await extractPdfImagesViaBackend(file);
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
      console.warn('[Lumina][PDF] Backend extraction failed, using text-only parsed session.', error);
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
