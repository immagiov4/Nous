import {
  buildPdfPageTextLayout,
  resolveLessonContextChunks,
  resolvePdfChunkPageSpan,
} from './documentIndex/index.ts';
import type { PdfTextChunk, PdfTextIndex } from './types.ts';

const PDF_IMAGE_PAGE_RADIUS = 2;
type PageMappingMode =
  | 'exact-from-page-text'
  | 'exact-from-chunk-metadata'
  | 'estimated-from-offsets';

const formatEstimatedPageRange = (
  span: { startPage: number; endPage: number } | null | undefined
): string | null => {
  if (!span) {
    return null;
  }

  return span.startPage === span.endPage
    ? `pag. ${span.startPage}`
    : `pag. ${span.startPage}-${span.endPage}`;
};

export const buildPdfChunkUsageDebugPayload = (
  sectionTitle: string,
  documentIndex: PdfTextIndex | null | undefined,
  primaryChunkIds: string[] | undefined,
  pageCount: number | undefined,
  targetedImagePages: number[] = [],
  pdfPages?: Array<{ pageNumber: number; text: string }>
): Record<string, unknown> | null => {
  if (!documentIndex || documentIndex.chunks.length === 0) {
    return null;
  }

  const pageLayout = buildPdfPageTextLayout(pdfPages);
  const hasStoredChunkPages = documentIndex.chunks.some(
    chunk => typeof chunk.pageStart === 'number' && typeof chunk.pageEnd === 'number'
  );
  const indexById = new Map(documentIndex.chunks.map(chunk => [chunk.id, chunk]));
  const primaryChunks = (primaryChunkIds || [])
    .map(chunkId => indexById.get(chunkId))
    .filter((chunk): chunk is PdfTextChunk => Boolean(chunk));
  const contextChunks = resolveLessonContextChunks(documentIndex, primaryChunkIds);
  const contextChunkSpans = contextChunks
    .map(chunk => ({
      chunk,
      span: resolvePdfChunkPageSpan(documentIndex, chunk, pageCount, pageLayout),
    }))
    .filter(item => Boolean(item.chunk));
  const pageStarts = contextChunkSpans
    .map(item => item.span?.startPage)
    .filter(Number.isFinite) as number[];
  const pageEnds = contextChunkSpans
    .map(item => item.span?.endPage)
    .filter(Number.isFinite) as number[];

  return {
    sectionTitle,
    pageCount: pageCount ?? 'unknown',
    primaryChunkIds: primaryChunks.map(chunk => chunk.id),
    primaryChunks: primaryChunks.map(chunk => ({
      id: chunk.id,
      sequence: chunk.sequence,
      headingPath: chunk.headingPath.join(' > ') || 'Nessuno',
      pageRange: formatEstimatedPageRange(
        resolvePdfChunkPageSpan(documentIndex, chunk, pageCount, pageLayout)
      ),
      pageRangeSource: resolvePdfChunkPageSpan(documentIndex, chunk, pageCount, pageLayout)?.exact
        ? 'exact'
        : 'estimated',
    })),
    promptContextChunkIds: contextChunks.map(chunk => chunk.id),
    promptContextPageRange:
      pageStarts.length > 0 && pageEnds.length > 0
        ? formatEstimatedPageRange({
            startPage: Math.min(...pageStarts),
            endPage: Math.max(...pageEnds),
          })
        : null,
    promptContextChunks: contextChunkSpans.map(({ chunk, span }) => ({
      id: chunk.id,
      sequence: chunk.sequence,
      headingPath: chunk.headingPath.join(' > ') || 'Nessuno',
      pageRange: formatEstimatedPageRange(span),
      pageRangeSource: span?.exact ? 'exact' : 'estimated',
    })),
    targetedImagePages:
      targetedImagePages.length > 0
        ? `pag. ${targetedImagePages[0]}-${targetedImagePages.at(-1)}`
        : null,
    pageMappingMode: resolvePageMappingMode({ hasStoredChunkPages, pageLayout }),
  };
};

const resolvePageMappingMode = ({
  hasStoredChunkPages,
  pageLayout,
}: {
  hasStoredChunkPages: boolean;
  pageLayout: ReturnType<typeof buildPdfPageTextLayout>;
}): PageMappingMode => {
  if (pageLayout) {
    return 'exact-from-page-text';
  }

  if (hasStoredChunkPages) {
    return 'exact-from-chunk-metadata';
  }

  return 'estimated-from-offsets';
};

export const estimateRelevantPdfImagePages = (
  documentIndex: PdfTextIndex | null | undefined,
  primaryChunkIds: string[] | undefined,
  pageCount: number | undefined,
  pdfPages?: Array<{ pageNumber: number; text: string }>
): number[] => {
  if (!documentIndex || documentIndex.chunks.length === 0 || !pageCount || pageCount < 1) {
    return [];
  }

  const pageLayout = buildPdfPageTextLayout(pdfPages);
  const indexById = new Map(documentIndex.chunks.map(chunk => [chunk.id, chunk]));
  const anchorChunks =
    (primaryChunkIds || [])
      .map(chunkId => indexById.get(chunkId))
      .filter((chunk): chunk is PdfTextChunk => Boolean(chunk)) || [];
  const resolvedAnchorChunks =
    anchorChunks.length > 0
      ? anchorChunks
      : documentIndex.chunks.slice(0, Math.min(2, documentIndex.chunks.length));

  const pages = new Set<number>();

  resolvedAnchorChunks.forEach(chunk => {
    const span = resolvePdfChunkPageSpan(documentIndex, chunk, pageCount, pageLayout);
    if (!span) {
      return;
    }

    for (
      let page = Math.max(1, span.startPage - PDF_IMAGE_PAGE_RADIUS);
      page <= Math.min(pageCount, span.endPage + PDF_IMAGE_PAGE_RADIUS);
      page += 1
    ) {
      pages.add(page);
    }
  });

  return Array.from(pages).sort((left, right) => left - right);
};
