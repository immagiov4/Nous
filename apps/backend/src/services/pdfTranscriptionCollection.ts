import { PreparedPdfTextSchema } from '@shared/pdfTranscription';
import type { SourcePreparationContext } from '../projects/sourcePreparationContext.js';
import { isRecord } from '../utils/validation.js';
import { PdfTranscriptionPool } from './pdfTranscriptionPool.js';

const sourceDescriptors = (source: unknown): Record<string, unknown>[] =>
  isRecord(source) && Array.isArray(source.sources) ? source.sources.filter(isRecord) : [];

/** Uses saved page provenance; submitted descriptors contribute identities, never budget counts. */
export const countRetainedScannedPages = (
  savedSource: unknown,
  submittedSource: unknown,
  replacedIds: readonly string[]
): number => {
  const retained = new Set(sourceDescriptors(submittedSource).map(source => source.id));
  const replaced = new Set(replacedIds);
  let scannedPages = 0;
  for (const source of sourceDescriptors(savedSource)) {
    if (typeof source.id !== 'string' || !retained.has(source.id) || replaced.has(source.id))
      continue;
    const prepared = PreparedPdfTextSchema.safeParse(source.preparedPdfText);
    if (!prepared.success) continue;
    const pageNumbers = new Set([
      ...prepared.data.pages
        .filter(page => page.provenance?.kind === 'vision-transcription')
        .map(page => page.pageNumber),
      ...(prepared.data.failedPages || []),
      ...(prepared.data.blankPages || []),
    ]);
    scannedPages += pageNumbers.size;
  }
  return scannedPages;
};

/** The ingestion job owns this lifetime, including aborting unfinished requests on any failure. */
export const withPdfTranscriptionCollection = async <T>(
  context: SourcePreparationContext,
  operation: () => Promise<T>
): Promise<T> => {
  const pool =
    context.pdfTranscriptionPool ||
    new PdfTranscriptionPool(undefined, context.previousScannedPages);
  context.pdfTranscriptionPool = pool;
  try {
    context.signal.throwIfAborted();
    return await operation();
  } finally {
    await pool.close();
  }
};
