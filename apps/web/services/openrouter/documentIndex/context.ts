import type { PdfTextChunk, PdfTextIndex } from '../../../types.ts';
import { MAX_CONTEXT_CHUNKS } from './constants.ts';

export const buildLessonChunkContext = (
  documentIndex: PdfTextIndex | null | undefined,
  primaryChunkIds: string[] | undefined
): string => {
  if (!documentIndex || documentIndex.chunks.length === 0) {
    return '';
  }

  return resolveLessonContextChunks(documentIndex, primaryChunkIds)
    .map(
      chunk => `CHUNK ${chunk.id}
Heading path: ${chunk.headingPath.join(' > ') || 'Nessuno'}
${chunk.text}`
    )
    .join('\n\n---\n\n');
};

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
      if (orderedSequences.size < MAX_CONTEXT_CHUNKS) {
        orderedSequences.add(Math.max(0, chunk.sequence - 1));
      }
      if (orderedSequences.size < MAX_CONTEXT_CHUNKS) {
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
    .slice(0, MAX_CONTEXT_CHUNKS)
    .map(sequence => documentIndex.chunks[sequence])
    .filter((chunk): chunk is PdfTextChunk => Boolean(chunk));
};
