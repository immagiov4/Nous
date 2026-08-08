// Extracts rendered PDF page images for backend processing.

import { sanitizePartialPages } from '@shared/sanitizePartialPages';
import { PDFParse } from 'pdf-parse';
import { buildSha256HexDigest } from '../utils/hash.js';
import { decodePdfDataUrl } from '../utils/pdfDataUrl.js';
import { normalizeLineEndings } from '../utils/text.js';

const MIN_IMAGE_BYTES = 2_000;
const IMAGE_CONTEXT_LINE_COUNT = 5;
const LINE_THRESHOLD = 4.6;
const CELL_THRESHOLD = 7;
const IMAGE_DIMENSION_THRESHOLD = 32;
const STANDALONE_RENDERED_IMAGE_MIN_AREA = 10_000;
const STANDALONE_RENDERED_IMAGE_MIN_MAX_DIMENSION = 140;
const STANDALONE_RENDERED_IMAGE_MIN_SHORT_SIDE = 72;
const STANDALONE_INTRINSIC_IMAGE_MIN_AREA = 24_000;
const STANDALONE_INTRINSIC_IMAGE_MIN_MAX_DIMENSION = 220;
const STANDALONE_INTRINSIC_IMAGE_MIN_SHORT_SIDE = 110;
const INLINE_RENDERED_IMAGE_MIN_DIMENSION = 90;
const INLINE_RENDERED_IMAGE_MIN_AREA = 14_000;
const UPSCALED_IMAGE_RENDERED_MIN_SHORT_SIDE = 140;
const UPSCALED_IMAGE_MIN_SHORT_SIDE_RATIO = 0.8;
const UPSCALED_IMAGE_MIN_AREA_RATIO = 0.6;
const UPSCALED_IMAGE_MAX_INTRINSIC_MAX_DIMENSION = 260;

export interface ExtractedPdfImage {
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

export interface PdfImageExtractionResult {
  failedPages: number[];
  images: ExtractedPdfImage[];
}

export class PdfImageExtractionError extends Error {
  readonly code = 'pdf_image_extraction_failed';
  readonly failedPages: number[];

  constructor(failedPages: number[], cause?: unknown) {
    super('PDF image extraction failed for every attempted page.', { cause });
    this.name = 'PdfImageExtractionError';
    this.failedPages = [...new Set(failedPages)].sort((left, right) => left - right);
  }
}

interface ImageDimensions {
  width: number;
  height: number;
}

interface ImageRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface PositionedPdfTextLine {
  text: string;
  top: number;
  bottom: number;
  centerY: number;
}

interface PageImagePlacement {
  isInline: boolean;
  intrinsicHeight: number;
  intrinsicWidth: number;
  rect: ImageRect;
  renderedHeight: number;
  renderedWidth: number;
}

const IMAGE_DATA_URL_PREFIX = /^data:([^;]+);base64,/i;

const getMimeTypeFromDataUrl = (dataUrl: string): string => {
  const match = IMAGE_DATA_URL_PREFIX.exec(dataUrl);
  return match?.[1] || 'image/png';
};

const decodeImageDataUrl = (dataUrl: string): Buffer => {
  const match = IMAGE_DATA_URL_PREFIX.exec(dataUrl);
  const base64 = match ? dataUrl.slice(match[0].length) : '';
  return Buffer.from(base64, 'base64');
};

const emptyImageTextContext = Object.freeze({
  textBefore: '',
  textCurrent: '',
  textAfter: '',
});

const normalizeLineText = (value: string): string =>
  normalizeLineEndings(value)
    .replaceAll(/[ \t]+/g, ' ')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();

const joinLineTexts = (lines: PositionedPdfTextLine[]): string =>
  lines
    .map(line => normalizeLineText(line.text))
    .filter(Boolean)
    .join('\n');

export const buildLocalImageTextContext = (
  lines: PositionedPdfTextLine[],
  rect: ImageRect
): { textBefore: string; textCurrent: string; textAfter: string } => {
  if (!Array.isArray(lines) || lines.length === 0) {
    return emptyImageTextContext;
  }

  const sortedLines = [...lines].sort((left, right) =>
    left.centerY === right.centerY ? left.top - right.top : left.centerY - right.centerY
  );

  const beforeLines = sortedLines
    .filter(line => line.centerY < rect.top)
    .slice(-IMAGE_CONTEXT_LINE_COUNT);
  const currentLines = sortedLines.filter(line => line.bottom > rect.top && line.top < rect.bottom);
  const afterLines = sortedLines
    .filter(line => line.centerY > rect.bottom)
    .slice(0, IMAGE_CONTEXT_LINE_COUNT);

  return {
    textBefore: joinLineTexts(beforeLines),
    textCurrent: joinLineTexts(currentLines),
    textAfter: joinLineTexts(afterLines),
  };
};

const getPdfJsModule = async () => await import('pdfjs-dist/legacy/build/pdf.mjs');

const transformPoint = (matrix: number[], x: number, y: number) => ({
  x: matrix[0] * x + matrix[2] * y + matrix[4],
  y: matrix[1] * x + matrix[3] * y + matrix[5],
});

const computeImageRect = (transformMatrix: number[], viewportTransform: number[]): ImageRect => {
  const combinedMatrix = [
    viewportTransform[0] * transformMatrix[0] + viewportTransform[2] * transformMatrix[1],
    viewportTransform[1] * transformMatrix[0] + viewportTransform[3] * transformMatrix[1],
    viewportTransform[0] * transformMatrix[2] + viewportTransform[2] * transformMatrix[3],
    viewportTransform[1] * transformMatrix[2] + viewportTransform[3] * transformMatrix[3],
    viewportTransform[0] * transformMatrix[4] +
      viewportTransform[2] * transformMatrix[5] +
      viewportTransform[4],
    viewportTransform[1] * transformMatrix[4] +
      viewportTransform[3] * transformMatrix[5] +
      viewportTransform[5],
  ];
  const points = [
    transformPoint(combinedMatrix, 0, 0),
    transformPoint(combinedMatrix, 1, 0),
    transformPoint(combinedMatrix, 0, 1),
    transformPoint(combinedMatrix, 1, 1),
  ];

  return {
    left: Math.min(...points.map(point => point.x)),
    top: Math.min(...points.map(point => point.y)),
    right: Math.max(...points.map(point => point.x)),
    bottom: Math.max(...points.map(point => point.y)),
  };
};

const measureImageRect = (rect: ImageRect) => ({
  renderedHeight: Math.max(0, Math.abs(rect.bottom - rect.top)),
  renderedWidth: Math.max(0, Math.abs(rect.right - rect.left)),
});

const resolvePngDimensions = (dataBuffer: Buffer): ImageDimensions | null => {
  if (dataBuffer.length < 24 || dataBuffer.toString('ascii', 1, 4) !== 'PNG') {
    return null;
  }

  const width = dataBuffer.readUInt32BE(16);
  const height = dataBuffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
};

const resolveGifDimensions = (dataBuffer: Buffer): ImageDimensions | null => {
  if (dataBuffer.length < 10 || dataBuffer.toString('ascii', 0, 3) !== 'GIF') {
    return null;
  }

  const width = dataBuffer.readUInt16LE(6);
  const height = dataBuffer.readUInt16LE(8);
  return width > 0 && height > 0 ? { width, height } : null;
};

const resolveJpegDimensions = (dataBuffer: Buffer): ImageDimensions | null => {
  if (dataBuffer.length < 4 || dataBuffer[0] !== 0xff || dataBuffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 9 < dataBuffer.length) {
    if (dataBuffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    while (offset < dataBuffer.length && dataBuffer[offset] === 0xff) {
      offset += 1;
    }

    if (offset >= dataBuffer.length) {
      return null;
    }

    const marker = dataBuffer[offset];
    offset += 1;

    if (marker === 0xd8 || marker === 0xd9) {
      continue;
    }

    if (marker === 0xda) {
      return null;
    }

    if (offset + 1 >= dataBuffer.length) {
      return null;
    }

    const segmentLength = dataBuffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > dataBuffer.length) {
      return null;
    }

    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 6 >= dataBuffer.length) {
        return null;
      }

      const height = dataBuffer.readUInt16BE(offset + 3);
      const width = dataBuffer.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }

    offset += segmentLength;
  }

  return null;
};

const resolveImageIntrinsicDimensions = (
  dataBuffer: Buffer,
  mimeType: string
): ImageDimensions | null => {
  if (mimeType === 'image/png') {
    return resolvePngDimensions(dataBuffer);
  }

  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
    return resolveJpegDimensions(dataBuffer);
  }

  if (mimeType === 'image/gif') {
    return resolveGifDimensions(dataBuffer);
  }

  return null;
};

type StandaloneFigureCandidate = Pick<
  PageImagePlacement,
  'intrinsicHeight' | 'intrinsicWidth' | 'isInline'
> &
  Partial<Pick<PageImagePlacement, 'renderedHeight' | 'renderedWidth'>>;

export const isPdfImageTooSmallForStandaloneFigure = (
  placement: StandaloneFigureCandidate
): boolean => {
  const renderedHeight = Math.max(0, placement.renderedHeight ?? placement.intrinsicHeight);
  const renderedWidth = Math.max(0, placement.renderedWidth ?? placement.intrinsicWidth);
  const minDimension = Math.min(renderedWidth, renderedHeight);
  const maxDimension = Math.max(renderedWidth, renderedHeight);
  const renderedArea = renderedWidth * renderedHeight;
  const intrinsicMinDimension = Math.min(placement.intrinsicWidth, placement.intrinsicHeight);
  const intrinsicMaxDimension = Math.max(placement.intrinsicWidth, placement.intrinsicHeight);
  const intrinsicArea = placement.intrinsicWidth * placement.intrinsicHeight;

  if (
    intrinsicMinDimension < STANDALONE_INTRINSIC_IMAGE_MIN_SHORT_SIDE &&
    intrinsicMaxDimension < STANDALONE_INTRINSIC_IMAGE_MIN_MAX_DIMENSION
  ) {
    return true;
  }

  if (
    intrinsicArea < STANDALONE_INTRINSIC_IMAGE_MIN_AREA &&
    intrinsicMaxDimension < STANDALONE_INTRINSIC_IMAGE_MIN_MAX_DIMENSION
  ) {
    return true;
  }

  if (
    minDimension < STANDALONE_RENDERED_IMAGE_MIN_SHORT_SIDE &&
    maxDimension < STANDALONE_RENDERED_IMAGE_MIN_MAX_DIMENSION
  ) {
    return true;
  }

  if (
    renderedArea < STANDALONE_RENDERED_IMAGE_MIN_AREA &&
    maxDimension < STANDALONE_RENDERED_IMAGE_MIN_MAX_DIMENSION
  ) {
    return true;
  }

  if (
    minDimension >= UPSCALED_IMAGE_RENDERED_MIN_SHORT_SIDE &&
    intrinsicMaxDimension < UPSCALED_IMAGE_MAX_INTRINSIC_MAX_DIMENSION &&
    intrinsicMinDimension < minDimension * UPSCALED_IMAGE_MIN_SHORT_SIDE_RATIO &&
    intrinsicArea < renderedArea * UPSCALED_IMAGE_MIN_AREA_RATIO
  ) {
    return true;
  }

  if (!placement.isInline) {
    return false;
  }

  return (
    minDimension < INLINE_RENDERED_IMAGE_MIN_DIMENSION ||
    renderedArea < INLINE_RENDERED_IMAGE_MIN_AREA
  );
};

const resolveEmbeddedImage = (
  pdfObjects: {
    get: (name: unknown, callback: (imgData: unknown) => void) => void;
  },
  name: unknown
): Promise<{ width: number; height: number }> =>
  new Promise((resolve, reject) => {
    pdfObjects.get(name, (imgData: unknown) => {
      if (!imgData || typeof imgData !== 'object') {
        reject(new Error(`Image object ${String(name)} not found`));
        return;
      }

      const width =
        typeof (imgData as { width?: unknown }).width === 'number'
          ? (imgData as { width: number }).width
          : 0;
      const height =
        typeof (imgData as { height?: unknown }).height === 'number'
          ? (imgData as { height: number }).height
          : 0;

      if (!width || !height) {
        reject(new Error(`Image object ${String(name)} has invalid dimensions`));
        return;
      }

      resolve({ width, height });
    });
  });

interface PdfPageProxy {
  cleanup: () => void;
  commonObjs: {
    has: (name: unknown) => boolean;
    get: (name: unknown, callback: (imgData: unknown) => void) => void;
  };
  getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  getTextContent: (params: {
    includeMarkedContent: boolean;
    disableNormalization: boolean;
  }) => Promise<{ items: unknown[] }>;
  getViewport: (params: { scale: number }) => {
    convertToViewportPoint: (x: number, y: number) => [number, number];
    transform: number[];
  };
  objs: { get: (name: unknown, callback: (imgData: unknown) => void) => void };
}

interface PdfDocumentProxy {
  getPage: (pageNumber: number) => Promise<PdfPageProxy>;
}

interface PendingPdfTextLine {
  baselineY: number;
  bottom: number;
  lastX?: number;
  parts: string[];
  top: number;
}

interface PositionedPdfTextFragment {
  baselineY: number;
  bottom: number;
  endsLine: boolean;
  left: number;
  text: string;
  top: number;
  width: number;
}

const readPositionedPdfTextFragment = (
  value: unknown,
  viewport: ReturnType<PdfPageProxy['getViewport']>
): PositionedPdfTextFragment | null => {
  if (!value || typeof value !== 'object' || !('str' in value)) return null;

  const text = typeof value.str === 'string' ? value.str : '';
  if (!text.trim()) return null;

  const metrics = value as {
    hasEOL?: boolean;
    height?: number;
    transform?: number[];
    width?: number;
  };
  const transform =
    Array.isArray(metrics.transform) && metrics.transform.length >= 6
      ? metrics.transform
      : [1, 0, 0, 1, 0, 0];
  const [left, baselineY] = viewport.convertToViewportPoint(transform[4], transform[5]);
  const height = Math.max(
    1,
    Math.abs(typeof metrics.height === 'number' ? metrics.height : transform[3])
  );
  return {
    baselineY,
    bottom: Math.max(baselineY, baselineY - height),
    endsLine: metrics.hasEOL === true || text.endsWith('\n'),
    left,
    text,
    top: Math.min(baselineY, baselineY - height),
    width: typeof metrics.width === 'number' ? metrics.width : 0,
  };
};

const extractPageTextLines = async (page: PdfPageProxy): Promise<PositionedPdfTextLine[]> => {
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent({
    includeMarkedContent: false,
    disableNormalization: false,
  });

  const lines: PendingPdfTextLine[] = [];
  let currentLine: PendingPdfTextLine | null = null;

  const flushCurrentLine = () => {
    if (!currentLine) {
      return;
    }

    const text = normalizeLineText(currentLine.parts.join(''));
    if (text) {
      lines.push({
        parts: [text],
        top: currentLine.top,
        bottom: currentLine.bottom,
        baselineY: currentLine.baselineY,
      });
    }

    currentLine = null;
  };

  for (const item of textContent.items) {
    const fragment = readPositionedPdfTextFragment(item, viewport);
    if (!fragment) continue;

    if (!currentLine || Math.abs(currentLine.baselineY - fragment.baselineY) > LINE_THRESHOLD) {
      flushCurrentLine();
      currentLine = {
        baselineY: fragment.baselineY,
        bottom: fragment.bottom,
        parts: [],
        top: fragment.top,
      };
    } else {
      currentLine.top = Math.min(currentLine.top, fragment.top);
      currentLine.bottom = Math.max(currentLine.bottom, fragment.bottom);
    }

    if (
      currentLine.lastX !== undefined &&
      fragment.left - currentLine.lastX > CELL_THRESHOLD &&
      currentLine.parts.length > 0
    ) {
      currentLine.parts.push(' ');
    }

    currentLine.parts.push(fragment.text);
    currentLine.lastX = fragment.left + fragment.width;

    if (fragment.endsLine) flushCurrentLine();
  }

  flushCurrentLine();

  return lines
    .map(line => ({
      text: line.parts[0],
      top: line.top,
      bottom: line.bottom,
      centerY: (line.top + line.bottom) / 2,
    }))
    .filter(line => line.text.length > 0);
};

const extractPageImagePlacements = async (
  page: PdfPageProxy,
  imageThreshold: number
): Promise<PageImagePlacement[]> => {
  const pdfjs = await getPdfJsModule();
  const viewport = page.getViewport({ scale: 1 });
  const opList = await page.getOperatorList();
  let transformMatrix = [1, 0, 0, 1, 0, 0];
  const transformStack: number[][] = [];
  const placements: PageImagePlacement[] = [];

  for (let index = 0; index < opList.fnArray.length; index += 1) {
    const fn = opList.fnArray[index];
    const args = Array.isArray(opList.argsArray[index])
      ? (opList.argsArray[index] as unknown[])
      : [];

    if (fn === pdfjs.OPS.save) {
      transformStack.push([...transformMatrix]);
      continue;
    }

    if (fn === pdfjs.OPS.restore) {
      const restoredMatrix = transformStack.pop();
      if (restoredMatrix) {
        transformMatrix = restoredMatrix;
      }
      continue;
    }

    if (fn === pdfjs.OPS.transform) {
      transformMatrix = pdfjs.Util.transform(transformMatrix, args as number[]);
      continue;
    }

    if (fn !== pdfjs.OPS.paintInlineImageXObject && fn !== pdfjs.OPS.paintImageXObject) {
      continue;
    }

    const name = args[0];
    const isCommon = page.commonObjs.has(name);
    const { width, height } = await resolveEmbeddedImage(
      isCommon ? page.commonObjs : page.objs,
      name
    );

    if (imageThreshold >= width || imageThreshold >= height) {
      continue;
    }

    const rect = computeImageRect(transformMatrix, viewport.transform);
    const { renderedHeight, renderedWidth } = measureImageRect(rect);

    placements.push({
      isInline: fn === pdfjs.OPS.paintInlineImageXObject,
      intrinsicHeight: height,
      intrinsicWidth: width,
      rect,
      renderedHeight,
      renderedWidth,
    });
  }

  return placements;
};

interface PdfImagePage {
  pageNumber: number;
  images: { dataUrl?: string }[];
}

interface PdfImagePageResult {
  failedPages: number[];
  pages: PdfImagePage[];
  successfulPages: number[];
}

const fetchImagesForPages = async (
  parser: PDFParse,
  pages: number[] | undefined
): Promise<PdfImagePageResult> => {
  if (!pages || pages.length === 0) {
    try {
      const bulk = await parser.getImage({
        imageThreshold: IMAGE_DIMENSION_THRESHOLD,
        imageBuffer: false,
        imageDataUrl: true,
      });
      const imagePages = bulk.pages as PdfImagePage[];
      return {
        failedPages: [],
        pages: imagePages,
        successfulPages: [...new Set(imagePages.map(page => page.pageNumber))].sort(
          (left, right) => left - right
        ),
      };
    } catch (error) {
      console.warn(
        '[Backend] Bulk PDF image extraction failed, falling back to per-page extraction.',
        error
      );
      const doc = (parser as unknown as { doc?: { numPages?: number } }).doc;
      const numPages = doc?.numPages ?? 0;
      if (numPages <= 0) {
        throw new PdfImageExtractionError([], error);
      }
      pages = Array.from({ length: numPages }, (_, index) => index + 1);
    }
  }

  const collected: PdfImagePage[] = [];
  const failedPages: number[] = [];
  const successfulPages: number[] = [];
  let firstFailure: unknown;
  for (const pageNumber of pages) {
    try {
      const pageResult = await parser.getImage({
        imageThreshold: IMAGE_DIMENSION_THRESHOLD,
        imageBuffer: false,
        imageDataUrl: true,
        partial: [pageNumber],
      });
      for (const page of pageResult.pages as PdfImagePage[]) {
        collected.push(page);
      }
      successfulPages.push(pageNumber);
    } catch (error) {
      firstFailure ??= error;
      failedPages.push(pageNumber);
      console.warn('[Backend] PDF page image extraction failed.', { error, pageNumber });
    }
  }
  if (successfulPages.length === 0 && failedPages.length > 0) {
    throw new PdfImageExtractionError(failedPages, firstFailure);
  }
  return { failedPages, pages: collected, successfulPages };
};

interface PdfImageCandidateInput {
  existingImages: ReadonlyMap<string, ExtractedPdfImage>;
  image: PdfImagePage['images'][number];
  imageNumber: number;
  pageLines: PositionedPdfTextLine[];
  pageNumber: number;
  placement?: PageImagePlacement;
}

const buildExtractedPdfImage = ({
  existingImages,
  image,
  imageNumber,
  pageLines,
  pageNumber,
  placement,
}: PdfImageCandidateInput): ExtractedPdfImage | null => {
  if (!image.dataUrl) return null;

  const mimeType = getMimeTypeFromDataUrl(image.dataUrl);
  const dataBuffer = decodeImageDataUrl(image.dataUrl);
  if (dataBuffer.length < MIN_IMAGE_BYTES) return null;

  const intrinsicDimensions =
    resolveImageIntrinsicDimensions(dataBuffer, mimeType) ||
    (placement
      ? {
          width: placement.intrinsicWidth,
          height: placement.intrinsicHeight,
        }
      : null);
  if (
    intrinsicDimensions &&
    isPdfImageTooSmallForStandaloneFigure({
      isInline: placement?.isInline ?? false,
      intrinsicHeight: intrinsicDimensions.height,
      intrinsicWidth: intrinsicDimensions.width,
      renderedHeight: placement?.renderedHeight,
      renderedWidth: placement?.renderedWidth,
    })
  ) {
    return null;
  }

  const hash = buildSha256HexDigest(dataBuffer);
  if (existingImages.has(hash)) return null;

  const imageContext = placement
    ? buildLocalImageTextContext(pageLines, placement.rect)
    : emptyImageTextContext;
  return {
    dataUrl: image.dataUrl,
    hash,
    id: `pdf-img-${String(imageNumber).padStart(3, '0')}`,
    intrinsicHeight: intrinsicDimensions?.height,
    intrinsicWidth: intrinsicDimensions?.width,
    mimeType,
    pageNumber,
    sizeBytes: dataBuffer.length,
    textAfter: imageContext.textAfter,
    textBefore: imageContext.textBefore,
    textCurrent: imageContext.textCurrent,
  };
};

const appendPdfPageImages = async ({
  dedupedImages,
  limit,
  page,
  pageProxy,
  signal,
}: {
  dedupedImages: Map<string, ExtractedPdfImage>;
  limit: number;
  page: PdfImagePage;
  pageProxy: PdfPageProxy | null;
  signal?: AbortSignal;
}): Promise<void> => {
  const [pageLines, pagePlacements]: [PositionedPdfTextLine[], PageImagePlacement[]] = pageProxy
    ? await Promise.all([
        extractPageTextLines(pageProxy),
        extractPageImagePlacements(pageProxy, IMAGE_DIMENSION_THRESHOLD),
      ])
    : [[], []];

  for (const [pageImageIndex, image] of page.images.entries()) {
    signal?.throwIfAborted();
    const extractedImage = buildExtractedPdfImage({
      existingImages: dedupedImages,
      image,
      imageNumber: dedupedImages.size + 1,
      pageLines,
      pageNumber: page.pageNumber,
      placement: pagePlacements[pageImageIndex],
    });
    if (!extractedImage) continue;

    dedupedImages.set(extractedImage.hash, extractedImage);
    if (dedupedImages.size >= limit) break;
  }
};

export const extractPdfImages = async (
  pdfDataUrl: string,
  limit = 36,
  partialPages?: number[],
  signal?: AbortSignal
): Promise<PdfImageExtractionResult> => {
  signal?.throwIfAborted();
  const pdfBuffer = decodePdfDataUrl(pdfDataUrl);
  const parser = new PDFParse({ data: pdfBuffer });
  const abortExtraction = () => {
    void parser.destroy().catch(() => undefined);
  };
  signal?.addEventListener('abort', abortExtraction, { once: true });
  const dedupedImages = new Map<string, ExtractedPdfImage>();
  const sanitizedPartialPages = sanitizePartialPages(partialPages);
  const failedPages = new Set<number>();
  const successfulPages = new Set<number>();
  let firstPageProcessingFailure: unknown;

  try {
    const pageResult = await fetchImagesForPages(parser, sanitizedPartialPages);
    for (const pageNumber of pageResult.failedPages) failedPages.add(pageNumber);
    for (const pageNumber of pageResult.successfulPages) successfulPages.add(pageNumber);
    signal?.throwIfAborted();
    const pdfDocument = (parser as unknown as { doc?: PdfDocumentProxy }).doc;

    for (const page of pageResult.pages) {
      signal?.throwIfAborted();
      let pageProxy: PdfPageProxy | null = null;
      try {
        pageProxy = pdfDocument ? await pdfDocument.getPage(page.pageNumber) : null;
        await appendPdfPageImages({
          dedupedImages,
          limit,
          page,
          pageProxy,
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        firstPageProcessingFailure ??= error;
        failedPages.add(page.pageNumber);
        successfulPages.delete(page.pageNumber);
        console.warn('[Backend] PDF page image processing failed.', {
          error,
          pageNumber: page.pageNumber,
        });
      } finally {
        pageProxy?.cleanup();
      }

      if (dedupedImages.size >= limit) {
        break;
      }
    }

    if (successfulPages.size === 0 && failedPages.size > 0) {
      throw new PdfImageExtractionError([...failedPages], firstPageProcessingFailure);
    }
  } finally {
    signal?.removeEventListener('abort', abortExtraction);
    await parser.destroy().catch(() => undefined);
  }

  return {
    failedPages: [...failedPages].sort((left, right) => left - right),
    images: Array.from(dedupedImages.values()),
  };
};
