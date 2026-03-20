import type { FileData, LearningPlan, PdfTextIndex } from '../types';

export type PdfProjectHydrationState =
  | 'idle'
  | 'missing-document-index'
  | 'missing-primary-chunk-mappings'
  | 'ready';

const isPdfFileData = (file: FileData | null): boolean => {
  if (!file) {
    return false;
  }

  return file.mimeType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
};

export const getPdfProjectHydrationState = (
  file: FileData | null,
  plan: LearningPlan | null,
  documentIndex: PdfTextIndex | null | undefined
): PdfProjectHydrationState => {
  if (!isPdfFileData(file) || !plan || plan.sections.length === 0) {
    return 'idle';
  }

  if (!documentIndex || documentIndex.chunks.length === 0) {
    return 'missing-document-index';
  }

  if (plan.sections.some(section => !section.primaryChunkIds || section.primaryChunkIds.length === 0)) {
    return 'missing-primary-chunk-mappings';
  }

  return 'ready';
};

export const needsPdfProjectHydration = (
  file: FileData | null,
  plan: LearningPlan | null,
  documentIndex: PdfTextIndex | null | undefined
): boolean => {
  const hydrationState = getPdfProjectHydrationState(file, plan, documentIndex);
  return hydrationState === 'missing-document-index' || hydrationState === 'missing-primary-chunk-mappings';
};
