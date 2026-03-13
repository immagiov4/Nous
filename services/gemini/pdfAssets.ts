import type { LessonImageRef, PdfDocumentAssets, PdfImageAsset } from '../../types';
import {
  MODEL_FLASH,
  callOpenRouter,
  callOpenRouterRaw,
  fileToDataUrl,
  getBackendUrl,
  isPdfFile,
  retryWithBackoff,
  type FileAnnotation,
  type FileAnnotationContentPart,
  type FileData,
} from './shared';

const PDF_PARSE_CACHE = new Map<string, Promise<PdfAssetSession>>();
const CONTEXT_WINDOW_CHARS = 320;
const IMAGE_ID_PREFIX = 'pdf-img-';
const MAX_BACKEND_EXTRACTED_IMAGES = 36;
const MAX_CAPTIONED_IMAGES = 24;

interface NormalizedTextBlock {
  type: 'text';
  text: string;
}

interface NormalizedImageBlock {
  type: 'image';
  dataUrl: string;
  mimeType: string;
}

type NormalizedPdfBlock = NormalizedTextBlock | NormalizedImageBlock;

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

export interface PdfAssetSession {
  annotations: FileAnnotation[];
  images: PdfImageAsset[];
  parsedAt: string;
  sourceHash?: string;
}

const summarizeAnnotations = (annotations: FileAnnotation[]) =>
  annotations.map(annotation => {
    const content = Array.isArray(annotation.file.content) ? annotation.file.content : [];
    return {
      type: annotation.type,
      name: annotation.file.name,
      hash: annotation.file.hash,
      textBlocks: content.filter(part => part.type === 'text').length,
      imageBlocks: content.filter(part => part.type === 'image_url').length,
    };
  });

const logPdfAssetDebug = (label: string, payload: Record<string, unknown>) => {
  console.groupCollapsed(`[Lumina][PDF] ${label}`);
  Object.entries(payload).forEach(([key, value]) => {
    console.info(key, value);
  });
  console.groupEnd();
};

const getPdfCacheKey = (file: FileData): string => `${file.name}:${file.data.length}:${file.data.slice(0, 96)}`;

const normalizeWhitespace = (text: string): string =>
  text.replace(/\s+/g, ' ').trim();

const clipContext = (text: string, takeFromEnd = false): string => {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= CONTEXT_WINDOW_CHARS) {
    return normalized;
  }

  return takeFromEnd
    ? normalized.slice(-CONTEXT_WINDOW_CHARS)
    : normalized.slice(0, CONTEXT_WINDOW_CHARS);
};

const getMimeTypeFromDataUrl = (dataUrl: string): string => {
  const match = /^data:([^;]+);base64,/i.exec(dataUrl);
  return match?.[1] || 'image/png';
};

const flattenAnnotationContent = (annotations: FileAnnotation[]): NormalizedPdfBlock[] => {
  const blocks: NormalizedPdfBlock[] = [];

  annotations.forEach(annotation => {
    if (annotation.type !== 'file' || !Array.isArray(annotation.file.content)) {
      return;
    }

    annotation.file.content.forEach((part: FileAnnotationContentPart) => {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        blocks.push({ type: 'text', text: part.text });
        return;
      }

      if (
        part.type === 'image_url' &&
        typeof part.image_url?.url === 'string' &&
        part.image_url.url.startsWith('data:image/')
      ) {
        blocks.push({
          type: 'image',
          dataUrl: part.image_url.url,
          mimeType: getMimeTypeFromDataUrl(part.image_url.url),
        });
      }
    });
  });

  return blocks;
};

const extractPdfImageAssets = (annotations: FileAnnotation[]): PdfImageAsset[] => {
  const blocks = flattenAnnotationContent(annotations);
  const images = blocks.filter((block): block is NormalizedImageBlock => block.type === 'image');

  return images.map((block, index) => {
    const priorText = blocks
      .slice(0, blocks.indexOf(block))
      .filter((candidate): candidate is NormalizedTextBlock => candidate.type === 'text')
      .map(candidate => candidate.text)
      .join(' ');
    const nextText = blocks
      .slice(blocks.indexOf(block) + 1)
      .filter((candidate): candidate is NormalizedTextBlock => candidate.type === 'text')
      .map(candidate => candidate.text)
      .join(' ');

    return {
      id: `${IMAGE_ID_PREFIX}${String(index + 1).padStart(3, '0')}`,
      mimeType: block.mimeType,
      dataUrl: block.dataUrl,
      textBefore: clipContext(priorText, true),
      textAfter: clipContext(nextText),
      sourceOrder: index + 1,
    };
  });
};

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
        model: MODEL_FLASH,
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

const parsePdfAnnotations = async (file: FileData): Promise<PdfAssetSession> => {
  const response = await retryWithBackoff(
    () =>
      callOpenRouterRaw({
        model: MODEL_FLASH,
        max_tokens: 256,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Parse this PDF and return a short acknowledgement. Preserve file annotations so I can reuse text and images later.',
              },
              {
                type: 'file',
                file: {
                  filename: file.name,
                  file_data: fileToDataUrl(file),
                },
              },
            ],
          },
        ],
        plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }],
      }),
    2,
    1000
  );

  const message = response.choices?.[0]?.message;
  const annotations = Array.isArray(message?.annotations) ? message.annotations : [];
  const sourceHash = annotations.find(annotation => annotation.type === 'file')?.file.hash;
  const images = extractPdfImageAssets(annotations);

  logPdfAssetDebug('Parse result', {
    filename: file.name,
    annotationCount: annotations.length,
    annotationSummary: summarizeAnnotations(annotations),
    extractedImageCount: images.length,
    extractedImages: images.map(image => ({
      id: image.id,
      mimeType: image.mimeType,
      sourceOrder: image.sourceOrder,
      textBefore: image.textBefore.slice(-120),
      textAfter: image.textAfter.slice(0, 120),
    })),
  });

  return {
    annotations,
    images,
    parsedAt: new Date().toISOString(),
    sourceHash,
  };
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
    try {
      const backendImages = await extractPdfImagesViaBackend(file);
      if (backendImages.length > 0) {
        return {
          annotations: [],
          images: backendImages,
          parsedAt: new Date().toISOString(),
          sourceHash: undefined,
        } satisfies PdfAssetSession;
      }

      logPdfAssetDebug('Backend extraction returned no usable images', {
        filename: file.name,
      });
    } catch (error) {
      console.warn('[Lumina][PDF] Backend extraction failed, falling back to annotation parsing.', error);
    }

    return parsePdfAnnotations(file);
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
