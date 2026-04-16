import { resolvePdfChunkPageSpan } from '../../services/openrouter/documentIndex.ts';
import type {
  LaboratoryExercise,
  LearningSection,
  PdfTextChunk,
  PdfTextIndex,
  ProjectSource,
} from '../../types.ts';

const MAX_CONTEXT_SOURCE_CHARS = 168_000;
const MAX_PDF_SOURCE_CHUNKS = 6;

interface ResolvedPageSpan {
  endPage: number;
  exact: boolean;
  startPage: number;
}

const clip = (value: string) => {
  if (value.length <= MAX_CONTEXT_SOURCE_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_CONTEXT_SOURCE_CHARS).trimEnd()}\n\n[sorgente troncata nel client]`;
};

const formatChunk = (chunk: PdfTextChunk) => {
  const headingPath = chunk.headingPath.join(' > ').trim() || 'Nessuno';
  return `CHUNK ${chunk.id}\nHeading path: ${headingPath}\n${chunk.text}`;
};

const buildPdfSourceMaterial = (
  documentIndex: PdfTextIndex,
  activeSection: LearningSection | null
): string => {
  const indexById = new Map(documentIndex.chunks.map(chunk => [chunk.id, chunk]));
  const orderedSequences = new Set<number>();

  (activeSection?.primaryChunkIds || [])
    .map(chunkId => indexById.get(chunkId))
    .filter((chunk): chunk is PdfTextChunk => Boolean(chunk))
    .forEach(chunk => {
      orderedSequences.add(chunk.sequence);
      if (orderedSequences.size < MAX_PDF_SOURCE_CHUNKS) {
        orderedSequences.add(Math.max(0, chunk.sequence - 1));
      }
      if (orderedSequences.size < MAX_PDF_SOURCE_CHUNKS) {
        orderedSequences.add(Math.min(documentIndex.chunks.length - 1, chunk.sequence + 1));
      }
    });

  if (orderedSequences.size === 0) {
    documentIndex.chunks.slice(0, Math.min(2, documentIndex.chunks.length)).forEach(chunk => {
      orderedSequences.add(chunk.sequence);
    });
  }

  return Array.from(orderedSequences)
    .sort((left, right) => left - right)
    .slice(0, MAX_PDF_SOURCE_CHUNKS)
    .map(sequence => documentIndex.chunks[sequence])
    .filter(Boolean)
    .map(formatChunk)
    .join('\n\n---\n\n');
};

const formatPageRangeSegment = (startPage: number, endPage: number): string =>
  startPage === endPage ? `${startPage}` : `${startPage}-${endPage}`;

const mergeResolvedPageSpans = (spans: ResolvedPageSpan[]): ResolvedPageSpan[] => {
  if (spans.length === 0) {
    return [];
  }

  const sortedSpans = [...spans].sort((left, right) => {
    if (left.startPage !== right.startPage) {
      return left.startPage - right.startPage;
    }

    return left.endPage - right.endPage;
  });

  return sortedSpans.reduce<ResolvedPageSpan[]>((mergedSpans, span) => {
    const previousSpan = mergedSpans[mergedSpans.length - 1];

    if (!previousSpan || span.startPage > previousSpan.endPage + 1) {
      mergedSpans.push({ ...span });
      return mergedSpans;
    }

    previousSpan.endPage = Math.max(previousSpan.endPage, span.endPage);
    previousSpan.exact = previousSpan.exact && span.exact;
    return mergedSpans;
  }, []);
};

const formatPageRangeLabel = (spans: ResolvedPageSpan[]): string | undefined => {
  if (spans.length === 0) {
    return undefined;
  }

  const mergedSpans = mergeResolvedPageSpans(spans);
  const formattedSegments = mergedSpans.map(span => {
    const segment = formatPageRangeSegment(span.startPage, span.endPage);
    return span.exact ? segment : `${segment} (stima)`;
  });

  return `pag. ${formattedSegments.join(', ')}`;
};

const getSourcePageLabelFromChunkIds = ({
  chunkIds,
  documentIndex,
}: {
  chunkIds?: string[];
  documentIndex: PdfTextIndex | null;
}): string | undefined => {
  if (!chunkIds?.length || !documentIndex?.chunks.length) {
    return undefined;
  }

  const indexById = new Map(documentIndex.chunks.map(chunk => [chunk.id, chunk]));
  const resolvedSpans = chunkIds
    .map(chunkId => indexById.get(chunkId))
    .filter((chunk): chunk is PdfTextChunk => Boolean(chunk))
    .map(chunk => resolvePdfChunkPageSpan(documentIndex, chunk, documentIndex.pageCount))
    .filter(
      (
        span
      ): span is {
        startPage: number;
        endPage: number;
        exact: boolean;
      } => Boolean(span)
    );

  if (resolvedSpans.length === 0) {
    return undefined;
  }

  return formatPageRangeLabel(resolvedSpans);
};

export const getLessonSourcePageLabel = ({
  activeSection,
  documentIndex,
}: {
  activeSection: LearningSection | null;
  documentIndex: PdfTextIndex | null;
}): string | undefined =>
  getSourcePageLabelFromChunkIds({
    chunkIds: activeSection?.primaryChunkIds,
    documentIndex,
  });

export const getLaboratorySourcePageLabel = ({
  activeExercise,
  documentIndex,
}: {
  activeExercise: LaboratoryExercise | null;
  documentIndex: PdfTextIndex | null;
}): string | undefined =>
  getSourcePageLabelFromChunkIds({
    chunkIds: activeExercise?.sourceChunkIds,
    documentIndex,
  });

export const buildContextSourceMaterial = ({
  activeSection,
  documentIndex,
  source,
}: {
  activeSection: LearningSection | null;
  documentIndex: PdfTextIndex | null;
  source: ProjectSource | null;
}): {
  sourceKind?: ProjectSource['kind'];
  sourceMaterial?: string;
  sourceName?: string;
} => {
  if (!source) {
    return {};
  }

  if (source.kind === 'codebase-bundle') {
    const material = source.aggregatedText.trim();
    return {
      sourceKind: source.kind,
      sourceMaterial: material ? clip(material) : undefined,
      sourceName: source.name,
    };
  }

  const sourceMaterial =
    documentIndex && documentIndex.chunks.length > 0
      ? clip(buildPdfSourceMaterial(documentIndex, activeSection))
      : undefined;

  return {
    sourceKind: source.kind,
    sourceMaterial,
    sourceName: source.file.name,
  };
};
