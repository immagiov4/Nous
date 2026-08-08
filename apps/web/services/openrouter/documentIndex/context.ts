import type { PdfTextChunk, PdfTextIndex } from '../../../types.ts';

const MAX_CONTEXT_CHUNKS = 6;

export const resolveLessonContextChunks = (
  documentIndex: PdfTextIndex | null | undefined,
  primaryChunkIds: string[] | undefined
): PdfTextChunk[] => {
  if (!documentIndex || documentIndex.chunks.length === 0) {
    return [];
  }

  const indexById = new Map(documentIndex.chunks.map(chunk => [chunk.id, chunk]));
  const orderedSequences = new Set<number>();

  (primaryChunkIds || [])
    .map(chunkId => indexById.get(chunkId))
    .filter((chunk): chunk is PdfTextChunk => Boolean(chunk))
    .forEach(chunk => {
      orderedSequences.add(chunk.sequence);
      const previousChunk = documentIndex.chunks[chunk.sequence - 1];
      if (
        orderedSequences.size < MAX_CONTEXT_CHUNKS &&
        previousChunk &&
        (!chunk.sourceId || previousChunk.sourceId === chunk.sourceId)
      ) {
        orderedSequences.add(previousChunk.sequence);
      }
      const nextChunk = documentIndex.chunks[chunk.sequence + 1];
      if (
        orderedSequences.size < MAX_CONTEXT_CHUNKS &&
        nextChunk &&
        (!chunk.sourceId || nextChunk.sourceId === chunk.sourceId)
      ) {
        orderedSequences.add(nextChunk.sequence);
      }
    });

  if (orderedSequences.size === 0) {
    documentIndex.chunks.slice(0, Math.min(2, documentIndex.chunks.length)).forEach(chunk => {
      orderedSequences.add(chunk.sequence);
    });
  }

  return Array.from(orderedSequences)
    .sort((left, right) => left - right)
    .slice(0, MAX_CONTEXT_CHUNKS)
    .map(sequence => documentIndex.chunks[sequence])
    .filter((chunk): chunk is PdfTextChunk => Boolean(chunk));
};
