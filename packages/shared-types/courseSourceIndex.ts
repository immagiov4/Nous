import type { PdfTextIndex } from './pdfTextIndex';

export interface IndexedCourseSource {
  id: string;
  name: string;
  hash: string;
  status: string;
  documentIndex?: PdfTextIndex | null;
}

/** Combines already ordered source indexes, retaining each chunk's source identity. */
export const combineCourseSourceIndexes = (
  sources: readonly IndexedCourseSource[],
  now: () => string = () => new Date().toISOString()
): PdfTextIndex | null => {
  const ready = sources.filter(
    source => source.status !== 'error' && source.documentIndex?.chunks.length
  );
  if (!ready.length) return null;
  const chunks = ready.flatMap(source =>
    (source.documentIndex?.chunks ?? []).map(chunk => ({
      ...chunk,
      headingPath:
        chunk.headingPath[0] === source.name
          ? chunk.headingPath
          : [source.name, ...chunk.headingPath],
      id: chunk.id.startsWith(`${source.id}:`) ? chunk.id : `${source.id}:${chunk.id}`,
      sourceId: source.id,
    }))
  );
  return {
    kind: 'pdf-text-index',
    parsedAt: now(),
    sourceHash: ready.map(source => source.hash).join(':'),
    sourceIds: ready.map(source => source.id),
    documentTitle: ready.map(source => source.name).join(', '),
    chunks: chunks.map((chunk, sequence) => ({ ...chunk, sequence })),
  };
};
