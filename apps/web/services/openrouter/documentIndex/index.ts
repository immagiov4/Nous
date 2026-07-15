export { buildPdfTextIndex } from './chunking.ts';
export {
  buildLessonChunkContext,
  resolveLessonContextChunks,
} from './context.ts';
export type { PdfPageTextLayout } from './layout.ts';
export {
  buildPdfPageTextLayout,
  resolvePdfChunkPageSpan,
} from './layout.ts';
export {
  getPdfLessonMappingState,
  needsPdfLessonMappingMigration,
  preparePdfLessonMappings,
  prepareSourceSetLessonMappings,
} from './mapping.ts';
