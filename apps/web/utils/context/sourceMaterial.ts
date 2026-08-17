import { MAX_CONTEXT_CHAT_FIELD_CHARS } from '@shared/lessonSourceContext';
import { resolveLessonContextChunks } from '../../services/openrouter/documentIndex/context.ts';
import { resolvePdfChunkPageSpan } from '../../services/openrouter/documentIndex/index.ts';
import { getCourseSourceDescriptors } from '../../services/projects/courseSources.ts';
import type {
  CourseSourceDescriptor,
  FileData,
  LessonNode,
  LessonSourceReference,
  PdfTextChunk,
  PdfTextIndex,
  ProjectSource,
  SourceArchiveEntry,
  SourceArchiveSelector,
} from '../../types.ts';

const CONTEXT_CHUNK_SEPARATOR = '\n\n---\n\n';

interface ResolvedPageSpan {
  endPage: number;
  exact: boolean;
  startPage: number;
}

export interface ResolvedLessonSourceReference extends LessonSourceReference {
  archiveSelectors?: SourceArchiveSelector[];
  archiveVersion?: Extract<ProjectSource, { kind: 'archive' }>['index']['version'];
  file: FileData;
  kind: CourseSourceDescriptor['kind'] | 'archive';
  name: string;
}

const compareArchiveEntries = (left: SourceArchiveEntry, right: SourceArchiveEntry): number => {
  if (left.path !== right.path) {
    return left.path < right.path ? -1 : 1;
  }
  return left.kind === right.kind ? 0 : left.kind === 'directory' ? -1 : 1;
};

const formatArchiveEntry = (entry: SourceArchiveEntry): string => {
  if (entry.kind === 'directory') {
    return `directory ${entry.path}`;
  }

  const header = [
    `file ${entry.path}`,
    entry.contentKind,
    `${entry.byteSize} bytes`,
    ...(entry.hash ? [`sha256 ${entry.hash}`] : []),
  ].join(' | ');
  return entry.preview === undefined ? header : `${header}\npreview:\n${entry.preview}`;
};

const buildArchiveSourceMaterial = (source: Extract<ProjectSource, { kind: 'archive' }>): string =>
  [...source.index.entries].sort(compareArchiveEntries).map(formatArchiveEntry).join('\n');

const formatChunk = (chunk: PdfTextChunk) => {
  const headingPath = chunk.headingPath.join(' > ').trim() || 'Nessuno';
  return `CHUNK ${chunk.id}\nHeading path: ${headingPath}\n${chunk.text}`;
};

const buildPdfSourceMaterial = (chunks: readonly PdfTextChunk[]): string =>
  chunks.map(formatChunk).join(CONTEXT_CHUNK_SEPARATOR);

const retainCompleteChunksWithinPromptBudget = (
  chunks: readonly PdfTextChunk[]
): PdfTextChunk[] => {
  const retainedChunks: PdfTextChunk[] = [];
  let retainedChars = 0;

  for (const chunk of chunks) {
    const separatorChars = retainedChunks.length ? CONTEXT_CHUNK_SEPARATOR.length : 0;
    const nextChars = separatorChars + formatChunk(chunk).length;
    if (retainedChars + nextChars > MAX_CONTEXT_CHAT_FIELD_CHARS) {
      break;
    }
    retainedChunks.push(chunk);
    retainedChars += nextChars;
  }

  return retainedChunks;
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
    const previousSpan = mergedSpans.at(-1);

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
  activeSection: LessonNode | null;
  documentIndex: PdfTextIndex | null;
}): string | undefined =>
  getSourcePageLabelFromChunkIds({
    chunkIds: activeSection?.primaryChunkIds,
    documentIndex,
  });

export const resolveLessonSourceReferences = ({
  activeSection,
  source,
}: {
  activeSection: LessonNode | null;
  source: ProjectSource | null;
}): ResolvedLessonSourceReference[] => {
  if (source?.kind === 'archive') {
    const archiveSelectors = activeSection?.sourceArchiveSelectors;
    const archiveVersion = source.index.version;
    return [
      {
        ...(archiveSelectors?.length ? { archiveSelectors } : {}),
        ...(archiveVersion ? { archiveVersion } : {}),
        chunkIds: [],
        file: source.file,
        kind: source.kind,
        name: source.name,
        sourceId: source.ref?.id || source.file.sourceId || source.name,
      },
    ];
  }

  const referencesBySourceId = new Map(
    (activeSection?.sourceReferences || []).map(reference => [reference.sourceId, reference])
  );
  const descriptors = getCourseSourceDescriptors(source);
  const legacySingleSourceReference =
    referencesBySourceId.size === 0 &&
    descriptors.length === 1 &&
    Boolean(activeSection?.primaryChunkIds?.length)
      ? {
          chunkIds: activeSection?.primaryChunkIds || [],
          sourceId: descriptors[0]?.id || '',
        }
      : null;

  return descriptors.flatMap(descriptor => {
    const reference =
      referencesBySourceId.get(descriptor.id) ||
      (legacySingleSourceReference?.sourceId === descriptor.id
        ? legacySingleSourceReference
        : undefined);
    return reference
      ? [
          {
            ...reference,
            chunkIds: reference.chunkIds || [],
            file: descriptor.file,
            kind: descriptor.kind,
            name: descriptor.name,
          },
        ]
      : [];
  });
};

const detachSourceFileData = (
  references: readonly ResolvedLessonSourceReference[]
): ResolvedLessonSourceReference[] =>
  references.map(reference => ({
    ...reference,
    file: { ...reference.file, data: '' },
  }));

const resolveSelectedChunkSourceReferences = ({
  documentIndex,
  selectedChunks,
  source,
}: {
  documentIndex: PdfTextIndex;
  selectedChunks: readonly PdfTextChunk[];
  source: ProjectSource;
}): ResolvedLessonSourceReference[] => {
  const descriptors = getCourseSourceDescriptors(source);

  return descriptors.flatMap(descriptor => {
    const sourceChunks = selectedChunks.filter(
      chunk => chunk.sourceId === descriptor.id || (!chunk.sourceId && descriptors.length === 1)
    );
    if (sourceChunks.length === 0) {
      return [];
    }

    const pageSpans = sourceChunks
      .map(chunk => resolvePdfChunkPageSpan(documentIndex, chunk, documentIndex.pageCount))
      .filter((span): span is NonNullable<typeof span> => Boolean(span));
    const pageStart = pageSpans.length
      ? Math.min(...pageSpans.map(span => span.startPage))
      : undefined;
    const pageEnd = pageSpans.length ? Math.max(...pageSpans.map(span => span.endPage)) : undefined;

    return [
      {
        chunkIds: sourceChunks.map(chunk => chunk.id),
        file: descriptor.file,
        kind: descriptor.kind,
        name: descriptor.name,
        ...(pageEnd === undefined ? {} : { pageEnd }),
        ...(pageStart === undefined ? {} : { pageStart }),
        sourceId: descriptor.id,
      },
    ];
  });
};

export const buildContextSourceMaterial = ({
  activeSection,
  documentIndex,
  source,
}: {
  activeSection: LessonNode | null;
  documentIndex: PdfTextIndex | null;
  source: ProjectSource | null;
}): {
  documentSourceReferences?: ResolvedLessonSourceReference[];
  sourceKind?: ProjectSource['kind'];
  sourceMaterial?: string;
} => {
  if (!source) {
    return {};
  }

  if (source.kind === 'archive') {
    return {
      documentSourceReferences: detachSourceFileData(
        resolveLessonSourceReferences({ activeSection, source })
      ),
      sourceKind: source.kind,
      sourceMaterial: buildArchiveSourceMaterial(source) || undefined,
    };
  }

  if (!documentIndex?.chunks.length) {
    return {
      documentSourceReferences: detachSourceFileData(
        resolveLessonSourceReferences({ activeSection, source })
      ),
      sourceKind: source.kind,
    };
  }

  const selectedChunkIds = activeSection?.primaryChunkIds?.length
    ? activeSection.primaryChunkIds
    : activeSection?.sourceReferences?.flatMap(reference => reference.chunkIds || []);
  const selectedChunks = resolveLessonContextChunks(documentIndex, selectedChunkIds);
  const descriptors = getCourseSourceDescriptors(source);
  const descriptorIds = new Set(descriptors.map(descriptor => descriptor.id));
  const attributableChunks = selectedChunks.filter(
    chunk =>
      descriptorIds.has(chunk.sourceId || '') || (!chunk.sourceId && descriptors.length === 1)
  );
  const retainedChunks = retainCompleteChunksWithinPromptBudget(attributableChunks);
  const documentSourceReferences = resolveSelectedChunkSourceReferences({
    documentIndex,
    selectedChunks: retainedChunks,
    source,
  });

  return {
    documentSourceReferences: detachSourceFileData(documentSourceReferences),
    sourceKind: source.kind,
    sourceMaterial: retainedChunks.length ? buildPdfSourceMaterial(retainedChunks) : undefined,
  };
};
