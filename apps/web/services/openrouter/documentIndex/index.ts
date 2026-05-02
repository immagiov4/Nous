export { buildPdfTextIndex } from './chunking.ts';
export {
  buildLessonChunkContext,
  resolveLessonContextChunks,
} from './context.ts';
// fallow-ignore-next-line unused-types — public barrel re-export
export type { PdfPageTextLayout } from './layout.ts';
export {
  buildPdfPageTextLayout,
  resolvePdfChunkPageSpan,
} from './layout.ts';
export {
  getPdfLessonMappingState,
  needsPdfLessonMappingMigration,
  preparePdfLessonMappings,
} from './mapping.ts';
