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

const getPdfJsModule = async () =>
  await import(
    new URL(
      '../../node_modules/pdf-parse/node_modules/pdfjs-dist/legacy/build/pdf.mjs',
      import.meta.url
    ).href
  );

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

const extractPageTextLines = async (page: {
  getViewport: (params: { scale: number }) => {
    convertToViewportPoint: (x: number, y: number) => [number, number];
  };
  getTextContent: (params: {
    includeMarkedContent: boolean;
    disableNormalization: boolean;
  }) => Promise<{ items: unknown[] }>;
}): Promise<PositionedPdfTextLine[]> => {
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent({
    includeMarkedContent: false,
    disableNormalization: false,
  });

  const lines: Array<{
    parts: string[];
    top: number;
    bottom: number;
    baselineY: number;
    lastX?: number;
  }> = [];
  let currentLine: {
    parts: string[];
    top: number;
    bottom: number;
    baselineY: number;
    lastX?: number;
  } | null = null;

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
    if (!item || typeof item !== 'object' || !('str' in item)) {
      continue;
    }

    const text = typeof item.str === 'string' ? item.str : '';
    if (!text.trim()) {
      continue;
    }

    const itemMetrics = item as unknown as {
      transform?: number[];
      height?: number;
      width?: number;
      hasEOL?: boolean;
    };
    const transform =
      Array.isArray(itemMetrics.transform) && itemMetrics.transform.length >= 6
        ? itemMetrics.transform
        : [1, 0, 0, 1, 0, 0];
    const [x, y] = viewport.convertToViewportPoint(transform[4], transform[5]);
    const height = Math.max(
      1,
      Math.abs(typeof itemMetrics.height === 'number' ? itemMetrics.height : transform[3])
    );
    const width = typeof itemMetrics.width === 'number' ? itemMetrics.width : 0;
    const top = Math.min(y, y - height);
    const bottom = Math.max(y, y - height);

    if (!currentLine || Math.abs(currentLine.baselineY - y) > LINE_THRESHOLD) {
      flushCurrentLine();
      currentLine = {
        parts: [],
        top,
        bottom,
        baselineY: y,
      };
    } else {
      currentLine.top = Math.min(currentLine.top, top);
      currentLine.bottom = Math.max(currentLine.bottom, bottom);
    }

    if (
      currentLine.lastX !== undefined &&
      x - currentLine.lastX > CELL_THRESHOLD &&
      currentLine.parts.length > 0
    ) {
      currentLine.parts.push(' ');
    }

    currentLine.parts.push(text);
    currentLine.lastX = x + width;

    if (itemMetrics.hasEOL === true || text.endsWith('\n')) {
      flushCurrentLine();
    }
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
  page: {
    commonObjs: {
      has: (name: unknown) => boolean;
      get: (name: unknown, callback: (imgData: unknown) => void) => void;
    };
    objs: { get: (name: unknown, callback: (imgData: unknown) => void) => void };
    getViewport: (params: { scale: number }) => { transform: number[] };
    getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  },
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

const fetchImagesForPages = async (
  parser: PDFParse,
  pages: number[] | undefined
): Promise<PdfImagePage[]> => {
  if (!pages || pages.length === 0) {
    try {
      const bulk = await parser.getImage({
        imageThreshold: IMAGE_DIMENSION_THRESHOLD,
        imageBuffer: false,
        imageDataUrl: true,
      });
      return bulk.pages as PdfImagePage[];
    } catch (error) {
      console.warn(
        '[Backend] Bulk PDF image extraction failed, falling back to per-page extraction.',
        error
      );
      const doc = (parser as unknown as { doc?: { numPages?: number } }).doc;
      const numPages = doc?.numPages ?? 0;
      if (numPages <= 0) {
        return [];
      }
      pages = Array.from({ length: numPages }, (_, index) => index + 1);
    }
  }

  const collected: PdfImagePage[] = [];
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
    } catch (error) {
      console.warn(
        `[Backend] Skipping PDF page ${pageNumber} during image extraction due to an error.`,
        error instanceof Error ? error.message : error
      );
    }
  }
  return collected;
};

export const extractPdfImages = async (
  pdfDataUrl: string,
  limit = 36,
  partialPages?: number[]
): Promise<ExtractedPdfImage[]> => {
  const pdfBuffer = decodePdfDataUrl(pdfDataUrl);
  const parser = new PDFParse({ data: pdfBuffer });
  const dedupedImages = new Map<string, ExtractedPdfImage>();
  const sanitizedPartialPages = sanitizePartialPages(partialPages);

  try {
    const imagePages = await fetchImagesForPages(parser, sanitizedPartialPages);
    const pdfDocument = (
      parser as unknown as {
        doc?: {
          getPage: (pageNumber: number) => Promise<{
            cleanup: () => void;
            commonObjs: {
              has: (name: unknown) => boolean;
              get: (name: unknown, callback: (imgData: unknown) => void) => void;
            };
            objs: { get: (name: unknown, callback: (imgData: unknown) => void) => void };
            getViewport: (params: { scale: number }) => {
              transform: number[];
              convertToViewportPoint: (x: number, y: number) => [number, number];
            };
            getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[] }>;
            getTextContent: (params: {
              includeMarkedContent: boolean;
              disableNormalization: boolean;
            }) => Promise<{ items: unknown[] }>;
          }>;
        };
      }
    ).doc;

    for (const page of imagePages) {
      const pageProxy = pdfDocument ? await pdfDocument.getPage(page.pageNumber) : null;
      const [pageLines, pagePlacements] = pageProxy
        ? await Promise.all([
            extractPageTextLines(pageProxy),
            extractPageImagePlacements(pageProxy, IMAGE_DIMENSION_THRESHOLD),
          ])
        : [[], []];

      for (const [pageImageIndex, image] of page.images.entries()) {
        if (!image.dataUrl) {
          continue;
        }

        const mimeType = getMimeTypeFromDataUrl(image.dataUrl);
        const dataBuffer = decodeImageDataUrl(image.dataUrl);
        if (dataBuffer.length < MIN_IMAGE_BYTES) {
          continue;
        }

        const placement = pagePlacements[pageImageIndex];
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
          continue;
        }

        const hash = buildSha256HexDigest(dataBuffer);
        if (dedupedImages.has(hash)) {
          continue;
        }

        const imageContext = placement
          ? buildLocalImageTextContext(pageLines, placement.rect)
          : emptyImageTextContext;

        dedupedImages.set(hash, {
          id: `pdf-img-${String(dedupedImages.size + 1).padStart(3, '0')}`,
          mimeType,
          dataUrl: image.dataUrl,
          sizeBytes: dataBuffer.length,
          hash,
          pageNumber: page.pageNumber,
          intrinsicWidth: intrinsicDimensions?.width,
          intrinsicHeight: intrinsicDimensions?.height,
          textBefore: imageContext.textBefore,
          textCurrent: imageContext.textCurrent,
          textAfter: imageContext.textAfter,
        });

        if (dedupedImages.size >= limit) {
          break;
        }
      }

      pageProxy?.cleanup();

      if (dedupedImages.size >= limit) {
        break;
      }
    }
  } finally {
    await parser.destroy().catch(() => undefined);
  }

  return Array.from(dedupedImages.values());
};
